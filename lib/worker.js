/**
 * lib/worker.js - Worker Lifecycle Logic
 * 
 * Handles Baileys connection lifecycle for serverless environment
 */

require('dotenv').config();

const { getPrismaClient } = require('./database');
const { acquireLock, updateHeartbeat, releaseLock, logConnectionEvent, HEARTBEAT_INTERVAL_MS } = require('./worker-lock');
const { createBaileysSocket } = require('./baileys');

const FUNCTION_TIMEOUT_MS = 50000; // 50s
const DEADLINE_WARNING_MS = 45000; // 45s

function generateWorkerId() {
  return `vercel-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Main worker function
 */
async function runWorker() {
  const workerId = generateWorkerId();
  console.log(`[WORKER] Starting worker: ${workerId}`);

  let sock = null;
  let heartbeatTimer = null;
  let isShuttingDown = false;
  let shutdownResolve = null;
  
  const shutdownPromise = new Promise(resolve => {
    shutdownResolve = resolve;
  });

  async function gracefulShutdown(reason = 'DEADLINE') {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`[WORKER] Graceful shutdown: ${reason}`);
    await logConnectionEvent(workerId, 'GRACEFUL_SHUTDOWN', { reason });

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    if (sock) {
      try {
        sock.end();
        console.log('[WORKER] Socket closed');
      } catch (err) {
        console.error('[WORKER] Error closing socket:', err);
      }
    }

    try {
      await releaseLock(workerId);
      await logConnectionEvent(workerId, 'LOCK_RELEASED');
      console.log('[WORKER] Lock released');
    } catch (err) {
      console.error('[WORKER] Error releasing lock:', err);
    }

    const prisma = getPrismaClient();
    await prisma.$disconnect();
    
    shutdownResolve();
  }

  try {
    await logConnectionEvent(workerId, 'FUNCTION_START');

    // ── Acquire Lock ──────────────────────────────────────────────────────
    console.log('[WORKER] Acquiring lock...');
    const lockResult = await acquireLock(workerId);

    if (!lockResult.success) {
      console.log(`[WORKER] ${lockResult.reason}`);
      await logConnectionEvent(workerId, 'LOCK_DENIED');
      return { status: 'skipped', reason: lockResult.reason };
    }

    console.log('[WORKER] Lock acquired');
    await logConnectionEvent(workerId, 'LOCK_ACQUIRED');

    // ── Create Baileys Socket ──────────────────────────────────────────────
    console.log('[WORKER] Creating Baileys socket...');
    sock = await createBaileysSocket(workerId);

    // ── Handle Messages ────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const chatId = msg.key.remoteJid;

        console.log(`[MESSAGE] Received: ${text} from ${chatId}`);
        await logConnectionEvent(workerId, 'MESSAGE_RECEIVED', { 
          from: chatId,
          text: text.substring(0, 100)
        });

        if (text.toLowerCase() === '!ping') {
          try {
            await sock.sendMessage(chatId, { text: 'pong' }, { quoted: msg });
            await logConnectionEvent(workerId, 'MESSAGE_SENT', { to: chatId });
            console.log('[MESSAGE] Sent: pong');
          } catch (err) {
            console.error('[MESSAGE] Failed to send:', err);
          }
        }
      }
    });

    // ── Start Heartbeat ─────────────────────────────────────────────────────
    heartbeatTimer = setInterval(async () => {
      try {
        await updateHeartbeat(workerId);
        console.log('[WORKER] Heartbeat sent');
      } catch (err) {
        console.error('[WORKER] Heartbeat failed:', err);
      }
    }, HEARTBEAT_INTERVAL_MS);

    // ── Schedule Deadline ──────────────────────────────────────────────────
    const deadlineTimer = setTimeout(() => {
      gracefulShutdown('DEADLINE');
    }, DEADLINE_WARNING_MS);

    console.log(`[WORKER] Running for ${FUNCTION_TIMEOUT_MS / 1000}s`);

    // Wait for shutdown signal
    await shutdownPromise;
    
    clearTimeout(deadlineTimer);
    
    return { 
      status: 'completed', 
      workerId,
      runtime: DEADLINE_WARNING_MS
    };

  } catch (err) {
    console.error('[WORKER] Error:', err);
    await logConnectionEvent(workerId, 'ERROR', { error: err.message });
    
    await gracefulShutdown('ERROR');
    throw err;
  }
}

module.exports = { runWorker };

/**
 * api/worker.js - Vercel Serverless Function Worker
 * 
 * Lifecycle:
 * START → Acquire Lock → Load Auth → Create Socket → CONNECTED
 *   → Heartbeat → Messages → Approaching Deadline → Graceful Disconnect
 *   → Release Lock → EXIT
 */

require('dotenv').config();

const { getPrismaClient } = require('../lib/database');
const { acquireLock, updateHeartbeat, releaseLock, logConnectionEvent } = require('../lib/worker-lock');
const { loadAuthState } = require('../lib/auth-state');
const { createBaileysSocket } = require('../lib/baileys');

// Vercel timeout: 60s (default), 900s (enterprise)
const FUNCTION_TIMEOUT = 50_000; // 50s safety margin
const HEARTBEAT_INTERVAL = 5_000; // 5s

let workerLock = null;
let heartbeatTimer = null;
let deadlineTimer = null;
let sock = null;

/**
 * Log event to DB (now using logConnectionEvent)
 */
async function logEvent(workerId, event, metadata = {}) {
  await logConnectionEvent(workerId, event, metadata);
}

/**
 * Graceful shutdown
 */
async function gracefulShutdown(workerId) {
  console.log('⚠️ Approaching deadline, shutting down gracefully...');
  
  await logEvent(workerId, 'DEADLINE_WARNING', { remainingMs: 0 });

  // Stop heartbeat
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (deadlineTimer) clearTimeout(deadlineTimer);

  // Disconnect Baileys
  if (sock) {
    try {
      sock.end();
      await logEvent(workerId, 'GRACEFUL_DISCONNECT');
    } catch (err) {
      console.error('Error closing socket:', err);
    }
  }

  // Release lock
  if (workerLock) {
    try {
      await releaseLock(workerLock.id);
      await logEvent(workerId, 'LOCK_RELEASED');
    } catch (err) {
      console.error('Error releasing lock:', err);
    }
  }

  // Disconnect Prisma
  const prisma = getPrismaClient();
  await prisma.$disconnect();
  console.log('✅ Graceful shutdown complete');
}

/**
 * Main worker function
 */
async function runWorker() {
  const workerId = `worker-${Date.now()}`;
  console.log(`🚀 Starting worker: ${workerId}`);

  try {
    await logEvent(workerId, 'FUNCTION_START');

    // ── Acquire Lock ──────────────────────────────────────────────────────
    console.log('🔒 Acquiring lock...');
    workerLock = await acquireLock(workerId, FUNCTION_TIMEOUT);

    if (!workerLock) {
      console.log('❌ Failed to acquire lock (another worker active)');
      await logEvent(workerId, 'LOCK_FAILED', { reason: 'Another worker active' });
      return { status: 'skipped', reason: 'Another worker holds lock' };
    }

    console.log(`✅ Lock acquired: ${workerLock.id}`);
    await logEvent(workerId, 'LOCK_ACQUIRED', { lockId: workerLock.id });

    // ── Load Auth State ────────────────────────────────────────────────────
    console.log('📦 Loading auth state from NeonDB...');
    const { state, saveCreds } = await loadAuthState();

    // ── Create Baileys Socket ──────────────────────────────────────────────
    console.log('🔌 Creating Baileys socket...');
    sock = await createBaileysSocket(workerId);

    sock.ev.on('creds.update', saveCreds);

    // ── Handle Connection Events ───────────────────────────────────────────
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      console.log(`📡 Connection: ${connection}`);

      if (connection === 'connecting') {
        await logEvent(workerId, 'BAILEYS_CONNECTING');
      }

      if (connection === 'open') {
        console.log('✅ Bot connected to WhatsApp!');
        await logEvent(workerId, 'BAILEYS_CONNECTED');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = statusCode ? `Code ${statusCode}` : 'Unknown';
        
        console.log(`❌ Connection closed: ${reason}`);
        await logEvent(workerId, 'BAILEYS_DISCONNECTED', { 
          statusCode, 
          reason: String(reason)
        });
      }
    });

    // ── Handle Messages ────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      const msg = messages[0];
      if (!msg?.message) return;

      const chatId = msg.key.remoteJid;
      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        ''
      ).trim().toLowerCase();

      console.log(`📩 Message from ${chatId}: ${text}`);
      await logEvent(workerId, 'MESSAGE_RECEIVED', { chatId, text });

      // Respond to "ping"
      if (text === 'ping') {
        await sock.sendMessage(chatId, { text: 'pong' }, { quoted: msg });
        await logEvent(workerId, 'MESSAGE_SENT', { chatId, reply: 'pong' });
      }
    });

    // ── Start Heartbeat ─────────────────────────────────────────────────────
    heartbeatTimer = setInterval(async () => {
      try {
        await updateHeartbeat(workerLock.id);
        console.log('💓 Heartbeat sent');
      } catch (err) {
        console.error('Heartbeat failed:', err);
      }
    }, HEARTBEAT_INTERVAL);

    // ── Schedule Deadline ──────────────────────────────────────────────────
    deadlineTimer = setTimeout(async () => {
      await gracefulShutdown(workerId);
    }, FUNCTION_TIMEOUT);

    console.log(`⏳ Worker will run for ${FUNCTION_TIMEOUT / 1000}s`);

    // Keep function alive until deadline
    await new Promise(resolve => {
      deadlineTimer.unref(); // Don't keep process alive just for this timer
      setTimeout(resolve, FUNCTION_TIMEOUT);
    });

    return { status: 'completed', workerId };

  } catch (err) {
    console.error('❌ Worker error:', err);
    await logEvent(workerId, 'ERROR', { error: err.message, stack: err.stack });
    
    // Cleanup on error
    if (workerLock) {
      try {
        await releaseLock(workerLock.id);
      } catch {}
    }
    
    throw err;
  }
}

/**
 * Vercel handler
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const result = await runWorker();
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
};

/**
 * index.js — Local Testing Entry Point
 * 
 * Hanya untuk testing lokal. Deployment menggunakan api/worker.js
 */

require('dotenv').config();

const { createBaileysSocket } = require('./lib/baileys');
const { acquireLock, updateHeartbeat, releaseLock, logConnectionEvent, HEARTBEAT_INTERVAL_MS } = require('./lib/worker-lock');
const { getPrismaClient } = require('./lib/database');

function generateWorkerId() {
    return `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function startBot() {
    const workerId = generateWorkerId();
    console.log(`[LOCAL] Starting worker: ${workerId}`);

    await logConnectionEvent(workerId, 'FUNCTION_START');

    const lockResult = await acquireLock(workerId);
    if (!lockResult.success) {
        console.log(`[LOCAL] ${lockResult.reason}`);
        await logConnectionEvent(workerId, 'LOCK_DENIED');
        return;
    }

    console.log('[LOCAL] Lock acquired');
    await logConnectionEvent(workerId, 'LOCK_ACQUIRED');

    let sock;
    let heartbeatTimer;
    let isShuttingDown = false;

    try {
        sock = await createBaileysSocket(workerId);

        heartbeatTimer = setInterval(async () => {
            try {
                await updateHeartbeat(workerId);
            } catch (err) {
                console.error('[LOCAL] Heartbeat failed:', err);
            }
        }, HEARTBEAT_INTERVAL_MS);

        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;

                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                
                console.log(`[MESSAGE] Received: ${text} from ${msg.key.remoteJid}`);
                
                await logConnectionEvent(workerId, 'MESSAGE_RECEIVED', { 
                    from: msg.key.remoteJid,
                    text: text.substring(0, 100)
                });

                if (text.toLowerCase() === '!ping') {
                    console.log('[MESSAGE] Sending pong...');
                    await sock.sendMessage(msg.key.remoteJid, { text: 'pong' });
                    await logConnectionEvent(workerId, 'MESSAGE_SENT', { to: msg.key.remoteJid });
                    console.log('[MESSAGE] Sent: pong');
                }
            }
        });

        process.on('SIGINT', gracefulShutdown);
        process.on('SIGTERM', gracefulShutdown);

        console.log('[LOCAL] Bot running. Press Ctrl+C to stop.');

    } catch (error) {
        console.error('[LOCAL] Error:', error);
        await logConnectionEvent(workerId, 'ERROR', { error: error.message });
        await cleanup();
    }

    async function gracefulShutdown() {
        if (isShuttingDown) return;
        isShuttingDown = true;

        console.log('\n[LOCAL] Graceful shutdown initiated');
        await logConnectionEvent(workerId, 'GRACEFUL_DISCONNECT');

        await cleanup();
        process.exit(0);
    }

    async function cleanup() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
        }

        if (sock) {
            try {
                sock.end();
                console.log('[LOCAL] Socket closed');
            } catch (err) {
                console.error('[LOCAL] Error closing socket:', err);
            }
        }

        await releaseLock(workerId);
        await logConnectionEvent(workerId, 'LOCK_RELEASED');
        console.log('[LOCAL] Lock released');

        const prisma = getPrismaClient();
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    startBot().catch(console.error);
}

module.exports = { startBot };

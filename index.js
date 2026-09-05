/**
 * index.js — Local Testing Entry Point
 * 
 * Hanya untuk testing lokal. Deployment menggunakan api/worker.js
 */

require('dotenv').config();

const readline = require('readline');
const { createBaileysSocket } = require('./lib/baileys');
const { acquireLock, updateHeartbeat, releaseLock, logConnectionEvent, HEARTBEAT_INTERVAL_MS } = require('./lib/worker-lock');
const { getPrismaClient } = require('./lib/database');

function generateWorkerId() {
    return `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function ask(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function choosePairingMethod() {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║     WhatsApp Bot - Setup Pairing      ║');
    console.log('╚════════════════════════════════════════╝\n');
    console.log('Pilih metode pairing:\n');
    console.log('  [1] Pairing Code  - Input nomor telepon');
    console.log('  [2] QR Code       - Scan dengan kamera\n');
    
    let choice = '';
    while (!['1', '2'].includes(choice)) {
        choice = await ask('Pilihan (1/2): ');
        if (!['1', '2'].includes(choice)) {
            console.log('❌ Input tidak valid. Masukkan 1 atau 2.\n');
        }
    }
    
    return choice === '1' ? 'code' : 'qr';
}

async function getPhoneNumber() {
    console.log('\n');
    let phone = '';
    while (true) {
        phone = await ask('Nomor WhatsApp (contoh: 628123456789): ');
        phone = phone.replace(/\D/g, '');
        
        if (/^62\d{8,13}$/.test(phone)) {
            return phone;
        }
        
        console.log('❌ Nomor tidak valid. Harus diawali 62, minimal 10 digit.\n');
    }
}

async function checkExistingSession() {
    const prisma = getPrismaClient();
    try {
        const creds = await prisma.authCreds.findUnique({ where: { id: 1 } });
        return !!creds;
    } catch {
        return false;
    }
}

async function startBot() {
    const workerId = generateWorkerId();
    console.log(`\n[LOCAL] Starting worker: ${workerId}`);

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
    let pairingMethod = 'qr';
    let phoneNumber = null;
    let shouldReconnect = true;

    async function connectSocket() {
        try {
            const hasSession = await checkExistingSession();
            
            if (!hasSession) {
                pairingMethod = await choosePairingMethod();
                
                if (pairingMethod === 'code') {
                    phoneNumber = await getPhoneNumber();
                    console.log('\n✓ Nomor terdaftar:', phoneNumber);
                    console.log('\n[LOCAL] Menunggu pairing code...\n');
                } else {
                    console.log('\n[LOCAL] QR Code akan ditampilkan setelah connect\n');
                }
            } else {
                console.log('[LOCAL] Session ditemukan, langsung connect\n');
            }

            sock = await createBaileysSocket(workerId, { 
                pairingMethod,
                phoneNumber 
            });

            sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    // 515 = restartRequired (after pairing success)
                    // 428 = connection replaced
                    if ((statusCode === 515 || statusCode === 428) && shouldReconnect) {
                        console.log('\n[LOCAL] Connection closed (code: ' + statusCode + '), reconnecting...\n');
                        await logConnectionEvent(workerId, 'RECONNECT_TRIGGERED', { statusCode });
                        
                        // Cleanup socket lama
                        if (sock) {
                            try {
                                sock.removeAllListeners();
                                sock.end();
                            } catch {}
                        }
                        
                        // Wait 3 detik lalu reconnect
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        
                        if (!isShuttingDown) {
                            console.log('[LOCAL] Reconnecting with saved session...\n');
                            connectSocket();
                        }
                    } else if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                        console.log('\n[LOCAL] Logged out, clearing session\n');
                        shouldReconnect = false;
                        await cleanup();
                    }
                }
            });

            if (!heartbeatTimer) {
                heartbeatTimer = setInterval(async () => {
                    try {
                        await updateHeartbeat(workerId);
                    } catch (err) {
                        console.error('[LOCAL] Heartbeat failed:', err);
                    }
                }, HEARTBEAT_INTERVAL_MS);
            }

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

            if (!process.listenerCount('SIGINT')) {
                process.on('SIGINT', gracefulShutdown);
                process.on('SIGTERM', gracefulShutdown);
            }

            console.log('[LOCAL] Bot running. Press Ctrl+C to stop.\n');

        } catch (error) {
            console.error('[LOCAL] Error:', error);
            await logConnectionEvent(workerId, 'ERROR', { error: error.message });
            
            if (!isShuttingDown && shouldReconnect) {
                console.log('[LOCAL] Retrying in 5 seconds...');
                setTimeout(() => connectSocket(), 5000);
            } else {
                await cleanup();
            }
        }
    }

    async function gracefulShutdown() {
        if (isShuttingDown) return;
        isShuttingDown = true;
        shouldReconnect = false;

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

    // Start initial connection
    await connectSocket();
}

if (require.main === module) {
    startBot().catch(console.error);
}

module.exports = { startBot };

const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { loadAuthState } = require('./auth-state');
const { logConnectionEvent } = require('./worker-lock');

async function createBaileysSocket(workerId, options = {}) {
    const { state, saveCreds } = await loadAuthState();
    
    const { pairingMethod = 'qr', phoneNumber = null, ...socketOptions } = options;
    
    const logger = pino({ 
        level: 'warn'
    });

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: state.keys
        },
        logger,
        printQRInTerminal: false,
        browser: ['Knightbot', 'Chrome', '121.0.0'],
        markOnlineOnConnect: true,
        syncFullHistory: false,
        ...socketOptions,
    });

    let pairingCodeRequested = false;

    sock.ev.on('creds.update', async () => {
        console.log('[BAILEYS] Creds updated, saving...');
        await saveCreds();
        console.log('[BAILEYS] Creds saved successfully');
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;
        
        console.log('[BAILEYS] Connection update:', { 
            connection, 
            isNewLogin,
            hasQr: !!qr,
            errorCode: lastDisconnect?.error?.output?.statusCode,
            registered: sock.authState?.creds?.registered
        });
        
        if (qr) {
            if (pairingMethod === 'qr') {
                console.log('\n╔════════════════════════════════════════╗');
                console.log('║          Scan QR Code                  ║');
                console.log('╚════════════════════════════════════════╝\n');
                console.log('WhatsApp → Perangkat Tertaut → Tautkan Perangkat\n');
                qrcode.generate(qr, { small: true });
                console.log('\n');
            }
            await logConnectionEvent(workerId, 'QR_GENERATED');
        }
        
        if (connection === 'connecting') {
            console.log('[BAILEYS] Connecting...');
            
            if (pairingMethod === 'code' && phoneNumber && !pairingCodeRequested && !sock.authState.creds.registered) {
                pairingCodeRequested = true;
                
                console.log('[BAILEYS] Waiting 3s before requesting pairing code...');
                await delay(3000);
                
                try {
                    console.log(`[BAILEYS] Requesting pairing code for ${phoneNumber}...`);
                    const code = await sock.requestPairingCode(phoneNumber);
                    const formatted = code.match(/.{1,4}/g)?.join('-') || code;
                    
                    console.log('\n╔════════════════════════════════════════╗');
                    console.log('║          Pairing Code                  ║');
                    console.log('╚════════════════════════════════════════╝\n');
                    console.log(`  Kode: ${formatted}\n`);
                    console.log('Cara pairing:');
                    console.log('  1. Buka WhatsApp di HP');
                    console.log('  2. Tekan ⋮ (titik 3) → Perangkat Tertaut');
                    console.log('  3. Tautkan dengan Nomor Telepon');
                    console.log('  4. Masukkan kode: ' + formatted);
                    console.log('\n  Menunggu pairing...\n');
                    
                    await logConnectionEvent(workerId, 'PAIRING_CODE_GENERATED', { phoneNumber });
                } catch (err) {
                    console.error('[BAILEYS] Gagal request pairing code:', err);
                    await logConnectionEvent(workerId, 'PAIRING_CODE_FAILED', { error: err.message });
                }
            }
            
            await logConnectionEvent(workerId, 'BAILEYS_CONNECTING');
        } else if (connection === 'open') {
            await logConnectionEvent(workerId, 'BAILEYS_CONNECTED');
            console.log('\n✅ [BAILEYS] Connected successfully!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            const reason = statusCode || 'UNKNOWN';
            
            console.log('[BAILEYS] Connection CLOSED');
            console.log('  Status code:', statusCode);
            console.log('  Reason:', DisconnectReason[statusCode] || reason);
            console.log('  Should reconnect:', shouldReconnect);
            console.log('  Error:', lastDisconnect?.error?.message);
            
            await logConnectionEvent(workerId, 'BAILEYS_DISCONNECTED', {
                disconnectReason: reason.toString(),
                shouldReconnect,
            });
            
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log('[BAILEYS] Logged out - clearing auth state');
                const { getPrismaClient } = require('./database');
                const prisma = getPrismaClient();
                await prisma.authCreds.deleteMany();
                await prisma.signalKey.deleteMany();
            }
        }
    });

    return sock;
}

module.exports = { createBaileysSocket };

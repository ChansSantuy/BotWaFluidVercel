const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { loadAuthState } = require('./auth-state');
const { logConnectionEvent } = require('./worker-lock');

async function createBaileysSocket(workerId, options = {}) {
    const { state, saveCreds } = await loadAuthState();
    
    const logger = pino({ 
        level: 'silent'
    });

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: state.keys
        },
        logger,
        printQRInTerminal: false,
        browser: ['Knightbot', 'Chrome', '121.0.0'],
        ...options,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('[BAILEYS] QR Code generated:');
            qrcode.generate(qr, { small: true });
            await logConnectionEvent(workerId, 'QR_GENERATED');
        }

        if (connection === 'connecting') {
            await logConnectionEvent(workerId, 'BAILEYS_CONNECTING');
            console.log('[BAILEYS] Connecting...');
        } else if (connection === 'open') {
            await logConnectionEvent(workerId, 'BAILEYS_CONNECTED');
            console.log('[BAILEYS] Connection opened successfully');
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            const reason = statusCode || 'UNKNOWN';
            
            await logConnectionEvent(workerId, 'BAILEYS_DISCONNECTED', {
                disconnectReason: reason.toString(),
                shouldReconnect,
            });

            console.log(`[BAILEYS] Connection closed: ${reason}, reconnect: ${shouldReconnect}`);
            
            if (statusCode === DisconnectReason.loggedOut) {
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

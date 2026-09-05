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

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            const reason = lastDisconnect?.error?.output?.statusCode || 'UNKNOWN';
            
            await logConnectionEvent(workerId, 'BAILEYS_DISCONNECTED', {
                disconnectReason: reason.toString(),
                shouldReconnect,
            });

            console.log(`[BAILEYS] Connection closed: ${reason}, reconnect: ${shouldReconnect}`);
        } else if (connection === 'open') {
            await logConnectionEvent(workerId, 'BAILEYS_CONNECTED');
            console.log('[BAILEYS] Connection opened successfully');
        } else if (connection === 'connecting') {
            await logConnectionEvent(workerId, 'BAILEYS_CONNECTING');
            console.log('[BAILEYS] Connecting...');
        }
    });

    return sock;
}

module.exports = { createBaileysSocket };

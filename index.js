/**
 * index.js — Entry point WhatsApp Bot
 *
 * Lifecycle:
 *  1. Inisialisasi Prisma → NeonDB
 *  2. Cek session (NeonDB auth state)
 *  3. Jika belum ada session → menu pairing (code / QR)
 *  4. Acquire worker lock
 *  5. Connect Baileys
 *  6. Heartbeat + deadline-aware shutdown
 *  7. Graceful disconnect → release lock → log event
 */

'use strict';

require('dotenv').config();

const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay,
} = require('@whiskeysockets/baileys');

const { Boom }        = require('@hapi/boom');
const { PrismaClient} = require('@prisma/client');
const pino            = require('pino');
const readline        = require('readline');
const qrcode          = require('qrcode-terminal');

const log                          = require('./lib/logger');
const { useNeonAuthState }         = require('./lib/neonAuthState');
const { WorkerLock }               = require('./lib/workerLock');
const { handleMessages }           = require('./main');
const { botName }                  = require('./settings');

// ─── Prisma client (singleton) ────────────────────────────────────────────────
const prisma = new PrismaClient({
    log: [],   // silent — kita handle logging sendiri
});

// ─── helper readline ──────────────────────────────────────────────────────────
function ask(prompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); }));
}

// ─── log event ke NeonDB ──────────────────────────────────────────────────────
async function logEvent(workerId, event, disconnectReason = null, metadata = null) {
    try {
        await prisma.connectionEvent.create({
            data: {
                workerId,
                event,
                disconnectReason,
                metadata: metadata ? JSON.stringify(metadata) : null,
            },
        });
    } catch (err) {
        log.error('Gagal menulis connection event', err);
    }
}

// ─── cek apakah session sudah tersimpan di NeonDB ────────────────────────────
async function hasExistingSession() {
    try {
        const row = await prisma.authCreds.findUnique({ where: { id: 1 } });
        return !!row;
    } catch {
        return false;
    }
}

// ─── menu pilihan pairing ─────────────────────────────────────────────────────
async function choosePairingMethod() {
    log.banner(`${botName} — Setup`);
    console.log('  Pilih metode untuk menghubungkan bot ke WhatsApp:\n');
    console.log('    [1]  Pairing Code  — masukkan kode di WhatsApp');
    console.log('    [2]  QR Code       — scan lewat kamera\n');

    let choice = '';
    while (!['1', '2'].includes(choice)) {
        choice = await ask('  Pilihan (1 / 2): ');
        if (!['1', '2'].includes(choice)) log.warn('Masukkan 1 atau 2.');
    }
    return choice;
}

// ─── minta nomor WA (harus diawali 62) ───────────────────────────────────────
async function askPhoneNumber() {
    let phone = '';
    while (true) {
        phone = await ask('  Nomor WhatsApp (contoh: 628123456789): ');
        phone = phone.replace(/\D/g, '');
        if (/^62\d{8,13}$/.test(phone)) break;
        log.warn('Nomor tidak valid. Harus diawali 62, 10–15 digit total.');
    }
    return phone;
}

// ─── fungsi utama ─────────────────────────────────────────────────────────────
async function startBot() {
    log.banner(botName);

    // ── 1. Koneksi ke NeonDB ──────────────────────────────────────────────────
    log.db('Menghubungkan ke NeonDB...');
    try {
        await prisma.$connect();
        log.ok('NeonDB terhubung');
    } catch (err) {
        log.error('Gagal terhubung ke NeonDB', err);
        process.exit(1);
    }

    // ── 2. Cek & pilih metode pairing ─────────────────────────────────────────
    const sessionExists = await hasExistingSession();
    let usePairingCode  = false;
    let phoneNumber     = null;

    if (!sessionExists) {
        log.info('Belum ada session tersimpan di NeonDB');
        const choice = await choosePairingMethod();
        usePairingCode = (choice === '1');
        if (usePairingCode) {
            phoneNumber = await askPhoneNumber();
        } else {
            log.info('QR Code akan ditampilkan setelah terhubung ke WhatsApp...');
        }
    } else {
        log.ok('Session ditemukan di NeonDB — langsung connect');
    }

    // ── 3. Worker lock ────────────────────────────────────────────────────────
    const lock = new WorkerLock(prisma);
    log.lock(`Worker ID: ${lock.id}`);

    const acquired = await lock.acquire();
    if (!acquired) {
        log.error('Tidak dapat mengambil worker lock — ada worker lain yang aktif');
        await prisma.$disconnect();
        process.exit(1);
    }

    await logEvent(lock.id, 'LOCK_ACQUIRED');

    // ── 4. Load auth state dari NeonDB ────────────────────────────────────────
    log.db('Memuat auth state dari NeonDB...');
    const { state, saveCreds } = await useNeonAuthState(prisma);

    // ── 5. Buat socket Baileys ────────────────────────────────────────────────
    const { version } = await fetchLatestBaileysVersion();
    log.info(`Baileys version: ${version.join('.')}`);

    const sock = makeWASocket({
        version,
        logger            : pino({ level: 'silent' }),
        printQRInTerminal : false,   // kita handle sendiri lewat qrcode-terminal
        auth: {
            creds : state.creds,
            keys  : makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        markOnlineOnConnect   : true,
        syncFullHistory       : false,
        defaultQueryTimeoutMs : 60_000,
        connectTimeoutMs      : 60_000,
        keepAliveIntervalMs   : 10_000,
    });

    await logEvent(lock.id, 'BAILEYS_CONNECTING');

    // ── 6. Simpan creds setiap ada update ─────────────────────────────────────
    sock.ev.on('creds.update', saveCreds);

    // ── 7. Handle connection update ───────────────────────────────────────────
    // Flag agar pairing code hanya di-request sekali
    let pairingRequested = false;
    // Flag untuk menghindari rekursi shutdown
    let isShuttingDown   = false;

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {

        // ── Tampilkan QR (mode QR) ─────────────────────────────────────────────
        if (qr && !usePairingCode) {
            console.clear();
            log.banner('Scan QR Code');
            console.log('  WhatsApp → Perangkat Tertaut → Tautkan Perangkat → Scan QR\n');
            qrcode.generate(qr, { small: true });
            console.log('');
        }

        // ── Request pairing code (mode code, satu kali) ───────────────────────
        if (usePairingCode && connection === 'connecting' && !pairingRequested && !sock.authState.creds.registered) {
            pairingRequested = true;
            await delay(3_000);
            try {
                const code      = await sock.requestPairingCode(phoneNumber);
                const formatted = code.match(/.{1,4}/g)?.join('-') || code;

                log.banner('Pairing Code');
                console.log(`  Kode    : ${formatted}`);
                console.log('  Cara    : WhatsApp → Perangkat Tertaut');
                console.log('            → Tautkan dengan Nomor Telepon');
                console.log('            → Masukkan kode di atas\n');
            } catch (err) {
                log.error('Gagal mendapatkan pairing code', err);
                await gracefulShutdown('PAIRING_FAILED');
            }
        }

        if (connection === 'connecting') {
            log.conn('Menghubungkan ke WhatsApp...');
        }

        // ── Berhasil terhubung ─────────────────────────────────────────────────
        if (connection === 'open') {
            log.ok('WhatsApp terhubung!');
            log.info('Kirim "ping" → bot akan membalas "pong"');
            log.divider();
            await logEvent(lock.id, 'BAILEYS_CONNECTED');
        }

        // ── Koneksi terputus ───────────────────────────────────────────────────
        if (connection === 'close') {
            const statusCode      = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            const reason          = DisconnectReason[statusCode] || String(statusCode);

            await logEvent(lock.id, 'GRACEFUL_DISCONNECT', reason);

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                log.warn('Session logout. Menghapus auth state dari NeonDB...');
                try {
                    await prisma.authCreds.deleteMany();
                    await prisma.signalKey.deleteMany();
                    log.ok('Auth state dihapus. Jalankan ulang bot untuk login kembali.');
                } catch (err) {
                    log.error('Gagal menghapus auth state', err);
                }
                await lock.release();
                await logEvent(lock.id, 'LOCK_RELEASED', 'LOGGED_OUT');
                await prisma.$disconnect();
                process.exit(0);
            }

            if (shouldReconnect && !isShuttingDown) {
                log.info(`Reconnect dalam 5 detik... (reason: ${reason})`);
                await logEvent(lock.id, 'RECONNECT', reason);
                await delay(5_000);
                // Release lock lama, biarkan startBot() acquire ulang
                await lock.release();
                await prisma.$disconnect();
                startBot();
            }
        }
    });

    // ── 8. Handle pesan masuk ─────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            await handleMessages(sock, chatUpdate);
        } catch (err) {
            log.error('Error saat handle pesan', err);
        }
    });

    // ── 9. Graceful shutdown helper ───────────────────────────────────────────
    async function gracefulShutdown(reason = 'SHUTDOWN') {
        if (isShuttingDown) return;
        isShuttingDown = true;

        log.warn(`Graceful shutdown dimulai (${reason})...`);
        await logEvent(lock.id, 'GRACEFUL_DISCONNECT', reason);

        try { sock.end(); } catch {}

        await lock.release();
        await logEvent(lock.id, 'LOCK_RELEASED', reason);

        await prisma.$disconnect();
        log.ok('Shutdown selesai.');
        process.exit(0);
    }

    // ── 10. Tangkap signal OS ─────────────────────────────────────────────────
    process.once('SIGINT',  () => gracefulShutdown('SIGINT'));
    process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

    return sock;
}

// ─── jalankan ─────────────────────────────────────────────────────────────────
startBot().catch(async (err) => {
    log.error('Fatal error saat start bot', err);
    try { await prisma.$disconnect(); } catch {}
    process.exit(1);
});

process.on('uncaughtException',  (err) => log.error('Uncaught Exception', err));
process.on('unhandledRejection', (err) => log.error('Unhandled Rejection', err));

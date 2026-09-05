/**
 * lib/neonAuthState.js
 *
 * Pengganti useMultiFileAuthState dari Baileys.
 * Menyimpan credentials dan signal keys ke NeonDB (PostgreSQL via Prisma).
 *
 * API yang dikembalikan identik dengan useMultiFileAuthState:
 *   { state: { creds, keys }, saveCreds }
 *
 * Prinsip:
 *  - AuthCreds: satu baris, id=1, kolom data (JSON string).
 *  - SignalKey:  baris per key, id = "{type}__{keyId}" (karakter / → __, : → -).
 *  - Setiap write bersifat upsert (atomic).
 */

'use strict';

const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const log = require('./logger');

// ─── helper encode / decode key id ────────────────────────────────────────────
function encodeKeyId(type, keyId) {
    // Simpan sebagai "type__keyId" — ganti karakter yang tidak aman untuk DB id
    return `${type}__${String(keyId).replace(/\//g, '__').replace(/:/g, '-')}`;
}

function decodeKeyId(id) {
    const sep = id.indexOf('__');
    const type  = id.slice(0, sep);
    const keyId = id.slice(sep + 2).replace(/--/g, ':').replace(/__/g, '/');
    return { type, keyId };
}

// ─── main export ──────────────────────────────────────────────────────────────
async function useNeonAuthState(prisma) {
    // ── load credentials ───────────────────────────────────────────────────────
    async function loadCreds() {
        try {
            const row = await prisma.authCreds.findUnique({ where: { id: 1 } });
            if (!row) return initAuthCreds();
            return JSON.parse(row.data, BufferJSON.reviver);
        } catch (err) {
            log.error('neonAuthState: gagal load creds, gunakan creds baru', err);
            return initAuthCreds();
        }
    }

    // ── save credentials (atomic upsert) ──────────────────────────────────────
    async function saveCreds() {
        try {
            const json = JSON.stringify(state.creds, BufferJSON.replacer);
            await prisma.authCreds.upsert({
                where  : { id: 1 },
                update : { data: json },
                create : { id: 1, data: json },
            });
            log.db('Credentials disimpan ke NeonDB');
        } catch (err) {
            log.error('neonAuthState: gagal simpan creds', err);
            throw err;
        }
    }

    // ── keys object (Baileys signal key store interface) ──────────────────────
    const keys = {
        // get({ "pre-key": [1,2], "session": ["id1"] })
        async get(types, ids) {
            const result = {};
            for (const type of types) {
                result[type] = {};
                for (const id of ids) {
                    const dbId = encodeKeyId(type, id);
                    try {
                        const row = await prisma.signalKey.findUnique({ where: { id: dbId } });
                        if (row) {
                            const parsed = JSON.parse(row.data, BufferJSON.reviver);
                            result[type][id] = parsed;
                        }
                    } catch (err) {
                        log.error(`neonAuthState: gagal load key ${dbId}`, err);
                    }
                }
            }
            return result;
        },

        // set({ "pre-key": { 1: {...}, 2: {...} }, ... })
        async set(data) {
            for (const [type, ids] of Object.entries(data)) {
                for (const [id, value] of Object.entries(ids || {})) {
                    const dbId = encodeKeyId(type, id);
                    try {
                        if (value == null) {
                            // null = hapus key
                            await prisma.signalKey.deleteMany({ where: { id: dbId } });
                        } else {
                            const json = JSON.stringify(value, BufferJSON.replacer);
                            await prisma.signalKey.upsert({
                                where  : { id: dbId },
                                update : { data: json },
                                create : { id: dbId, data: json },
                            });
                        }
                    } catch (err) {
                        log.error(`neonAuthState: gagal set key ${dbId}`, err);
                    }
                }
            }
        },
    };

    // ── inisialisasi state ─────────────────────────────────────────────────────
    const creds = await loadCreds();
    const state = { creds, keys };

    log.db('NeonDB auth state siap');

    return { state, saveCreds };
}

module.exports = { useNeonAuthState };

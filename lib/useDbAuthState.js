/**
 * lib/useDbAuthState.js
 *
 * Pengganti useMultiFileAuthState dari Baileys.
 * Semua session data (creds + signal keys) disimpan di PostgreSQL
 * via Prisma v7 + @prisma/adapter-pg.
 *
 * Kontrak identik dengan useMultiFileAuthState:
 *   { state: { creds, keys: { get, set } }, saveCreds }
 */

'use strict';

require('dotenv/config');

const { PrismaPg }                  = require('@prisma/adapter-pg');
const { PrismaClient }              = require('@prisma/client');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { proto }                     = require('@whiskeysockets/baileys');

// ── Buat Prisma client dengan driver adapter PrismaPg ─────────────────────────
function createPrisma() {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    return new PrismaClient({ adapter });
}

// Singleton — satu instance untuk seluruh lifetime bot
const prisma = createPrisma();

// ── Helper: normalise nama key (sama seperti fixFileName di Baileys) ──────────
// "/" → "__"   ":" → "-"
const fixKey = (raw) => raw?.replace(/\//g, '__')?.replace(/:/g, '-') ?? raw;

// ── ID gabungan untuk tabel signal_keys: "{type}__{keyId}" ───────────────────
const buildId = (type, keyId) => fixKey(`${type}__${keyId}`);

// ── Baca satu signal key dari DB ──────────────────────────────────────────────
async function readSignalKey(type, keyId) {
    try {
        const row = await prisma.signalKey.findUnique({
            where: { id: buildId(type, keyId) }
        });
        if (!row) return null;

        let value = JSON.parse(row.data, BufferJSON.reviver);

        // Baileys expects AppStateSyncKeyData sebagai proto object
        if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }

        return value;
    } catch {
        return null;
    }
}

// ── Tulis satu signal key ke DB ───────────────────────────────────────────────
async function writeSignalKey(type, keyId, value) {
    const id   = buildId(type, keyId);
    const data = JSON.stringify(value, BufferJSON.replacer);

    await prisma.signalKey.upsert({
        where  : { id },
        update : { data },
        create : { id, data }
    });
}

// ── Hapus satu signal key dari DB ─────────────────────────────────────────────
async function deleteSignalKey(type, keyId) {
    try {
        await prisma.signalKey.delete({
            where: { id: buildId(type, keyId) }
        });
    } catch {
        // baris tidak ada → tidak masalah
    }
}

// ── Cek apakah creds sudah ada di DB (dipakai index.js) ──────────────────────
async function hasExistingSession() {
    try {
        const row = await prisma.authCreds.findUnique({ where: { id: 1 } });
        return !!row;
    } catch {
        return false;
    }
}

// ── Hapus seluruh session dari DB (saat logout) ───────────────────────────────
async function clearSession() {
    await prisma.authCreds.deleteMany();
    await prisma.signalKey.deleteMany();
}

// ── Main: useDbAuthState ──────────────────────────────────────────────────────
async function useDbAuthState() {
    // Baca creds dari DB, fallback ke fresh creds jika belum ada
    let creds;
    try {
        const row = await prisma.authCreds.findUnique({ where: { id: 1 } });
        creds = row
            ? JSON.parse(row.data, BufferJSON.reviver)
            : initAuthCreds();
    } catch {
        creds = initAuthCreds();
    }

    return {
        state: {
            creds,

            keys: {
                /**
                 * get(type, ids) → { [id]: value }
                 * Dipanggil Baileys saat butuh membaca kunci signal.
                 */
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            data[id] = await readSignalKey(type, id);
                        })
                    );
                    return data;
                },

                /**
                 * set(data) → void
                 * data = { [category]: { [id]: value | null } }
                 * null/undefined berarti hapus key tersebut.
                 */
                set: async (data) => {
                    const tasks = [];
                    for (const type in data) {
                        for (const keyId in data[type]) {
                            const value = data[type][keyId];
                            tasks.push(
                                value
                                    ? writeSignalKey(type, keyId, value)
                                    : deleteSignalKey(type, keyId)
                            );
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },

        /**
         * saveCreds() — dipanggil Baileys setiap creds berubah
         */
        saveCreds: async () => {
            const data = JSON.stringify(creds, BufferJSON.replacer);
            await prisma.authCreds.upsert({
                where  : { id: 1 },
                update : { data },
                create : { id: 1, data }
            });
        }
    };
}

module.exports = { useDbAuthState, hasExistingSession, clearSession };

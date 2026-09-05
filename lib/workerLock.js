/**
 * lib/workerLock.js
 *
 * Distributed lock via NeonDB.
 * Hanya satu worker yang boleh menjadi active owner koneksi WhatsApp.
 *
 * Tabel: worker_lock (via Prisma model WorkerLock)
 *
 * Lifecycle:
 *   acquire()  → coba ambil lock. Return true jika berhasil, false jika sudah ada owner lain.
 *   heartbeat() → perbarui expires_at selama worker masih hidup.
 *   release()  → tandai lock sebagai RELEASED dan hapus lease.
 *
 * Lock dianggap expired jika:
 *   expiresAt < NOW()
 * Artinya worker lain boleh mengambil alih.
 */

'use strict';

const { randomUUID } = require('crypto');
const log = require('./logger');

// Durasi lease default: 90 detik. Heartbeat setiap 30 detik.
const LEASE_DURATION_MS  = 90_000;
const HEARTBEAT_INTERVAL = 30_000;

class WorkerLock {
    /**
     * @param {import('@prisma/client').PrismaClient} prisma
     * @param {string} [workerId] - ID unik worker ini. Auto-generate jika tidak diberikan.
     */
    constructor(prisma, workerId) {
        this.prisma    = prisma;
        this.workerId  = workerId || `worker-${randomUUID().slice(0, 8)}`;
        this._timer    = null;
        this._acquired = false;
    }

    // ── Hitung waktu expiry dari sekarang ──────────────────────────────────────
    _nextExpiry() {
        return new Date(Date.now() + LEASE_DURATION_MS);
    }

    // ── Coba acquire lock ──────────────────────────────────────────────────────
    async acquire() {
        try {
            const now = new Date();

            // Cek apakah ada lock aktif milik worker lain
            const existing = await this.prisma.workerLock.findFirst({
                where: { status: 'ACTIVE' },
            });

            if (existing) {
                const expired = existing.expiresAt < now;
                if (!expired && existing.workerId !== this.workerId) {
                    log.lock(`Lock dipegang oleh ${existing.workerId} (expires: ${existing.expiresAt.toISOString()})`);
                    log.warn(`Worker ${this.workerId} DITOLAK — lock belum expired`);
                    return false;
                }

                // Lock expired atau milik worker ini sendiri → ambil alih
                if (expired) {
                    log.lock(`Lock expired dari ${existing.workerId}, mengambil alih...`);
                }

                await this.prisma.workerLock.update({
                    where: { id: existing.id },
                    data: {
                        workerId    : this.workerId,
                        status      : 'ACTIVE',
                        heartbeatAt : now,
                        expiresAt   : this._nextExpiry(),
                    },
                });
            } else {
                // Belum ada lock sama sekali → buat baru
                await this.prisma.workerLock.create({
                    data: {
                        workerId    : this.workerId,
                        status      : 'ACTIVE',
                        heartbeatAt : now,
                        expiresAt   : this._nextExpiry(),
                    },
                });
            }

            this._acquired = true;
            log.lock(`Lock diperoleh oleh ${this.workerId}`);
            this._startHeartbeat();
            return true;

        } catch (err) {
            log.error('workerLock: gagal acquire lock', err);
            return false;
        }
    }

    // ── Perbarui heartbeat + expiry ────────────────────────────────────────────
    async heartbeat() {
        if (!this._acquired) return;
        try {
            await this.prisma.workerLock.updateMany({
                where: { workerId: this.workerId, status: 'ACTIVE' },
                data: {
                    heartbeatAt : new Date(),
                    expiresAt   : this._nextExpiry(),
                },
            });
            log.lock(`Heartbeat dari ${this.workerId}`);
        } catch (err) {
            log.error('workerLock: gagal heartbeat', err);
        }
    }

    // ── Release lock ───────────────────────────────────────────────────────────
    async release() {
        this._stopHeartbeat();
        if (!this._acquired) return;
        try {
            await this.prisma.workerLock.updateMany({
                where: { workerId: this.workerId, status: 'ACTIVE' },
                data: {
                    status    : 'RELEASED',
                    expiresAt : new Date(), // expired sekarang agar worker lain bisa masuk
                },
            });
            this._acquired = false;
            log.lock(`Lock dirilis oleh ${this.workerId}`);
        } catch (err) {
            log.error('workerLock: gagal release lock', err);
        }
    }

    // ── Cek apakah worker ini masih pemegang lock ──────────────────────────────
    async isOwner() {
        try {
            const row = await this.prisma.workerLock.findFirst({
                where: { workerId: this.workerId, status: 'ACTIVE' },
            });
            return !!row && row.expiresAt > new Date();
        } catch {
            return false;
        }
    }

    // ── Internal: jalankan heartbeat timer ────────────────────────────────────
    _startHeartbeat() {
        this._stopHeartbeat();
        this._timer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL);
        // Unref agar timer tidak menghalangi process exit
        if (this._timer.unref) this._timer.unref();
    }

    _stopHeartbeat() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    get id() { return this.workerId; }
}

module.exports = { WorkerLock, LEASE_DURATION_MS, HEARTBEAT_INTERVAL };

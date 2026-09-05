const { getPrismaClient } = require('./database');

const LEASE_DURATION_MS = 30000; // 30 seconds
const HEARTBEAT_INTERVAL_MS = 10000; // 10 seconds

async function acquireLock(workerId) {
    const prisma = getPrismaClient();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LEASE_DURATION_MS);

    try {
        await prisma.$transaction(async (tx) => {
            const existingLock = await tx.workerLock.findFirst({
                where: { status: 'ACTIVE' },
            });

            if (existingLock) {
                if (now < new Date(existingLock.expiresAt)) {
                    throw new Error('LOCK_DENIED');
                }
                await tx.workerLock.updateMany({
                    where: { id: existingLock.id },
                    data: { status: 'EXPIRED' },
                });
            }

            await tx.workerLock.create({
                data: {
                    workerId,
                    status: 'ACTIVE',
                    heartbeatAt: now,
                    expiresAt,
                },
            });
        });

        return { success: true };
    } catch (error) {
        if (error.message === 'LOCK_DENIED') {
            return { success: false, reason: 'LOCK_DENIED' };
        }
        throw error;
    }
}

async function updateHeartbeat(workerId) {
    const prisma = getPrismaClient();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LEASE_DURATION_MS);

    await prisma.workerLock.updateMany({
        where: {
            workerId,
            status: 'ACTIVE',
        },
        data: {
            heartbeatAt: now,
            expiresAt,
        },
    });
}

async function releaseLock(workerId) {
    const prisma = getPrismaClient();
    await prisma.workerLock.updateMany({
        where: {
            workerId,
            status: 'ACTIVE',
        },
        data: {
            status: 'RELEASED',
        },
    });
}

async function logConnectionEvent(workerId, event, metadata = {}) {
    const prisma = getPrismaClient();
    await prisma.connectionEvent.create({
        data: {
            workerId,
            event,
            disconnectReason: metadata.disconnectReason || null,
            metadata: JSON.stringify(metadata),
        },
    });
}

module.exports = {
    acquireLock,
    updateHeartbeat,
    releaseLock,
    logConnectionEvent,
    HEARTBEAT_INTERVAL_MS,
};

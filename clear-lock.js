const { getPrismaClient } = require('./lib/database');

async function clearLock() {
    const prisma = getPrismaClient();
    await prisma.workerLock.deleteMany();
    console.log('Lock cleared');
    await prisma.$disconnect();
}

clearLock();

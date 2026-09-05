const { getPrismaClient } = require('./lib/database');

async function fix() {
    const prisma = getPrismaClient();
    
    try {
        await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS worker_lock_status_key');
        console.log('Dropped index worker_lock_status_key');
    } catch (err) {
        console.log('Index not found or already dropped');
    }
    
    await prisma.$disconnect();
}

fix();

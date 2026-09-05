const { getPrismaClient } = require('./database');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

async function loadAuthState() {
    const prisma = getPrismaClient();
    
    let creds = initAuthCreds();
    
    try {
        const credsRecord = await prisma.authCreds.findUnique({ where: { id: 1 } });
        if (credsRecord) {
            creds = JSON.parse(credsRecord.data, BufferJSON.reviver);
        }
    } catch (err) {
        console.log('[AUTH] No existing creds, using new ones');
    }

    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const keyIds = ids.map(id => `${type}__${id}`);
                const records = await prisma.signalKey.findMany({
                    where: { id: { in: keyIds } }
                });
                
                const keys = {};
                for (const record of records) {
                    const id = record.id.split('__')[1];
                    keys[id] = JSON.parse(record.data, BufferJSON.reviver);
                }
                return keys;
            },
            set: async (data) => {
                const operations = [];
                
                for (const type in data) {
                    const keys = data[type];
                    for (const id in keys) {
                        const keyId = `${type}__${id}`;
                        const value = keys[id];
                        
                        if (value === null || value === undefined) {
                            operations.push(
                                prisma.signalKey.delete({ where: { id: keyId } }).catch(() => {})
                            );
                        } else {
                            operations.push(
                                prisma.signalKey.upsert({
                                    where: { id: keyId },
                                    create: {
                                        id: keyId,
                                        data: JSON.stringify(value, BufferJSON.replacer),
                                    },
                                    update: {
                                        data: JSON.stringify(value, BufferJSON.replacer),
                                    },
                                })
                            );
                        }
                    }
                }
                
                await Promise.all(operations);
            }
        }
    };

    const saveCreds = async () => {
        if (state.creds) {
            await prisma.authCreds.upsert({
                where: { id: 1 },
                create: {
                    id: 1,
                    data: JSON.stringify(state.creds, BufferJSON.replacer),
                },
                update: {
                    data: JSON.stringify(state.creds, BufferJSON.replacer),
                },
            });
        }
    };

    return { state, saveCreds };
}

module.exports = { loadAuthState };

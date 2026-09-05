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
                const keys = {};
                for (const id of ids) {
                    const keyId = `${type}__${id}`;
                    try {
                        const record = await prisma.signalKey.findUnique({ where: { id: keyId } });
                        if (record) {
                            keys[id] = JSON.parse(record.data, BufferJSON.reviver);
                        }
                    } catch (err) {
                        // Key not found, skip
                    }
                }
                return keys;
            },
            set: async (data) => {
                const promises = [];
                for (const type in data) {
                    const keys = data[type];
                    for (const id in keys) {
                        const keyId = `${type}__${id}`;
                        const value = keys[id];
                        if (value === null || value === undefined) {
                            promises.push(
                                prisma.signalKey.delete({ where: { id: keyId } }).catch(() => {})
                            );
                        } else {
                            promises.push(
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
                await Promise.all(promises);
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

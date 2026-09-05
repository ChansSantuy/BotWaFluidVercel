/**
 * main.js - Message handler
 * Hanya menangani pesan "ping" → membalas "pong"
 */

const chalk = require('chalk');

async function handleMessages(sock, messageUpdate) {
    try {
        const { messages, type } = messageUpdate;
        if (type !== 'notify') return;

        const message = messages[0];
        if (!message?.message) return;

        const chatId   = message.key.remoteJid;
        const sender   = message.key.participant || message.key.remoteJid;
        const isGroup  = chatId.endsWith('@g.us');

        // Ambil teks pesan dari berbagai tipe
        const text = (
            message.message?.conversation ||
            message.message?.extendedTextMessage?.text ||
            message.message?.imageMessage?.caption ||
            message.message?.videoMessage?.caption ||
            ''
        ).trim().toLowerCase();

        if (!text) return;

        // Log setiap pesan masuk
        const from   = isGroup ? chalk.blue('[Group]') : chalk.magenta('[DM]');
        const who    = chalk.gray(sender.split('@')[0]);
        const msg    = chalk.white(text);
        console.log(`${chalk.cyan('📨')} ${from} ${who} ${chalk.gray('→')} ${msg}`);

        // Balas "pong" jika pesan adalah "ping"
        if (text === 'ping') {
            console.log(chalk.green(`  ↳ 🏓 Membalas "pong" ke ${sender.split('@')[0]}`));
            await sock.sendMessage(chatId, { text: 'pong' }, { quoted: message });
        }

    } catch (err) {
        console.error(chalk.red('❌ Error di handleMessages:'), err);
    }
}

module.exports = { handleMessages };

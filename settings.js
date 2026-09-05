// settings.js — konfigurasi bot
require('dotenv').config();

module.exports = {
    // Nama bot yang ditampilkan di terminal
    botName: 'SansDev Bot',

    // Nomor owner (format internasional tanpa +, contoh: 628xxx)
    ownerNumber: process.env.OWNER_NUMBER || '628xxxxxxxxxx',
};

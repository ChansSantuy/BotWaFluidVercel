/**
 * lib/logger.js
 * Wrapper chalk untuk terminal output yang konsisten.
 */

'use strict';

const chalk = require('chalk');

const tag = {
    info  : chalk.bgCyan.black(' INFO '),
    ok    : chalk.bgGreen.black(' OK   '),
    warn  : chalk.bgYellow.black(' WARN '),
    error : chalk.bgRed.white(' ERR  '),
    db    : chalk.bgMagenta.white(' DB   '),
    lock  : chalk.bgBlue.white(' LOCK '),
    conn  : chalk.bgWhite.black(' CONN '),
    event : chalk.bgGray.white(' EVT  '),
};

function ts() {
    return chalk.dim(new Date().toISOString());
}

const log = {
    info  : (msg) => console.log(`${ts()} ${tag.info}  ${msg}`),
    ok    : (msg) => console.log(`${ts()} ${tag.ok}  ${chalk.green(msg)}`),
    warn  : (msg) => console.warn(`${ts()} ${tag.warn}  ${chalk.yellow(msg)}`),
    error : (msg, err) => {
        console.error(`${ts()} ${tag.error}  ${chalk.red(msg)}`);
        if (err) console.error(chalk.dim(err?.stack || err));
    },
    db    : (msg) => console.log(`${ts()} ${tag.db}  ${chalk.magenta(msg)}`),
    lock  : (msg) => console.log(`${ts()} ${tag.lock}  ${chalk.blue(msg)}`),
    conn  : (msg) => console.log(`${ts()} ${tag.conn}  ${msg}`),
    event : (msg) => console.log(`${ts()} ${tag.event}  ${chalk.gray(msg)}`),

    // Separator dekoratif
    banner: (title) => {
        const line = '═'.repeat(42);
        console.log('');
        console.log(chalk.cyan(`╔${line}╗`));
        console.log(chalk.cyan(`║  ${chalk.bold(title.padEnd(40))}║`));
        console.log(chalk.cyan(`╚${line}╝`));
        console.log('');
    },

    divider: () => console.log(chalk.dim('─'.repeat(46))),
};

module.exports = log;

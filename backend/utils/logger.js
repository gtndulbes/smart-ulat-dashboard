/**
 * ============================================================
 * logger.js
 * ------------------------------------------------------------
 * Logger terpusat untuk Smart Ulat Hongkong Backend.
 *
 * Fitur:
 *   - Level: DEBUG < INFO < WARN < ERROR
 *   - Timestamp: ISO 8601
 *   - Warna terminal (ANSI) — auto-disable kalau bukan TTY
 *   - Format: [LEVEL] [timestamp] [scope] message
 *
 * Dipakai oleh:
 *   - server.js
 *   - mqtt/*.js
 *   - websocket/*.js
 *   - api/*.js
 *   - services/*.js
 *   - middleware/*.js
 *
 * Cara pakai:
 *   const logger = require('./utils/logger');
 *   logger.info('Server started');
 *   logger.warn('MQTT reconnect');
 *   logger.error('Sensor failed', { err });
 *   const log = logger.scope('MQTT');    // prefix [MQTT]
 *   log.debug('incoming message');
 * ============================================================
 */

'use strict';

const config = require('../config/config');

// ------------------------------------------------------------
// Level mapping
// ------------------------------------------------------------
const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const LEVEL_LABEL = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR'
};

// Warna ANSI per level
const LEVEL_COLOR = {
  debug: '\x1b[90m',   // gray
  info: '\x1b[36m',    // cyan
  warn: '\x1b[33m',    // yellow
  error: '\x1b[31m'    // red
};

const COLOR_RESET = '\x1b[0m';

// ------------------------------------------------------------
// Deteksi TTY (kalau output di-pipe, jangan beri warna)
// ------------------------------------------------------------
const isTTY = process.stdout.isTTY === true;

const colorize = (text, color) => {
  if (!isTTY) return text;
  return `${color}${text}${COLOR_RESET}`;
};

// ------------------------------------------------------------
// Filter level minimum dari config
// ------------------------------------------------------------
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

// ------------------------------------------------------------
// Core log function
// ------------------------------------------------------------
function write(level, scope, args) {
  if (LEVELS[level] < currentLevel) return;

  const timestamp = new Date().toISOString();
  const label = LEVEL_LABEL[level];
  const color = LEVEL_COLOR[level];
  const scopeStr = scope ? ` [${scope}]` : '';

  const header = colorize(`[${label}]`, color);
  const ts = colorize(timestamp, '\x1b[90m');
  const sc = scope ? colorize(scopeStr, '\x1b[35m') : '';

  // Kalau ada banyak argumen, gunakan console.log agar objek di-render
  // dengan baik oleh Node.js inspector.
  if (level === 'error') {
    console.error(`${header} ${ts}${sc}`, ...args);
  } else if (level === 'warn') {
    console.warn(`${header} ${ts}${sc}`, ...args);
  } else {
    console.log(`${header} ${ts}${sc}`, ...args);
  }
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------
const logger = {
  /**
   * Debug — hanya tampil kalau LOG_LEVEL=debug
   */
  debug(...args) {
    write('debug', null, args);
  },

  /**
   * Info — operasi normal
   */
  info(...args) {
    write('info', null, args);
  },

  /**
   * Warn — sesuatu yang perlu diperhatikan
   */
  warn(...args) {
    write('warn', null, args);
  },

  /**
   * Error — kegagalan, tapi server tetap jalan
   */
  error(...args) {
    write('error', null, args);
  },

  /**
   * Buat logger dengan scope tertentu, misal:
   *   const log = logger.scope('MQTT');
   *   log.info('connected');   // → [INFO] [timestamp] [MQTT] connected
   */
  scope(name) {
    const s = String(name || '').trim();
    return {
      debug: (...a) => write('debug', s, a),
      info:  (...a) => write('info',  s, a),
      warn:  (...a) => write('warn',  s, a),
      error: (...a) => write('error', s, a)
    };
  },

  /**
   * Level yang sedang aktif (untuk debugging logger sendiri)
   */
  currentLevel: config.logLevel,

  /**
   * Level map (read-only) — kadang berguna untuk unit test
   */
  LEVELS
};

// ------------------------------------------------------------
// Export
// ------------------------------------------------------------
module.exports = logger;
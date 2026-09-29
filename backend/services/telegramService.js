/**
 * ============================================================
 * telegramService.js
 * ------------------------------------------------------------
 * Kirim alert ke Telegram via Bot API.
 *
 * Fitur:
 *   - HTML formatting (bold, italic)
 *   - Emoji per severity
 *   - Retry + timeout
 *   - Rate limit (jangan spam)
 *   - Stats
 * ============================================================
 */

'use strict';

const https = require('https');
const { URL } = require('url');

const config = require('../config/config');
const logger = require('../utils/logger');

const log = logger.scope('TELEGRAM');

const stats = {
  sent: 0,
  success: 0,
  failed: 0,
  rateLimited: 0,
  lastSentAt: null,
  lastErrorAt: null,
  lastErrorMessage: null
};

// Rate limit state
const lastSentByKey = new Map(); // key → timestamp
const RATE_LIMIT_WINDOW_MS = 30 * 1000;

// ------------------------------------------------------------
function _escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _emoji(severity) {
  const s = String(severity || '').toUpperCase();
  if (s === 'CRITICAL') return '🚨';
  if (s === 'WARNING')  return '⚠️';
  if (s === 'INFO')     return 'ℹ️';
  return '•';
}

function _formatTime(iso) {
  try {
    const d = new Date(iso || Date.now());
    return d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  } catch {
    return new Date().toISOString();
  }
}

// ------------------------------------------------------------
function postJSON(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);

    const req = https.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ------------------------------------------------------------
/**
 * Kirim alert ke Telegram.
 * @param {object} alert — { severity, title, message, timestamp }
 * @param {object} [opts] — { key, force }
 */
async function sendAlert(alert, opts = {}) {
  if (!config.telegram.enabled) {
    return { success: false, skipped: true, reason: 'Telegram belum dikonfigurasi' };
  }

  const severity = String(alert.severity || 'INFO').toUpperCase();

  // Skip INFO supaya tidak spam
  if (severity === 'INFO' && !opts.force) {
    return { success: false, skipped: true, reason: 'INFO tidak dikirim ke Telegram' };
  }

  // Rate limit — dedup per key (severity+title)
  const key = opts.key || `${severity}::${alert.title}`;
  const now = Date.now();
  const last = lastSentByKey.get(key) || 0;
  if (!opts.force && now - last < RATE_LIMIT_WINDOW_MS) {
    stats.rateLimited += 1;
    log.debug(`Rate limited: ${key} (${Math.round((now - last) / 1000)}s ago)`);
    return { success: false, skipped: true, reason: 'rate_limited' };
  }

  if (config.simulationMode) {
    log.debug(`[SIM] Telegram alert: [${severity}] ${alert.title}`);
    lastSentByKey.set(key, now);
    return { success: true, simulated: true };
  }

  const emoji = _emoji(severity);
  const text = [
    `🚨 <b>SMART ULAT HONGKONG</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `${emoji} <b>[${_escapeHtml(severity)}] ${_escapeHtml(alert.title)}</b>`,
    `${_escapeHtml(alert.message)}`,
    ``,
    `🕐 ${_formatTime(alert.timestamp)}`
  ].join('\n');

  const url = `${config.telegram.apiBase}/bot${config.telegram.botToken}/sendMessage`;
  const body = {
    chat_id: config.telegram.chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  stats.sent += 1;

  try {
    const res = await postJSON(url, body, 10000);
    if (res.status === 200 && res.data && res.data.ok) {
      stats.success += 1;
      stats.lastSentAt = new Date().toISOString();
      lastSentByKey.set(key, now);
      log.info(`📤 Telegram alert terkirim [${severity}] ${alert.title}`);
      return { success: true };
    }
    const err = res.data?.description || `HTTP ${res.status}`;
    stats.failed += 1;
    stats.lastErrorAt = new Date().toISOString();
    stats.lastErrorMessage = err;
    log.warn(`Telegram gagal: ${err}`);
    return { success: false, error: err };
  } catch (err) {
    stats.failed += 1;
    stats.lastErrorAt = new Date().toISOString();
    stats.lastErrorMessage = err.message;
    log.error('Telegram error:', err.message);
    return { success: false, error: err.message };
  }
}

// ------------------------------------------------------------
/**
 * Kirim pesan teks bebas (untuk testing / startup notif).
 */
async function sendMessage(text) {
  if (!config.telegram.enabled) return { success: false, skipped: true };
  if (config.simulationMode) return { success: true, simulated: true };

  const url = `${config.telegram.apiBase}/bot${config.telegram.botToken}/sendMessage`;
  try {
    const res = await postJSON(url, {
      chat_id: config.telegram.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, 10000);
    return { success: res.status === 200 && res.data?.ok };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function getStats() {
  return {
    ...stats,
    enabled: config.telegram.enabled,
    tokenConfigured: Boolean(config.telegram.botToken),
    chatIdConfigured: Boolean(config.telegram.chatId),
    rateLimitWindowSec: RATE_LIMIT_WINDOW_MS / 1000
  };
}

function resetRateLimit() {
  lastSentByKey.clear();
}

module.exports = { sendAlert, sendMessage, getStats, resetRateLimit };
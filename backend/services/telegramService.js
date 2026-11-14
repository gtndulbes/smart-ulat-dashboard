/**
 * ============================================================
 * telegramService.js
 * ------------------------------------------------------------
 * Kirim alert ke Telegram via Bot API.
 *
 * Fitur:
 *   - HTML formatting (bold, italic)
 *   - Emoji per severity
 *   - Timeout 8s + retry 1x (backoff 2s)
 *   - Circuit breaker: setelah 2x fail, skip 30s
 *   - Keep-alive agent (reuse TLS socket)
 *   - Error classification (DNS / TLS / timeout / refused)
 *   - Rate limit per alert key
 *   - Stats lengkap
 * ============================================================
 */

'use strict';

const https = require('https');
const { URL } = require('url');

const config = require('../config/config');
const logger = require('../utils/logger');

const log = logger.scope('TELEGRAM');

// ============================================================
// Konfigurasi (bisa override via .env)
// ============================================================
const TIMEOUT_MS         = parseInt(process.env.TELEGRAM_TIMEOUT_MS || '8000', 10);
const MAX_RETRIES        = parseInt(process.env.TELEGRAM_MAX_RETRIES || '1', 10);
const RETRY_BACKOFF_MS   = 2000;
const RATE_LIMIT_WINDOW_MS = 30 * 1000;
const CIRCUIT_OPEN_AFTER = 2;               // fail berapa kali sebelum buka circuit
const CIRCUIT_WINDOW_MS  = 30 * 1000;       // berapa lama circuit terbuka

// ============================================================
// Keep-alive agent — reuse TLS socket antar request
// ============================================================
const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 4,
  maxFreeSockets: 2
});

// ============================================================
// Stats
// ============================================================
const stats = {
  sent: 0,
  success: 0,
  failed: 0,
  rateLimited: 0,
  retried: 0,
  circuitSkipped: 0,
  lastSentAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  lastFailureCategory: null,
  consecutiveFailures: 0
};

// ============================================================
// Rate limit + circuit breaker state
// ============================================================
const lastSentByKey = new Map();   // key → timestamp
let lastFailureAt = 0;              // timestamp (ms)

// ============================================================
// Helper
// ============================================================
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

/**
 * Klasifikasi error → kategori yang lebih informatif.
 */
function _classifyError(err) {
  const code = err.code || '';
  const msg = String(err.message || '').toLowerCase();

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'dns';
  }
  if (code === 'ECONNREFUSED') {
    return 'refused';
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return 'reset';
  }
  if (code === 'ETIMEDOUT' || msg.includes('timeout')) {
    return 'timeout';
  }
  if (msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls')) {
    return 'tls';
  }
  return 'unknown';
}

/**
 * Peta kategori → saran fix (untuk log).
 */
function _categoryHint(cat) {
  switch (cat) {
    case 'dns':     return 'Cek DNS / nslookup api.telegram.org';
    case 'refused': return 'Port 443 diblokir (firewall / ISP)';
    case 'reset':   return 'Koneksi diputus (proxy / VPN / firewall)';
    case 'timeout': return 'Tidak bisa reach api.telegram.org dalam ' + TIMEOUT_MS + 'ms';
    case 'tls':     return 'TLS handshake gagal — Node.js terlalu lama atau CA store rusak';
    default:        return 'Error tidak dikenal — cek network & firewall';
  }
}

// ============================================================
// HTTP POST JSON (dengan timeout + agent)
// ============================================================
function postJSON(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch { return reject(new Error('URL tidak valid: ' + url)); }

    const payload = JSON.stringify(body);

    const req = https.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'SmartUlat-Backend/1.0'
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

    req.on('timeout', () => {
      const err = new Error(`Timeout ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
      reject(err);
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ============================================================
// Retry wrapper
// ============================================================
async function _postWithRetry(url, body) {
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) stats.retried += 1;
      return await postJSON(url, body, TIMEOUT_MS);
    } catch (err) {
      lastErr = err;

      // Jangan retry untuk DNS error (sia-sia)
      if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') break;

      if (attempt < MAX_RETRIES) {
        log.debug(`Retry ${attempt + 1}/${MAX_RETRIES} dalam ${RETRY_BACKOFF_MS}ms (${err.message})`);
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      }
    }
  }

  throw lastErr;
}

// ============================================================
// API: sendAlert
// ============================================================
/**
 * Kirim alert ke Telegram.
 * @param {object} alert — { severity, title, message, timestamp }
 * @param {object} [opts] — { key, force, skipCircuit }
 */
async function sendAlert(alert, opts = {}) {
  if (!config.telegram.enabled) {
    return { success: false, skipped: true, reason: 'Telegram belum dikonfigurasi' };
  }

  const severity = String(alert.severity || 'INFO').toUpperCase();

  // Skip INFO tanpa network call
  if (severity === 'INFO' && !opts.force) {
    return { success: false, skipped: true, reason: 'INFO tidak dikirim ke Telegram' };
  }

  // Rate limit per key
  const key = opts.key || `${severity}::${alert.title}`;
  const now = Date.now();
  const last = lastSentByKey.get(key) || 0;
  if (!opts.force && now - last < RATE_LIMIT_WINDOW_MS) {
    stats.rateLimited += 1;
    log.debug(`Rate limited: ${key} (${Math.round((now - last) / 1000)}s ago)`);
    return { success: false, skipped: true, reason: 'rate_limited' };
  }

  // Circuit breaker — kalau backend baru saja gagal berkali-kali, skip
  if (!opts.skipCircuit && stats.consecutiveFailures >= CIRCUIT_OPEN_AFTER
      && (now - lastFailureAt) < CIRCUIT_WINDOW_MS) {
    stats.circuitSkipped += 1;
    log.debug(`Circuit open: skip (${stats.consecutiveFailures} fail, retry in ${Math.ceil((CIRCUIT_WINDOW_MS - (now - lastFailureAt)) / 1000)}s)`);
    return { success: false, skipped: true, reason: 'circuit_open' };
  }

  // Simulation mode
  if (config.simulationMode) {
    log.debug(`[SIM] Telegram alert: [${severity}] ${alert.title}`);
    lastSentByKey.set(key, now);
    return { success: true, simulated: true };
  }

  // Compose message
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
    const res = await _postWithRetry(url, body);

    if (res.status === 200 && res.data && res.data.ok) {
      stats.success += 1;
      stats.consecutiveFailures = 0;
      stats.lastSentAt = new Date().toISOString();
      lastSentByKey.set(key, now);
      log.info(`📤 Telegram alert terkirim [${severity}] ${alert.title}`);
      return { success: true };
    }

    // HTTP 200 tapi ok=false, atau 4xx/5xx
    const errMsg = res.data?.description || `HTTP ${res.status}`;
    stats.failed += 1;
    stats.consecutiveFailures += 1;
    stats.lastErrorAt = new Date().toISOString();
    stats.lastErrorMessage = errMsg;
    stats.lastFailureCategory = 'api_error';
    lastFailureAt = now;

    // Kalau 401/403 = token salah atau bot diblokir → log jelas
    if (res.status === 401) {
      log.error(`❌ Token bot INVALID (401 Unauthorized) — cek TELEGRAM_BOT_TOKEN di .env`);
    } else if (res.status === 403) {
      log.error(`❌ Bot diblokir user (403 Forbidden) — buka chat bot & klik Unblock`);
    } else if (res.status === 400 && errMsg.includes('chat not found')) {
      log.error(`❌ Chat ID salah (400) — cek TELEGRAM_CHAT_ID di .env`);
    } else {
      log.warn(`Telegram gagal: ${errMsg}`);
    }

    return { success: false, error: errMsg };
  } catch (err) {
    const cat = _classifyError(err);
    stats.failed += 1;
    stats.consecutiveFailures += 1;
    stats.lastErrorAt = new Date().toISOString();
    stats.lastErrorMessage = err.message;
    stats.lastFailureCategory = cat;
    lastFailureAt = now;

    log.error(`Telegram error [${cat}]: ${err.message}`);
    log.error(`  → ${_categoryHint(cat)}`);

    if (stats.consecutiveFailures === CIRCUIT_OPEN_AFTER) {
      log.warn(`⚠ Circuit OPEN: Telegram akan skip ${CIRCUIT_WINDOW_MS / 1000}s ke depan`);
    }

    return { success: false, error: err.message, category: cat };
  }
}

// ============================================================
// API: sendMessage (tanpa severity — untuk test/startup)
// ============================================================
async function sendMessage(text) {
  if (!config.telegram.enabled) {
    return { success: false, skipped: true, reason: 'Telegram belum dikonfigurasi' };
  }
  if (config.simulationMode) {
    return { success: true, simulated: true };
  }

  const url = `${config.telegram.apiBase}/bot${config.telegram.botToken}/sendMessage`;
  const body = {
    chat_id: config.telegram.chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  try {
    const res = await _postWithRetry(url, body);
    const ok = res.status === 200 && res.data?.ok;
    if (!ok) {
      const errMsg = res.data?.description || `HTTP ${res.status}`;
      log.warn(`sendMessage gagal: ${errMsg}`);
      return { success: false, error: errMsg };
    }
    stats.success += 1;
    stats.consecutiveFailures = 0;
    stats.lastSentAt = new Date().toISOString();
    return { success: true };
  } catch (err) {
    const cat = _classifyError(err);
    log.error(`sendMessage error [${cat}]: ${err.message}`);
    log.error(`  → ${_categoryHint(cat)}`);
    return { success: false, error: err.message, category: cat };
  }
}

// ============================================================
// Getter & utility
// ============================================================
function getStats() {
  return {
    ...stats,
    enabled: config.telegram.enabled,
    tokenConfigured: Boolean(config.telegram.botToken),
    chatIdConfigured: Boolean(config.telegram.chatId),
    rateLimitWindowSec: RATE_LIMIT_WINDOW_MS / 1000,
    circuitState: stats.consecutiveFailures >= CIRCUIT_OPEN_AFTER ? 'open' : 'closed',
    config: {
      timeoutMs: TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
      circuitOpenAfter: CIRCUIT_OPEN_AFTER,
      circuitWindowSec: CIRCUIT_WINDOW_MS / 1000
    }
  };
}

function resetRateLimit() {
  lastSentByKey.clear();
}

function resetCircuit() {
  stats.consecutiveFailures = 0;
  lastFailureAt = 0;
  log.info('Circuit breaker di-reset manual');
}

module.exports = {
  sendAlert,
  sendMessage,
  getStats,
  resetRateLimit,
  resetCircuit
};
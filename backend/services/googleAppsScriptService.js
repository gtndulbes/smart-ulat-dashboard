/**
 * ============================================================
 * googleAppsScriptService.js
 * ============================================================
 */

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const config = require('../config/config');
const logger = require('../utils/logger');

const log = logger.scope('GAS');

const stats = {
  sent: 0,
  success: 0,
  failed: 0,
  timeouts: 0,
  retries: 0,
  reads: 0,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  consecutiveFails: 0
};

// ------------------------------------------------------------
// POST JSON
// ------------------------------------------------------------
function postJSON(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch { return reject(new Error('URL tidak valid: ' + url)); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);

    const options = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'SmartUlat-Backend/1.0'
      },
      timeout: timeoutMs
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return postJSON(res.headers.location, body, timeoutMs).then(resolve).catch(reject);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Response bukan JSON: ' + data.slice(0, 200))); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ------------------------------------------------------------
// GET JSON
// ------------------------------------------------------------
function getJSON(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch { return reject(new Error('URL tidak valid: ' + url)); }

    const lib = parsed.protocol === 'https:' ? https : http;

    const options = {
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'SmartUlat-Backend/1.0' },
      timeout: timeoutMs
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return getJSON(res.headers.location, timeoutMs).then(resolve).catch(reject);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Response bukan JSON: ' + data.slice(0, 200))); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.end();
  });
}

// ------------------------------------------------------------
// appendRow
// ------------------------------------------------------------
async function appendRow(sheetName, row, opts = {}) {
  if (!config.gas.enabled) {
    return { success: false, skipped: true, reason: 'GAS_WEB_APP_URL belum diisi' };
  }

  if (config.simulationMode) {
    log.debug(`[SIM] POST GAS (${sheetName}): ${row.length} kolom`);
    return { success: true, simulated: true, sheet: sheetName };
  }

  const maxRetries = opts.maxRetries ?? config.gas.maxRetries ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? config.gas.retryDelayMs ?? 2000;
  const timeoutMs = config.gas.timeoutMs ?? 15000;

  const body = { token: config.gas.webAppToken || '', sheet: sheetName, action: 'append', row };

  stats.sent += 1;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await postJSON(config.gas.webAppUrl, body, timeoutMs);
      if (resp && resp.success === true) {
        stats.success += 1;
        stats.consecutiveFails = 0;
        stats.lastSuccessAt = new Date().toISOString();
        if (attempt > 0) stats.retries += attempt;
        return { success: true, sheet: sheetName, response: resp };
      }
      lastErr = new Error(resp?.error || 'GAS balas success:false');
      break;
    } catch (err) {
      lastErr = err;
      if (/timeout/i.test(err.message)) stats.timeouts += 1;
      if (attempt < maxRetries) {
        stats.retries += 1;
        const delay = retryDelayMs * Math.pow(2, attempt);
        log.warn(`GAS retry ${attempt + 1}/${maxRetries} (${err.message}) in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  stats.failed += 1;
  stats.consecutiveFails += 1;
  stats.lastErrorAt = new Date().toISOString();
  stats.lastErrorMessage = lastErr ? lastErr.message : 'unknown';
  log.error(`✗ GAS appendRow gagal: ${stats.lastErrorMessage}`);
  return { success: false, sheet: sheetName, error: stats.lastErrorMessage };
}

// ------------------------------------------------------------
// readSheet — query ke GAS
// ------------------------------------------------------------
/**
 * @param {object} opts — { sheet, limit, offset, from, to, search }
 */
async function readSheet(opts = {}) {
  const sheet = opts.sheet || 'Log';
  const limit = Math.max(1, Math.min(opts.limit || 100, 1000));
  const offset = Math.max(0, opts.offset || 0);
  const from = opts.from || '';
  const to = opts.to || '';
  const search = opts.search || '';

  // ----------------------------------------
  // Guard: GAS belum dikonfigurasi
  // ----------------------------------------
  if (!config.gas.enabled) {
    log.debug('readSheet: GAS belum dikonfigurasi — return empty');
    return {
      success: true,
      sheet,
      headers: [],
      rows: [],
      total: 0,
      offset,
      limit,
      hasMore: false,
      empty: true,
      reason: 'GAS_WEB_APP_URL belum diisi'
    };
  }

  // ----------------------------------------
  // Simulation mode — return empty (tanpa dummy)
  // ----------------------------------------
  if (config.simulationMode) {
    log.debug('readSheet: SIMULATION_MODE — return empty (no dummy)');
    return {
      success: true,
      sheet,
      headers: [],
      rows: [],
      total: 0,
      offset,
      limit,
      hasMore: false,
      empty: true,
      reason: 'SIMULATION_MODE aktif'
    };
  }

  // ----------------------------------------
  // GET request ke GAS
  // ----------------------------------------
  const params = new URLSearchParams({
    action: 'read',
    token: config.gas.webAppToken || '',
    sheet,
    limit: String(limit),
    offset: String(offset),
    from,
    to,
    search
  });

  const url = `${config.gas.webAppUrl}?${params.toString()}`;

  try {
    stats.reads += 1;
    const resp = await getJSON(url, config.gas.timeoutMs || 15000);
    if (!resp || resp.success !== true) {
      return { success: false, error: resp?.error || 'GAS balas success:false' };
    }
    return {
      success: true,
      sheet: resp.sheet,
      headers: resp.headers || [],
      rows: resp.rows || [],
      total: resp.total || 0,
      offset: resp.offset || offset,
      limit: resp.limit || limit,
      hasMore: Boolean(resp.hasMore)
    };
  } catch (err) {
    log.error('readSheet error:', err.message);
    return { success: false, error: err.message };
  }
}

// ------------------------------------------------------------
// ping
// ------------------------------------------------------------
async function ping() {
  if (!config.gas.enabled) return { ok: false, error: 'GAS_WEB_APP_URL belum diisi' };
  try {
    const url = `${config.gas.webAppUrl}?action=ping`;
    const resp = await getJSON(url, 8000);
    return { ok: true, response: resp };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getStats() {
  return {
    ...stats,
    enabled: config.gas.enabled,
    urlConfigured: Boolean(config.gas.webAppUrl),
    tokenConfigured: Boolean(config.gas.webAppToken)
  };
}

module.exports = {
  appendRow,
  readSheet,
  ping,
  getStats
};
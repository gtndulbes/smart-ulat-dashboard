/**
 * ============================================================
 * historyService.js — Periodic logging + alert logging
 * ============================================================
 */

'use strict';

const config = require('../config/config');
const logger = require('../utils/logger');
const stateService = require('./stateService');
const gasService = require('./googleAppsScriptService');

const log = logger.scope('HISTORY');

let timer = null;
let running = false;

const stats = {
  logged: 0,
  alertsLogged: 0,
  skipped: 0,
  errors: 0,
  startedAt: null,
  lastLogAt: null,
  lastAlertLogAt: null,
  lastErrorMessage: null
};

// ------------------------------------------------------------
// Row utama (Log sheet)
// ------------------------------------------------------------
function buildRow(state) {
  const s = state.sensors         || {};
  const a = state.actuators       || {};
  const p = state.power           || {};
  const sm = state.selfMonitoring || {};
  const fp = state.fuzzyPid       || {};
  const ss = state.systemStatus   || {};
  const fPeltier = fp.peltier     || {};

  const r = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v))
    ? Number(v.toFixed(d)) : '';

  return [
    new Date().toISOString(),
    r(s.temperature, 2),
    r(s.humidity, 2),
    r(s.nh3, 2),
    r(p.voltage, 2),
    r(p.current, 3),
    r(p.power, 2),
    a.peltier?.status || 'OFF',
    r(a.peltier?.pwm, 0),
    r(a.exhaustFan?.pwm, 0),
    r(a.heatsinkFan?.pwm, 0),
    sm.safeMode ? 'SAFE_MODE' : 'NORMAL',
    sm.safeMode ? 1 : 0,
    r(fPeltier.error, 3),
    r(fPeltier.deltaError, 3),
    r(fPeltier.kp, 3),
    r(fPeltier.ki, 4),
    r(fPeltier.kd, 3),
    r(fPeltier.pidOutput, 2),
    p.status || 'UNKNOWN',
    ss.uptime ?? '',
    sm.sht31 || '',
    sm.mq135 || '',
    sm.ina219 || ''
  ];
}

function hasMeaningfulData(state) {
  const s = state?.sensors;
  if (!s) return false;
  return Number.isFinite(s.temperature) || Number.isFinite(s.humidity);
}

// ------------------------------------------------------------
// Log row periodik
// ------------------------------------------------------------
async function logNow(opts = {}) {
  if (!config.gas.enabled) {
    stats.skipped += 1;
    return { success: false, skipped: true };
  }

  const state = stateService.getState();
  if (!hasMeaningfulData(state)) {
    stats.skipped += 1;
    return { success: false, skipped: true, reason: 'no_data' };
  }

  const row = buildRow(state);
  try {
    const res = await gasService.appendRow('Log', row);
    if (res.success) {
      stats.logged += 1;
      stats.lastLogAt = new Date().toISOString();
      if (!opts.silent) log.info(`📊 Logged row #${stats.logged}`);
      return { success: true, row };
    }
    stats.errors += 1;
    stats.lastErrorMessage = res.error || 'unknown';
    return { success: false, error: stats.lastErrorMessage };
  } catch (err) {
    stats.errors += 1;
    stats.lastErrorMessage = err.message;
    log.error('logNow error:', err.message);
    return { success: false, error: err.message };
  }
}

// ------------------------------------------------------------
// Log alert ke sheet "Alerts"
// ------------------------------------------------------------
async function logAlert(alert) {
  if (!config.gas.enabled) return { success: false, skipped: true };

  const ts = alert.timestamp || new Date().toISOString();
  const row = [
    ts,
    String(alert.severity || 'INFO').toUpperCase(),
    alert.title || 'Alert',
    alert.message || ''
  ];

  try {
    const res = await gasService.appendRow('Alerts', row);
    if (res.success) {
      stats.alertsLogged += 1;
      stats.lastAlertLogAt = new Date().toISOString();
      log.debug(`📝 Alert logged: [${row[1]}] ${row[2]}`);
      return { success: true };
    }
    return { success: false, error: res.error };
  } catch (err) {
    log.error('logAlert error:', err.message);
    return { success: false, error: err.message };
  }
}

// ------------------------------------------------------------
// Start / Stop
// ------------------------------------------------------------
function start() {
  if (running) return;
  if (!config.gas.enabled) {
    log.warn('GAS tidak aktif — historyService skip start');
    return;
  }

  const intervalMs = Math.max(
    config.intervals.historyMinIntervalMs,
    config.intervals.historyLogMs
  );

  running = true;
  stats.startedAt = new Date().toISOString();
  timer = setInterval(() => { logNow({ silent: true }); }, intervalMs);
  timer.unref?.();
  log.info(`History scheduler started — interval ${intervalMs / 1000}s`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  running = false;
  log.info('History scheduler stopped');
}

function isRunning() { return running; }

function getStats() {
  return {
    ...stats,
    running,
    intervalMs: Math.max(
      config.intervals.historyMinIntervalMs,
      config.intervals.historyLogMs
    ),
    gas: gasService.getStats()
  };
}

module.exports = { start, stop, logNow, logAlert, isRunning, getStats, buildRow };
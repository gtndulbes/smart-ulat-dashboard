/**
 * ============================================================
 * alertService.js
 * ------------------------------------------------------------
 * Orchestrator alert — jembatan antara stateService & eksternal.
 *
 * Alur:
 *   stateService.addAlert() → emit('alert')
 *        ↓
 *   alertService listener
 *        ├─► Telegram (kalau WARNING / CRITICAL)
 *        └─► GAS log sheet "Alerts"
 *
 *   stateService.updateSelfMonitoring() → safeModeChanged
 *        ↓
 *   alertService bikin alert otomatis + route ke atas
 *
 * Fitur:
 *   - Auto-generate alert dari SAFE_MODE change
 *   - Auto-generate alert dari power CRITICAL (transisi)
 *   - Auto-generate alert dari NH3 EMERGENCY
 *   - Dedup via Telegram rate limit
 *   - Stats
 * ============================================================
 */

'use strict';

const logger = require('../utils/logger');
const stateService = require('./stateService');
const telegramService = require('./telegramService');
const historyService = require('./historyService');

const log = logger.scope('ALERT');

// ------------------------------------------------------------
// Stats
// ------------------------------------------------------------
const stats = {
  received: 0,
  forwardedTelegram: 0,
  forwardedGAS: 0,
  errors: 0,
  lastAlertAt: null,
  lastAlertTitle: null
};

// ------------------------------------------------------------
// Track state untuk deteksi transisi
// ------------------------------------------------------------
let lastPowerStatus = 'UNKNOWN';
let lastSafeMode = false;
let lastNh3Emergency = false;
let initialized = false;

// ------------------------------------------------------------
// Route alert ke Telegram + GAS
// ------------------------------------------------------------
async function _dispatch(alert, opts = {}) {
  stats.received += 1;
  stats.lastAlertAt = new Date().toISOString();
  stats.lastAlertTitle = alert.title;

  const severity = String(alert.severity || 'INFO').toUpperCase();

  // 1) Telegram (WARNING / CRITICAL only)
  if (severity === 'WARNING' || severity === 'CRITICAL') {
    try {
      const res = await telegramService.sendAlert(alert, opts);
      if (res.success) stats.forwardedTelegram += 1;
    } catch (err) {
      stats.errors += 1;
      log.error('Telegram dispatch error:', err.message);
    }
  }

  // 2) GAS log
  try {
    await historyService.logAlert(alert);
    stats.forwardedGAS += 1;
  } catch (err) {
    stats.errors += 1;
    log.error('GAS logAlert error:', err.message);
  }
}

// ------------------------------------------------------------
// Listener: alert dari stateService.addAlert()
// ------------------------------------------------------------
function _onAlert(alert) {
  log.debug(`Alert: [${alert.severity}] ${alert.title}`);
  _dispatch(alert, { key: `${alert.severity}::${alert.title}` });
}

// ------------------------------------------------------------
// Listener: SAFE_MODE change
// ------------------------------------------------------------
function _onSafeModeChange(e) {
  const { prev, current } = e;
  const alert = {
    severity: current ? 'CRITICAL' : 'INFO',
    title: current ? 'SAFE MODE ACTIVATED' : 'SAFE MODE CLEARED',
    message: current
      ? 'Sensor error terdeteksi. Peltier OFF, Exhaust 100%.'
      : 'Sistem kembali normal. Kontrol Fuzzy-PID dilanjutkan.',
    timestamp: new Date().toISOString()
  };
  stateService.addAlert(alert);
}

// ------------------------------------------------------------
// Periodic monitor — deteksi NH3 emergency & power critical
// ------------------------------------------------------------
let monitorTimer = null;

function _startMonitor() {
  if (monitorTimer) return;

  monitorTimer = setInterval(() => {
    try {
      const state = stateService.getState();
      const sp = state.configuration?.setpoint || {};
      const nh3 = state.sensors?.nh3;
      const powerStatus = state.power?.status;
      const safe = state.selfMonitoring?.safeMode;

      // --- NH3 emergency ---
      const nh3Limit = sp.nh3Emergency ?? 25;
      const nh3Emerg = Number.isFinite(nh3) && nh3 >= nh3Limit;

      if (nh3Emerg && !lastNh3Emergency) {
        stateService.addAlert({
          severity: 'CRITICAL',
          title: 'NH3 EMERGENCY',
          message: `NH3 mencapai ${nh3.toFixed(1)} ppm (limit ${nh3Limit} ppm)`,
          timestamp: new Date().toISOString()
        });
      }
      lastNh3Emergency = nh3Emerg;

      // --- Power critical (transisi) ---
      if (powerStatus === 'CRITICAL' && lastPowerStatus !== 'CRITICAL') {
        const v = state.power.voltage, i = state.power.current, p = state.power.power;
        stateService.addAlert({
          severity: 'CRITICAL',
          title: 'POWER CRITICAL',
          message: `V=${v?.toFixed(2)}V I=${i?.toFixed(2)}A P=${p?.toFixed(1)}W`,
          timestamp: new Date().toISOString()
        });
      } else if (powerStatus === 'WARNING' && lastPowerStatus === 'NORMAL') {
        stateService.addAlert({
          severity: 'WARNING',
          title: 'POWER WARNING',
          message: 'Suplai daya mendekati batas threshold',
          timestamp: new Date().toISOString()
        });
      }
      lastPowerStatus = powerStatus;

      // Sync safeMode internal (kalau belum pernah lewat event)
      lastSafeMode = safe;
    } catch (err) {
      log.error('Monitor error:', err.message);
    }
  }, 5000);

  monitorTimer.unref?.();
}

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
function init() {
  if (initialized) {
    log.warn('alertService sudah di-init');
    return;
  }

  // Listen event alert
  stateService.on('alert', _onAlert);

  // Listen safe mode change
  stateService.on('safeModeChanged', _onSafeModeChange);

  // Start periodic monitor
  _startMonitor();

  initialized = true;
  log.info('Alert service initialized');
  log.info(`  Telegram: ${telegramService.getStats().enabled ? 'ENABLED' : 'disabled'}`);
}

function shutdown() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  initialized = false;
}

function getStats() {
  return {
    ...stats,
    initialized,
    telegram: telegramService.getStats()
  };
}

module.exports = { init, shutdown, getStats };
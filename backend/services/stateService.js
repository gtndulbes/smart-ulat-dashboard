/**
 * ============================================================
 * stateService.js — Central state
 * ============================================================
 */

'use strict';

const EventEmitter = require('events');
const config = require('../config/config');
const logger = require('../utils/logger');

const log = logger.scope('STATE');

const MAX_ALERTS = 100;
const MAX_COMMAND_RESPONSES = 50;

// ------------------------------------------------------------
// State awal
// ------------------------------------------------------------
function createInitialState() {
  return {
    sensors: { temperature: null, humidity: null, nh3: null, timestamp: null },

    actuators: {
      peltier: { status: 'OFF', pwm: 0 },
      exhaustFan: { pwm: 0 },
      heatsinkFan: { pwm: 0 },
      timestamp: null
    },

    power: {
      voltage: null, current: null, power: null,
      status: 'UNKNOWN', timestamp: null
    },

    selfMonitoring: {
      wifi: 'UNKNOWN', mqtt: 'UNKNOWN',
      sht31: 'UNKNOWN', mq135: 'UNKNOWN', ina219: 'UNKNOWN',
      peltier: 'UNKNOWN', exhaustFan: 'UNKNOWN', heatsinkFan: 'UNKNOWN',
      safeMode: false,
      humidityInterlock: false,
      humidityCapFactor: 1.0,
      timestamp: null
    },

    // ============================================
    // NEW: Fuzzy-PID intermediate values (Step 8)
    // ============================================
    fuzzyPid: {
      peltier: {
        actual: null, setpoint: null,
        error: null, deltaError: null,
        kp: null, ki: null, kd: null,
        dKp: null, dKi: null, dKd: null,
        pidOutput: null,
        pwm: 0, mode: 'OFF'
      },
      fanTemp: {
        error: null, deltaError: null,
        kp: null, ki: null, kd: null,
        dKp: null, dKi: null, dKd: null,
        output: 0
      },
      fanHum: {
        error: null, deltaError: null,
        kp: null, ki: null, kd: null,
        dKp: null, dKi: null, dKd: null,
        output: 0
      },
      fanNH3: {
        error: null, deltaError: null,
        kp: null, ki: null, kd: null,
        dKp: null, dKi: null, dKd: null,
        output: 0
      },
      fanFinal: { maxOutput: 0, pwm: 0 },
      timestamp: null
    },

    configuration: JSON.parse(JSON.stringify(config.defaults)),

    alerts: [],
    commandResponses: [],

    systemStatus: {
      mode: 'auto',
      uptime: null,
      freeHeap: null,
      lastUpdate: null,
      bootTime: new Date().toISOString()
    },

    meta: {
      lastTelemetry: null,
      lastActuator: null,
      lastPower: null,
      lastSelfMonitoring: null,
      lastStatus: null,
      lastAlert: null,
      lastCommandResponse: null,
      lastFuzzyPid: null,
      updateCount: {
        telemetry: 0, actuator: 0, power: 0,
        selfMonitoring: 0, status: 0, alert: 0,
        commandResponse: 0, fuzzyPid: 0
      }
    }
  };
}

let state = createInitialState();
let initialized = false;

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

// ------------------------------------------------------------
function deepClone(obj) {
  if (typeof structuredClone === 'function') return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}
function nowIso() { return new Date().toISOString(); }

function emitUpdate(section) {
  emitter.emit('updated', { section, timestamp: nowIso() });
  const key = section === 'selfmonitoring' ? 'selfMonitoring'
            : section === 'fuzzyPid'      ? 'fuzzyPid'
            : section;
  if (state[key] !== undefined && emitter.listenerCount(section) > 0) {
    emitter.emit(section, deepClone(state[key]));
  }
}

// ------------------------------------------------------------
function init() {
  if (initialized) { log.warn('stateService sudah init'); return; }
  state = createInitialState();
  initialized = true;
  log.info('State service initialized');
  log.info(`  Setpoint: T=${state.configuration.setpoint.temperature}°C RH=${state.configuration.setpoint.humidity}% NH3=${state.configuration.setpoint.nh3}ppm`);
}

function reset() {
  state = createInitialState();
  log.warn('State di-reset');
  emitUpdate('all');
}

// ------------------------------------------------------------
function updateTelemetry(t) {
  if (!t || typeof t !== 'object') return;
  if (t.temperature !== undefined) state.sensors.temperature = t.temperature;
  if (t.humidity !== undefined)    state.sensors.humidity    = t.humidity;
  if (t.nh3 !== undefined)         state.sensors.nh3         = t.nh3;
  state.sensors.timestamp = nowIso();
  state.meta.lastTelemetry = nowIso();
  state.meta.updateCount.telemetry += 1;
  emitUpdate('sensors');
}

function updateActuator(a) {
  if (!a || typeof a !== 'object') return;
  if (a.peltier) {
    if (a.peltier.status !== undefined) state.actuators.peltier.status = a.peltier.status;
    if (a.peltier.pwm !== undefined)    state.actuators.peltier.pwm    = a.peltier.pwm;
  }
  if (a.exhaustFan && a.exhaustFan.pwm !== undefined) {
    state.actuators.exhaustFan.pwm = a.exhaustFan.pwm;
  }
  if (a.heatsinkFan && a.heatsinkFan.pwm !== undefined) {
    state.actuators.heatsinkFan.pwm = a.heatsinkFan.pwm;
  }
  state.actuators.timestamp = nowIso();
  state.meta.lastActuator = nowIso();
  state.meta.updateCount.actuator += 1;
  emitUpdate('actuators');
}

function updatePower(p) {
  if (!p || typeof p !== 'object') return;
  if (p.voltage !== undefined) state.power.voltage = p.voltage;
  if (p.current !== undefined) state.power.current = p.current;
  if (p.power !== undefined)   state.power.power   = p.power;
  if (state.power.power === null && state.power.voltage !== null && state.power.current !== null) {
    state.power.power = Number((state.power.voltage * state.power.current).toFixed(2));
  }
  state.power.status = evaluatePowerStatus(state.power);
  state.power.timestamp = nowIso();
  state.meta.lastPower = nowIso();
  state.meta.updateCount.power += 1;
  emitUpdate('power');
}

function evaluatePowerStatus(power) {
  const p = state.configuration.power;
  if (!p) return 'UNKNOWN';
  if (power.voltage === null || power.current === null) return 'UNKNOWN';
  const crit = power.voltage < p.voltageMin || power.voltage > p.voltageMax ||
               power.current > p.currentMax ||
               (power.power !== null && power.power > p.powerMax);
  if (crit) return 'CRITICAL';
  const warn = power.voltage < p.voltageMin * 1.05 ||
               power.voltage > p.voltageMax * 0.95 ||
               power.current > p.currentMax * 0.9 ||
               (power.power !== null && power.power > p.powerMax * 0.9);
  return warn ? 'WARNING' : 'NORMAL';
}

function updateSelfMonitoring(sm) {
  if (!sm || typeof sm !== 'object') return;
  const prevSafe = state.selfMonitoring.safeMode;
  ['wifi','mqtt','sht31','mq135','ina219','peltier','exhaustFan','heatsinkFan'].forEach((f) => {
    if (sm[f] !== undefined) state.selfMonitoring[f] = sm[f];
  });
  if (sm.safeMode !== undefined) state.selfMonitoring.safeMode = Boolean(sm.safeMode);
  state.selfMonitoring.timestamp = nowIso();
  state.meta.lastSelfMonitoring = nowIso();
  state.meta.updateCount.selfMonitoring += 1;
  emitUpdate('selfMonitoring');
  if (prevSafe !== state.selfMonitoring.safeMode) {
    log.warn(`SAFE_MODE: ${prevSafe} → ${state.selfMonitoring.safeMode}`);
    emitter.emit('safeModeChanged', { prev: prevSafe, current: state.selfMonitoring.safeMode, timestamp: nowIso() });
  }
}

function updateStatus(s) {
  if (!s || typeof s !== 'object') return;
  if (s.mode !== undefined)     state.systemStatus.mode = s.mode;
  if (s.uptime !== undefined)   state.systemStatus.uptime = s.uptime;
  if (s.freeHeap !== undefined) state.systemStatus.freeHeap = s.freeHeap;
  state.systemStatus.lastUpdate = nowIso();
  state.meta.lastStatus = nowIso();
  state.meta.updateCount.status += 1;
  emitUpdate('systemStatus');
}

// ------------------------------------------------------------
// NEW: Fuzzy-PID updater (Step 8)
// ------------------------------------------------------------
function updateFuzzyPid(fp) {
  if (!fp || typeof fp !== 'object') return;

  const p = state.fuzzyPid;

  // Peltier loop
  if (fp.peltier && typeof fp.peltier === 'object') {
    const src = fp.peltier;
    const dst = p.peltier;
    ['actual','setpoint','error','deltaError','kp','ki','kd',
     'dKp','dKi','dKd','pidOutput','pwm','mode'].forEach((k) => {
      if (src[k] !== undefined) dst[k] = src[k];
    });
  }

  // Fan loops (temp, hum, nh3)
  ['fanTemp','fanHum','fanNH3'].forEach((loop) => {
    if (fp[loop] && typeof fp[loop] === 'object') {
      const src = fp[loop];
      const dst = p[loop];
      ['error','deltaError','kp','ki','kd','dKp','dKi','dKd','output'].forEach((k) => {
        if (src[k] !== undefined) dst[k] = src[k];
      });
    }
  });

  // Fan final (MAX operator result)
  if (fp.fanFinal && typeof fp.fanFinal === 'object') {
    if (fp.fanFinal.maxOutput !== undefined) p.fanFinal.maxOutput = fp.fanFinal.maxOutput;
    if (fp.fanFinal.pwm !== undefined)       p.fanFinal.pwm       = fp.fanFinal.pwm;
  }

  // Auto-compute fanFinal kalau ESP32 tidak kirim
  if (fp.fanFinal === undefined) {
    const o1 = p.fanTemp.output || 0;
    const o2 = p.fanHum.output || 0;
    const o3 = p.fanNH3.output || 0;
    const maxOut = Math.max(o1, o2, o3);
    p.fanFinal.maxOutput = maxOut;
    p.fanFinal.pwm = Math.round(maxOut * 255 / 100);
  }

  p.timestamp = nowIso();
  state.meta.lastFuzzyPid = nowIso();
  state.meta.updateCount.fuzzyPid += 1;

  emitUpdate('fuzzyPid');
}

// ------------------------------------------------------------
function addAlert(alert) {
  if (!alert || typeof alert !== 'object') return;
  const entry = {
    id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    severity: String(alert.severity || 'INFO').toUpperCase(),
    title: alert.title || 'Alert',
    message: alert.message || '',
    timestamp: alert.timestamp || nowIso(),
    read: false
  };
  state.alerts.unshift(entry);
  if (state.alerts.length > MAX_ALERTS) state.alerts = state.alerts.slice(0, MAX_ALERTS);
  state.meta.lastAlert = nowIso();
  state.meta.updateCount.alert += 1;
  log.warn(`Alert [${entry.severity}] ${entry.title}: ${entry.message}`);
  emitUpdate('alerts');
  emitter.emit('alert', entry);
}

function addCommandResponse(r) {
  if (!r || typeof r !== 'object') return;
  const entry = {
    success: Boolean(r.success),
    command: r.command || 'UNKNOWN',
    message: r.message || '',
    timestamp: r.timestamp || nowIso()
  };
  state.commandResponses.unshift(entry);
  if (state.commandResponses.length > MAX_COMMAND_RESPONSES) {
    state.commandResponses = state.commandResponses.slice(0, MAX_COMMAND_RESPONSES);
  }
  state.meta.lastCommandResponse = nowIso();
  state.meta.updateCount.commandResponse += 1;
  emitUpdate('commandResponses');
  emitter.emit('commandResponse', entry);
}

// ------------------------------------------------------------
function getConfig() { return deepClone(state.configuration); }

function setConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  ['setpoint','pid','fuzzy','peltier','fan','heatsink','power'].forEach((s) => {
    if (cfg[s] && typeof cfg[s] === 'object') {
      state.configuration[s] = { ...state.configuration[s], ...cfg[s] };
    }
  });
  if (cfg.mode !== undefined) state.configuration.mode = cfg.mode;
  log.info('Configuration di-update:', Object.keys(cfg));
  emitUpdate('configuration');
  emitter.emit('config', deepClone(state.configuration));
}

// ------------------------------------------------------------
function getAlerts(limit = MAX_ALERTS) { return deepClone(state.alerts.slice(0, limit)); }
function markAlertRead(id) {
  const a = state.alerts.find((x) => x.id === id);
  if (a) { a.read = true; emitUpdate('alerts'); return true; }
  return false;
}
function clearAlerts() { state.alerts = []; emitUpdate('alerts'); }

function getState() { return deepClone(state); }

function getSummary() {
  return {
    sensors: { ...state.sensors },
    actuators: { ...state.actuators },
    power: { ...state.power },
    selfMonitoring: { ...state.selfMonitoring },
    fuzzyPid: { ...state.fuzzyPid },
    systemStatus: { ...state.systemStatus },
    alertsCount: state.alerts.length,
    unreadAlerts: state.alerts.filter((a) => !a.read).length,
    meta: { ...state.meta }
  };
}

function getStats() {
  return {
    initialized,
    alerts: state.alerts.length,
    unreadAlerts: state.alerts.filter((a) => !a.read).length,
    commandResponses: state.commandResponses.length,
    updateCount: { ...state.meta.updateCount },
    lastUpdate: {
      telemetry: state.meta.lastTelemetry,
      actuator: state.meta.lastActuator,
      power: state.meta.lastPower,
      selfMonitoring: state.meta.lastSelfMonitoring,
      status: state.meta.lastStatus,
      alert: state.meta.lastAlert,
      fuzzyPid: state.meta.lastFuzzyPid
    }
  };
}

function on(event, listener)  { emitter.on(event, listener); }
function off(event, listener) { emitter.off(event, listener); }
function once(event, listener){ emitter.once(event, listener); }

module.exports = {
  init, reset,
  updateTelemetry, updateActuator, updatePower, updateSelfMonitoring, updateStatus,
  updateFuzzyPid,
  addAlert, addCommandResponse,
  getConfig, setConfig,
  getAlerts, markAlertRead, clearAlerts,
  getState, getSummary, getStats,
  on, off, once
};
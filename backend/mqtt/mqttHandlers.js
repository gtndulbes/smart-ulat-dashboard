/**
 * ============================================================
 * mqttHandlers.js — Handler message MQTT
 * ============================================================
 */

'use strict';

const mqttClient = require('./mqttClient');
const mqttTopics = require('./mqttTopics');
const config = require('../config/config');
const logger = require('../utils/logger');

const log = logger.scope('MQTT-HANDLER');

let stateService = null;
function setStateService(svc) {
  stateService = svc;
  log.info('stateService terpasang di handler');
}

const stats = {
  totalMessages: 0,
  byCategory: {
    telemetry: 0, actuator: 0, power: 0, selfmonitoring: 0,
    status: 0, alert: 0, response: 0, fuzzypid: 0, unknown: 0
  },
  errors: 0,
  lastMessageAt: null
};

function isObject(p) { return p && typeof p === 'object' && !Array.isArray(p); }
function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------
function handleTelemetry(payload) {
  if (!isObject(payload)) return;
  const t = {
    temperature: num(payload.temperature),
    humidity: num(payload.humidity),
    nh3: num(payload.nh3),
    timestamp: payload.timestamp || Date.now()
  };
  if (stateService && stateService.updateTelemetry) stateService.updateTelemetry(t);
}

function handleActuator(payload) {
  if (!isObject(payload)) return;
  const a = {
    peltier: { status: payload.peltier?.status || 'OFF', pwm: num(payload.peltier?.pwm) },
    exhaustFan: { pwm: num(payload.exhaustFan?.pwm) },
    heatsinkFan: { pwm: num(payload.heatsinkFan?.pwm) }
  };
  if (stateService && stateService.updateActuator) stateService.updateActuator(a);
}

function handlePower(payload) {
  if (!isObject(payload)) return;
  const p = {
    voltage: num(payload.voltage),
    current: num(payload.current),
    power: num(payload.power)
  };
  if (stateService && stateService.updatePower) stateService.updatePower(p);
}

function handleSelfMonitoring(payload) {
  if (!isObject(payload)) return;
  const sm = {
    wifi: payload.wifi || 'UNKNOWN',
    mqtt: payload.mqtt || 'UNKNOWN',
    sht31: payload.sht31 || 'UNKNOWN',
    mq135: payload.mq135 || 'UNKNOWN',
    ina219: payload.ina219 || 'UNKNOWN',
    peltier: payload.peltier || 'UNKNOWN',
    exhaustFan: payload.exhaustFan || 'UNKNOWN',
    heatsinkFan: payload.heatsinkFan || 'UNKNOWN',
    safeMode: Boolean(payload.safeMode),

    // Humidity interlock info
    humidityInterlock: Boolean(payload.humidityInterlock),
    humidityCapFactor: typeof payload.humidityCapFactor === 'number'
      ? payload.humidityCapFactor
      : 1.0
  };
  if (sm.safeMode) log.warn('⚠ SAFE_MODE aktif di ESP32');
  if (sm.humidityInterlock) {
    log.warn(`⚠ Humidity interlock aktif (cap: ${Math.round(sm.humidityCapFactor * 100)}%)`);
  }
  if (stateService && stateService.updateSelfMonitoring) stateService.updateSelfMonitoring(sm);
}

function handleStatus(payload) {
  if (!isObject(payload)) return;
  const s = { mode: num(payload.mode), uptime: num(payload.uptime), freeHeap: num(payload.freeHeap) };
  if (stateService && stateService.updateStatus) stateService.updateStatus(s);
}

function handleAlert(payload) {
  if (!isObject(payload)) return;
  const alert = {
    severity: String(payload.severity || 'INFO').toUpperCase(),
    title: payload.title || 'Alert',
    message: payload.message || '',
    timestamp: payload.timestamp || Date.now()
  };
  const level = alert.severity === 'CRITICAL' ? 'error'
              : alert.severity === 'WARNING'  ? 'warn'
              : 'info';
  log[level](`🚨 [${alert.severity}] ${alert.title}: ${alert.message}`);
  if (stateService && stateService.addAlert) stateService.addAlert(alert);
}

function handleResponse(payload) {
  if (!isObject(payload)) return;
  const r = {
    success: Boolean(payload.success),
    command: payload.command || 'UNKNOWN',
    message: payload.message || '',
    timestamp: payload.timestamp || Date.now()
  };
  const icon = r.success ? '✅' : '❌';
  log.info(`${icon} Response [${r.command}]: ${r.message}`);
  if (stateService && stateService.addCommandResponse) stateService.addCommandResponse(r);
}

// ------------------------------------------------------------
// NEW: Fuzzy-PID handler (Step 8)
// ------------------------------------------------------------
function handleFuzzyPid(payload) {
  if (!isObject(payload)) {
    log.warn('FuzzyPid: payload bukan object');
    return;
  }

  // Validasi ringan: pastikan ada salah satu loop
  const hasAny = payload.peltier || payload.fanTemp || payload.fanHum ||
                 payload.fanNH3 || payload.fanFinal;
  if (!hasAny) {
    log.warn('FuzzyPid: tidak ada loop yang valid');
    return;
  }

  log.debug('FuzzyPid update:', {
    peltier_pwm: payload.peltier?.pwm,
    fanTemp_out: payload.fanTemp?.output,
    fanHum_out:  payload.fanHum?.output,
    fanNH3_out:  payload.fanNH3?.output,
    fanFinal_pwm: payload.fanFinal?.pwm
  });

  if (stateService && stateService.updateFuzzyPid) {
    stateService.updateFuzzyPid(payload);
  }
}

// ------------------------------------------------------------
function route({ topic, payload, raw, category }) {
  stats.totalMessages += 1;
  stats.lastMessageAt = new Date().toISOString();

  const cat = category || mqttTopics.getCategory(topic);
  if (stats.byCategory[cat] !== undefined) stats.byCategory[cat] += 1;
  else stats.byCategory.unknown += 1;

  if (payload === null) {
    log.warn(`Pesan bukan JSON dari ${topic}: ${raw.slice(0, 100)}`);
    return;
  }

  try {
    switch (cat) {
      case 'telemetry':      handleTelemetry(payload); break;
      case 'actuator':       handleActuator(payload); break;
      case 'power':          handlePower(payload); break;
      case 'selfmonitoring': handleSelfMonitoring(payload); break;
      case 'status':         handleStatus(payload); break;
      case 'alert':          handleAlert(payload); break;
      case 'response':       handleResponse(payload); break;
      case 'fuzzypid':       handleFuzzyPid(payload); break;
      default:
        log.debug(`Topik tidak dikenal: ${topic}`);
    }
  } catch (err) {
    stats.errors += 1;
    log.error(`Handler error untuk ${topic}:`, err.message);
  }
}

function init() {
  mqttClient.on('message', route);
  log.info('Handler terpasang — siap menerima message MQTT');
}

function getStats() {
  return { ...stats, byCategory: { ...stats.byCategory } };
}

module.exports = {
  init, setStateService, getStats,
  handlers: {
    handleTelemetry, handleActuator, handlePower,
    handleSelfMonitoring, handleStatus, handleAlert, handleResponse,
    handleFuzzyPid
  }
};
/**
 * ============================================================
 * mqttPublisher.js
 * ------------------------------------------------------------
 * Wrapper untuk publish message dari backend ke ESP32.
 *
 * Fitur:
 *   - Publish ke topik CONTROL (manual control)
 *   - Publish ke topik CONFIG (update konfigurasi)
 *   - Request-response dengan correlationId + timeout
 *   - Tracking pending commands (audit)
 *   - Retry otomatis kalau publish gagal
 *   - Guard simulation mode
 *
 * Alur command:
 *   dashboard → backend → publish(TOPICS.CONTROL, {command, value, correlationId})
 *                              ↓
 *                          ESP32 eksekusi
 *                              ↓
 *                          publish(TOPICS.RESPONSE, {correlationId, success, message})
 *                              ↓
 *                          mqttPublisher.resolveResponse(correlationId, response)
 *
 * Cara pakai:
 *   const publisher = require('./mqtt/mqttPublisher');
 *
 *   // Fire and forget
 *   await publisher.publishControl({ command: 'SET_PELTIER_PWM', value: 120 });
 *
 *   // Request-response (tunggu balasan ESP32)
 *   const res = await publisher.sendCommand(
 *     { command: 'SET_TEMP_SETPOINT', value: 27.5 },
 *     10000    // timeout ms
 *   );
 *   console.log(res.success, res.message);
 * ============================================================
 */

'use strict';

const crypto = require('crypto');

const mqttClient = require('./mqttClient');
const mqttTopics = require('./mqttTopics');
const config = require('../config/config');
const logger = require('../utils/logger');

const log = logger.scope('MQTT-PUB');

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
// Map correlationId → { resolve, reject, timeout, command, sentAt }
const pendingCommands = new Map();

// Statistik
const stats = {
  commandsSent: 0,
  commandsSuccess: 0,
  commandsFailed: 0,
  commandsTimeout: 0,
  configsSent: 0,
  lastCommandAt: null,
  lastCommandName: null
};

// ------------------------------------------------------------
// Helper: generate correlationId unik
// ------------------------------------------------------------
function generateCorrelationId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `cmd-${ts}-${rand}`;
}

// ------------------------------------------------------------
// Helper: attach listener untuk response (dipanggil sekali di init)
// ------------------------------------------------------------
let responseListenerAttached = false;

function attachResponseListener() {
  if (responseListenerAttached) return;
  responseListenerAttached = true;

  mqttClient.on('message', ({ topic, payload, category }) => {
    if (category !== 'response' || !payload) return;
    const correlationId = payload.correlationId;
    if (!correlationId) {
      // Response tanpa correlationId → broadcast saja (bukan dari command ini)
      return;
    }

    const pending = pendingCommands.get(correlationId);
    if (!pending) {
      log.debug(`Response correlationId tidak dikenal: ${correlationId}`);
      return;
    }

    clearTimeout(pending.timeout);
    pendingCommands.delete(correlationId);

    const elapsed = Date.now() - pending.sentAt;

    if (payload.success) {
      stats.commandsSuccess += 1;
      log.info(`✅ Command [${pending.command}] sukses (${elapsed}ms)`);
      pending.resolve({
        success: true,
        correlationId,
        command: pending.command,
        message: payload.message || 'OK',
        elapsedMs: elapsed,
        raw: payload
      });
    } else {
      stats.commandsFailed += 1;
      log.warn(`❌ Command [${pending.command}] gagal (${elapsed}ms): ${payload.message || 'unknown'}`);
      pending.resolve({
        success: false,
        correlationId,
        command: pending.command,
        message: payload.message || 'Command failed',
        elapsedMs: elapsed,
        raw: payload
      });
    }
  });

  log.debug('Response listener terpasang');
}

// ------------------------------------------------------------
// Publish raw (internal)
// ------------------------------------------------------------
async function publishRaw(topic, payload, options = {}) {
  if (config.simulationMode) {
    log.warn(`SIMULATION_MODE — publish ${topic} dilewati`);
    return {
      simulated: true,
      topic,
      payload
    };
  }

  const maxRetries = options.maxRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 500;

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await mqttClient.publish(topic, payload, {
        qos: options.qos ?? 1,
        retain: options.retain ?? false
      });
      return { ok: true, topic, payload, attempt };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        log.warn(`Publish attempt #${attempt + 1} gagal, retry dalam ${retryDelayMs}ms: ${err.message}`);
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }

  throw lastError || new Error('Publish gagal tanpa error detail');
}

// ------------------------------------------------------------
// Public API: publishControl (fire-and-forget)
// ------------------------------------------------------------
/**
 * Kirim command ke ESP32 tanpa menunggu response.
 * Cocok untuk command yang tidak butuh konfirmasi (mis. manual PWM test).
 *
 * @param {object} commandObj — { command, value, ... }
 * @param {object} [options]  — { qos, retain, maxRetries }
 * @returns {Promise<object>}
 */
async function publishControl(commandObj, options = {}) {
  if (!commandObj || typeof commandObj !== 'object') {
    throw new Error('commandObj harus object');
  }
  if (!commandObj.command) {
    throw new Error('commandObj.command wajib diisi');
  }

  const payload = {
    ...commandObj,
    correlationId: commandObj.correlationId || generateCorrelationId(),
    timestamp: Date.now()
  };

  stats.commandsSent += 1;
  stats.lastCommandAt = new Date().toISOString();
  stats.lastCommandName = payload.command;

  log.info(`→ CONTROL [${payload.command}]`, payload.value !== undefined ? `value=${payload.value}` : '');

  const result = await publishRaw(mqttTopics.TOPICS.CONTROL, payload, options);
  return { ...result, correlationId: payload.correlationId };
}

// ------------------------------------------------------------
// Public API: sendCommand (request-response)
// ------------------------------------------------------------
/**
 * Kirim command ke ESP32 dan tunggu response dengan timeout.
 *
 * @param {object} commandObj — { command, value, ... }
 * @param {number} [timeoutMs] — default dari config.intervals.commandResponseTimeoutMs
 * @param {object} [options]  — { qos, retain, maxRetries }
 * @returns {Promise<object>} — { success, correlationId, command, message, elapsedMs, raw }
 */
async function sendCommand(commandObj, timeoutMs, options = {}) {
  attachResponseListener();

  if (!commandObj || typeof commandObj !== 'object') {
    throw new Error('commandObj harus object');
  }
  if (!commandObj.command) {
    throw new Error('commandObj.command wajib diisi');
  }

  const timeout = timeoutMs ?? config.intervals.commandResponseTimeoutMs ?? 10000;
  const correlationId = commandObj.correlationId || generateCorrelationId();

  const payload = {
    ...commandObj,
    correlationId,
    timestamp: Date.now()
  };

  // Guard simulation mode
  if (config.simulationMode) {
    log.warn(`SIMULATION_MODE — sendCommand [${payload.command}] disimulasikan sukses`);
    return {
      success: true,
      simulated: true,
      correlationId,
      command: payload.command,
      message: 'Simulated OK (SIMULATION_MODE=true)',
      elapsedMs: 0,
      raw: null
    };
  }

  // Guard: MQTT harus connect
  if (!mqttClient.isConnected()) {
    throw new Error('MQTT tidak terhubung ke broker. Command tidak dikirim.');
  }

  stats.commandsSent += 1;
  stats.lastCommandAt = new Date().toISOString();
  stats.lastCommandName = payload.command;

  log.info(`→ CONTROL [${payload.command}] (wait ${timeout}ms)`, payload.value !== undefined ? `value=${payload.value}` : '');

  // Setup promise + timeout
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(correlationId);
      stats.commandsTimeout += 1;
      log.error(`⏱ Timeout [${payload.command}] (${timeout}ms) — ESP32 tidak balas`);

      // Resolve sebagai failed timeout (bukan reject) supaya caller tinggal cek .success
      resolve({
        success: false,
        timeout: true,
        correlationId,
        command: payload.command,
        message: `Timeout setelah ${timeout}ms`,
        elapsedMs: timeout,
        raw: null
      });
    }, timeout);

    pendingCommands.set(correlationId, {
      resolve,
      reject,
      timeout: timer,
      command: payload.command,
      sentAt: Date.now()
    });
  });

  // Kirim command
  try {
    await publishRaw(mqttTopics.TOPICS.CONTROL, payload, options);
  } catch (err) {
    // Bersihkan pending & reject
    const pending = pendingCommands.get(correlationId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingCommands.delete(correlationId);
    }
    stats.commandsFailed += 1;
    log.error(`Publish control gagal [${payload.command}]: ${err.message}`);
    return {
      success: false,
      correlationId,
      command: payload.command,
      message: `Publish gagal: ${err.message}`,
      elapsedMs: 0,
      raw: null
    };
  }

  return promise;
}

// ------------------------------------------------------------
// Public API: publishConfig
// ------------------------------------------------------------
/**
 * Kirim konfigurasi ke ESP32 (topik CONFIG).
 * ESP32 akan simpan ke NVS dan reply via topik RESPONSE.
 *
 * @param {object} configObj — { spTemp, spHum, peltierKp, ... }
 * @param {number} [timeoutMs] — opsional, kalau mau tunggu response
 * @returns {Promise<object>}
 */
async function publishConfig(configObj, timeoutMs) {
  if (!configObj || typeof configObj !== 'object') {
    throw new Error('configObj harus object');
  }

  const correlationId = generateCorrelationId();
  const payload = {
    ...configObj,
    correlationId,
    timestamp: Date.now()
  };

  if (config.simulationMode) {
    log.warn('SIMULATION_MODE — publishConfig disimulasikan sukses');
    return {
      success: true,
      simulated: true,
      correlationId,
      message: 'Simulated OK (SIMULATION_MODE=true)'
    };
  }

  if (!mqttClient.isConnected()) {
    throw new Error('MQTT tidak terhubung — config tidak dikirim');
  }

  stats.configsSent += 1;
  log.info(`→ CONFIG update (${Object.keys(configObj).length} field)`);

  // Kalau tidak diminta tunggu response → fire and forget
  if (!timeoutMs || timeoutMs <= 0) {
    await publishRaw(mqttTopics.TOPICS.CONFIG, payload, { qos: 1 });
    return { ok: true, correlationId };
  }

  // Tunggu response
  attachResponseListener();
  const timeout = timeoutMs;

  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(correlationId);
      resolve({
        success: false,
        timeout: true,
        correlationId,
        message: `Timeout setelah ${timeout}ms`
      });
    }, timeout);

    pendingCommands.set(correlationId, {
      resolve,
      reject: () => {},
      timeout: timer,
      command: 'CONFIG_UPDATE',
      sentAt: Date.now()
    });
  });

  await publishRaw(mqttTopics.TOPICS.CONFIG, payload, { qos: 1 });
  return promise;
}

// ------------------------------------------------------------
// Public API: cancel all pending (saat shutdown)
// ------------------------------------------------------------
function cancelAllPending(reason = 'Server shutdown') {
  if (pendingCommands.size === 0) return;

  log.warn(`Membatalkan ${pendingCommands.size} pending command: ${reason}`);

  for (const [correlationId, pending] of pendingCommands.entries()) {
    clearTimeout(pending.timeout);
    pending.resolve({
      success: false,
      canceled: true,
      correlationId,
      command: pending.command,
      message: reason,
      elapsedMs: Date.now() - pending.sentAt
    });
  }

  pendingCommands.clear();
}

// ------------------------------------------------------------
// Public API: getStats
// ------------------------------------------------------------
function getStats() {
  return {
    ...stats,
    pending: pendingCommands.size
  };
}

// ------------------------------------------------------------
// Export
// ------------------------------------------------------------
module.exports = {
  publishControl,
  sendCommand,
  publishConfig,
  cancelAllPending,
  getStats
};
/**
 * ============================================================
 * mqttClient.js
 * ------------------------------------------------------------
 * Koneksi utama ke EMQX Cloud via MQTT over TLS.
 *
 * Fitur:
 *   - Connect mqtts:// (TLS port 8883)
 *   - Username/password authentication
 *   - Auto reconnect dengan exponential backoff
 *   - Subscribe semua topik ESP32 (dari getSubscribeList)
 *   - Event emitter: 'connected' | 'disconnected' | 'message' | 'error'
 *   - Guard simulation mode (tidak connect kalau SIMULATION_MODE=true)
 *   - Graceful shutdown
 *
 * Dipakai oleh:
 *   - server.js (init)
 *   - mqttHandlers.js (consume messages)
 *   - mqttPublisher.js (publish)
 *   - services/* (subscribe ke event 'message')
 *
 * Event yang di-emit:
 *   'connected'          → berhasil connect + subscribe
 *   'disconnected'       → koneksi putus
 *   'reconnecting'       → sedang mencoba reconnect
 *   'error'              → error dari broker/koneksi
 *   'message'            → { topic, payload, raw }
 *   'subscribed'         → berhasil subscribe topik (dengan topic)
 * ============================================================
 */

'use strict';

const mqtt = require('mqtt');
const EventEmitter = require('events');

const config = require('../config/config');
const logger = require('../utils/logger');
const mqttTopics = require('./mqttTopics');

const log = logger.scope('MQTT');

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
let client = null;
let isConnecting = false;
let reconnectAttempts = 0;
let lastConnectedAt = null;
let lastDisconnectedAt = null;

// Event emitter internal
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

// ------------------------------------------------------------
// Helper: sanitasi URL untuk logging (sembunyikan password)
// ------------------------------------------------------------
function safeBrokerUrl(url) {
  if (!url) return '(empty)';
  try {
    // Kalau URL mengandung @ (user:pass@host), masking password
    const u = new URL(url.replace(/^mqtts?:\/\//, 'https://'));
    const host = u.hostname;
    const port = u.port || 'default';
    const proto = url.split('://')[0];
    return `${proto}://${host}:${port}`;
  } catch {
    return '(invalid url)';
  }
}

// ------------------------------------------------------------
// Build options untuk mqtt.connect
// ------------------------------------------------------------
function buildConnectOptions() {
  const opts = {
    clientId: config.mqtt.clientId,
    username: config.mqtt.username || undefined,
    password: config.mqtt.password || undefined,
    clean: config.mqtt.clean !== false,
    keepalive: config.mqtt.keepalive || 60,
    reconnectPeriod: config.mqtt.reconnectPeriod || 5000,
    connectTimeout: config.mqtt.connectTimeout || 30000,
    resubscribe: config.mqtt.resubscribe !== false,
    protocolVersion: 4,             // MQTT 3.1.1 (paling kompatibel)
    rejectUnauthorized: true        // WAJIB untuk TLS
  };

  // CA cert custom (opsional)
  if (config.mqtt.caCert) {
    try {
      const fs = require('fs');
      if (fs.existsSync(config.mqtt.caCert)) {
        opts.ca = fs.readFileSync(config.mqtt.caCert);
        log.info('CA cert custom dimuat:', config.mqtt.caCert);
      } else {
        log.warn('MQTT_CA_CERT diisi tapi file tidak ada:', config.mqtt.caCert);
      }
    } catch (err) {
      log.warn('Gagal baca CA cert:', err.message);
    }
  }

  return opts;
}

// ------------------------------------------------------------
// Handle incoming message
// ------------------------------------------------------------
function handleIncomingMessage(topic, buffer) {
  const raw = buffer.toString('utf8');
  let payload = null;

  // Parse JSON kalau bisa
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;  // bukan JSON, biarkan raw
  }

  // Log ringkas
  const category = mqttTopics.getCategory(topic);
  if (config.logLevel === 'debug') {
    log.debug(`← [${category}] ${topic}`, payload || raw);
  } else {
    log.info(`← [${category}] ${topic}`);
  }

  // Emit event
  emitter.emit('message', { topic, payload, raw, category });
}

// ------------------------------------------------------------
// Connect
// ------------------------------------------------------------
function connect() {
  // Guard: simulation mode
  if (config.simulationMode) {
    log.warn('SIMULATION_MODE=true — MQTT TIDAK akan connect ke broker.');
    log.warn('Set SIMULATION_MODE=false di .env untuk connect ke EMQX Cloud.');
    return null;
  }

  // Guard: sudah connect atau sedang connect
  if (client && client.connected) {
    log.warn('MQTT client sudah connected. Abaikan connect().');
    return client;
  }
  if (isConnecting) {
    log.warn('MQTT sedang connecting. Abaikan connect().');
    return client;
  }

  // Guard: credential wajib ada
  if (!config.mqtt.brokerUrl) {
    log.error('MQTT_BROKER_URL kosong. Tidak bisa connect.');
    return null;
  }

  isConnecting = true;

  const url = config.mqtt.brokerUrl;
  const opts = buildConnectOptions();

  log.info('Connecting to broker...');
  log.info(`  URL      : ${safeBrokerUrl(url)}`);
  log.info(`  ClientID : ${opts.clientId}`);
  log.info(`  User     : ${opts.username ? '***' : '(none)'}`);
  log.info(`  Keepalive: ${opts.keepalive}s`);
  log.info(`  Reconnect: ${opts.reconnectPeriod}ms`);

  try {
    client = mqtt.connect(url, opts);
  } catch (err) {
    isConnecting = false;
    log.error('Gagal membuat MQTT client:', err.message);
    emitter.emit('error', err);
    return null;
  }

  // ----------------------------------------------------------
  // Event: connect
  // ----------------------------------------------------------
  client.on('connect', (packet) => {
    isConnecting = false;
    reconnectAttempts = 0;
    lastConnectedAt = new Date();

    log.info('✅ Connected to MQTT broker');
    if (packet && packet.sessionPresent !== undefined) {
      log.debug(`  Session present: ${packet.sessionPresent}`);
    }

    // Subscribe topik ESP32
    const subscribeList = mqttTopics.getSubscribeList();
    client.subscribe(subscribeList, { qos: 1 }, (err, granted) => {
      if (err) {
        log.error('Gagal subscribe:', err.message);
        emitter.emit('error', err);
        return;
      }
      log.info(`Subscribe ${granted.length} topik:`);
      granted.forEach((g) => {
        log.info(`  ✓ ${g.topic} (QoS ${g.qos})`);
      });
      emitter.emit('subscribed', granted);
    });

    emitter.emit('connected', packet);
  });

  // ----------------------------------------------------------
  // Event: message
  // ----------------------------------------------------------
  client.on('message', (topic, buffer) => {
    try {
      handleIncomingMessage(topic, buffer);
    } catch (err) {
      log.error('Error handle message:', err.message);
    }
  });

  // ----------------------------------------------------------
  // Event: reconnect (dipanggil setiap kali auto-reconnect)
  // ----------------------------------------------------------
  client.on('reconnect', () => {
    reconnectAttempts += 1;
    log.warn(`Reconnecting... (attempt #${reconnectAttempts})`);
    emitter.emit('reconnecting', reconnectAttempts);
  });

  // ----------------------------------------------------------
  // Event: offline
  // ----------------------------------------------------------
  client.on('offline', () => {
    log.warn('MQTT client offline');
  });

  // ----------------------------------------------------------
  // Event: close
  // ----------------------------------------------------------
  client.on('close', () => {
    if (lastConnectedAt && !lastDisconnectedAt) {
      lastDisconnectedAt = new Date();
      const dur = ((lastDisconnectedAt - lastConnectedAt) / 1000).toFixed(1);
      log.warn(`Disconnected from broker (was online ${dur}s)`);
    } else {
      log.warn('Disconnected from broker');
    }
    emitter.emit('disconnected');
  });

  // ----------------------------------------------------------
  // Event: error
  // ----------------------------------------------------------
  client.on('error', (err) => {
    isConnecting = false;
    log.error('MQTT error:', err.message);

    // Cek pola error umum
    if (err.message && err.message.includes('Not authorized')) {
      log.error('→ Cek MQTT_USERNAME & MQTT_PASSWORD di .env');
    } else if (err.message && err.message.includes('ECONNREFUSED')) {
      log.error('→ Cek MQTT_BROKER_URL & port 8883 (TLS)');
    } else if (err.message && err.message.includes('certificate')) {
      log.error('→ Cek TLS cert. Coba update Node.js ke versi terbaru.');
    }

    emitter.emit('error', err);
  });

  // ----------------------------------------------------------
  // Event: end (setelah disconnect dipanggil)
  // ----------------------------------------------------------
  client.on('end', () => {
    log.info('MQTT client ended');
  });

  return client;
}

// ------------------------------------------------------------
// Disconnect (graceful)
// ------------------------------------------------------------
function disconnect() {
  return new Promise((resolve) => {
    if (!client) return resolve();
    log.info('Disconnecting MQTT...');
    client.end(false, {}, () => {
      log.info('MQTT disconnected');
      client = null;
      resolve();
    });
  });
}

// ------------------------------------------------------------
// Publish (delegate ke mqttPublisher di Step 2 FILE 5)
// ------------------------------------------------------------
function publish(topic, payload, options = {}) {
  return new Promise((resolve, reject) => {
    if (!client || !client.connected) {
      return reject(new Error('MQTT not connected'));
    }

    const qos = options.qos ?? 1;
    const retain = options.retain ?? false;
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);

    client.publish(topic, message, { qos, retain }, (err) => {
      if (err) {
        log.error(`Publish gagal → ${topic}:`, err.message);
        return reject(err);
      }
      log.debug(`→ ${topic}`, message.length > 200 ? message.slice(0, 200) + '…' : message);
      resolve();
    });
  });
}

// ------------------------------------------------------------
// Getter status
// ------------------------------------------------------------
function isConnected() {
  return Boolean(client && client.connected);
}

function getClient() {
  return client;
}

function getStatus() {
  return {
    connected: isConnected(),
    clientId: config.mqtt.clientId,
    brokerUrl: safeBrokerUrl(config.mqtt.brokerUrl),
    reconnectAttempts,
    lastConnectedAt: lastConnectedAt ? lastConnectedAt.toISOString() : null,
    lastDisconnectedAt: lastDisconnectedAt ? lastDisconnectedAt.toISOString() : null,
    simulation: config.simulationMode
  };
}

// ------------------------------------------------------------
// Event subscription (public)
// ------------------------------------------------------------
function on(event, listener) {
  emitter.on(event, listener);
}

function off(event, listener) {
  emitter.off(event, listener);
}

function once(event, listener) {
  emitter.once(event, listener);
}

// ------------------------------------------------------------
// Export
// ------------------------------------------------------------
module.exports = {
  connect,
  disconnect,
  publish,
  isConnected,
  getClient,
  getStatus,
  on,
  off,
  once
};
/**
 * ============================================================
 * websocketServer.js
 * ------------------------------------------------------------
 * WebSocket server untuk broadcast realtime state ke semua
 * dashboard client (multi-user).
 *
 * Alur:
 *   stateService event 'updated' | 'alert' | 'safeModeChanged'
 *        ↓
 *   websocketServer.broadcast()
 *        ↓
 *   semua client (dashboard) yang terhubung
 *
 * Protokol pesan:
 *   Server → Client:
 *     { type: 'welcome',  serverTime, clientId }
 *     { type: 'initial',  data: <full state> }
 *     { type: 'update',   section, data, timestamp }
 *     { type: 'alert',    data: <alert> }
 *     { type: 'safeMode', data: { prev, current } }
 *     { type: 'pong',     timestamp }
 *
 *   Client → Server:
 *     { type: 'ping' }
 *     (Step 10: { type: 'command', ... })
 *
 * Fitur:
 *   - Attach ke HTTP server yang sudah ada (path /ws)
 *   - Kirim initial state saat client connect
 *   - Listen event stateService → broadcast
 *   - Heartbeat ping/pong (deteksi dead client)
 *   - Track clients + stats
 *   - Graceful shutdown
 * ============================================================
 */

'use strict';

const WebSocket = require('ws');

const config = require('../config/config');
const logger = require('../utils/logger');
const stateService = require('../services/stateService');

const log = logger.scope('WS');

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
let wss = null;
let heartbeatInterval = null;

const stats = {
  totalConnections: 0,
  currentConnections: 0,
  messagesSent: 0,
  messagesReceived: 0,
  errors: 0,
  lastConnectAt: null,
  lastDisconnectAt: null
};

// ------------------------------------------------------------
// Helper: kirim JSON aman
// ------------------------------------------------------------
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    stats.messagesSent += 1;
    return true;
  } catch (err) {
    stats.errors += 1;
    log.error('Send gagal:', err.message);
    return false;
  }
}

// ------------------------------------------------------------
// Broadcast ke semua client
// ------------------------------------------------------------
function broadcast(obj, filterFn) {
  if (!wss) return 0;
  const payload = JSON.stringify(obj);
  let count = 0;

  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (filterFn && !filterFn(client)) return;
    try {
      client.send(payload);
      stats.messagesSent += 1;
      count += 1;
    } catch (err) {
      stats.errors += 1;
    }
  });

  return count;
}

// ------------------------------------------------------------
// Handler: client connect
// ------------------------------------------------------------
function onConnection(ws, req) {
  stats.totalConnections += 1;
  stats.currentConnections = wss.clients.size;
  stats.lastConnectAt = new Date().toISOString();

  // Simpan metadata di ws object
  ws.isAlive = true;
  ws.clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ws.clientIp = req.socket.remoteAddress || 'unknown';
  ws.connectedAt = Date.now();

  log.info(`Client connected: ${ws.clientId} (${ws.clientIp}) — total: ${stats.currentConnections}`);

  // Kirim welcome
  safeSend(ws, {
    type: 'welcome',
    serverTime: new Date().toISOString(),
    clientId: ws.clientId,
    simulation: config.simulationMode
  });

  // Kirim initial state
  try {
    safeSend(ws, {
      type: 'initial',
      data: stateService.getState(),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log.error('Gagal kirim initial state:', err.message);
  }

  // Listen heartbeat pong
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Listen message dari client
  ws.on('message', (buffer) => {
    stats.messagesReceived += 1;
    try {
      const msg = JSON.parse(buffer.toString('utf8'));
      handleClientMessage(ws, msg);
    } catch (err) {
      log.warn(`Pesan non-JSON dari ${ws.clientId}`);
    }
  });

  // Listen close
  ws.on('close', (code, reason) => {
    stats.currentConnections = wss.clients.size;
    stats.lastDisconnectAt = new Date().toISOString();
    const dur = ((Date.now() - ws.connectedAt) / 1000).toFixed(1);
    log.info(`Client disconnected: ${ws.clientId} (code=${code}, ${dur}s) — total: ${stats.currentConnections}`);
  });

  // Listen error
  ws.on('error', (err) => {
    stats.errors += 1;
    log.error(`WS error [${ws.clientId}]:`, err.message);
  });
}

// ------------------------------------------------------------
// Handler: pesan dari client
// ------------------------------------------------------------
function handleClientMessage(ws, msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'ping':
      safeSend(ws, { type: 'pong', timestamp: new Date().toISOString() });
      break;

    // Step 10 akan tambahkan: case 'command': ...
    default:
      log.debug(`Pesan tidak dikenal dari ${ws.clientId}:`, msg.type);
  }
}

// ------------------------------------------------------------
// Wire stateService event → broadcast
// ------------------------------------------------------------
function wireStateEvents() {
  // Update per section
  stateService.on('updated', ({ section, timestamp }) => {
    let data = null;
    try {
      const snap = stateService.getState();
      switch (section) {
        case 'sensors':         data = snap.sensors; break;
        case 'actuators':       data = snap.actuators; break;
        case 'power':           data = snap.power; break;
        case 'selfMonitoring':  data = snap.selfMonitoring; break;
        case 'fuzzyPid':        data = snap.fuzzyPid; break;      // ← TAMBAHAN
        case 'systemStatus':    data = snap.systemStatus; break;
        case 'configuration':   data = snap.configuration; break;
        case 'alerts':          data = snap.alerts.slice(0, 20); break;
        case 'commandResponses':data = snap.commandResponses.slice(0, 20); break;
        default:                data = snap;
      }
    } catch (err) {
      log.error('Gagal ambil state section:', err.message);
    }

    broadcast({
      type: 'update',
      section,
      data,
      timestamp: timestamp || new Date().toISOString()
    });
  });

  // Alert baru
  stateService.on('alert', (alert) => {
    broadcast({
      type: 'alert',
      data: alert,
      timestamp: new Date().toISOString()
    });
  });

  // SAFE_MODE change
  stateService.on('safeModeChanged', (e) => {
    broadcast({
      type: 'safeMode',
      data: e,
      timestamp: new Date().toISOString()
    });
  });

  log.info('State events terhubung ke broadcast');
}

// ------------------------------------------------------------
// Heartbeat — ping tiap 30s, terminate yang tidak balas
// ------------------------------------------------------------
function startHeartbeat() {
  const intervalMs = config.websocket.heartbeatIntervalMs || 30000;

  heartbeatInterval = setInterval(() => {
    if (!wss) return;
    let alive = 0, dead = 0;

    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        log.warn(`Terminating dead client: ${ws.clientId}`);
        ws.terminate();
        dead++;
        return;
      }
      ws.isAlive = false;
      ws.ping();
      alive++;
    });

    if (dead > 0 || config.logLevel === 'debug') {
      log.debug(`Heartbeat: ${alive} alive, ${dead} terminated`);
    }
  }, intervalMs);

  // Cleanup saat proses exit
  heartbeatInterval.unref?.();
}

// ------------------------------------------------------------
// Init — attach ke HTTP server
// ------------------------------------------------------------
function init(httpServer) {
  if (wss) {
    log.warn('WebSocket server sudah di-init');
    return wss;
  }
  if (!httpServer) {
    throw new Error('websocketServer.init() butuh httpServer (dari server.listen)');
  }

  const path = config.websocket.path || '/ws';

  wss = new WebSocket.Server({
    server: httpServer,
    path,
    perMessageDeflate: false,   // IoT data kecil, kompresi tidak worth
    maxPayload: 1024 * 1024,    // 1 MB max
    clientTracking: true
  });

  wss.on('connection', onConnection);

  wss.on('error', (err) => {
    stats.errors += 1;
    log.error('WS server error:', err.message);
  });

  wireStateEvents();
  startHeartbeat();

  log.info(`WebSocket server siap di path ${path}`);
  log.info(`  Heartbeat: ${config.websocket.heartbeatIntervalMs / 1000}s`);
  log.info(`  Max clients: ${config.websocket.maxClients || 'unlimited'}`);

  return wss;
}

// ------------------------------------------------------------
// Shutdown
// ------------------------------------------------------------
function shutdown() {
  return new Promise((resolve) => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (!wss) return resolve();

    log.info('Menutup WebSocket server...');
    wss.clients.forEach((ws) => {
      try { ws.close(1001, 'Server shutdown'); } catch {}
    });
    wss.close(() => {
      log.info('WebSocket server closed');
      wss = null;
      resolve();
    });
  });
}

// ------------------------------------------------------------
// Getter
// ------------------------------------------------------------
function getStats() {
  return {
    ...stats,
    currentConnections: wss ? wss.clients.size : 0,
    path: config.websocket.path,
    heartbeatIntervalMs: config.websocket.heartbeatIntervalMs
  };
}

function isRunning() {
  return Boolean(wss);
}

function getClients() {
  if (!wss) return [];
  const list = [];
  wss.clients.forEach((ws) => {
    list.push({
      clientId: ws.clientId,
      ip: ws.clientIp,
      connectedAt: ws.connectedAt ? new Date(ws.connectedAt).toISOString() : null,
      durationSec: ws.connectedAt ? Math.floor((Date.now() - ws.connectedAt) / 1000) : 0
    });
  });
  return list;
}

// ------------------------------------------------------------
// Export
// ------------------------------------------------------------
module.exports = {
  init,
  shutdown,
  broadcast,
  getStats,
  isRunning,
  getClients
};
/**
 * ============================================================
 * websocket.js — WebSocket Client (Frontend)
 * ------------------------------------------------------------
 * Fitur:
 *   - Auto-detect protocol (ws:// atau wss://)
 *   - Auto reconnect dengan exponential backoff
 *   - Event emitter (on/off/once)
 *   - Cache state terakhir
 *   - Kirim heartbeat ping tiap 25 detik
 *
 * Event yang di-emit:
 *   'open', 'close', 'error', 'reconnecting',
 *   'welcome', 'initial', 'update', 'alert', 'safeMode', 'pong',
 *   'state' (setiap ada perubahan state dari server)
 *
 * Cara pakai:
 *   WSClient.on('update', (msg) => console.log(msg));
 *   WSClient.connect();
 * ============================================================
 */

'use strict';

const WSClient = (() => {
  // ----------------------------------------
  // Konfigurasi
  // ----------------------------------------
  const PATH = '/ws';
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 30000;
  const PING_INTERVAL_MS = 25000;

  // ----------------------------------------
  // State
  // ----------------------------------------
  let ws = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let manuallyClosed = false;

  // Cache state terakhir dari server
  let lastState = {
    sensors: null,
    actuators: null,
    power: null,
    selfMonitoring: null,
    systemStatus: null,
    configuration: null,
    alerts: []
  };

  // Event listeners
  const listeners = {};

  // ----------------------------------------
  // Event emitter
  // ----------------------------------------
  function on(event, cb) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(cb);
  }

  function off(event, cb) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter((fn) => fn !== cb);
  }

  function once(event, cb) {
    const wrapper = (...args) => {
      off(event, wrapper);
      cb(...args);
    };
    on(event, wrapper);
  }

  function emit(event, ...args) {
    (listeners[event] || []).forEach((cb) => {
      try { cb(...args); } catch (e) { console.error('[WS] listener error:', e); }
    });
  }

  // ----------------------------------------
  // URL builder
  // ----------------------------------------
  function buildWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}${PATH}`;
  }

  // ----------------------------------------
  // Handler: message dari server
  // ----------------------------------------
  function handleMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.warn('[WS] pesan non-JSON:', event.data);
      return;
    }

    switch (msg.type) {
      case 'welcome':
        emit('welcome', msg);
        break;

      case 'initial':
        if (msg.data) {
          Object.assign(lastState, msg.data);
          emit('initial', msg.data);
          emit('state', lastState);
        }
        break;

      case 'update':
        if (msg.section && msg.data !== undefined) {
          lastState[msg.section] = msg.data;
        }
        emit('update', msg);
        emit('state', lastState);
        break;

      case 'alert':
        if (msg.data) {
          lastState.alerts = [msg.data, ...(lastState.alerts || [])].slice(0, 100);
        }
        emit('alert', msg.data);
        emit('state', lastState);
        break;

      case 'safeMode':
        emit('safeMode', msg.data);
        break;

      case 'pong':
        emit('pong', msg);
        break;

      default:
        console.debug('[WS] tipe pesan tidak dikenal:', msg.type);
    }
  }

  // ----------------------------------------
  // Connect
  // ----------------------------------------
  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    manuallyClosed = false;

    const url = buildWsUrl();
    console.log(`[WS] Connecting → ${url} (attempt #${reconnectAttempts + 1})`);

    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('[WS] gagal buat WebSocket:', err);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectAttempts = 0;
      console.log('[WS] ✅ Connected');
      emit('open');
      startPing();
    };

    ws.onmessage = handleMessage;

    ws.onerror = (err) => {
      console.warn('[WS] error');
      emit('error', err);
    };

    ws.onclose = (event) => {
      console.warn(`[WS] Closed (code=${event.code})`);
      stopPing();
      emit('close', event);
      if (!manuallyClosed) scheduleReconnect();
    };
  }

  // ----------------------------------------
  // Reconnect dengan exponential backoff
  // ----------------------------------------
  function scheduleReconnect() {
    if (reconnectTimer) return;

    const delay = Math.min(
      RECONNECT_MIN_MS * Math.pow(2, reconnectAttempts),
      RECONNECT_MAX_MS
    );
    reconnectAttempts += 1;

    console.log(`[WS] Reconnect dalam ${delay}ms (attempt #${reconnectAttempts})`);
    emit('reconnecting', { attempt: reconnectAttempts, delay });

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // ----------------------------------------
  // Ping keepalive
  // ----------------------------------------
  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  function stopPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  // ----------------------------------------
  // Send
  // ----------------------------------------
  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      console.error('[WS] send gagal:', err);
      return false;
    }
  }

  // ----------------------------------------
  // Close manual
  // ----------------------------------------
  function close() {
    manuallyClosed = true;
    stopPing();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try { ws.close(1000, 'manual'); } catch {}
    }
  }

  // ----------------------------------------
  // Public API
  // ----------------------------------------
  return {
    connect,
    close,
    send,
    on,
    off,
    once,
    getState: () => ({ ...lastState }),
    isConnected: () => Boolean(ws && ws.readyState === WebSocket.OPEN),
    getReadyState: () => ws ? ws.readyState : WebSocket.CLOSED
  };
})();

window.WSClient = WSClient;
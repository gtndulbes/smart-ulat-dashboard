/**
 * ============================================================
 * self-monitoring.js — Self-Monitoring Page Handler
 * ------------------------------------------------------------
 * STEP 9: Halaman Self-Monitoring.
 *
 * Fitur:
 *   - Banner SAFE_MODE (muncul otomatis saat aktif)
 *   - Communication: WiFi, MQTT, WebSocket, Backend
 *   - Sensors: SHT31-D, MQ-135, INA219
 *   - Actuators: Peltier, Exhaust, Heatsink
 *   - System info: uptime, freeHeap, lastUpdate, safeMode
 * ============================================================
 */

'use strict';

const SelfMonitoring = (() => {
  let mounted = false;
  const subs = [];
  const el = {};

  let healthInterval = null;

  // ----------------------------------------
  function _on(event, cb) {
    WSClient.on(event, cb);
    subs.push([event, cb]);
  }
  function _unsub() {
    subs.forEach(([ev, cb]) => WSClient.off(ev, cb));
    subs.length = 0;
  }

  // ----------------------------------------
  function _cacheDom() {
    const ids = [
      // Safe mode banner
      'sm-safe-banner',
      // Communication
      'sm-wifi-dot', 'sm-wifi-text',
      'sm-mqtt-dot', 'sm-mqtt-text',
      'sm-ws-dot', 'sm-ws-text',
      'sm-backend-dot', 'sm-backend-text',
      // Sensors
      'sm-sht31-dot', 'sm-sht31-text',
      'sm-mq135-dot', 'sm-mq135-text',
      'sm-ina219-dot', 'sm-ina219-text',
      // Actuators
      'sm-peltier-dot', 'sm-peltier-text',
      'sm-exhaust-dot', 'sm-exhaust-text',
      'sm-heatsink-dot', 'sm-heatsink-text',
      // System
      'sm-uptime', 'sm-heap', 'sm-last-update', 'sm-safe-text', 'sm-humlock-text'
    ];
    ids.forEach((id) => { el[id] = document.getElementById(id); });
  }

  // ----------------------------------------
  // Status helper
  // ----------------------------------------
  // Status values yang dianggap OK
  const OK_VALUES = ['OK', 'CONNECTED'];

  function _statusClass(status) {
    if (!status || status === 'UNKNOWN') return 'unknown';
    const s = String(status).toUpperCase();
    if (OK_VALUES.includes(s)) return 'ok';
    if (s === 'WARN' || s === 'WARNING') return 'warn';
    return 'err';
  }

  function _setDot(id, status) {
    const node = el[id];
    if (!node) return;
    const cls = _statusClass(status);
    const map = {
      ok:      'w-3 h-3 rounded-full bg-neon-green shadow-glow-green',
      warn:    'w-3 h-3 rounded-full bg-neon-orange',
      err:     'w-3 h-3 rounded-full bg-neon-red shadow-glow-red animate-pulse',
      unknown: 'w-3 h-3 rounded-full bg-slate-500'
    };
    node.className = map[cls];
  }

  function _setText(id, value) {
    const node = el[id];
    if (!node) return;
    node.textContent = (value === null || value === undefined) ? '—' : String(value);
  }

  // ----------------------------------------
  // Renderers
  // ----------------------------------------
  function renderBanner(safeMode) {
    const banner = el['sm-safe-banner'];
    if (!banner) return;
    if (safeMode) banner.classList.remove('hidden');
    else banner.classList.add('hidden');
  }

  function renderSelfMonitoring(sm) {
    if (!sm) return;

    // Communication (dari ESP32)
    _setDot('sm-wifi-dot', sm.wifi);
    _setText('sm-wifi-text', sm.wifi);

    _setDot('sm-mqtt-dot', sm.mqtt);
    _setText('sm-mqtt-text', sm.mqtt);

    // WebSocket status (dari client, bukan ESP32)
    const wsOk = WSClient.isConnected();
    _setDot('sm-ws-dot', wsOk ? 'CONNECTED' : 'DISCONNECTED');
    _setText('sm-ws-text', wsOk ? 'CONNECTED' : 'DISCONNECTED');

    // Sensors
    _setDot('sm-sht31-dot', sm.sht31);
    _setText('sm-sht31-text', sm.sht31);

    _setDot('sm-mq135-dot', sm.mq135);
    _setText('sm-mq135-text', sm.mq135);

    _setDot('sm-ina219-dot', sm.ina219);
    _setText('sm-ina219-text', sm.ina219);

    // Actuators
    _setDot('sm-peltier-dot', sm.peltier);
    _setText('sm-peltier-text', sm.peltier);

    _setDot('sm-exhaust-dot', sm.exhaustFan);
    _setText('sm-exhaust-text', sm.exhaustFan);

    _setDot('sm-heatsink-dot', sm.heatsinkFan);
    _setText('sm-heatsink-text', sm.heatsinkFan);

    // Safe mode
    _setText('sm-safe-text', sm.safeMode ? 'ON' : 'OFF');
    renderBanner(sm.safeMode);
    
        // Humidity interlock
    if (sm.humidityInterlock) {
      const pct = Math.round((sm.humidityCapFactor ?? 1) * 100);
      _setText('sm-humlock-text', `⚠ ACTIVE (${pct}%)`);
      const node = el['sm-humlock-text'];
      if (node) node.className = 'font-mono text-amber-300 mt-1';
    } else {
      _setText('sm-humlock-text', 'OFF');
      const node = el['sm-humlock-text'];
      if (node) node.className = 'font-mono text-slate-200 mt-1';
    }
  }

  function renderSystemStatus(systemStatus, backendData) {
    if (systemStatus) {
      _setText('sm-uptime', systemStatus.uptime != null
        ? Utils.formatUptime(systemStatus.uptime)
        : '—');
      _setText('sm-heap', systemStatus.freeHeap != null
        ? `${Math.round(systemStatus.freeHeap / 1024)} KB`
        : '—');
      _setText('sm-last-update', systemStatus.lastUpdate
        ? Utils.formatTime(new Date(systemStatus.lastUpdate))
        : '—');
    }

    // Backend dari health REST
    if (backendData) {
      _setDot('sm-backend-dot', 'CONNECTED');
      _setText('sm-backend-text', `v${backendData.version || '?'} · ${backendData.env || '?'}`);
    }
  }

  async function pollBackendHealth() {
    try {
      const data = await Utils.getJSON('/api/health');
      _setDot('sm-backend-dot', 'CONNECTED');
      _setText('sm-backend-text', `v${data.version} · ${data.env}`);
    } catch {
      _setDot('sm-backend-dot', 'DISCONNECTED');
      _setText('sm-backend-text', 'OFFLINE');
    }
  }

  // ----------------------------------------
  // Full render
  // ----------------------------------------
  function renderAll(state) {
    if (!state) return;
    renderSelfMonitoring(state.selfMonitoring);
    renderSystemStatus(state.systemStatus, null);
  }

  // ----------------------------------------
  function mount() {
    if (mounted) return;
    mounted = true;
    _cacheDom();

    console.log('[SelfMonitoring] mount');

    // Initial
    const state = WSClient.getState();
    renderAll(state);

    // Subscribe
    _on('update', (msg) => {
      if (msg.section === 'selfMonitoring') renderSelfMonitoring(msg.data);
      else if (msg.section === 'systemStatus') renderSystemStatus(msg.data, null);
    });

    _on('initial', (data) => renderAll(data));

    // WS connection change → update WS dot
    _on('open', () => {
      _setDot('sm-ws-dot', 'CONNECTED');
      _setText('sm-ws-text', 'CONNECTED');
    });
    _on('close', () => {
      _setDot('sm-ws-dot', 'DISCONNECTED');
      _setText('sm-ws-text', 'DISCONNECTED');
    });

    // Backend health poll
    pollBackendHealth();
    healthInterval = setInterval(pollBackendHealth, 10000);
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    console.log('[SelfMonitoring] unmount');
    _unsub();
    if (healthInterval) {
      clearInterval(healthInterval);
      healthInterval = null;
    }
  }

  return { mount, unmount };
})();

window.SelfMonitoring = SelfMonitoring;
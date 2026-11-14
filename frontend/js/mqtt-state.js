/**
 * ============================================================
 * mqtt-state.js — Frontend State Store
 * ------------------------------------------------------------
 * Central store untuk semua state dari backend (via WebSocket).
 *
 * Peran:
 *   - websocket.js  → transport (kirim/terima)
 *   - mqtt-state.js → state store (cache + derived values)
 *   - page modules  → consumer (dashboard, monitoring, dst)
 *
 * Fitur:
 *   - Cache state per section
 *   - Snapshot immutable (deep clone)
 *   - Event granular: 'sensors:update', 'power:update', dst
 *   - Computed/delta values (dT, dP, trend)
 *   - History mini (10 update terakhir per section)
 *   - Fallback aman kalau backend kirim data tidak lengkap
 *   - esp32Online: heartbeat status ESP32 (dari backend, bukan payload)
 *   - WiFi card di UI dirender dari esp32Online (bukan selfMonitoring.wifi)
 * ============================================================
 */

'use strict';

const MqttState = (() => {
  // ----------------------------------------
  // State internal
  // ----------------------------------------
  const HISTORY_SIZE = 10;

  let state = _createEmptyState();
  let history = _createEmptyHistory();
  let initialized = false;

  const listeners = {};       // event → [cb]

  // ----------------------------------------
  // Factory: empty state
  // ----------------------------------------
  function _createEmptyState() {
    return {
      sensors: {
        temperature: null,
        humidity: null,
        nh3: null,
        timestamp: null
      },
      actuators: {
        peltier:     { status: 'OFF', pwm: 0 },
        exhaustFan:  { pwm: 0 },
        heatsinkFan: { pwm: 0 },
        timestamp: null
      },
      power: {
        voltage: null,
        current: null,
        power: null,
        status: 'UNKNOWN',
        timestamp: null
      },
      selfMonitoring: {
        // 'wifi' field disimpan untuk backward-compat, tapi TIDAK dirender.
        // UI WiFi card menggunakan esp32Online (heartbeat backend).
        wifi: 'UNKNOWN',
        mqtt: 'UNKNOWN',
        sht31: 'UNKNOWN',
        mq135: 'UNKNOWN',
        ina219: 'UNKNOWN',
        peltier: 'UNKNOWN',
        exhaustFan: 'UNKNOWN',
        heatsinkFan: 'UNKNOWN',
        safeMode: false,
        timestamp: null
      },
      fuzzyPid: {
        peltier: {
          actual: null, setpoint: null,
          error: null, deltaError: null,
          kp: null, ki: null, kd: null,
          dKp: null, dKi: null, dKd: null,
          pidOutput: null, pwm: 0, mode: 'OFF'
        },
        fanTemp: { error: null, deltaError: null, kp: null, ki: null, kd: null, dKp: null, dKi: null, dKd: null, output: 0 },
        fanHum:  { error: null, deltaError: null, kp: null, ki: null, kd: null, dKp: null, dKi: null, dKd: null, output: 0 },
        fanNH3:  { error: null, deltaError: null, kp: null, ki: null, kd: null, dKp: null, dKi: null, dKd: null, output: 0 },
        fanFinal: { maxOutput: 0, pwm: 0 },
        timestamp: null
      },
      systemStatus: {
        mode: 'auto',
        uptime: null,
        freeHeap: null,
        lastUpdate: null
      },
      configuration: null,
      alerts: [],

      // ═══════════════════════════════════════════════════════════
      // Status ESP32 (dihitung backend dari heartbeat)
      // true  = telemetry terakhir < 15 detik yang lalu
      // false = ESP32 offline / WiFi putus / MQTT putus / crash
      // ═══════════════════════════════════════════════════════════
      esp32Online: true,

      meta: {
        lastTelemetry: null,
        lastActuator: null,
        lastPower: null,
        lastSelfMonitoring: null,
        lastFuzzyPid: null,
        lastStatus: null,
        lastConfig: null
      }
    };
  }

  // ----------------------------------------
  // Factory: empty history
  // ----------------------------------------
  function _createEmptyHistory() {
    const h = {};
    ['sensors', 'actuators', 'power', 'selfMonitoring', 'fuzzyPid', 'systemStatus']
      .forEach((k) => { h[k] = []; });
    return h;
  }

  // ----------------------------------------
  // Event emitter
  // ----------------------------------------
  function on(event, cb) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(cb);
    return () => off(event, cb);
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

  function emit(event, payload) {
    (listeners[event] || []).forEach((cb) => {
      try { cb(payload); }
      catch (e) { console.error(`[MqttState] listener '${event}' error:`, e); }
    });
  }

  // ----------------------------------------
  // Deep clone
  // ----------------------------------------
  function _clone(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(obj); } catch { /* fallback */ }
    }
    return JSON.parse(JSON.stringify(obj));
  }

  // ----------------------------------------
  // Update helpers
  // ----------------------------------------
  function _pushHistory(section) {
    if (!history[section]) return;
    history[section].push({
      data: _clone(state[section]),
      timestamp: Date.now()
    });
    if (history[section].length > HISTORY_SIZE) {
      history[section].shift();
    }
  }

  function _updateSection(section, data) {
    if (!state[section]) return;
    if (!data || typeof data !== 'object') return;

    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) state[section][k] = v;
    }

    state[section].timestamp = new Date().toISOString();

    _pushHistory(section);
    emit(`${section}:update`, _clone(state[section]));
    emit('change', { section, data: _clone(state[section]) });
  }

  // ----------------------------------------
  // Update per section
  // ----------------------------------------
  function updateSensors(data) {
    _updateSection('sensors', data);
    state.meta.lastTelemetry = new Date().toISOString();
  }

  function updateActuators(data) {
    if (!data || typeof data !== 'object') return;

    if (data.peltier)     Object.assign(state.actuators.peltier, data.peltier);
    if (data.exhaustFan)  Object.assign(state.actuators.exhaustFan, data.exhaustFan);
    if (data.heatsinkFan) Object.assign(state.actuators.heatsinkFan, data.heatsinkFan);

    state.actuators.timestamp = new Date().toISOString();
    _pushHistory('actuators');
    emit('actuators:update', _clone(state.actuators));
    emit('change', { section: 'actuators', data: _clone(state.actuators) });
    state.meta.lastActuator = new Date().toISOString();
  }

  function updatePower(data) {
    _updateSection('power', data);
    state.meta.lastPower = new Date().toISOString();
  }

  function updateSelfMonitoring(data) {
    const prevSafe = state.selfMonitoring.safeMode;

    _updateSection('selfMonitoring', data);
    state.meta.lastSelfMonitoring = new Date().toISOString();

    if (prevSafe !== state.selfMonitoring.safeMode) {
      emit('safeModeChanged', {
        prev: prevSafe,
        current: state.selfMonitoring.safeMode,
        timestamp: new Date().toISOString()
      });
    }
  }

  function updateFuzzyPid(data) {
    if (!data || typeof data !== 'object') return;

    if (data.peltier) Object.assign(state.fuzzyPid.peltier, data.peltier);
    ['fanTemp', 'fanHum', 'fanNH3'].forEach((loop) => {
      if (data[loop]) Object.assign(state.fuzzyPid[loop], data[loop]);
    });
    if (data.fanFinal) Object.assign(state.fuzzyPid.fanFinal, data.fanFinal);

    state.fuzzyPid.timestamp = new Date().toISOString();
    _pushHistory('fuzzyPid');
    emit('fuzzyPid:update', _clone(state.fuzzyPid));
    emit('change', { section: 'fuzzyPid', data: _clone(state.fuzzyPid) });
    state.meta.lastFuzzyPid = new Date().toISOString();
  }

  function updateSystemStatus(data) {
    _updateSection('systemStatus', data);
    state.meta.lastStatus = new Date().toISOString();
  }

  function updateConfiguration(data) {
    if (!data || typeof data !== 'object') return;
    state.configuration = _clone(data);
    emit('configuration:update', _clone(state.configuration));
    emit('change', { section: 'configuration', data: _clone(state.configuration) });
    state.meta.lastConfig = new Date().toISOString();
  }

  function updateAlerts(alerts) {
    if (!Array.isArray(alerts)) return;
    state.alerts = _clone(alerts);
    emit('alerts:update', _clone(state.alerts));
    emit('change', { section: 'alerts', data: _clone(state.alerts) });
  }

  function addAlert(alert) {
    if (!alert) return;
    state.alerts.unshift(_clone(alert));
    if (state.alerts.length > 100) state.alerts = state.alerts.slice(0, 100);
    emit('alert:new', _clone(alert));
    emit('alerts:update', _clone(state.alerts));
  }

  // ═══════════════════════════════════════════════════════════════
  // Update status ESP32 online/offline
  // Payload: boolean atau { online: boolean }
  // Edge-triggered: emit hanya saat berubah
  // ═══════════════════════════════════════════════════════════════
  function updateEsp32Online(data) {
    const online = typeof data === 'boolean' ? data : Boolean(data?.online);

    if (state.esp32Online === online) return;

    const prev = state.esp32Online;
    state.esp32Online = online;

    console.log(`[MqttState] ESP32 ${prev ? 'ONLINE' : 'OFFLINE'} → ${online ? 'ONLINE' : 'OFFLINE'}`);
    emit('esp32Online:update', online);
    emit('change', { section: 'esp32Online', data: online });
  }

  // ═══════════════════════════════════════════════════════════════
  // Reset saat WS disconnect permanen (tidak ada heartbeat baru)
  // Dipakai kalau mau force-offline status saat backend mati
  // ═══════════════════════════════════════════════════════════════
  function clearEsp32Online() {
    if (state.esp32Online === false) return;
    state.esp32Online = false;
    console.log('[MqttState] ESP32 OFFLINE (WS disconnected)');
    emit('esp32Online:update', false);
    emit('change', { section: 'esp32Online', data: false });
  }

  // ============================================================
  // DERIVED VALUES
  // ============================================================
  function getTemperatureDelta() {
    const h = history.sensors;
    if (h.length < 2) return null;
    const curr = h[h.length - 1].data.temperature;
    const prev = h[h.length - 2].data.temperature;
    if (curr == null || prev == null) return null;
    return Number((curr - prev).toFixed(2));
  }

  function getTemperatureTrend() {
    const d = getTemperatureDelta();
    if (d === null) return 'unknown';
    if (d > 0.1) return 'up';
    if (d < -0.1) return 'down';
    return 'stable';
  }

  function getPowerTrend() {
    const h = history.power;
    if (h.length < 2) return 'unknown';
    const curr = h[h.length - 1].data.power;
    const prev = h[h.length - 2].data.power;
    if (curr == null || prev == null) return 'unknown';
    const d = curr - prev;
    if (d > 0.5) return 'up';
    if (d < -0.5) return 'down';
    return 'stable';
  }

  function getOverallStatus() {
    if (state.esp32Online === false) return 'offline';

    if (state.selfMonitoring.safeMode) return 'safe';

    const ps = state.power.status;
    if (ps === 'CRITICAL') return 'critical';

    const sp = state.configuration?.setpoint;
    if (sp && Number.isFinite(state.sensors.nh3) && Number.isFinite(sp.nh3Emergency)) {
      if (state.sensors.nh3 >= sp.nh3Emergency) return 'critical';
    }
    if (ps === 'WARNING') return 'warning';

    if (state.selfMonitoring.sht31 === 'ERROR') return 'warning';

    return 'normal';
  }

  function getDataAge(section) {
    const m = state.meta;
    const key = {
      sensors: 'lastTelemetry',
      actuators: 'lastActuator',
      power: 'lastPower',
      selfMonitoring: 'lastSelfMonitoring',
      fuzzyPid: 'lastFuzzyPid',
      systemStatus: 'lastStatus',
      configuration: 'lastConfig'
    }[section];
    if (!key || !m[key]) return null;
    return Date.now() - new Date(m[key]).getTime();
  }

  function isStale(section, thresholdMs = 15000) {
    const age = getDataAge(section);
    return age === null || age > thresholdMs;
  }

  // ============================================================
  // PUBLIC GETTERS
  // ============================================================
  function getSensors()         { return _clone(state.sensors); }
  function getActuators()       { return _clone(state.actuators); }
  function getPower()           { return _clone(state.power); }
  function getSelfMonitoring()  { return _clone(state.selfMonitoring); }
  function getFuzzyPid()        { return _clone(state.fuzzyPid); }
  function getSystemStatus()    { return _clone(state.systemStatus); }
  function getConfiguration()   { return _clone(state.configuration); }
  function getAlerts()          { return _clone(state.alerts); }
  function getMeta()            { return _clone(state.meta); }
  function getEsp32Online()     { return state.esp32Online; }

  function getAll() {
    return {
      sensors: _clone(state.sensors),
      actuators: _clone(state.actuators),
      power: _clone(state.power),
      selfMonitoring: _clone(state.selfMonitoring),
      fuzzyPid: _clone(state.fuzzyPid),
      systemStatus: _clone(state.systemStatus),
      configuration: _clone(state.configuration),
      alerts: _clone(state.alerts),
      esp32Online: state.esp32Online,
      meta: _clone(state.meta)
    };
  }

  function getHistory(section) {
    if (!history[section]) return [];
    return _clone(history[section]);
  }

  // ============================================================
  // WSClient INTEGRATION
  // ============================================================
  function _wireWebSocket() {
    if (typeof WSClient === 'undefined') {
      console.warn('[MqttState] WSClient tidak ada — state tidak akan terisi');
      return;
    }

    // Full snapshot saat connect
    WSClient.on('initial', (data) => {
      if (!data) return;
      console.log('[MqttState] initial state diterima:', Object.keys(data));

      if (data.sensors)        updateSensors(data.sensors);
      if (data.actuators)      updateActuators(data.actuators);
      if (data.power)          updatePower(data.power);
      if (data.selfMonitoring) updateSelfMonitoring(data.selfMonitoring);
      if (data.fuzzyPid)       updateFuzzyPid(data.fuzzyPid);
      if (data.systemStatus)   updateSystemStatus(data.systemStatus);
      if (data.configuration)  updateConfiguration(data.configuration);
      if (Array.isArray(data.alerts)) updateAlerts(data.alerts);

      // FIX: pakai updateEsp32Online() supaya dedup konsisten
      if (typeof data.esp32Online === 'boolean') {
        updateEsp32Online(data.esp32Online);
      }

      emit('ready', getAll());
    });

    // Update per section
    WSClient.on('update', (msg) => {
      if (!msg || !msg.section) return;
      const { section, data } = msg;

      switch (section) {
        case 'sensors':        updateSensors(data); break;
        case 'actuators':      updateActuators(data); break;
        case 'power':          updatePower(data); break;
        case 'selfMonitoring': updateSelfMonitoring(data); break;
        case 'fuzzyPid':       updateFuzzyPid(data); break;
        case 'systemStatus':   updateSystemStatus(data); break;
        case 'configuration':  updateConfiguration(data); break;
        case 'alerts':         updateAlerts(data); break;
        case 'esp32Online':    updateEsp32Online(data); break;
        default: break;
      }
    });

    // Alert baru
    WSClient.on('alert', (alert) => {
      addAlert(alert);
    });

    // SAFE_MODE change
    WSClient.on('safeMode', (e) => {
      state.selfMonitoring.safeMode = Boolean(e?.current);
      emit('safeModeChanged', e);
    });

    // Fallback: cache dari WSClient (kalau initial tidak terkirim)
    const cached = WSClient.getState?.();
    if (cached && !initialized) {
      console.log('[MqttState] restore dari WSClient cache');
      if (cached.sensors)        updateSensors(cached.sensors);
      if (cached.actuators)      updateActuators(cached.actuators);
      if (cached.power)          updatePower(cached.power);
      if (cached.selfMonitoring) updateSelfMonitoring(cached.selfMonitoring);
      if (cached.fuzzyPid)       updateFuzzyPid(cached.fuzzyPid);
      if (cached.systemStatus)   updateSystemStatus(cached.systemStatus);
      if (cached.configuration)  updateConfiguration(cached.configuration);
      if (Array.isArray(cached.alerts)) updateAlerts(cached.alerts);
      if (typeof cached.esp32Online === 'boolean') {
        updateEsp32Online(cached.esp32Online);
      }
    }
  }

  // ============================================================
  // INIT
  // ============================================================
  function init() {
    if (initialized) {
      console.warn('[MqttState] sudah di-init');
      return;
    }

    state = _createEmptyState();
    history = _createEmptyHistory();

    _wireWebSocket();

    initialized = true;
    console.log('[MqttState] initialized');
  }

  function reset() {
    state = _createEmptyState();
    history = _createEmptyHistory();
    emit('reset', {});
    console.log('[MqttState] reset');
  }

  function destroy() {
    Object.keys(listeners).forEach((k) => delete listeners[k]);
    initialized = false;
    console.log('[MqttState] destroyed');
  }

  // ============================================================
  // EXPORT
  // ============================================================
  return {
    // Lifecycle
    init,
    reset,
    destroy,

    // Events
    on,
    off,
    once,

    // Getters
    getSensors,
    getActuators,
    getPower,
    getSelfMonitoring,
    getFuzzyPid,
    getSystemStatus,
    getConfiguration,
    getAlerts,
    getMeta,
    getEsp32Online,
    getAll,
    getHistory,

    // Derived
    getTemperatureDelta,
    getTemperatureTrend,
    getPowerTrend,
    getOverallStatus,
    getDataAge,
    isStale,

    // Manual update (untuk testing)
    updateSensors,
    updateActuators,
    updatePower,
    updateSelfMonitoring,
    updateFuzzyPid,
    updateSystemStatus,
    updateConfiguration,
    updateAlerts,
    updateEsp32Online,
    clearEsp32Online,
    addAlert,

    // Info
    isInitialized: () => initialized
  };
})();

window.MqttState = MqttState;
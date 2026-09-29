/**
 * ============================================================
 * dashboard.js — Dashboard Page Handler
 * ============================================================
 */

'use strict';

const Dashboard = (() => {
  let mounted = false;
  const subs = [];
  const el = {};

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
      'dash-status',
      'dash-temp', 'dash-temp-status', 'dash-temp-sp',
      'dash-hum', 'dash-hum-status', 'dash-hum-sp',
      'dash-nh3', 'dash-nh3-status', 'dash-nh3-limit',
      'dash-peltier-status', 'dash-peltier-pwm',
      'dash-exhaust-pwm', 'dash-heatsink-pwm',
      'dash-v', 'dash-i', 'dash-p', 'dash-power-status',
      'dash-sys-ws', 'dash-sys-ws-text',
      'dash-sys-mqtt', 'dash-sys-mqtt-text',
      'dash-sys-sensor', 'dash-sys-sensor-text',
      'dash-sys-safe', 'dash-sys-safe-text',
      // Manual control
      'mc-feedback',
      'mc-mode-auto', 'mc-mode-manual',
      'mc-save-config', 'mc-clear-safe', 'mc-emergency',
      'mc-pel-off', 'mc-pel-cool', 'mc-pel-heat',
      'mc-pel-pwm', 'mc-pel-pwm-val', 'mc-pel-apply',
      'mc-exh-pwm', 'mc-exh-pwm-val', 'mc-exh-apply',
      'mc-hs-pwm',  'mc-hs-pwm-val',  'mc-hs-apply',
      'mc-last-command'
    ];
    ids.forEach((id) => { el[id] = document.getElementById(id); });
  }

  // ----------------------------------------
  // Status evaluators (dari Step 6)
  // ----------------------------------------
  function _evalTempStatus(t) {
    if (t === null || t === undefined) return { cls: 'scada-badge-idle', text: '—' };
    if (t >= 26 && t <= 29) return { cls: 'scada-badge-ok', text: 'NORMAL' };
    if (t < 24 || t > 32)   return { cls: 'scada-badge-err', text: 'CRITICAL' };
    return { cls: 'scada-badge-warn', text: 'WARNING' };
  }
  function _evalHumStatus(h) {
    if (h === null || h === undefined) return { cls: 'scada-badge-idle', text: '—' };
    if (h >= 60 && h <= 90) return { cls: 'scada-badge-ok', text: 'NORMAL' };
    if (h < 50 || h > 95)   return { cls: 'scada-badge-err', text: 'CRITICAL' };
    return { cls: 'scada-badge-warn', text: 'WARNING' };
  }
  function _evalNh3Status(n, limit) {
    if (n === null || n === undefined) return { cls: 'scada-badge-idle', text: '—' };
    const lim = limit || 25;
    if (n < lim)       return { cls: 'scada-badge-ok', text: 'AMAN' };
    if (n < lim * 1.2) return { cls: 'scada-badge-warn', text: 'WARNING' };
    return { cls: 'scada-badge-err', text: 'EMERGENCY' };
  }
  function _evalPeltierStatus(s) {
    const cls = s === 'COOLING' ? 'scada-badge-ok'
              : s === 'HEATING' ? 'scada-badge-warn'
              : 'scada-badge-idle';
    return { cls, text: s || 'OFF' };
  }
  function _evalPowerStatus(s) {
    const map = {
      NORMAL:       { cls: 'scada-badge-ok',   text: 'NORMAL' },
      WARNING:      { cls: 'scada-badge-warn', text: 'WARNING' },
      CRITICAL:     { cls: 'scada-badge-err',  text: 'CRITICAL' },
      SENSOR_ERROR: { cls: 'scada-badge-err',  text: 'SENSOR ERR' },
      UNKNOWN:      { cls: 'scada-badge-idle', text: 'UNKNOWN' }
    };
    return map[s] || map.UNKNOWN;
  }

  // ----------------------------------------
  function _setText(id, value) {
    if (el[id]) el[id].textContent = value;
  }
  function _setBadge(id, { cls, text }) {
    const node = el[id];
    if (!node) return;
    node.className = `scada-badge ${cls}`;
    node.textContent = text;
  }
  function _setDot(id, ok) {
    const node = el[id];
    if (!node) return;
    node.className = `w-2 h-2 rounded-full ${ok ? 'bg-neon-green shadow-glow-green' : 'bg-neon-red shadow-glow-red'}`;
  }

  // ----------------------------------------
  // Renderers
  // ----------------------------------------
  function renderSensors(sensors, configuration) {
    if (!sensors) return;
    const spTemp = configuration?.setpoint?.temperature ?? null;
    const spHum  = configuration?.setpoint?.humidity    ?? null;
    const spNh3  = configuration?.setpoint?.nh3Emergency ?? configuration?.setpoint?.nh3 ?? 25;

    _setText('dash-temp',    Utils.formatNumber(sensors.temperature, 1));
    _setText('dash-hum',     Utils.formatNumber(sensors.humidity, 1));
    _setText('dash-nh3',     Utils.formatNumber(sensors.nh3, 1));
    _setText('dash-temp-sp', Utils.formatNumber(spTemp, 1));
    _setText('dash-hum-sp',  Utils.formatNumber(spHum, 1));
    _setText('dash-nh3-limit', Utils.formatNumber(spNh3, 0));

    _setBadge('dash-temp-status', _evalTempStatus(sensors.temperature));
    _setBadge('dash-hum-status',  _evalHumStatus(sensors.humidity));
    _setBadge('dash-nh3-status',  _evalNh3Status(sensors.nh3, spNh3));
  }

  function renderActuators(actuators) {
    if (!actuators) return;
    if (actuators.peltier) {
      _setBadge('dash-peltier-status', _evalPeltierStatus(actuators.peltier.status));
      _setText('dash-peltier-pwm', `PWM: ${actuators.peltier.pwm ?? '—'}`);
    }
    _setText('dash-exhaust-pwm',  actuators.exhaustFan?.pwm ?? '—');
    _setText('dash-heatsink-pwm', actuators.heatsinkFan?.pwm ?? '—');
  }

  function renderPower(power) {
    if (!power) return;
    _setText('dash-v', Utils.formatNumber(power.voltage, 2));
    _setText('dash-i', Utils.formatNumber(power.current, 2));
    _setText('dash-p', Utils.formatNumber(power.power,   2));
    _setBadge('dash-power-status', _evalPowerStatus(power.status));
  }

  function renderSelfMonitoring(sm) {
    if (!sm) return;
    const sht31Ok = sm.sht31 === 'OK';
    const mqttOk  = sm.mqtt === 'CONNECTED';
    const safeOn  = Boolean(sm.safeMode);

    _setDot('dash-sys-mqtt', mqttOk);
    _setText('dash-sys-mqtt-text', sm.mqtt || '—');
    _setDot('dash-sys-sensor', sht31Ok);
    _setText('dash-sys-sensor-text', sm.sht31 || '—');
    _setText('dash-sys-safe-text', safeOn ? 'ON' : 'OFF');
    if (el['dash-sys-safe']) {
      el['dash-sys-safe'].className = `w-2 h-2 rounded-full ${
        safeOn ? 'bg-neon-red shadow-glow-red animate-pulse' : 'bg-neon-green shadow-glow-green'
      }`;
    }
  }

  function renderSystemStatusFromHealth(data) {
    const wsConnected = WSClient.isConnected();
    _setDot('dash-sys-ws', wsConnected);
    _setText('dash-sys-ws-text', wsConnected ? 'OK' : 'OFF');

    const badge = el['dash-status'];
    if (!badge) return;
    if (data?.simulation) {
      badge.className = 'scada-badge scada-badge-warn';
      badge.textContent = 'SIMULATION';
    } else if (!wsConnected) {
      badge.className = 'scada-badge scada-badge-err';
      badge.textContent = 'OFFLINE';
    } else {
      badge.className = 'scada-badge scada-badge-ok';
      badge.textContent = 'LIVE';
    }
  }

  function renderAll(state) {
    if (!state) return;
    renderSensors(state.sensors, state.configuration);
    renderActuators(state.actuators);
    renderPower(state.power);
    renderSelfMonitoring(state.selfMonitoring);
  }

  // ----------------------------------------
  // Health poll
  // ----------------------------------------
  let healthInterval = null;
  async function _pollHealth() {
    try {
      const data = await Utils.getJSON('/api/health');
      renderSystemStatusFromHealth(data);
    } catch {
      renderSystemStatusFromHealth(null);
    }
  }

  // ============================================================
  // MANUAL CONTROL (Step 10)
  // ============================================================
  function _setFeedback(cls, text) {
    const node = el['mc-feedback'];
    if (!node) return;
    node.className = `scada-badge ${cls}`;
    node.textContent = text;
  }

  function _logCommand(cmd, value, result) {
    const node = el['mc-last-command'];
    if (!node) return;
    const time = Utils.formatTime(new Date());
    const val = value !== undefined ? ` = ${value}` : '';
    const status = result.ok
      ? (result.data?.simulated ? 'SIM-OK' : (result.data?.success ? 'OK' : 'FAIL'))
      : `HTTP ${result.status}`;
    const msg = result.data?.message || result.data?.error || '';
    node.textContent = `[${time}] ${cmd}${val} → ${status}${msg ? ` — ${msg}` : ''}`;
  }

  async function _sendCommand(command, value) {
    _setFeedback('scada-badge-warn', 'SENDING…');

    const payload = { command };
    if (value !== undefined) payload.value = value;

    try {
      const result = await Utils.postJSON('/api/control', payload);
      _logCommand(command, value, result);

      if (result.ok && result.data?.success) {
        _setFeedback('scada-badge-ok', 'OK');
        setTimeout(() => _setFeedback('scada-badge-idle', 'READY'), 1500);
      } else {
        _setFeedback('scada-badge-err', 'FAILED');
        setTimeout(() => _setFeedback('scada-badge-idle', 'READY'), 2500);
      }
      return result;
    } catch (err) {
      _logCommand(command, value, { ok: false, status: 0, data: { error: err.message } });
      _setFeedback('scada-badge-err', 'ERROR');
      setTimeout(() => _setFeedback('scada-badge-idle', 'READY'), 2500);
      return { ok: false, status: 0, data: { error: err.message } };
    }
  }

  function _bindSlider(sliderId, valId) {
    const slider = el[sliderId];
    const label = el[valId];
    if (!slider || !label) return;
    const update = () => { label.textContent = slider.value; };
    slider.addEventListener('input', update);
    update();
  }

  function setupManualControl() {
    // Cek ada UI manual control
    if (!el['mc-pel-pwm']) return;

    // Slider live label
    _bindSlider('mc-pel-pwm', 'mc-pel-pwm-val');
    _bindSlider('mc-exh-pwm', 'mc-exh-pwm-val');
    _bindSlider('mc-hs-pwm',  'mc-hs-pwm-val');

    // Mode
    el['mc-mode-auto']?.addEventListener('click', () => _sendCommand('SET_MODE', 'auto'));
    el['mc-mode-manual']?.addEventListener('click', () => _sendCommand('SET_MODE', 'manual'));

    // Save
    el['mc-save-config']?.addEventListener('click', () => _sendCommand('SAVE_CONFIG'));

    // Clear Safe
    el['mc-clear-safe']?.addEventListener('click', () => {
      if (confirm('Matikan SAFE_MODE? Sistem akan kembali normal.')) {
        _sendCommand('CLEAR_SAFE_MODE');
      }
    });

    // Emergency Stop
    el['mc-emergency']?.addEventListener('click', () => {
      if (confirm('EMERGENCY STOP?\nPeltier OFF, Exhaust 255, SAFE_MODE ON.')) {
        _sendCommand('EMERGENCY_STOP');
      }
    });

    // Peltier
    el['mc-pel-off']?.addEventListener('click',  () => _sendCommand('SET_PELTIER_MODE', 'OFF'));
    el['mc-pel-cool']?.addEventListener('click', () => _sendCommand('SET_PELTIER_MODE', 'COOLING'));
    el['mc-pel-heat']?.addEventListener('click', () => _sendCommand('SET_PELTIER_MODE', 'HEATING'));
    el['mc-pel-apply']?.addEventListener('click', () => {
      const v = Number(el['mc-pel-pwm'].value);
      _sendCommand('SET_PELTIER_PWM', v);
    });

    // Exhaust
    el['mc-exh-apply']?.addEventListener('click', () => {
      const v = Number(el['mc-exh-pwm'].value);
      _sendCommand('SET_EXHAUST_PWM', v);
    });

    // Heatsink
    el['mc-hs-apply']?.addEventListener('click', () => {
      const v = Number(el['mc-hs-pwm'].value);
      _sendCommand('SET_HEATSINK_PWM', v);
    });
  }

  // ----------------------------------------
  // Mount / Unmount
  // ----------------------------------------
  function mount() {
    if (mounted) return;
    mounted = true;
    _cacheDom();

    console.log('[Dashboard] mount');

    const initial = WSClient.getState();
    if (initial) renderAll(initial);

    _on('state', (state) => renderAll(state));

    _on('update', (msg) => {
      if (msg.section === 'sensors')        renderSensors(msg.data, WSClient.getState()?.configuration);
      else if (msg.section === 'actuators') renderActuators(msg.data);
      else if (msg.section === 'power')     renderPower(msg.data);
      else if (msg.section === 'selfMonitoring') renderSelfMonitoring(msg.data);
    });

    _on('open',  () => renderSystemStatusFromHealth({ simulation: false }));
    _on('close', () => renderSystemStatusFromHealth(null));

    _pollHealth();
    healthInterval = setInterval(_pollHealth, 10000);

    // Manual control binding
    setupManualControl();
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    console.log('[Dashboard] unmount');
    _unsub();
    if (healthInterval) {
      clearInterval(healthInterval);
      healthInterval = null;
    }
    // Event listeners di DOM akan hilang otomatis karena HTML di-replace Router
  }

  return { mount, unmount };
})();

window.Dashboard = Dashboard;
/**
 * ============================================================
 * dashboard.js — Dashboard Page Handler
 * ------------------------------------------------------------
 * Fitur:
 *   - Render semua section realtime via WS
 *   - Badge status: LIVE / ESP32 OFFLINE / BACKEND OFFLINE / SIMULATION
 *   - Manual control (mode, PWM, emergency) dengan UI locking:
 *     AUTO   → tombol Apply/Off/Cool/Heat + slider DISABLED
 *     MANUAL → semua tombol + slider ENABLED
 *   - Subscribe esp32Online untuk deteksi ESP32 putus
 *   - Subscribe systemStatus untuk sync UI mode
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
      'mc-mode-auto', 'mc-mode-manual', 'mc-mode-status',   // ← mc-mode-status BARU
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
  // Status evaluators
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

  // ═══════════════════════════════════════════════════════════════
  // Badge status (header dashboard) — 4 state:
  //   1. BACKEND OFFLINE  (merah)  — WS putus, tidak bisa trust apa pun
  //   2. ESP32 OFFLINE    (kuning) — backend OK, ESP32 tidak report
  //   3. SIMULATION       (kuning) — mode simulasi
  //   4. LIVE             (hijau)  — semua OK
  // ═══════════════════════════════════════════════════════════════
  function renderSystemStatusFromHealth(data) {
    const wsConnected = WSClient.isConnected();
    const state = WSClient.getState();
    const esp32Online = state?.esp32Online !== false;

    _setDot('dash-sys-ws', wsConnected);
    _setText('dash-sys-ws-text', wsConnected ? 'OK' : 'OFF');

    const badge = el['dash-status'];
    if (!badge) return;

    if (!wsConnected) {
      badge.className = 'scada-badge scada-badge-err';
      badge.textContent = 'BACKEND OFFLINE';
      return;
    }

    if (!esp32Online) {
      badge.className = 'scada-badge scada-badge-warn';
      badge.textContent = 'ESP32 OFFLINE';
      return;
    }

    if (data?.simulation) {
      badge.className = 'scada-badge scada-badge-warn';
      badge.textContent = 'SIMULATION';
      return;
    }

    badge.className = 'scada-badge scada-badge-ok';
    badge.textContent = 'LIVE';
  }

  function renderAll(state) {
    if (!state) return;
    renderSensors(state.sensors, state.configuration);
    renderActuators(state.actuators);
    renderPower(state.power);
    renderSelfMonitoring(state.selfMonitoring);
    renderSystemStatusFromHealth({ simulation: false });
  }

  // ============================================================
  // MODE UI LOCKING
  // ============================================================

  /**
   * Set state UI berdasarkan mode aktif:
   *   AUTO   → tombol apply/off/cool/heat + slider DISABLED
   *   MANUAL → semua tombol + slider ENABLED
   *
   * Dipanggil saat:
   *   - mount (sync awal dari state)
   *   - klik AUTO/MANUAL (optimistic)
   *   - terima update systemStatus dari WS (mode berubah dari ESP32)
   */
  function setModeUI(isManual) {
    const btnIds = [
      'mc-pel-off', 'mc-pel-cool', 'mc-pel-heat', 'mc-pel-apply',
      'mc-exh-apply', 'mc-hs-apply'
    ];
    const sliderIds = ['mc-pel-pwm', 'mc-exh-pwm', 'mc-hs-pwm'];

    btnIds.forEach((id) => {
      const btn = el[id];
      if (!btn) return;
      btn.disabled = !isManual;
      btn.classList.toggle('opacity-40', !isManual);
      btn.classList.toggle('cursor-not-allowed', !isManual);
    });

    sliderIds.forEach((id) => {
      const slider = el[id];
      if (!slider) return;
      slider.disabled = !isManual;
      slider.classList.toggle('opacity-40', !isManual);
    });

    // Badge indicator
    const badge = el['mc-mode-status'];
    if (badge) {
      if (isManual) {
        badge.className = 'scada-badge scada-badge-warn text-[10px]';
        badge.textContent = 'MANUAL';
      } else {
        badge.className = 'scada-badge scada-badge-ok text-[10px]';
        badge.textContent = 'AUTO';
      }
    }

    // Highlight tombol mode aktif
    const btnAuto   = el['mc-mode-auto'];
    const btnManual = el['mc-mode-manual'];
    if (btnAuto && btnManual) {
      if (isManual) {
        btnManual.classList.add('bg-neon-cyan/20', 'border-neon-cyan/40', 'text-cyan-200');
        btnManual.classList.remove('bg-navy-700', 'border-slate-700/60');
        btnAuto.classList.remove('bg-neon-cyan/20', 'border-neon-cyan/40', 'text-cyan-200');
        btnAuto.classList.add('bg-navy-700', 'border-slate-700/60');
      } else {
        btnAuto.classList.add('bg-neon-cyan/20', 'border-neon-cyan/40', 'text-cyan-200');
        btnAuto.classList.remove('bg-navy-700', 'border-slate-700/60');
        btnManual.classList.remove('bg-neon-cyan/20', 'border-neon-cyan/40', 'text-cyan-200');
        btnManual.classList.add('bg-navy-700', 'border-slate-700/60');
      }
    }

    console.log(`[Dashboard] Mode UI: ${isManual ? 'MANUAL (unlocked)' : 'AUTO (locked)'}`);
  }

  // ============================================================
  // MANUAL CONTROL
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
    if (!el['mc-pel-pwm']) return;

    _bindSlider('mc-pel-pwm', 'mc-pel-pwm-val');
    _bindSlider('mc-exh-pwm', 'mc-exh-pwm-val');
    _bindSlider('mc-hs-pwm',  'mc-hs-pwm-val');

    // ─────────────────────────────────────────────────────────────
    // Mode toggle — kirim command + sync UI
    //
    // AUTO: setelah backend ack sukses, lock UI (disable manual)
    // MANUAL: setelah backend ack sukses, unlock UI
    //
    // Kalau gagal (timeout / MQTT down), UI tetap di state lama
    // → user bisa retry.
    // ─────────────────────────────────────────────────────────────
    el['mc-mode-auto']?.addEventListener('click', async () => {
      const result = await _sendCommand('SET_MODE', 'auto');
      if (result?.ok && result?.data?.success) {
        setModeUI(false);
      }
    });

    el['mc-mode-manual']?.addEventListener('click', async () => {
      const result = await _sendCommand('SET_MODE', 'manual');
      if (result?.ok && result?.data?.success) {
        setModeUI(true);
      }
    });

    el['mc-save-config']?.addEventListener('click', () => _sendCommand('SAVE_CONFIG'));

    el['mc-clear-safe']?.addEventListener('click', () => {
      if (confirm('Matikan SAFE_MODE? Sistem akan kembali normal.')) {
        _sendCommand('CLEAR_SAFE_MODE');
      }
    });

    el['mc-emergency']?.addEventListener('click', () => {
      if (confirm('EMERGENCY STOP?\nPeltier OFF, Exhaust 255, SAFE_MODE ON.')) {
        _sendCommand('EMERGENCY_STOP');
      }
    });

    // ─────────────────────────────────────────────────────────────
    // Manual PWM commands — guarded oleh disabled state.
    // Kalau tombol disabled, browser tidak trigger click.
    // Tapi sebagai defense-in-depth, cek disabled juga.
    // ─────────────────────────────────────────────────────────────
    el['mc-pel-off']?.addEventListener('click',  () => {
      if (el['mc-pel-off']?.disabled) return;
      _sendCommand('SET_PELTIER_MODE', 'OFF');
    });
    el['mc-pel-cool']?.addEventListener('click', () => {
      if (el['mc-pel-cool']?.disabled) return;
      _sendCommand('SET_PELTIER_MODE', 'COOLING');
    });
    el['mc-pel-heat']?.addEventListener('click', () => {
      if (el['mc-pel-heat']?.disabled) return;
      _sendCommand('SET_PELTIER_MODE', 'HEATING');
    });
    el['mc-pel-apply']?.addEventListener('click', () => {
      if (el['mc-pel-apply']?.disabled) return;
      const v = Number(el['mc-pel-pwm'].value);
      _sendCommand('SET_PELTIER_PWM', v);
    });

    el['mc-exh-apply']?.addEventListener('click', () => {
      if (el['mc-exh-apply']?.disabled) return;
      const v = Number(el['mc-exh-pwm'].value);
      _sendCommand('SET_EXHAUST_PWM', v);
    });

    el['mc-hs-apply']?.addEventListener('click', () => {
      if (el['mc-hs-apply']?.disabled) return;
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

    // ─────────────────────────────────────────────────────────────
    // Sync UI mode awal dari state
    // systemStatus.mode: 0 (auto) / 1 (manual)
    // ─────────────────────────────────────────────────────────────
    const initialMode = initial?.systemStatus?.mode;
    const initialIsManual = (initialMode === 1 || initialMode === 'manual');
    setModeUI(initialIsManual);

    _on('state', (state) => renderAll(state));

    _on('update', (msg) => {
      if (msg.section === 'sensors')        renderSensors(msg.data, WSClient.getState()?.configuration);
      else if (msg.section === 'actuators') renderActuators(msg.data);
      else if (msg.section === 'power')     renderPower(msg.data);
      else if (msg.section === 'selfMonitoring') renderSelfMonitoring(msg.data);
      else if (msg.section === 'esp32Online')    renderSystemStatusFromHealth({ simulation: false });
      else if (msg.section === 'systemStatus') {
        // ═══════════════════════════════════════════════════════════
        // Sync UI mode dari ESP32.
        // ESP32 publish mode lewat TOPIC_STATUS: 0 (auto) / 1 (manual).
        // Saat user lain ubah mode via dashboard lain, atau ESP32
        // sendiri switch mode (misal boot force auto), UI kita ikut.
        // ═══════════════════════════════════════════════════════════
        const mode = msg.data?.mode;
        const isManual = (mode === 1 || mode === 'manual');
        setModeUI(isManual);
      }
    });

    _on('open',  () => renderSystemStatusFromHealth({ simulation: false }));
    _on('close', () => renderSystemStatusFromHealth(null));

    renderSystemStatusFromHealth({ simulation: false });

    setupManualControl();
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    console.log('[Dashboard] unmount');
    _unsub();
  }

  return { mount, unmount };
})();

window.Dashboard = Dashboard;
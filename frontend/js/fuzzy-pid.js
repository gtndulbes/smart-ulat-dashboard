/**
 * ============================================================
 * fuzzy-pid.js — Fuzzy-PID Page Handler
 * ------------------------------------------------------------
 * STEP 8: Render realtime intermediate fuzzy-PID values.
 * STEP 19: + Humidity Interlock badge (dynamic)
 *
 * Data source:
 *   WSClient state.fuzzyPid ← MQTT topic smartulat/fuzzypid
 *   WSClient state.selfMonitoring ← untuk humidity interlock
 * ============================================================
 */

'use strict';

const FuzzyPid = (() => {
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
      // Peltier loop
      'fp-temp-mode', 'fp-temp-actual', 'fp-temp-sp',
      'fp-temp-error', 'fp-temp-de',
      'fp-temp-kp', 'fp-temp-ki', 'fp-temp-kd',
      'fp-temp-dkp', 'fp-temp-dki', 'fp-temp-dkd',
      'fp-temp-pid-out', 'fp-temp-pwm',
      'fp-temp-humlock',                    // ← BARU
      // Fan loops
      'fp-fan-temp-out', 'fp-fan-temp-e', 'fp-fan-temp-de',
      'fp-fan-hum-out',  'fp-fan-hum-e',  'fp-fan-hum-de',
      'fp-fan-nh3-out',  'fp-fan-nh3-e',  'fp-fan-nh3-de',
      // Final
      'fp-fan-final-pct', 'fp-fan-final-pwm'
    ];
    ids.forEach((id) => { el[id] = document.getElementById(id); });
  }

  // ----------------------------------------
  function _set(id, value, decimals = 2) {
    const node = el[id];
    if (!node) return;
    if (value === null || value === undefined || Number.isNaN(value)) {
      node.textContent = '—';
      return;
    }
    if (typeof value === 'number') node.textContent = value.toFixed(decimals);
    else node.textContent = String(value);
  }

  function _setText(id, value) {
    const node = el[id];
    if (!node) return;
    node.textContent = (value === null || value === undefined) ? '—' : String(value);
  }

  function _setSigned(id, value, decimals) {
    const node = el[id];
    if (!node) return;
    if (value === null || value === undefined || Number.isNaN(value)) {
      node.textContent = '—';
      return;
    }
    const sign = value >= 0 ? '+' : '';
    node.textContent = `${sign}${value.toFixed(decimals)}`;
  }

  function _setBadgeMode(id, mode) {
    const node = el[id];
    if (!node) return;
    const m = String(mode || 'OFF').toUpperCase();
    const cls = m === 'COOLING' ? 'scada-badge-ok'
              : m === 'HEATING' ? 'scada-badge-warn'
              : 'scada-badge-idle';
    node.className = `scada-badge ${cls}`;
    node.textContent = m;
  }

  // ----------------------------------------
  // Humidity Interlock Badge (BARU)
  // ----------------------------------------
  function renderHumidityLock(sm) {
    const node = el['fp-temp-humlock'];
    if (!node) return;

    // Cek dari selfMonitoring
    if (sm && sm.humidityInterlock === true) {
      const pct = Math.round((sm.humidityCapFactor ?? 1) * 100);
      node.classList.remove('hidden');
      node.className = 'scada-badge scada-badge-warn flex-shrink-0';
      node.textContent = `💧 HUM LOCK ${pct}%`;
      node.title = `Cooling dibatasi ${pct}% karena RH tinggi (anti-kondensasi)`;
    } else {
      // Sembunyikan kalau tidak aktif
      node.classList.add('hidden');
      node.textContent = '';
      node.removeAttribute('title');
    }
  }

  // ----------------------------------------
  // Renderers
  // ----------------------------------------
  function renderPeltier(p, config) {
    if (!p) {
      // Fallback: hitung dari sensor + setpoint
      const s = WSClient.getState();
      const temp = s?.sensors?.temperature;
      const sp = config?.setpoint?.temperature;
      if (Number.isFinite(temp) && Number.isFinite(sp)) {
        _set('fp-temp-actual', temp, 1);
        _set('fp-temp-sp', sp, 1);
        _set('fp-temp-error', temp - sp, 2);
      }
      return;
    }

    _setBadgeMode('fp-temp-mode', p.mode || 'OFF');
    _set('fp-temp-actual', p.actual, 1);
    _set('fp-temp-sp', p.setpoint, 1);
    _set('fp-temp-error', p.error, 2);
    _set('fp-temp-de', p.deltaError, 2);

    _set('fp-temp-kp', p.kp, 2);
    _set('fp-temp-ki', p.ki, 3);
    _set('fp-temp-kd', p.kd, 2);

    // ΔKp/ΔKi/ΔKd dengan tanda +/-
    _setSigned('fp-temp-dkp', p.dKp, 2);
    _setSigned('fp-temp-dki', p.dKi, 3);
    _setSigned('fp-temp-dkd', p.dKd, 2);

    _set('fp-temp-pid-out', p.pidOutput, 2);
    _set('fp-temp-pwm', p.pwm, 0);
  }

  function renderFan(loopId, data) {
    const map = {
      fanTemp: { out: 'fp-fan-temp-out', e: 'fp-fan-temp-e', de: 'fp-fan-temp-de' },
      fanHum:  { out: 'fp-fan-hum-out',  e: 'fp-fan-hum-e',  de: 'fp-fan-hum-de'  },
      fanNH3:  { out: 'fp-fan-nh3-out',  e: 'fp-fan-nh3-e',  de: 'fp-fan-nh3-de'  }
    };
    const ids = map[loopId];
    if (!ids || !data) return;

    _set(ids.out, data.output, 1);
    _set(ids.e,   data.error, 2);
    _set(ids.de,  data.deltaError, 2);
  }

  function renderFinal(fanFinal) {
    if (!fanFinal) return;
    _set('fp-fan-final-pct', fanFinal.maxOutput, 1);
    _set('fp-fan-final-pwm', fanFinal.pwm, 0);
  }

  function renderAll(fp, config) {
    if (!fp) return;
    renderPeltier(fp.peltier, config);
    renderFan('fanTemp', fp.fanTemp);
    renderFan('fanHum',  fp.fanHum);
    renderFan('fanNH3',  fp.fanNH3);
    renderFinal(fp.fanFinal);
  }

  // ----------------------------------------
  // Mount / Unmount
  // ----------------------------------------
  function mount() {
    if (mounted) return;
    mounted = true;
    _cacheDom();

    console.log('[FuzzyPid] mount');

    // Initial render dari state cache
    const state = WSClient.getState();
    if (state?.fuzzyPid) renderAll(state.fuzzyPid, state.configuration);
    if (state?.selfMonitoring) renderHumidityLock(state.selfMonitoring);

    // Subscribe
    _on('update', (msg) => {
      if (msg.section === 'fuzzyPid') {
        renderAll(msg.data, WSClient.getState()?.configuration);
      } else if (msg.section === 'selfMonitoring') {
        // ← BARU: update humidity interlock badge
        renderHumidityLock(msg.data);
      } else if (msg.section === 'sensors') {
        // Update fallback peltier (biar actual tetap update meski fuzzyPid belum datang)
        const st = WSClient.getState();
        if (!st?.fuzzyPid?.peltier?.actual) {
          renderPeltier(null, st?.configuration);
        }
      }
    });

    _on('initial', (data) => {
      if (data?.fuzzyPid) renderAll(data.fuzzyPid, data.configuration);
      if (data?.selfMonitoring) renderHumidityLock(data.selfMonitoring);
    });
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    console.log('[FuzzyPid] unmount');
    _unsub();
  }

  return { mount, unmount };
})();

window.FuzzyPid = FuzzyPid;
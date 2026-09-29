/**
 * ============================================================
 * configuration.js — Configuration Page Handler
 * ------------------------------------------------------------
 * STEP 11: Form konfigurasi lengkap.
 *
 * Fitur:
 *   - Load config dari /api/config
 *   - Populate ke form
 *   - Track "dirty" state (perubahan belum disave)
 *   - Save → POST /api/config
 *   - Reload dari server
 *   - WS sync: kalau user lain ubah config, form auto-update
 *     (hanya kalau form ini tidak sedang dirty)
 * ============================================================
 */

'use strict';

const Configuration = (() => {
  let mounted = false;
  const subs = [];
  const el = {};
  let dirty = false;
  let lastLoadedConfig = null;

  // ----------------------------------------
  function _on(ev, cb) {
    WSClient.on(ev, cb);
    subs.push([ev, cb]);
  }
  function _unsub() {
    subs.forEach(([ev, cb]) => WSClient.off(ev, cb));
    subs.length = 0;
  }

  // ----------------------------------------
  function _cacheDom() {
    const ids = [
      // badge & buttons
      'cfg-dirty-badge', 'cfg-reload', 'cfg-save',
      // setpoint
      'cfg-sp-temp', 'cfg-sp-hum', 'cfg-sp-nh3', 'cfg-nh3-emerg',
      // pid peltier
      'cfg-peltier-kp', 'cfg-peltier-ki', 'cfg-peltier-kd',
      // pid fan temp
      'cfg-fanT-kp', 'cfg-fanT-ki', 'cfg-fanT-kd',
      // pid fan hum
      'cfg-fanH-kp', 'cfg-fanH-ki', 'cfg-fanH-kd',
      // pid fan nh3
      'cfg-fanN-kp', 'cfg-fanN-ki', 'cfg-fanN-kd',
      // heatsink
      'cfg-hs-min', 'cfg-hs-max', 'cfg-hs-curve',
      // power
      'cfg-v-min', 'cfg-v-max', 'cfg-i-max', 'cfg-p-max'
    ];
    ids.forEach((id) => { el[id] = document.getElementById(id); });
  }

  // ----------------------------------------
  function _setDirty(d) {
    dirty = d;
    const badge = el['cfg-dirty-badge'];
    const saveBtn = el['cfg-save'];
    if (badge) {
      badge.className = `scada-badge ${d ? 'scada-badge-warn' : 'scada-badge-idle'}`;
      badge.textContent = d ? 'MODIFIED' : 'SYNCED';
    }
    if (saveBtn) saveBtn.disabled = !d;
  }

  // ----------------------------------------
  function _val(id) {
    const node = el[id];
    if (!node) return undefined;
    if (node.type === 'number') {
      const v = Number(node.value);
      return Number.isFinite(v) ? v : undefined;
    }
    return node.value;
  }

  function _setInput(id, value) {
    const node = el[id];
    if (!node) return;
    if (value === undefined || value === null) {
      node.value = '';
    } else {
      node.value = value;
    }
  }

  // ----------------------------------------
  function applyConfigToForm(cfg) {
    if (!cfg) return;

    // setpoint
    _setInput('cfg-sp-temp',   cfg.setpoint?.temperature);
    _setInput('cfg-sp-hum',    cfg.setpoint?.humidity);
    _setInput('cfg-sp-nh3',    cfg.setpoint?.nh3);
    _setInput('cfg-nh3-emerg', cfg.setpoint?.nh3Emergency);

    // pid peltier
    _setInput('cfg-peltier-kp', cfg.pid?.peltier?.kp);
    _setInput('cfg-peltier-ki', cfg.pid?.peltier?.ki);
    _setInput('cfg-peltier-kd', cfg.pid?.peltier?.kd);

    // pid fan temp
    _setInput('cfg-fanT-kp', cfg.pid?.fanTemp?.kp);
    _setInput('cfg-fanT-ki', cfg.pid?.fanTemp?.ki);
    _setInput('cfg-fanT-kd', cfg.pid?.fanTemp?.kd);

    // pid fan hum
    _setInput('cfg-fanH-kp', cfg.pid?.fanHum?.kp);
    _setInput('cfg-fanH-ki', cfg.pid?.fanHum?.ki);
    _setInput('cfg-fanH-kd', cfg.pid?.fanHum?.kd);

    // pid fan nh3
    _setInput('cfg-fanN-kp', cfg.pid?.fanNH3?.kp);
    _setInput('cfg-fanN-ki', cfg.pid?.fanNH3?.ki);
    _setInput('cfg-fanN-kd', cfg.pid?.fanNH3?.kd);

    // heatsink
    _setInput('cfg-hs-min',   cfg.heatsink?.minPwm);
    _setInput('cfg-hs-max',   cfg.heatsink?.maxPwm);
    _setInput('cfg-hs-curve', cfg.heatsink?.curve);

    // power
    _setInput('cfg-v-min', cfg.power?.voltageMin);
    _setInput('cfg-v-max', cfg.power?.voltageMax);
    _setInput('cfg-i-max', cfg.power?.currentMax);
    _setInput('cfg-p-max', cfg.power?.powerMax);

    lastLoadedConfig = JSON.parse(JSON.stringify(cfg));
    _setDirty(false);
  }

  function readConfigFromForm() {
    const cfg = {
      setpoint: {
        temperature: _val('cfg-sp-temp'),
        humidity:    _val('cfg-sp-hum'),
        nh3:         _val('cfg-sp-nh3'),
        nh3Emergency:_val('cfg-nh3-emerg')
      },
      pid: {
        peltier: {
          kp: _val('cfg-peltier-kp'),
          ki: _val('cfg-peltier-ki'),
          kd: _val('cfg-peltier-kd')
        },
        fanTemp: {
          kp: _val('cfg-fanT-kp'),
          ki: _val('cfg-fanT-ki'),
          kd: _val('cfg-fanT-kd')
        },
        fanHum: {
          kp: _val('cfg-fanH-kp'),
          ki: _val('cfg-fanH-ki'),
          kd: _val('cfg-fanH-kd')
        },
        fanNH3: {
          kp: _val('cfg-fanN-kp'),
          ki: _val('cfg-fanN-ki'),
          kd: _val('cfg-fanN-kd')
        }
      },
      heatsink: {
        minPwm: _val('cfg-hs-min'),
        maxPwm: _val('cfg-hs-max'),
        curve:  _val('cfg-hs-curve')
      },
      power: {
        voltageMin: _val('cfg-v-min'),
        voltageMax: _val('cfg-v-max'),
        currentMax: _val('cfg-i-max'),
        powerMax:   _val('cfg-p-max')
      }
    };

    // Buang undefined
    function clean(o) {
      if (o === null || o === undefined) return o;
      if (typeof o !== 'object') return o;
      const out = {};
      for (const [k, v] of Object.entries(o)) {
        const cv = clean(v);
        if (cv !== undefined) out[k] = cv;
      }
      return out;
    }
    return clean(cfg);
  }

  // ----------------------------------------
  // Load dari server
  // ----------------------------------------
  async function loadConfig() {
    _setDirty(false);
    try {
      const data = await Utils.getJSON('/api/config');
      applyConfigToForm(data.config);
      console.log('[Configuration] Config dimuat');
    } catch (err) {
      console.error('[Configuration] Gagal load config:', err);
    }
  }

  // ----------------------------------------
  // Save
  // ----------------------------------------
  async function saveConfig() {
    const payload = readConfigFromForm();
    console.log('[Configuration] Save:', payload);

    const btn = el['cfg-save'];
    if (btn) { btn.disabled = true; btn.textContent = '💾 Menyimpan…'; }

    try {
      const result = await Utils.postJSON('/api/config', payload);

      if (result.ok && result.data?.success) {
        // Update lastLoadedConfig dari response
        if (result.data.config) {
          applyConfigToForm(result.data.config);
        }
        _setDirty(false);

        const mqttNote = result.data.mqttSent === false
          ? ' (MQTT belum sync)'
          : '';
        console.log(`[Configuration] ✅ ${result.data.message}${mqttNote}`);

        // Toast-ish feedback
        _showFlash('ok', '✓ Tersimpan' + mqttNote);
      } else {
        const errMsg = result.data?.error || `HTTP ${result.status}`;
        console.warn('[Configuration] Save gagal:', errMsg);
        _showFlash('err', `✗ ${errMsg}`);
      }
    } catch (err) {
      console.error('[Configuration] Save error:', err);
      _showFlash('err', `✗ ${err.message}`);
    } finally {
      if (btn) { btn.disabled = !dirty; btn.textContent = '💾 Simpan ke ESP32'; }
    }
  }

  // ----------------------------------------
  // Flash feedback di badge
  // ----------------------------------------
  function _showFlash(type, text) {
    const badge = el['cfg-dirty-badge'];
    if (!badge) return;
    const cls = type === 'ok' ? 'scada-badge-ok' : 'scada-badge-err';
    badge.className = `scada-badge ${cls}`;
    badge.textContent = text;
    setTimeout(() => {
      badge.className = `scada-badge ${dirty ? 'scada-badge-warn' : 'scada-badge-idle'}`;
      badge.textContent = dirty ? 'MODIFIED' : 'SYNCED';
    }, 2500);
  }

  // ----------------------------------------
  // Bind form change → dirty
  // ----------------------------------------
  function bindDirtyTracking() {
    const ids = [
      'cfg-sp-temp', 'cfg-sp-hum', 'cfg-sp-nh3', 'cfg-nh3-emerg',
      'cfg-peltier-kp', 'cfg-peltier-ki', 'cfg-peltier-kd',
      'cfg-fanT-kp', 'cfg-fanT-ki', 'cfg-fanT-kd',
      'cfg-fanH-kp', 'cfg-fanH-ki', 'cfg-fanH-kd',
      'cfg-fanN-kp', 'cfg-fanN-ki', 'cfg-fanN-kd',
      'cfg-hs-min', 'cfg-hs-max', 'cfg-hs-curve',
      'cfg-v-min', 'cfg-v-max', 'cfg-i-max', 'cfg-p-max'
    ];

    ids.forEach((id) => {
      const node = el[id];
      if (!node) return;
      node.addEventListener('input', () => _setDirty(true));
      node.addEventListener('change', () => _setDirty(true));
    });
  }

  function bindButtons() {
    el['cfg-reload']?.addEventListener('click', () => {
      if (dirty && !confirm('Ada perubahan yang belum disave. Yakin reload?')) return;
      loadConfig();
    });

    el['cfg-save']?.addEventListener('click', () => saveConfig());
  }

  // ----------------------------------------
  // Mount / Unmount
  // ----------------------------------------
  function mount() {
    if (mounted) return;
    mounted = true;
    _cacheDom();

    console.log('[Configuration] mount');

    // Cek form ada
    if (!el['cfg-sp-temp']) {
      console.warn('[Configuration] Form tidak ditemukan');
      mounted = false;
      return;
    }

    bindButtons();
    bindDirtyTracking();

    // Load awal dari REST
    loadConfig();

    // WS sync — kalau user lain ubah, update form (kalau tidak dirty)
    _on('config', (newCfg) => {
      console.log('[Configuration] Config dari WS (user lain)');
      if (!dirty) applyConfigToForm(newCfg);
      else _showFlash('err', '! Server config berubah');
    });

    // 'update' event juga bisa bawa configuration section
    _on('update', (msg) => {
      if (msg.section === 'configuration') {
        if (!dirty) applyConfigToForm(msg.data);
      }
    });
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    console.log('[Configuration] unmount');
    _unsub();
  }

  return { mount, unmount };
})();

window.Configuration = Configuration;
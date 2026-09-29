/**
 * ============================================================
 * power.js — Power Page Handler
 * ------------------------------------------------------------
 * STEP 9: Halaman Power Monitoring (INA219).
 *
 * Fitur:
 *   - Realtime V/I/P dari state.power
 *   - Status badge (NORMAL / WARNING / CRITICAL / SENSOR_ERROR)
 *   - Threshold info dari configuration.power
 *   - Chart trend V/I/P (RingBuffer)
 * ============================================================
 */

'use strict';

const Power = (() => {
  let mounted = false;
  const subs = [];
  const el = {};

  let chart = null;
  let buf = null;
  let updateTimer = null;

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
      'power-v', 'power-i', 'power-p',
      'power-status',
      'power-v-min', 'power-v-max', 'power-i-max', 'power-p-max'
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
    node.textContent = Number(value).toFixed(decimals);
  }

  function _setText(id, value) {
    const node = el[id];
    if (!node) return;
    node.textContent = (value === null || value === undefined) ? '—' : String(value);
  }

  function _setStatusBadge(status) {
    const node = el['power-status'];
    if (!node) return;
    const map = {
      NORMAL:       { cls: 'scada-badge-ok',   text: 'NORMAL' },
      WARNING:      { cls: 'scada-badge-warn', text: 'WARNING' },
      CRITICAL:     { cls: 'scada-badge-err',  text: 'CRITICAL' },
      SENSOR_ERROR: { cls: 'scada-badge-err',  text: 'SENSOR ERROR' },
      UNKNOWN:      { cls: 'scada-badge-idle', text: 'UNKNOWN' }
    };
    const s = map[status] || map.UNKNOWN;
    node.className = `scada-badge ${s.cls}`;
    node.textContent = s.text;
  }

  // ----------------------------------------
  // Render
  // ----------------------------------------
  function renderThresholds(config) {
    const p = config?.power;
    if (!p) return;
    _setText('power-v-min', p.voltageMin);
    _setText('power-v-max', p.voltageMax);
    _setText('power-i-max', p.currentMax);
    _setText('power-p-max', p.powerMax);
  }

  function renderPower(power) {
    if (!power) return;
    _set('power-v', power.voltage, 2);
    _set('power-i', power.current, 2);
    _set('power-p', power.power,   2);
    _setStatusBadge(power.status);
  }

  // ----------------------------------------
  // Chart
  // ----------------------------------------
  function initChart() {
    if (typeof Chart === 'undefined') return;
    const canvas = document.getElementById('chart-power-page');
    if (!canvas) return;

    buf = {
      voltage: new RingBuffer(3600),
      current: new RingBuffer(3600),
      power:   new RingBuffer(3600)
    };

    const opts = Charts.baseOptions();
    opts.scales.y.title = { display: true, text: 'V / A', color: '#64748b', font: { size: 10 } };
    opts.scales.y2 = {
      type: 'linear',
      position: 'right',
      grid: { drawOnChartArea: false },
      border: { color: 'rgba(148,163,184,0.15)' },
      ticks: { color: '#64748b', font: { size: 10, family: 'JetBrains Mono' } },
      title: { display: true, text: 'W', color: '#64748b', font: { size: 10 } }
    };

    chart = Charts.create('chart-power-page', {
      type: 'line',
      data: {
        datasets: [
          Charts.makeLineDataset('Voltage (V)', Charts.COLOR.voltage, { yAxisID: 'y' }),
          Charts.makeLineDataset('Current (A)', Charts.COLOR.current, { yAxisID: 'y', fill: false }),
          Charts.makeLineDataset('Power (W)',   Charts.COLOR.power,   { yAxisID: 'y2' })
        ]
      },
      options: opts
    });
  }

  function pushToBuffer(power) {
    if (!buf || !power) return;
    const t = Date.now();
    if (Number.isFinite(power.voltage)) buf.voltage.push({ x: t, y: power.voltage });
    if (Number.isFinite(power.current)) buf.current.push({ x: t, y: power.current });
    if (Number.isFinite(power.power))   buf.power.push({ x: t, y: power.power });
    scheduleRefresh();
  }

  function refreshChart() {
    if (!chart || !buf) return;
    const rangeMs = 5 * 60 * 1000;
    chart.data.datasets[0].data = buf.voltage.sliceByAge(rangeMs);
    chart.data.datasets[1].data = buf.current.sliceByAge(rangeMs);
    chart.data.datasets[2].data = buf.power.sliceByAge(rangeMs);
    chart.update('none');
  }

  function scheduleRefresh() {
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      refreshChart();
    }, 500);
  }

  // ----------------------------------------
  function renderAll(state) {
    if (!state) return;
    renderThresholds(state.configuration);
    renderPower(state.power);
  }

  // ----------------------------------------
  function mount() {
    if (mounted) return;
    mounted = true;
    _cacheDom();

    console.log('[Power] mount');

    // Initial render
    const state = WSClient.getState();
    renderAll(state);
    if (state?.power) pushToBuffer(state.power);

    // Chart
    initChart();

    // Subscribe
    _on('update', (msg) => {
      if (msg.section === 'power') {
        renderPower(msg.data);
        pushToBuffer(msg.data);
      } else if (msg.section === 'configuration') {
        renderThresholds(msg.data);
      }
    });

    _on('initial', (data) => renderAll(data));
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    console.log('[Power] unmount');

    if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
    _unsub();
    Charts.destroy(chart); chart = null;
    buf = null;
  }

  return { mount, unmount };
})();

window.Power = Power;
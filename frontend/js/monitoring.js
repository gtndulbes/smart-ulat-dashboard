/**
 * ============================================================
 * monitoring.js — Monitoring Page Handler
 * ============================================================
 */

'use strict';

const Monitoring = (() => {
  let mounted = false;
  const subs = [];
  const charts = { env: null, act: null, pow: null };
  let currentRangeMs = 5 * 60 * 1000;
  let updateTimer = null;
  let buf = null;
  let resizeTimer = null;
  let lastBreakpoint = null;

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
  function initBuffers() {
    const CAP = 3600;
    buf = {
      temp:     new RingBuffer(CAP),
      hum:      new RingBuffer(CAP),
      nh3:      new RingBuffer(CAP),
      peltier:  new RingBuffer(CAP),
      exhaust:  new RingBuffer(CAP),
      heatsink: new RingBuffer(CAP),
      voltage:  new RingBuffer(CAP),
      current:  new RingBuffer(CAP),
      power:    new RingBuffer(CAP)
    };
  }

  // ----------------------------------------
  function _bpKey() {
    return Charts.isMobile() ? 'mobile' : (Charts.isTablet() ? 'tablet' : 'desktop');
  }

  // ----------------------------------------
  function initCharts() {
    const TICK_COLOR = '#64748b';

    // ENV
    const envOpts = Charts.baseOptions();
    envOpts.scales.y.title = { display: !Charts.isMobile(), text: '°C / ppm', color: TICK_COLOR, font: { size: 10 } };
    envOpts.scales.y2 = {
      type: 'linear',
      position: 'right',
      grid: { drawOnChartArea: false },
      border: { color: 'rgba(148,163,184,0.15)' },
      ticks: {
        color: TICK_COLOR,
        font: { size: Charts.isMobile() ? 9 : 10, family: 'JetBrains Mono' },
        maxTicksLimit: Charts.isMobile() ? 5 : 8
      },
      title: { display: !Charts.isMobile(), text: '%RH', color: TICK_COLOR, font: { size: 10 } }
    };

    charts.env = Charts.create('chart-environment', {
      type: 'line',
      data: {
        datasets: [
          Charts.makeLineDataset('Temperature (°C)', Charts.COLOR.temp, { yAxisID: 'y' }),
          Charts.makeLineDataset('Humidity (%RH)',   Charts.COLOR.hum,  { yAxisID: 'y2', fill: false }),
          Charts.makeLineDataset('NH₃ (ppm)',        Charts.COLOR.nh3,  { yAxisID: 'y' })
        ]
      },
      options: envOpts
    });

    // ACT
    const actOpts = Charts.baseOptions();
    actOpts.scales.y.min = 0;
    actOpts.scales.y.max = 255;
    actOpts.scales.y.title = { display: !Charts.isMobile(), text: 'PWM', color: TICK_COLOR, font: { size: 10 } };

    charts.act = Charts.create('chart-actuator', {
      type: 'line',
      data: {
        datasets: [
          Charts.makeLineDataset('Peltier PWM',  Charts.COLOR.peltier),
          Charts.makeLineDataset('Exhaust PWM',  Charts.COLOR.exhaust),
          Charts.makeLineDataset('Heatsink PWM', Charts.COLOR.heatsink)
        ]
      },
      options: actOpts
    });

    // POW
    const powOpts = Charts.baseOptions();
    powOpts.scales.y.title = { display: !Charts.isMobile(), text: 'V / A', color: TICK_COLOR, font: { size: 10 } };
    powOpts.scales.y2 = {
      type: 'linear',
      position: 'right',
      grid: { drawOnChartArea: false },
      border: { color: 'rgba(148,163,184,0.15)' },
      ticks: {
        color: TICK_COLOR,
        font: { size: Charts.isMobile() ? 9 : 10, family: 'JetBrains Mono' },
        maxTicksLimit: Charts.isMobile() ? 5 : 8
      },
      title: { display: !Charts.isMobile(), text: 'W', color: TICK_COLOR, font: { size: 10 } }
    };

    charts.pow = Charts.create('chart-power', {
      type: 'line',
      data: {
        datasets: [
          Charts.makeLineDataset('Voltage (V)', Charts.COLOR.voltage, { yAxisID: 'y' }),
          Charts.makeLineDataset('Current (A)', Charts.COLOR.current, { yAxisID: 'y', fill: false }),
          Charts.makeLineDataset('Power (W)',   Charts.COLOR.power,   { yAxisID: 'y2' })
        ]
      },
      options: powOpts
    });

    // Animation off
    [charts.env, charts.act, charts.pow].forEach((c) => {
      if (c) c.options.animation = { duration: 0 };
    });

    lastBreakpoint = _bpKey();
  }

  // ----------------------------------------
  function destroyCharts() {
    Charts.destroy(charts.env); charts.env = null;
    Charts.destroy(charts.act); charts.act = null;
    Charts.destroy(charts.pow); charts.pow = null;
  }

  // ----------------------------------------
  function pushSensors(s) {
    if (!s || !buf) return;
    const t = Date.now();
    if (Number.isFinite(s.temperature)) buf.temp.push({ x: t, y: s.temperature });
    if (Number.isFinite(s.humidity))    buf.hum.push({ x: t, y: s.humidity });
    if (Number.isFinite(s.nh3))         buf.nh3.push({ x: t, y: s.nh3 });
  }
  function pushActuators(a) {
    if (!a || !buf) return;
    const t = Date.now();
    if (Number.isFinite(a.peltier?.pwm))     buf.peltier.push({ x: t, y: a.peltier.pwm });
    if (Number.isFinite(a.exhaustFan?.pwm))  buf.exhaust.push({ x: t, y: a.exhaustFan.pwm });
    if (Number.isFinite(a.heatsinkFan?.pwm)) buf.heatsink.push({ x: t, y: a.heatsinkFan.pwm });
  }
  function pushPower(p) {
    if (!p || !buf) return;
    const t = Date.now();
    if (Number.isFinite(p.voltage)) buf.voltage.push({ x: t, y: p.voltage });
    if (Number.isFinite(p.current)) buf.current.push({ x: t, y: p.current });
    if (Number.isFinite(p.power))   buf.power.push({ x: t, y: p.power });
  }

  // ----------------------------------------
  function refreshCharts() {
    if (!buf) return;
    const ms = currentRangeMs;

    if (charts.env) {
      charts.env.data.datasets[0].data = buf.temp.sliceByAge(ms);
      charts.env.data.datasets[1].data = buf.hum.sliceByAge(ms);
      charts.env.data.datasets[2].data = buf.nh3.sliceByAge(ms);
      charts.env.update('none');
    }
    if (charts.act) {
      charts.act.data.datasets[0].data = buf.peltier.sliceByAge(ms);
      charts.act.data.datasets[1].data = buf.exhaust.sliceByAge(ms);
      charts.act.data.datasets[2].data = buf.heatsink.sliceByAge(ms);
      charts.act.update('none');
    }
    if (charts.pow) {
      charts.pow.data.datasets[0].data = buf.voltage.sliceByAge(ms);
      charts.pow.data.datasets[1].data = buf.current.sliceByAge(ms);
      charts.pow.data.datasets[2].data = buf.power.sliceByAge(ms);
      charts.pow.update('none');
    }
  }

  function scheduleRefresh() {
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      refreshCharts();
    }, 500);
  }

  // ----------------------------------------
  function setupRangeButtons() {
    const btns = document.querySelectorAll('.range-btn');
    if (!btns.length) return;

    btns.forEach((btn) => {
      btn.addEventListener('click', () => {
        btns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const sec = parseInt(btn.dataset.range, 10);
        if (Number.isFinite(sec)) {
          currentRangeMs = sec * 1000;
          refreshCharts();
        }
      });
    });
  }

  // ----------------------------------------
  function handleResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;

      const newBp = _bpKey();
      if (newBp !== lastBreakpoint) {
        console.log(`[Monitoring] breakpoint ${lastBreakpoint} → ${newBp} — reinit charts`);
        // Destroy & re-init supaya legend & tick font adjust
        const state = WSClient.getState();
        destroyCharts();
        initCharts();
        if (state) {
          if (state.sensors)   pushSensors(state.sensors);
          if (state.actuators) pushActuators(state.actuators);
          if (state.power)     pushPower(state.power);
        }
        refreshCharts();
      } else {
        // Same breakpoint — cukup update responsive opts
        Charts.updateResponsiveOptions(charts.env);
        Charts.updateResponsiveOptions(charts.act);
        Charts.updateResponsiveOptions(charts.pow);
      }
    }, 300);
  }

  // ----------------------------------------
  function mount() {
    if (mounted) return;
    mounted = true;

    console.log('[Monitoring] mount');

    if (!document.getElementById('chart-environment')) {
      console.warn('[Monitoring] canvas tidak ditemukan');
      mounted = false;
      return;
    }
    if (typeof Chart === 'undefined') {
      console.error('[Monitoring] Chart.js belum dimuat!');
      mounted = false;
      return;
    }

    initBuffers();
    initCharts();
    setupRangeButtons();

    // Listen resize
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);

    // Seed
    const initial = WSClient.getState();
    if (initial) {
      if (initial.sensors)   pushSensors(initial.sensors);
      if (initial.actuators) pushActuators(initial.actuators);
      if (initial.power)     pushPower(initial.power);
    }

    _on('update', (msg) => {
      if (msg.section === 'sensors')        pushSensors(msg.data);
      else if (msg.section === 'actuators') pushActuators(msg.data);
      else if (msg.section === 'power')     pushPower(msg.data);
      scheduleRefresh();
    });

    refreshCharts();
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;

    console.log('[Monitoring] unmount');

    if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }

    window.removeEventListener('resize', handleResize);
    window.removeEventListener('orientationchange', handleResize);

    _unsub();
    destroyCharts();
    buf = null;
    lastBreakpoint = null;
  }

  return { mount, unmount };
})();

window.Monitoring = Monitoring;
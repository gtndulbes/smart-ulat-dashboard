/**
 * ============================================================
 * charts.js — Chart.js Wrapper + Ring Buffer
 * ============================================================
 */

'use strict';

const Charts = (() => {
  // ----------------------------------------
  // Color palette
  // ----------------------------------------
  const COLOR = {
    temp:     { border: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
    hum:      { border: '#06b6d4', bg: 'rgba(6,182,212,0.15)'  },
    nh3:      { border: '#a855f7', bg: 'rgba(168,85,247,0.15)' },
    peltier:  { border: '#ef4444', bg: 'rgba(239,68,68,0.15)'  },
    exhaust:  { border: '#22d3ee', bg: 'rgba(34,211,238,0.15)' },
    heatsink: { border: '#84cc16', bg: 'rgba(132,204,22,0.15)' },
    voltage:  { border: '#3b82f6', bg: 'rgba(59,130,246,0.15)' },
    current:  { border: '#f97316', bg: 'rgba(249,115,22,0.15)' },
    power:    { border: '#10b981', bg: 'rgba(16,185,129,0.15)' }
  };

  const GRID_COLOR = 'rgba(148,163,184,0.08)';
  const TICK_COLOR = '#64748b';
  const FONT_MONO  = 'JetBrains Mono';

  // ----------------------------------------
  // Breakpoint helper
  // ----------------------------------------
  const BP_MOBILE = 640;   // sm
  const BP_TABLET = 1024;  // lg

  function isMobile() {
    return typeof window !== 'undefined' && window.innerWidth < BP_MOBILE;
  }
  function isTablet() {
    return typeof window !== 'undefined' &&
           window.innerWidth >= BP_MOBILE &&
           window.innerWidth < BP_TABLET;
  }

  // ----------------------------------------
  // Dataset
  // ----------------------------------------
  function makeLineDataset(label, color, opts = {}) {
    return {
      label,
      data: [],
      borderColor: color.border,
      backgroundColor: color.bg,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: color.border,
      pointHoverBorderColor: '#0b1220',
      pointHoverBorderWidth: 2,
      tension: 0.3,
      fill: opts.fill !== false,
      yAxisID: opts.yAxisID || 'y',
      spanGaps: true,
      ...opts
    };
  }

  // ----------------------------------------
  // Legend config — responsive
  // ----------------------------------------
  function _legendConfig() {
    const mobile  = isMobile();
    const tablet  = isTablet();

    return {
      display: true,
      // Mobile: bawah (banyak ruang vertikal, mudah tap)
      // Desktop: atas-kanan (tidak ganggu grafik)
      position: mobile ? 'bottom' : 'top',
      align: mobile ? 'start' : 'end',

      // Full width di mobile, tidak di desktop
      fullSize: mobile,

      labels: {
        color: '#cbd5e1',
        font: {
          size: mobile ? 10 : (tablet ? 11 : 11),
          family: 'Inter',
          weight: '500'
        },
        // Touch target lebih besar di mobile
        boxWidth: mobile ? 12 : 10,
        boxHeight: mobile ? 12 : 10,
        padding: mobile ? 10 : 12,
        usePointStyle: true,
        pointStyle: 'circle',
        // Tidak truncate text
        textAlign: 'left'
      },

      // Padding dari border chart
      // (Chart.js v4: gunakan padding pada legend langsung)
      rtl: false
    };
  }

  // ----------------------------------------
  // Base options
  // ----------------------------------------
  function baseOptions(opts = {}) {
    const mobile = isMobile();

    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      normalized: true,
      parsing: false,

      // Touch: mode 'index' lebih ramah di mobile
      interaction: {
        mode: mobile ? 'index' : 'nearest',
        axis: 'x',
        intersect: false
      },

      // Layout padding di mobile
      layout: {
        padding: mobile
          ? { top: 4, right: 6, bottom: 0, left: 4 }
          : { top: 4, right: 8, bottom: 0, left: 4 }
      },

      plugins: {
        legend: _legendConfig(),

        tooltip: {
          backgroundColor: 'rgba(7,11,20,0.96)',
          borderColor: 'rgba(6,182,212,0.35)',
          borderWidth: 1,
          titleColor: '#e2e8f0',
          bodyColor: '#cbd5e1',
          titleFont: { family: FONT_MONO, size: mobile ? 10 : 11, weight: '600' },
          bodyFont: { family: FONT_MONO, size: mobile ? 10 : 11 },
          padding: mobile ? 8 : 10,
          cornerRadius: 6,
          displayColors: true,
          callbacks: {
            title: (items) => {
              if (!items.length) return '';
              const d = new Date(items[0].parsed.x);
              return d.toLocaleTimeString('id-ID', { hour12: false });
            },
            label: (item) => {
              const v = item.parsed.y;
              const label = item.dataset.label || '';
              const formatted = (v === null || v === undefined || isNaN(v))
                ? '—'
                : Number(v).toFixed(2);
              return `${label}: ${formatted}`;
            }
          }
        }
      },

      scales: {
        x: {
          type: 'time',
          time: {
            unit: 'second',
            displayFormats: {
              millisecond: 'HH:mm:ss',
              second: 'HH:mm:ss',
              minute: 'HH:mm',
              hour: 'HH:mm'
            },
            tooltipFormat: 'HH:mm:ss'
          },
          grid: { color: GRID_COLOR, drawTicks: false },
          border: { color: 'rgba(148,163,184,0.15)' },
          ticks: {
            color: TICK_COLOR,
            font: { size: mobile ? 9 : 10, family: FONT_MONO },
            maxRotation: 0,
            autoSkipPadding: mobile ? 30 : 20,
            maxTicksLimit: mobile ? 4 : 8
          }
        },

        y: {
          type: 'linear',
          position: 'left',
          grid: { color: GRID_COLOR, drawTicks: false },
          border: { color: 'rgba(148,163,184,0.15)' },
          ticks: {
            color: TICK_COLOR,
            font: { size: mobile ? 9 : 10, family: FONT_MONO },
            padding: mobile ? 4 : 6,
            maxTicksLimit: mobile ? 5 : 8
          },
          ...(opts.y || {})
        }
      }
    };
  }

  // ----------------------------------------
  // Create chart
  // ----------------------------------------
  function create(canvasId, options) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) {
      console.warn(`[Charts] canvas #${canvasId} tidak ditemukan`);
      return null;
    }
    const ctx = canvas.getContext('2d');
    try {
      return new Chart(ctx, options);
    } catch (err) {
      console.error(`[Charts] gagal create chart #${canvasId}:`, err);
      return null;
    }
  }

  function destroy(chart) {
    if (!chart) return;
    try { chart.destroy(); } catch (e) { /* noop */ }
  }

  /**
   * Update legend/axis options sesuai breakpoint sekarang.
   * Dipanggil saat resize melewati breakpoint.
   */
  function updateResponsiveOptions(chart) {
    if (!chart || !chart.options) return;

    const mobile = isMobile();

    // Legend
    if (chart.options.plugins?.legend) {
      chart.options.plugins.legend.position = mobile ? 'bottom' : 'top';
      chart.options.plugins.legend.align = mobile ? 'start' : 'end';
      chart.options.plugins.legend.fullSize = mobile;

      const labels = chart.options.plugins.legend.labels;
      if (labels) {
        labels.boxWidth = mobile ? 12 : 10;
        labels.boxHeight = mobile ? 12 : 10;
        labels.padding = mobile ? 10 : 12;
        if (labels.font) labels.font.size = mobile ? 10 : 11;
      }
    }

    // Scales
    if (chart.options.scales) {
      const sx = chart.options.scales.x;
      if (sx?.ticks) {
        sx.ticks.font = { size: mobile ? 9 : 10, family: FONT_MONO };
        sx.ticks.maxTicksLimit = mobile ? 4 : 8;
      }
      const sy = chart.options.scales.y;
      if (sy?.ticks) {
        sy.ticks.font = { size: mobile ? 9 : 10, family: FONT_MONO };
        sy.ticks.maxTicksLimit = mobile ? 5 : 8;
      }
    }

    try { chart.update('none'); } catch (e) { /* noop */ }
  }

  return {
    COLOR,
    makeLineDataset,
    baseOptions,
    create,
    destroy,
    updateResponsiveOptions,
    isMobile,
    isTablet
  };
})();

// ============================================================
// RingBuffer
// ============================================================
class RingBuffer {
  constructor(capacity = 3600) {
    this.capacity = capacity;
    this.data = [];
  }
  push(point) {
    this.data.push(point);
    if (this.data.length > this.capacity) this.data.shift();
  }
  sliceByAge(maxAgeMs) {
    if (!maxAgeMs || maxAgeMs <= 0) return this.data.slice();
    const cutoff = Date.now() - maxAgeMs;
    let i = 0;
    while (i < this.data.length && this.data[i].x < cutoff) i++;
    return this.data.slice(i);
  }
  size() { return this.data.length; }
  clear() { this.data = []; }
}

window.Charts = Charts;
window.RingBuffer = RingBuffer;
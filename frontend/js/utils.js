'use strict';

const Utils = {
  $(id) { return document.getElementById(id); },
  $$(selector) { return document.querySelectorAll(selector); },

  pad2(n) { return String(n).padStart(2, '0'); },

  formatTime(date = new Date()) {
    return `${this.pad2(date.getHours())}:${this.pad2(date.getMinutes())}:${this.pad2(date.getSeconds())}`;
  },

  formatDate(date = new Date()) {
    const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
    const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
    return `${days[date.getDay()]}, ${this.pad2(date.getDate())} ${months[date.getMonth()]} ${date.getFullYear()}`;
  },

  formatUptime(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  },

  formatNumber(n, decimals = 1) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return Number(n).toFixed(decimals);
  },

  setBadge(node, cls, text) {
    if (!node) return;
    node.className = `scada-badge ${cls}`;
    node.textContent = text;
  },

  // ============================================================
  // FETCH dengan timeout + retry + error handling
  // ============================================================
  /**
   * Fetch dengan timeout (AbortController).
   * @param {string} url
   * @param {object} opts — { method, headers, body, timeoutMs, retries }
   */
  async fetchWithTimeout(url, opts = {}) {
    const {
      method = 'GET',
      headers = {},
      body,
      timeoutMs = 10000,
      retries = 0,
      retryDelayMs = 1000
    } = opts;

    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, {
          method,
          headers,
          body,
          signal: controller.signal,
          cache: 'no-store'
        });
        clearTimeout(timer);
        return res;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;

        const isAbort = err.name === 'AbortError';
        const isNetwork = err.name === 'TypeError';

        // Jangan retry kalau bukan timeout / network error
        if (!isAbort && !isNetwork) throw err;

        if (attempt < retries) {
          console.warn(`[fetch] retry ${attempt + 1}/${retries} for ${url} (${err.message})`);
          await new Promise((r) => setTimeout(r, retryDelayMs * Math.pow(2, attempt)));
        }
      }
    }

    if (lastErr?.name === 'AbortError') {
      throw new Error(`Timeout ${timeoutMs}ms — ${url}`);
    }
    throw lastErr || new Error('Unknown fetch error');
  },

  async getJSON(url, opts = {}) {
    const res = await this.fetchWithTimeout(url, {
      method: 'GET',
      timeoutMs: 10000,
      retries: 1,
      ...opts
    });
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errBody = await res.json();
        if (errBody?.message || errBody?.error) {
          errMsg = errBody.message || errBody.error;
        }
      } catch { /* noop */ }
      throw new Error(errMsg);
    }
    return res.json();
  },

  async postJSON(url, body, opts = {}) {
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 15000,
      retries: 0,   // POST tidak auto-retry (bisa double-execute)
      ...opts
    });
    let data = null;
    try { data = await res.json(); } catch { /* noop */ }
    return { ok: res.ok, status: res.status, data };
  },

  async fetchHTML(url) {
    const res = await this.fetchWithTimeout(url, {
      method: 'GET',
      timeoutMs: 8000,
      retries: 2,
      retryDelayMs: 500
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res.text();
  },

  // ============================================================
  // Utility lain
  // ============================================================
  debounce(fn, wait = 200) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  },

  throttle(fn, wait = 200) {
    let last = 0;
    return function (...args) {
      const now = Date.now();
      if (now - last < wait) return;
      last = now;
      fn.apply(this, args);
    };
  },

  toggleClass(node, cls, on) {
    if (!node) return;
    if (on) node.classList.add(cls);
    else node.classList.remove(cls);
  },

  // Escape HTML untuk injeksi ke innerHTML
  escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
};

window.Utils = Utils;
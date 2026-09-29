/**
 * ============================================================
 * history.js — History Page Handler
 * ============================================================
 */

'use strict';

const History = (() => {
  let mounted = false;
  let loading = false;

  const state = {
    page: 1,
    limit: 50,
    from: '',
    to: '',
    search: '',
    sheet: 'Log',
    rows: [],
    headers: [],
    pagination: { page: 1, totalPages: 1, total: 0, hasMore: false },
    error: null,
    simulated: false,
    empty: false,
    emptyReason: null
  };

  const el = {};

  function _cacheDom() {
    const ids = [
      'hist-date-from', 'hist-date-to', 'hist-search',
      'hist-apply-filter', 'hist-tbody',
      'hist-page', 'hist-total-pages',
      'hist-prev', 'hist-next',
      'hist-export-csv', 'hist-export-xlsx', 'hist-open-sheet'
    ];
    ids.forEach((id) => { el[id] = document.getElementById(id); });
  }

  // ----------------------------------------
  // Fetch
  // ----------------------------------------
  async function fetchHistory() {
    if (loading) return;
    loading = true;

    const params = new URLSearchParams({
      sheet: state.sheet,
      page: String(state.page),
      limit: String(state.limit)
    });
    if (state.from)   params.set('from', state.from);
    if (state.to)     params.set('to', state.to);
    if (state.search) params.set('search', state.search);

    _renderLoading();

    try {
      const data = await Utils.getJSON(`/api/history?${params.toString()}`);

      if (!data.success) {
        state.error = data.error || 'Gagal load data';
        state.rows = [];
        state.headers = [];
        _renderError(state.error);
        return;
      }

      state.rows = data.rows || [];
      state.headers = data.headers || Object.keys(state.rows[0] || {});
      state.pagination = data.pagination || { page: 1, totalPages: 1, total: 0 };
      state.simulated = Boolean(data.simulated);
      state.empty = state.rows.length === 0;
      state.error = null;

      _renderTable();
      _renderPagination();
    } catch (err) {
      state.error = err.message;
      _renderError(err.message);
    } finally {
      loading = false;
    }
  }

  // ----------------------------------------
  // Render: loading
  // ----------------------------------------
  function _renderLoading() {
    if (!el['hist-tbody']) return;
    el['hist-tbody'].innerHTML = `
      <tr>
        <td colspan="10" class="px-3 py-12 text-center text-slate-500">
          <div class="inline-flex items-center gap-3">
            <div class="w-2 h-2 rounded-full bg-neon-cyan animate-pulse"></div>
            <span class="text-sm">Memuat data…</span>
          </div>
        </td>
      </tr>
    `;
  }

  // ----------------------------------------
  // Render: error
  // ----------------------------------------
  function _renderError(msg) {
    if (!el['hist-tbody']) return;
    el['hist-tbody'].innerHTML = `
      <tr>
        <td colspan="10" class="px-3 py-12 text-center">
          <p class="text-red-300 text-sm mb-1">✗ Gagal memuat data</p>
          <p class="text-slate-500 text-xs font-mono">${Utils.escapeHtml(msg)}</p>
        </td>
      </tr>
    `;
    if (el['hist-page']) el['hist-page'].textContent = '—';
    if (el['hist-total-pages']) el['hist-total-pages'].textContent = '—';
    if (el['hist-prev']) el['hist-prev'].disabled = true;
    if (el['hist-next']) el['hist-next'].disabled = true;
  }

  // ----------------------------------------
  // Render: table
  // ----------------------------------------
  function _renderTable() {
    const tbody = el['hist-tbody'];
    if (!tbody) return;

    // ----------------------------------------
    // Empty state — data kosong
    // ----------------------------------------
    if (state.rows.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" class="px-3 py-16 text-center">
            <div class="inline-flex flex-col items-center gap-3 max-w-md mx-auto">
              <div class="w-14 h-14 rounded-full bg-navy-700 border border-slate-700/60 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
              </div>
              <div>
                <p class="text-slate-300 text-sm font-medium">Belum ada data historis</p>
                <p class="text-slate-500 text-xs mt-1">
                  ${state.search
                    ? 'Tidak ada data yang cocok dengan filter. Coba ubah kata kunci atau tanggal.'
                    : 'Data akan muncul setelah ESP32 terhubung dan logging ke Google Sheets.'}
                </p>
              </div>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    // ----------------------------------------
    // Data ada → render tabel
    // ----------------------------------------
    const displayCols = [
      'Timestamp', 'Temperature (°C)', 'Humidity (%RH)', 'NH3 (ppm)',
      'Voltage (V)', 'Current (A)', 'Power (W)',
      'Peltier Status', 'Peltier PWM', 'Exhaust PWM', 'Heatsink PWM',
      'System Status'
    ];

    const html = state.rows.map((row) => {
      const cells = displayCols.map((col) => {
        let v = row[col];
        if (v === undefined || v === null || v === '') v = '—';

        if (col === 'Timestamp') {
          return `<td class="px-3 py-2 font-mono text-[11px] text-slate-300 whitespace-nowrap">${Utils.escapeHtml(v)}</td>`;
        }
        if (col === 'System Status') {
          const isSafe = String(v).toUpperCase() === 'SAFE_MODE';
          const cls = isSafe ? 'scada-badge-err' : 'scada-badge-ok';
          return `<td class="px-3 py-2 text-right"><span class="scada-badge ${cls}">${Utils.escapeHtml(v)}</span></td>`;
        }
        if (col === 'Peltier Status') {
          const cls = v === 'COOLING' ? 'scada-badge-ok'
                    : v === 'HEATING' ? 'scada-badge-warn'
                    : 'scada-badge-idle';
          return `<td class="px-3 py-2 text-right"><span class="scada-badge ${cls}">${Utils.escapeHtml(v)}</span></td>`;
        }
        if (typeof v === 'number' || /^-?\d/.test(String(v))) {
          return `<td class="px-3 py-2 text-right font-mono text-slate-300">${Utils.escapeHtml(v)}</td>`;
        }
        return `<td class="px-3 py-2 text-slate-300">${Utils.escapeHtml(v)}</td>`;
      }).join('');

      return `<tr class="border-b border-slate-800/40 hover:bg-navy-700/30">${cells}</tr>`;
    }).join('');

    tbody.innerHTML = html;
  }

  // ----------------------------------------
  // Render: pagination
  // ----------------------------------------
  function _renderPagination() {
    const p = state.pagination;
    if (el['hist-page']) el['hist-page'].textContent = p.page;
    if (el['hist-total-pages']) el['hist-total-pages'].textContent = p.totalPages;
    if (el['hist-prev']) el['hist-prev'].disabled = p.page <= 1;
    if (el['hist-next']) el['hist-next'].disabled = !p.hasMore && p.page >= p.totalPages;
  }

  // ----------------------------------------
  // Actions
  // ----------------------------------------
  function applyFilter() {
    state.from = el['hist-date-from']?.value || '';
    state.to = el['hist-date-to']?.value || '';
    state.search = el['hist-search']?.value.trim() || '';
    state.page = 1;
    fetchHistory();
  }

  function goPrev() {
    if (state.page <= 1) return;
    state.page -= 1;
    fetchHistory();
  }

  function goNext() {
    if (state.page >= state.pagination.totalPages) return;
    state.page += 1;
    fetchHistory();
  }

  // ----------------------------------------
  // Export CSV
  // ----------------------------------------
  function exportCSV() {
    if (state.rows.length === 0) {
      alert('Tidak ada data untuk di-export.');
      return;
    }

    const cols = state.headers.length ? state.headers : Object.keys(state.rows[0]);
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const lines = [];
    lines.push(cols.map(escape).join(','));
    state.rows.forEach((r) => {
      lines.push(cols.map((c) => escape(r[c])).join(','));
    });

    const csv = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smart-ulat-history-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportXLSX() {
    if (state.rows.length === 0) {
      alert('Tidak ada data untuk di-export.');
      return;
    }

    const cols = state.headers.length ? state.headers : Object.keys(state.rows[0]);
    const lines = [cols.join('\t')];
    state.rows.forEach((r) => {
      lines.push(cols.map((c) => String(r[c] ?? '')).join('\t'));
    });

    const tsv = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([tsv], { type: 'application/vnd.ms-excel' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smart-ulat-history-${ts}.xls`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function openGoogleSheet() {
    alert('Buka Google Sheet secara manual di Google Drive Anda.');
  }

  // ----------------------------------------
  // Bind events
  // ----------------------------------------
  function bindEvents() {
    el['hist-apply-filter']?.addEventListener('click', applyFilter);

    el['hist-search']?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyFilter();
    });

    el['hist-prev']?.addEventListener('click', goPrev);
    el['hist-next']?.addEventListener('click', goNext);
    el['hist-export-csv']?.addEventListener('click', exportCSV);
    el['hist-export-xlsx']?.addEventListener('click', exportXLSX);
    el['hist-open-sheet']?.addEventListener('click', (e) => {
      e.preventDefault();
      openGoogleSheet();
    });

    // Default tanggal: 7 hari terakhir
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    if (el['hist-date-from'] && !el['hist-date-from'].value) {
      el['hist-date-from'].value = fmt(weekAgo);
    }
    if (el['hist-date-to'] && !el['hist-date-to'].value) {
      el['hist-date-to'].value = fmt(today);
    }
  }

  // ----------------------------------------
  // Mount / Unmount
  // ----------------------------------------
  function mount() {
    if (mounted) return;
    mounted = true;
    _cacheDom();

    console.log('[History] mount');

    if (!el['hist-tbody']) {
      console.warn('[History] tabel tidak ditemukan');
      mounted = false;
      return;
    }

    state.page = 1;
    state.rows = [];
    state.headers = [];
    state.error = null;

    bindEvents();

    state.from = el['hist-date-from']?.value || '';
    state.to = el['hist-date-to']?.value || '';
    state.search = el['hist-search']?.value.trim() || '';

    fetchHistory();
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    console.log('[History] unmount');
  }

  return { mount, unmount, refresh: fetchHistory };
})();

window.History = History;
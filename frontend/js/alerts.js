/**
 * ============================================================
 * alerts.js — Alert / Notification System (Frontend)
 * ------------------------------------------------------------
 * STEP 14:
 *   - Toast notifikasi (pojok kanan atas)
 *   - Notification center (bell icon di navbar)
 *   - Persist di localStorage (max 50)
 *   - Mark read / clear all
 *   - Sound (optional) & auto-dismiss
 * ============================================================
 */

'use strict';

const Alerts = (() => {
  const STORAGE_KEY = 'smartulat:alerts';
  const MAX_ALERTS = 50;
  const TOAST_DURATION_MS = {
    INFO:     4000,
    WARNING:  6000,
    CRITICAL: 10000
  };

  // ----------------------------------------
  // State
  // ----------------------------------------
  let items = [];              // array alert (terbaru dulu)
  let mounted = false;
  let dropdownOpen = false;

  // ----------------------------------------
  // Utils
  // ----------------------------------------
  function _uid() {
    return `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function _severityClass(sev) {
    const s = String(sev || 'INFO').toUpperCase();
    if (s === 'CRITICAL') return 'scada-badge-err';
    if (s === 'WARNING')  return 'scada-badge-warn';
    return 'scada-badge-idle';
  }

  function _severityIcon(sev) {
    const s = String(sev || 'INFO').toUpperCase();
    if (s === 'CRITICAL') return '🚨';
    if (s === 'WARNING')  return '⚠️';
    return 'ℹ️';
  }

  function _severityBorder(sev) {
    const s = String(sev || 'INFO').toUpperCase();
    if (s === 'CRITICAL') return 'border-l-red-500';
    if (s === 'WARNING')  return 'border-l-amber-500';
    return 'border-l-slate-500';
  }

  // ----------------------------------------
  // Persistence
  // ----------------------------------------
  function _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) items = parsed.slice(0, MAX_ALERTS);
    } catch (err) {
      console.warn('[Alerts] gagal load storage:', err);
    }
  }

  function _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ALERTS)));
    } catch (err) {
      console.warn('[Alerts] gagal save storage:', err);
    }
  }

  // ----------------------------------------
  // Add alert baru (dari WS)
  // ----------------------------------------
  function add(raw) {
    if (!raw) return;

    const alert = {
      id: raw.id || _uid(),
      severity: String(raw.severity || 'INFO').toUpperCase(),
      title: raw.title || 'Alert',
      message: raw.message || '',
      timestamp: raw.timestamp || new Date().toISOString(),
      read: false
    };

    // Dedup by id (kalau sudah ada, skip)
    if (items.some((x) => x.id === alert.id)) return;

    items.unshift(alert);
    if (items.length > MAX_ALERTS) items = items.slice(0, MAX_ALERTS);

    _save();
    _updateBadge();

    // Toast
    _showToast(alert);

    // Kalau dropdown sedang terbuka, re-render
    if (dropdownOpen) _renderDropdown();

    // Update unread badge title
    _updateDocTitle();

    return alert;
  }

  // ----------------------------------------
  // Mark read / clear
  // ----------------------------------------
  function markRead(id) {
    const a = items.find((x) => x.id === id);
    if (a) { a.read = true; _save(); _updateBadge(); }
    if (dropdownOpen) _renderDropdown();
    _updateDocTitle();
  }

  function markAllRead() {
    items.forEach((a) => { a.read = true; });
    _save();
    _updateBadge();
    if (dropdownOpen) _renderDropdown();
    _updateDocTitle();
  }

  function clearAll() {
    items = [];
    _save();
    _updateBadge();
    if (dropdownOpen) _renderDropdown();
    _updateDocTitle();
  }

  function remove(id) {
    items = items.filter((x) => x.id !== id);
    _save();
    _updateBadge();
    if (dropdownOpen) _renderDropdown();
  }

  function unreadCount() {
    return items.filter((a) => !a.read).length;
  }

  // ----------------------------------------
  // Toast
  // ----------------------------------------
  function _showToast(alert) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `pointer-events-auto scada-card border-l-4 ${_severityBorder(alert.severity)} shadow-lg flex items-start gap-3 transform transition-all duration-300 translate-x-full`;
    toast.innerHTML = `
      <div class="text-lg leading-none">${_severityIcon(alert.severity)}</div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <p class="text-xs uppercase tracking-widest text-slate-500">${alert.severity}</p>
          <span class="text-[10px] text-slate-600 font-mono">${_formatTime(alert.timestamp)}</span>
        </div>
        <p class="text-sm font-semibold text-slate-100 mt-0.5">${_escape(alert.title)}</p>
        <p class="text-xs text-slate-400 mt-0.5">${_escape(alert.message)}</p>
      </div>
      <button class="text-slate-500 hover:text-slate-200 text-lg leading-none" data-dismiss>&times;</button>
    `;

    const dismiss = toast.querySelector('[data-dismiss]');
    if (dismiss) {
      dismiss.addEventListener('click', () => _dismissToast(toast));
    }

    container.appendChild(toast);

    // Trigger slide-in
    requestAnimationFrame(() => {
      toast.classList.remove('translate-x-full');
      toast.classList.add('translate-x-0');
    });

    // Auto dismiss
    const duration = TOAST_DURATION_MS[alert.severity] ?? 5000;
    setTimeout(() => _dismissToast(toast), duration);

    // Limit jumlah toast visible (max 4)
    while (container.children.length > 4) {
      container.removeChild(container.firstChild);
    }
  }

  function _dismissToast(toast) {
    if (!toast || !toast.parentNode) return;
    toast.classList.add('translate-x-full', 'opacity-0');
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }

  function _formatTime(iso) {
    try {
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    } catch {
      return '';
    }
  }

  function _escape(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ----------------------------------------
  // Notification center (dropdown)
  // ----------------------------------------
  function _toggleDropdown() {
    dropdownOpen = !dropdownOpen;
    const el = document.getElementById('notifDropdown');
    if (!el) return;
    if (dropdownOpen) {
      el.classList.remove('hidden');
      _renderDropdown();
      // Close on click outside
      setTimeout(() => {
        document.addEventListener('click', _onDocClick, { once: true });
      }, 0);
    } else {
      el.classList.add('hidden');
    }
  }

  function _onDocClick(e) {
    const el = document.getElementById('notifDropdown');
    const btn = document.getElementById('bellBtn');
    if (!el || el.classList.contains('hidden')) return;
    if (el.contains(e.target) || (btn && btn.contains(e.target))) {
      // Re-attach listener kalau click di dalam
      setTimeout(() => {
        document.addEventListener('click', _onDocClick, { once: true });
      }, 0);
      return;
    }
    dropdownOpen = false;
    el.classList.add('hidden');
  }

  function _renderDropdown() {
    const el = document.getElementById('notifList');
    if (!el) return;

    if (items.length === 0) {
      el.innerHTML = `
        <div class="px-4 py-8 text-center text-slate-500 text-sm">
          Tidak ada notifikasi
        </div>
      `;
      return;
    }

    el.innerHTML = items.map((a) => `
      <div class="px-3 py-2.5 border-b border-slate-800/60 ${a.read ? 'opacity-60' : ''} hover:bg-navy-700/40 group cursor-pointer" data-id="${a.id}">
        <div class="flex items-start gap-2.5">
          <div class="text-base leading-none mt-0.5">${_severityIcon(a.severity)}</div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="scada-badge ${_severityClass(a.severity)}">${a.severity}</span>
              <span class="text-[10px] text-slate-500 font-mono ml-auto">${_formatTime(a.timestamp)}</span>
            </div>
            <p class="text-xs font-semibold text-slate-200 mt-1">${_escape(a.title)}</p>
            <p class="text-[11px] text-slate-400 mt-0.5">${_escape(a.message)}</p>
          </div>
          <button class="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-300 transition" data-remove>&times;</button>
        </div>
      </div>
    `).join('');

    // Bind clicks
    el.querySelectorAll('[data-id]').forEach((row) => {
      const id = row.dataset.id;
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-remove]')) return;
        markRead(id);
      });
      const removeBtn = row.querySelector('[data-remove]');
      if (removeBtn) {
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          remove(id);
        });
      }
    });
  }

  // ----------------------------------------
  // Badge & title
  // ----------------------------------------
  function _updateBadge() {
    const badge = document.getElementById('bellBadge');
    if (!badge) return;
    const n = unreadCount();
    if (n > 0) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  function _updateDocTitle() {
    const n = unreadCount();
    const baseTitle = 'Smart Ulat Hongkong';
    if (n > 0) document.title = `(${n}) ${baseTitle}`;
    else document.title = baseTitle;
  }

  // ----------------------------------------
  // Wire WSClient
  // ----------------------------------------
  function _wireWS() {
    if (typeof WSClient === 'undefined') return;

    // Alert individual (rawat toast + add)
    WSClient.on('alert', (alert) => {
      add(alert);
    });

    // Sync awal dari initial state
    WSClient.on('initial', (state) => {
      if (state?.alerts && Array.isArray(state.alerts)) {
        // Merge dengan local — yang belum ada di local, add silent
        state.alerts.forEach((a) => {
          if (!items.some((x) => x.id === a.id)) {
            items.push({
              id: a.id || _uid(),
              severity: String(a.severity || 'INFO').toUpperCase(),
              title: a.title || 'Alert',
              message: a.message || '',
              timestamp: a.timestamp || new Date().toISOString(),
              read: Boolean(a.read)
            });
          }
        });
        items.sort((x, y) => new Date(y.timestamp) - new Date(x.timestamp));
        if (items.length > MAX_ALERTS) items = items.slice(0, MAX_ALERTS);
        _save();
        _updateBadge();
        _updateDocTitle();
        if (dropdownOpen) _renderDropdown();
      }
    });

    // Update dari section 'alerts' — sinkron penuh (kalau user lain clear)
    WSClient.on('update', (msg) => {
      if (msg.section === 'alerts' && Array.isArray(msg.data)) {
        // Merge: server menang untuk field read
        const map = new Map(items.map((x) => [x.id, x]));
        msg.data.forEach((s) => {
          const existing = map.get(s.id);
          if (existing) existing.read = Boolean(s.read);
        });
        _save();
        _updateBadge();
        _updateDocTitle();
      }
    });
  }

  // ----------------------------------------
  // Mount / Init
  // ----------------------------------------
  function init() {
    if (mounted) return;
    mounted = true;

    _load();
    _updateBadge();
    _updateDocTitle();

    // Bell button
    const btn = document.getElementById('bellBtn');
    if (btn) btn.addEventListener('click', _toggleDropdown);

    // Mark all read
    const markBtn = document.getElementById('notifMarkAll');
    if (markBtn) markBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      markAllRead();
    });

    // Clear all
    const clearBtn = document.getElementById('notifClearAll');
    if (clearBtn) clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Hapus semua notifikasi?')) clearAll();
    });

    _wireWS();

    console.log(`[Alerts] initialized — ${items.length} alert(s) tersimpan`);
  }

  // ----------------------------------------
  // Public API
  // ----------------------------------------
  return {
    init,
    add,
    markRead,
    markAllRead,
    clearAll,
    remove,
    unreadCount,
    getAll: () => items.slice()
  };
})();

window.Alerts = Alerts;
'use strict';

(() => {
  const HEALTH_ENDPOINT = '/api/health';
  const HEALTH_INTERVAL_MS = 10000;

  const el = {
    clockTime:    Utils.$('clockTime'),
    clockDate:    Utils.$('clockDate'),
    serverDot:    Utils.$('serverDot'),
    serverLabel:  Utils.$('serverLabel'),
    wsDot:        Utils.$('wsDot'),
    wsLabel:      Utils.$('wsLabel'),
    menuBtn:      Utils.$('menuBtn'),
    sidebar:      Utils.$('sidebar'),
    sidebarClose: Utils.$('sidebarCloseBtn'),
    overlay:      Utils.$('drawerOverlay')
  };

  // ============================================================
  // DRAWER LOGIC v2
  // ============================================================
  function isMobile() {
    return window.matchMedia('(max-width: 767px)').matches;
  }

  function openDrawer() {
    if (!el.sidebar) return;
    el.sidebar.classList.add('drawer-open');
    if (el.overlay) el.overlay.classList.add('active');
    document.body.classList.add('drawer-locked');
    // Focus trap minimal — fokus ke tombol close
    setTimeout(() => el.sidebarClose?.focus?.(), 100);
  }

  function closeDrawer() {
    if (!el.sidebar) return;
    el.sidebar.classList.remove('drawer-open');
    if (el.overlay) el.overlay.classList.remove('active');
    document.body.classList.remove('drawer-locked');
    // Kembalikan fokus ke tombol menu
    if (isMobile()) el.menuBtn?.focus?.();
  }

  function toggleDrawer() {
    if (!el.sidebar) return;
    if (el.sidebar.classList.contains('drawer-open')) closeDrawer();
    else openDrawer();
  }

  function setupSidebarToggle() {
    if (!el.menuBtn) return;

    // Toggle button
    el.menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDrawer();
    });

    // Close button di drawer
    if (el.sidebarClose) {
      el.sidebarClose.addEventListener('click', (e) => {
        e.stopPropagation();
        closeDrawer();
      });
    }

    // Klik overlay → tutup
    if (el.overlay) {
      el.overlay.addEventListener('click', closeDrawer);
    }

    // ESC → tutup
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDrawer();
    });

    // Auto-close saat pindah halaman
    if (el.sidebar) {
      el.sidebar.querySelectorAll('[data-route]').forEach((link) => {
        link.addEventListener('click', () => {
          if (isMobile()) closeDrawer();
        });
      });
    }

    // Resize: pastikan drawer state konsisten
    window.addEventListener('resize', Utils.debounce(() => {
      if (!isMobile()) {
        // Desktop: pastikan drawer tertutup & unlock body
        el.sidebar?.classList.remove('drawer-open');
        el.overlay?.classList.remove('active');
        document.body.classList.remove('drawer-locked');
      }
    }, 150));
  }

  // ============================================================
  // PAGE MODULE REGISTRY
  // ============================================================
  function getPageModule(routeName) {
    switch (routeName) {
      case 'dashboard':       return window.Dashboard       || null;
      case 'monitoring':      return window.Monitoring      || null;
      case 'fuzzy-pid':       return window.FuzzyPid        || null;
      case 'power':           return window.Power           || null;
      case 'self-monitoring': return window.SelfMonitoring  || null;
      case 'history':         return window.History         || null;
      case 'configuration':   return window.Configuration   || null;
      default: return null;
    }
  }

  let currentPageModule = null;

  function onPageChanged({ name }) {
    if (currentPageModule && currentPageModule.unmount) {
      try { currentPageModule.unmount(); } catch (e) { console.warn('[App] unmount error:', e); }
    }

    closeDrawer();   // pastikan drawer tertutup saat pindah halaman

    const mod = getPageModule(name);
    if (mod && mod.mount) {
      try { mod.mount(); currentPageModule = mod; }
      catch (e) { console.error('[App] mount error:', e); currentPageModule = null; }
    } else {
      currentPageModule = null;
    }
  }

  // ============================================================
  // CLOCK
  // ============================================================
  function startClock() {
    const tick = () => {
      const now = new Date();
      if (el.clockTime) el.clockTime.textContent = Utils.formatTime(now);
      if (el.clockDate) el.clockDate.textContent = Utils.formatDate(now);
    };
    tick();
    setInterval(tick, 1000);
  }

  // ============================================================
  // HEALTH POLL
  // ============================================================
  async function checkHealth() {
    try {
      await Utils.getJSON(HEALTH_ENDPOINT, { timeoutMs: 5000, retries: 0 });
      if (el.serverDot) el.serverDot.className = 'w-2 h-2 rounded-full bg-neon-green shadow-glow-green';
      if (el.serverLabel) {
        el.serverLabel.textContent = 'SERVER OK';
        el.serverLabel.className = 'text-[11px] font-mono tracking-wide text-emerald-300';
      }
    } catch (err) {
      if (el.serverDot) el.serverDot.className = 'w-2 h-2 rounded-full bg-neon-red shadow-glow-red';
      if (el.serverLabel) {
        el.serverLabel.textContent = 'SERVER ERR';
        el.serverLabel.className = 'text-[11px] font-mono tracking-wide text-red-300';
      }
    }
  }

  function startHealthPolling() {
    checkHealth();
    setInterval(checkHealth, HEALTH_INTERVAL_MS);
  }

  // ============================================================
  // WEBSOCKET
  // ============================================================
  function updateWsIndicator(state) {
    if (!el.wsDot || !el.wsLabel) return;
    const map = {
      open:         { cls: 'w-2 h-2 rounded-full bg-neon-green shadow-glow-green', label: 'WS OK',   color: 'text-emerald-300' },
      reconnecting: { cls: 'w-2 h-2 rounded-full bg-neon-orange animate-pulse',    label: 'WS…',    color: 'text-amber-300'   },
      closed:       { cls: 'w-2 h-2 rounded-full bg-neon-red',                     label: 'WS OFF', color: 'text-red-300'     }
    };
    const s = map[state] || map.closed;
    el.wsDot.className = s.cls;
    el.wsLabel.textContent = s.label;
    el.wsLabel.className = `text-[11px] font-mono tracking-wide ${s.color}`;
  }

  function setupWebSocket() {
    if (typeof WSClient === 'undefined') return;
    WSClient.on('open',         () => updateWsIndicator('open'));
    WSClient.on('reconnecting', () => updateWsIndicator('reconnecting'));
    WSClient.on('close',        () => updateWsIndicator('reconnecting'));
    WSClient.connect();
    updateWsIndicator('reconnecting');
  }

  // ============================================================
  // GLOBAL HANDLERS
  // ============================================================
  function setupGlobalErrorHandlers() {
    window.addEventListener('error', (e) => {
      if (e.filename && !e.filename.includes(location.origin)) return;
      const msg = e.error?.message || e.message || 'Runtime error';
      console.error('[GlobalError]', msg);
      if (typeof Alerts !== 'undefined' && Alerts.add) {
        Alerts.add({ severity: 'WARNING', title: 'JavaScript Error', message: msg.slice(0, 120), timestamp: new Date().toISOString() });
      }
    });

    window.addEventListener('unhandledrejection', (e) => {
      const msg = e.reason?.message || String(e.reason) || 'Promise rejection';
      console.error('[UnhandledRejection]', msg);
      if (typeof Alerts !== 'undefined' && Alerts.add) {
        Alerts.add({ severity: 'WARNING', title: 'Async Error', message: msg.slice(0, 120), timestamp: new Date().toISOString() });
      }
    });
  }

  function setupNetworkDetector() {
    window.addEventListener('online', () => {
      checkHealth();
      if (typeof WSClient !== 'undefined' && !WSClient.isConnected()) WSClient.connect();
    });
    window.addEventListener('offline', () => {
      if (el.serverDot) el.serverDot.className = 'w-2 h-2 rounded-full bg-neon-red shadow-glow-red';
      if (el.serverLabel) {
        el.serverLabel.textContent = 'OFFLINE';
        el.serverLabel.className = 'text-[11px] font-mono tracking-wide text-red-300';
      }
    });
  }

  function setupGlobalResize() {
    const handler = Utils.debounce(() => {
      if (typeof Chart !== 'undefined' && Chart.instances) {
        try {
          Object.values(Chart.instances).forEach((chart) => {
            if (chart && !chart.destroyed && typeof chart.resize === 'function') chart.resize();
          });
        } catch { /* noop */ }
      }
      if (currentPageModule && typeof currentPageModule.resize === 'function') {
        try { currentPageModule.resize(); } catch { /* noop */ }
      }
    }, 250);
    window.addEventListener('resize', handler);
    window.addEventListener('orientationchange', () => setTimeout(handler, 400));
  }

  function setupVisibilityHandler() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        checkHealth();
        if (typeof WSClient !== 'undefined' && !WSClient.isConnected()) WSClient.connect();
      }
    });
  }

  // ============================================================
  // INIT
  // ============================================================
  function init() {
    console.log('%c[Smart Ulat Hongkong] STEP 18 — Integration Test', 'color:#06b6d4;font-weight:bold');
    console.log(`[App] Viewport: ${window.innerWidth}x${window.innerHeight}`);

    setupGlobalErrorHandlers();
    setupNetworkDetector();
    startClock();
    setupSidebarToggle();
    startHealthPolling();
    setupWebSocket();

    if (typeof MqttState !== 'undefined') MqttState.init();

    setupGlobalResize();
    setupVisibilityHandler();

    if (typeof Alerts !== 'undefined') Alerts.init();

    if (typeof Router !== 'undefined') {
      Router.on('pageChanged', onPageChanged);
      Router.init();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
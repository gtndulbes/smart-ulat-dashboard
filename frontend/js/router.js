/**
 * ============================================================
 * router.js — Hash-based Router (Frontend)
 * ------------------------------------------------------------
 * Fitur:
 *   - Route hash: #/dashboard, #/monitoring, #/fuzzy-pid, dst
 *   - Fetch fragment dari pages/*.html
 *   - Inject ke #pageContent
 *   - Update sidebar active state
 *   - Loading state + error handling
 *   - Emit event saat page berubah
 *
 * Cara pakai:
 *   Router.on('pageChanged', ({ name }) => {...});
 *   Router.init();       // otomatis handle hashchange
 * ============================================================
 */

'use strict';

const Router = (() => {
  // ----------------------------------------
  // Konfigurasi
  // ----------------------------------------
  const DEFAULT_ROUTE = 'dashboard';

  // Daftar route yang dikenal
  const ROUTES = {
    'dashboard':       { title: 'Dashboard',       file: '/pages/dashboard.html' },
    'monitoring':      { title: 'Monitoring',      file: '/pages/monitoring.html' },
    'fuzzy-pid':       { title: 'Fuzzy-PID',       file: '/pages/fuzzy-pid.html' },
    'power':           { title: 'Power',           file: '/pages/power.html' },
    'self-monitoring': { title: 'Self-Monitoring', file: '/pages/self-monitoring.html' },
    'history':         { title: 'History',         file: '/pages/history.html' },
    'configuration':   { title: 'Configuration',   file: '/pages/configuration.html' }
  };

  // ----------------------------------------
  // State
  // ----------------------------------------
  let currentRoute = null;
  let pageContainer = null;
  const listeners = {};

  // ----------------------------------------
  // Event emitter
  // ----------------------------------------
  function on(event, cb) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(cb);
  }

  function off(event, cb) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter((fn) => fn !== cb);
  }

  function emit(event, payload) {
    (listeners[event] || []).forEach((cb) => {
      try { cb(payload); } catch (e) { console.error('[Router] listener error:', e); }
    });
  }

  // ----------------------------------------
  // Parse hash → route name
  // ----------------------------------------
  function getRouteFromHash() {
    const hash = (location.hash || '').replace(/^#\/?/, '').trim();
    const name = hash || DEFAULT_ROUTE;
    return ROUTES[name] ? name : DEFAULT_ROUTE;
  }

  // ----------------------------------------
  // Update active nav
  // ----------------------------------------
  function setActiveNav(routeName) {
    document.querySelectorAll('[data-route]').forEach((el) => {
      const isActive = el.dataset.route === routeName;
      el.classList.toggle('active', isActive);
    });
  }

  // ----------------------------------------
  // Update document title
  // ----------------------------------------
  function setTitle(routeName) {
    const route = ROUTES[routeName];
    const title = route ? route.title : 'Dashboard';
    document.title = `${title} — Smart Ulat Hongkong`;
    const headerEl = document.getElementById('pageTitle');
    if (headerEl) headerEl.textContent = title;
  }

  // ----------------------------------------
  // Show loading
  // ----------------------------------------
  function showLoading() {
    if (!pageContainer) return;
    pageContainer.innerHTML = `
      <div class="flex items-center justify-center py-20">
        <div class="flex items-center gap-3 text-slate-400">
          <div class="w-2 h-2 rounded-full bg-neon-cyan animate-pulse"></div>
          <span class="text-sm">Memuat halaman…</span>
        </div>
      </div>
    `;
  }

  // ----------------------------------------
  // Show error
  // ----------------------------------------
  function showError(err, routeName) {
    if (!pageContainer) return;
    pageContainer.innerHTML = `
      <div class="scada-card">
        <p class="scada-label text-red-400">Error</p>
        <h2 class="scada-title">Gagal memuat halaman</h2>
        <p class="text-sm text-slate-400 mt-3">
          Halaman <code class="font-mono text-red-300">${routeName}</code> tidak dapat dimuat.
        </p>
        <p class="text-xs text-slate-500 mt-2 font-mono">${err?.message || 'Unknown error'}</p>
        <button onclick="Router.reload()"
                class="mt-4 px-3 py-1.5 rounded-md bg-navy-700 hover:bg-navy-600 border border-slate-700/60 text-xs">
          ↻ Coba lagi
        </button>
      </div>
    `;
  }

  // ----------------------------------------
  // Load page
  // ----------------------------------------
  async function loadPage(routeName) {
    const route = ROUTES[routeName];
    if (!route) return;

    showLoading();
    setActiveNav(routeName);
    setTitle(routeName);

    // Scroll ke atas
    window.scrollTo({ top: 0, behavior: 'smooth' });

    try {
      const html = await Utils.fetchHTML(route.file);
      pageContainer.innerHTML = html;

      currentRoute = routeName;

      // Emit event — Step 6+ akan listen untuk wiring per halaman
      emit('pageChanged', { name: routeName, route });
      emit(`page:${routeName}`, { name: routeName, route });

      // Log
      console.log(`[Router] Loaded page: ${routeName}`);
    } catch (err) {
      console.error(`[Router] Gagal load ${route.file}:`, err);
      showError(err, routeName);
      emit('pageError', { name: routeName, error: err });
    }
  }

  // ----------------------------------------
  // Handle hash change
  // ----------------------------------------
  function handleHashChange() {
    const routeName = getRouteFromHash();
    if (routeName === currentRoute) return;
    loadPage(routeName);
  }

  // ----------------------------------------
  // Navigate (programmatic)
  // ----------------------------------------
  function navigate(routeName) {
    if (!ROUTES[routeName]) {
      console.warn(`[Router] Route tidak dikenal: ${routeName}`);
      return;
    }
    location.hash = `#/${routeName}`;
  }

  // ----------------------------------------
  // Reload halaman sekarang
  // ----------------------------------------
  function reload() {
    const routeName = getRouteFromHash();
    currentRoute = null;
    loadPage(routeName);
  }

  // ----------------------------------------
  // Init
  // ----------------------------------------
  function init() {
    pageContainer = Utils.$('pageContent');
    if (!pageContainer) {
      console.error('[Router] #pageContent tidak ditemukan di index.html');
      return;
    }

    // Setup nav links
    document.querySelectorAll('[data-route]').forEach((el) => {
      el.addEventListener('click', (e) => {
        // Klik link normal juga harus close sidebar (mobile)
        const sidebar = Utils.$('sidebar');
        if (sidebar && window.innerWidth < 768) {
          sidebar.classList.add('hidden');
          sidebar.classList.remove('flex');
        }
      });
    });

    // Listen hash change
    window.addEventListener('hashchange', handleHashChange);

    // Load route pertama
    const initial = getRouteFromHash();
    if (!location.hash) {
      location.hash = `#/${initial}`;
    }
    loadPage(initial);

    console.log('[Router] Initialized');
  }

  // ----------------------------------------
  // Public API
  // ----------------------------------------
  return {
    init,
    navigate,
    reload,
    on,
    off,
    getCurrent: () => currentRoute,
    getRoutes: () => ({ ...ROUTES })
  };
})();

window.Router = Router;
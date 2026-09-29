/**
 * ============================================================
 * service-worker.js
 * ------------------------------------------------------------
 * PWA Service Worker — full implementation
 *
 * Strategi cache:
 *   - /api/*       → network only (jangan cache, harus fresh)
 *   - /ws          → skip (WebSocket tidak boleh di-cache)
 *   - navigate     → network-first, fallback offline.html
 *   - /pages/*.html → stale-while-revalidate
 *   - static (css, js, assets) → cache-first dengan background update
 *   - external fonts → cache-first (long TTL)
 *
 * Fitur:
 *   - Precache app shell saat install
 *   - Cleanup cache lama saat activate
 *   - Message channel untuk skipWaiting dari client
 *   - Background sync (kalau diperlukan di masa depan)
 * ============================================================
 */

'use strict';

// ------------------------------------------------------------
// Versioning — bump saat deploy supaya cache lama dihapus
// ------------------------------------------------------------
const CACHE_VERSION = 'v16';
const CACHE_STATIC  = `smart-ulat-static-${CACHE_VERSION}`;
const CACHE_PAGES   = `smart-ulat-pages-${CACHE_VERSION}`;
const CACHE_EXT     = `smart-ulat-ext-${CACHE_VERSION}`;

// ------------------------------------------------------------
// App shell — pre-cache saat install
// ------------------------------------------------------------
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.json',
  '/css/style.css',
  '/js/utils.js',
  '/js/charts.js',
  '/js/websocket.js',
  '/js/router.js',
  '/js/alerts.js',
  '/js/dashboard.js',
  '/js/monitoring.js',
  '/js/fuzzy-pid.js',
  '/js/power.js',
  '/js/self-monitoring.js',
  '/js/configuration.js',
  '/js/history.js',
  '/js/pwa.js',
  '/js/app.js',
  '/pages/dashboard.html',
  '/pages/monitoring.html',
  '/pages/fuzzy-pid.html',
  '/pages/power.html',
  '/pages/self-monitoring.html',
  '/pages/history.html',
  '/pages/configuration.html',
  '/assets/icons/icon.svg',
  '/assets/icons/icon-maskable.svg'
];

// ------------------------------------------------------------
// INSTALL — precache app shell
// ------------------------------------------------------------
self.addEventListener('install', (event) => {
  console.log(`[SW] install ${CACHE_VERSION}`);

  event.waitUntil(
    caches.open(CACHE_STATIC).then(async (cache) => {
      // Cache satu-satu supaya kalau ada yang gagal, tidak semua gagal
      const results = await Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[SW] gagal cache ${url}:`, err.message);
          })
        )
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      console.log(`[SW] precached ${ok}/${PRECACHE_URLS.length} URLs`);
    }).then(() => self.skipWaiting())
  );
});

// ------------------------------------------------------------
// ACTIVATE — bersihkan cache lama
// ------------------------------------------------------------
self.addEventListener('activate', (event) => {
  console.log(`[SW] activate ${CACHE_VERSION}`);

  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) =>
            key.startsWith('smart-ulat-') &&
            !key.endsWith(CACHE_VERSION)
          )
          .map((key) => {
            console.log(`[SW] hapus cache lama: ${key}`);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim())
  );
});

// ------------------------------------------------------------
// FETCH — routing strategi
// ------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) Skip non-GET
  if (req.method !== 'GET') return;

  // 2) Skip WebSocket & HMR
  if (url.pathname.startsWith('/ws') ||
      url.pathname.startsWith('/sockjs') ||
      url.pathname.startsWith('/__') ||
      req.headers.get('upgrade') === 'websocket') {
    return;
  }

  // 3) Skip API — selalu network
  if (url.pathname.startsWith('/api/')) {
    return; // biarkan browser handle langsung
  }

  // 4) Cross-origin (font, CDN)
  if (url.origin !== self.location.origin) {
    event.respondWith(cacheFirstExternal(req));
    return;
  }

  // 5) Navigate request (buka halaman) → network-first fallback offline
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(networkFirstNavigate(req));
    return;
  }

  // 6) Page fragment (/pages/*.html) → stale-while-revalidate
  if (url.pathname.startsWith('/pages/')) {
    event.respondWith(staleWhileRevalidate(req, CACHE_PAGES));
    return;
  }

  // 7) Static (css, js, assets) → cache-first dengan background revalidate
  if (url.pathname.startsWith('/css/') ||
      url.pathname.startsWith('/js/') ||
      url.pathname.startsWith('/assets/') ||
      url.pathname === '/manifest.json') {
    event.respondWith(cacheFirstStatic(req));
    return;
  }

  // 8) Default → network-first
  event.respondWith(networkFirstNavigate(req));
});

// ============================================================
// STRATEGY 1 — Network first (navigate)
// ============================================================
async function networkFirstNavigate(req) {
  try {
    const fresh = await fetch(req);
    // Cache successful HTML
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (err) {
    // Fallback: cache
    const cached = await caches.match(req);
    if (cached) return cached;

    // Fallback: index.html untuk SPA
    const cachedIndex = await caches.match('/index.html');
    if (cachedIndex) return cachedIndex;

    // Fallback: offline page
    const offline = await caches.match('/offline.html');
    if (offline) return offline;

    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

// ============================================================
// STRATEGY 2 — Cache first (static, external)
// ============================================================
async function cacheFirstStatic(req) {
  const cached = await caches.match(req);
  if (cached) {
    // Background update
    fetchAndUpdate(req, CACHE_STATIC).catch(() => {});
    return cached;
  }
  return fetchAndUpdate(req, CACHE_STATIC);
}

async function cacheFirstExternal(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  return fetchAndUpdate(req, CACHE_EXT);
}

// ============================================================
// STRATEGY 3 — Stale-while-revalidate (page fragments)
// ============================================================
async function staleWhileRevalidate(req, cacheName) {
  const cached = await caches.match(req);
  const fetchPromise = fetchAndUpdate(req, cacheName);
  return cached || fetchPromise;
}

// ============================================================
// Helper
// ============================================================
async function fetchAndUpdate(req, cacheName) {
  const response = await fetch(req);
  if (response && response.ok) {
    const clone = response.clone();
    caches.open(cacheName).then((cache) => {
      cache.put(req, clone).catch(() => {});
    });
  }
  return response;
}

// ============================================================
// MESSAGE — dari client (skipWaiting, clearCache)
// ============================================================
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('smart-ulat-')).map((k) => caches.delete(k))
        )
      ).then(() => {
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({ cleared: true });
        }
      })
    );
    return;
  }

  if (event.data.type === 'GET_VERSION') {
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ version: CACHE_VERSION });
    }
  }
});

// ============================================================
// Log
// ============================================================
console.log(`[SW] loaded ${CACHE_VERSION}`);
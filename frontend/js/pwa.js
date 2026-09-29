/**
 * ============================================================
 * pwa.js — PWA Bootstrap
 * ------------------------------------------------------------
 * STEP 15:
 *   - Register service worker
 *   - Handle install prompt (beforeinstallprompt)
 *   - Handle update available
 *   - Detect display mode (standalone / browser)
 *   - Clean cache helper
 * ============================================================
 */

'use strict';

const PWA = (() => {
  let deferredPrompt = null;
  let registration = null;
  let updateAvailable = false;

  // ----------------------------------------
  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true ||
      document.referrer.startsWith('android-app://')
    );
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  // ----------------------------------------
  // Install button UI
  // ----------------------------------------
  function _showInstallButton() {
    const btn = document.getElementById('installBtn');
    if (btn) btn.classList.remove('hidden');
  }

  function _hideInstallButton() {
    const btn = document.getElementById('installBtn');
    if (btn) btn.classList.add('hidden');
  }

  async function _promptInstall() {
    if (!deferredPrompt) {
      // iOS: tampilkan instruksi manual
      if (isIOS()) {
        alert(
          'Install di iOS:\n\n' +
          '1. Tap ikon Share di Safari\n' +
          '2. Pilih "Add to Home Screen"\n' +
          '3. Tap "Add"'
        );
      } else {
        alert('Browser Anda tidak mendukung install prompt otomatis.\nCari menu browser → "Install App" atau "Add to Home Screen".');
      }
      return;
    }

    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    console.log(`[PWA] install choice: ${choice.outcome}`);

    if (choice.outcome === 'accepted') {
      _hideInstallButton();
      _toast('Aplikasi berhasil di-install ✓');
    }
    deferredPrompt = null;
  }

  function _toast(text) {
    // Cari container toast dari Alerts; kalau ada, pakai
    if (typeof Alerts !== 'undefined' && Alerts.add) {
      Alerts.add({
        severity: 'INFO',
        title: 'Install',
        message: text,
        timestamp: new Date().toISOString()
      });
    } else {
      console.log('[PWA]', text);
    }
  }

  // ----------------------------------------
  // beforeinstallprompt
  // ----------------------------------------
  function _setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      console.log('[PWA] beforeinstallprompt fired');
      _showInstallButton();
    });

    window.addEventListener('appinstalled', () => {
      console.log('[PWA] app installed');
      deferredPrompt = null;
      _hideInstallButton();
      _toast('Smart Ulat berhasil di-install.');
    });

    // Button
    const btn = document.getElementById('installBtn');
    if (btn) btn.addEventListener('click', _promptInstall);

    // iOS: tampilkan tombol manual (karena tidak ada event)
    if (isIOS() && !isStandalone()) {
      _showInstallButton();
    }

    // Kalau sudah standalone, sembunyikan
    if (isStandalone()) {
      _hideInstallButton();
    }
  }

  // ----------------------------------------
  // Register service worker
  // ----------------------------------------
  async function _registerSW() {
    if (!('serviceWorker' in navigator)) {
      console.warn('[PWA] service worker tidak didukung');
      return;
    }

    try {
      registration = await navigator.serviceWorker.register('/service-worker.js', {
        scope: '/'
      });
      console.log('[PWA] SW registered:', registration.scope);

      // Deteksi update SW
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            console.log('[PWA] update available');
            updateAvailable = true;
            _showUpdateBanner();
          }
        });
      });

      // Reload otomatis saat SW baru mengambil alih
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        console.log('[PWA] controller changed — reload');
        window.location.reload();
      });

      // Cek update tiap 1 jam
      setInterval(() => {
        registration.update().catch(() => {});
      }, 60 * 60 * 1000);

    } catch (err) {
      console.error('[PWA] register SW error:', err);
    }
  }

  // ----------------------------------------
  // Update banner
  // ----------------------------------------
  function _showUpdateBanner() {
    const el = document.getElementById('pwaUpdateBanner');
    if (el) el.classList.remove('hidden');
  }

  function _hideUpdateBanner() {
    const el = document.getElementById('pwaUpdateBanner');
    if (el) el.classList.add('hidden');
  }

  async function _applyUpdate() {
    if (!registration || !registration.waiting) {
      window.location.reload();
      return;
    }
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    // controllerchange akan memicu reload
  }

  // ----------------------------------------
  // Clear cache (untuk debugging)
  // ----------------------------------------
  async function clearCache() {
    if (!navigator.serviceWorker.controller) return false;
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        resolve(Boolean(event.data?.cleared));
      };
      navigator.serviceWorker.controller.postMessage(
        { type: 'CLEAR_CACHE' },
        [channel.port2]
      );
    });
  }

  // ----------------------------------------
  // Init
  // ----------------------------------------
  function init() {
    console.log('[PWA] init — standalone:', isStandalone());
    _setupInstallPrompt();
    _registerSW();

    // Wire update banner button
    const updateBtn = document.getElementById('pwaUpdateBtn');
    if (updateBtn) updateBtn.addEventListener('click', _applyUpdate);

    const dismissBtn = document.getElementById('pwaUpdateDismiss');
    if (dismissBtn) dismissBtn.addEventListener('click', _hideUpdateBanner);
  }

  // ----------------------------------------
  // Public API
  // ----------------------------------------
  return {
    init,
    isStandalone,
    isIOS,
    clearCache,
    getRegistration: () => registration,
    isUpdateAvailable: () => updateAvailable
  };
})();

window.PWA = PWA;
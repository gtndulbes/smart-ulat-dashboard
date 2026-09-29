/**
 * ============================================================
 * configService.js
 * ------------------------------------------------------------
 * Persistence layer untuk konfigurasi sistem.
 *
 * Kenapa perlu?
 *   - stateService cuma simpan config di memory
 *   - Kalau server restart, config balik ke default
 *   - Dashboard sudah ubah setpoint/PID dll → hilang begitu restart
 *
 * Solusi:
 *   - Simpan config ke file JSON (backend/data/config.json)
 *   - Load saat startup → apply ke stateService
 *   - Save otomatis saat config berubah (debounced)
 *
 * Alur:
 *   server.js
 *     ↓ init
 *   configService.init()
 *     ├─ load dari file (kalau ada)
 *     ├─ merge dengan defaults (kalau file lama/korup)
 *     └─ apply ke stateService
 *
 *   User ubah config di dashboard
 *     ↓
 *   configRoutes POST → stateService.setConfig()
 *     ↓ emit('config')
 *   configService listener → save ke file (debounced 1s)
 *
 * Fitur:
 *   - Atomic write (tulis ke .tmp lalu rename)
 *   - Debounced save (hindari disk I/O berlebihan)
 *   - Schema version + migration hook
 *   - Graceful fallback kalau file korup
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../config/config');
const logger = require('../utils/logger');
const stateService = require('./stateService');

const log = logger.scope('CONFIG-SVC');

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TMP_FILE = path.join(DATA_DIR, 'config.json.tmp');
const SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 1000;

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
let initialized = false;
let saveTimer = null;
let lastLoadedAt = null;
let lastSavedAt = null;
let pendingSave = false;

const stats = {
  loads: 0,
  saves: 0,
  saveErrors: 0,
  loadErrors: 0,
  migrations: 0,
  fileExists: false,
  fileSize: 0
};

// ------------------------------------------------------------
// Ensure dir ada
// ------------------------------------------------------------
function _ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    log.info(`Direktori data dibuat: ${DATA_DIR}`);
  }
}

// ------------------------------------------------------------
// Deep merge
// ------------------------------------------------------------
function _deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  if (!target || typeof target !== 'object') return source;

  const out = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = _deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

// ------------------------------------------------------------
// Load dari file
// ------------------------------------------------------------
function _loadFromFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      stats.fileExists = false;
      log.info('File config belum ada — pakai default');
      return null;
    }

    stats.fileExists = true;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    stats.fileSize = raw.length;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn(`File config korup (JSON invalid): ${err.message}`);
      log.warn('Backup file lama, pakai default');
      _backupCorrupt();
      stats.loadErrors += 1;
      return null;
    }

    // Cek schema version
    if (!parsed || typeof parsed !== 'object') {
      log.warn('File config bukan object — skip');
      stats.loadErrors += 1;
      return null;
    }

    const fileVersion = parsed._meta?.version || 0;

    // Migration hook (untuk masa depan)
    if (fileVersion < SCHEMA_VERSION) {
      log.warn(`Config versi ${fileVersion} → migrate ke ${SCHEMA_VERSION}`);
      parsed = _migrate(parsed, fileVersion);
      stats.migrations += 1;
    }

    // Buang meta sebelum apply ke stateService
    const { _meta, ...configOnly } = parsed;

    stats.loads += 1;
    lastLoadedAt = new Date().toISOString();
    log.info(`Config dimuat dari file (${raw.length} bytes)`);

    return configOnly;
  } catch (err) {
    log.error('Gagal load config file:', err.message);
    stats.loadErrors += 1;
    return null;
  }
}

// ------------------------------------------------------------
// Backup file korup
// ------------------------------------------------------------
function _backupCorrupt() {
  try {
    const backup = `${CONFIG_FILE}.corrupt-${Date.now()}`;
    fs.renameSync(CONFIG_FILE, backup);
    log.warn(`File korup di-backup ke: ${path.basename(backup)}`);
  } catch (err) {
    log.error('Gagal backup file korup:', err.message);
  }
}

// ------------------------------------------------------------
// Migration hook
// ------------------------------------------------------------
function _migrate(data, fromVersion) {
  // Contoh: kalau fromVersion < 1, tambahkan field baru
  const migrated = { ...data };

  // Migration #0 → #1: pastikan semua section ada
  if (fromVersion < 1) {
    migrated.setpoint = migrated.setpoint || {};
    migrated.pid = migrated.pid || {};
    migrated.peltier = migrated.peltier || {};
    migrated.fan = migrated.fan || {};
    migrated.heatsink = migrated.heatsink || {};
    migrated.power = migrated.power || {};
  }

  migrated._meta = {
    ...(migrated._meta || {}),
    version: SCHEMA_VERSION,
    migratedAt: new Date().toISOString(),
    fromVersion
  };

  return migrated;
}

// ------------------------------------------------------------
// Save ke file (atomic write)
// ------------------------------------------------------------
function _writeToFile(cfg) {
  _ensureDir();

  const payload = {
    _meta: {
      version: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      service: config.service,
      env: config.env
    },
    ...cfg
  };

  const json = JSON.stringify(payload, null, 2);

  try {
    // Atomic: tulis ke .tmp dulu
    fs.writeFileSync(TMP_FILE, json, 'utf8');

    // Rename (atomic di POSIX)
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }
    fs.renameSync(TMP_FILE, CONFIG_FILE);

    stats.saves += 1;
    stats.fileExists = true;
    stats.fileSize = json.length;
    lastSavedAt = new Date().toISOString();

    log.debug(`Config disimpan ke file (${json.length} bytes)`);
    return true;
  } catch (err) {
    log.error('Gagal save config file:', err.message);
    stats.saveErrors += 1;

    // Cleanup tmp
    try {
      if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
    } catch { /* noop */ }

    return false;
  }
}

// ------------------------------------------------------------
// Debounced save
// ------------------------------------------------------------
function _scheduleSave() {
  if (saveTimer) {
    pendingSave = true;
    return;
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    pendingSave = false;

    try {
      const cfg = stateService.getConfig();
      _writeToFile(cfg);
    } catch (err) {
      log.error('Debounced save error:', err.message);
    }
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/**
 * Init: load config dari file (kalau ada) → apply ke stateService.
 * Dipanggil SEKALI saat server start, SETELAH stateService.init().
 */
function init() {
  if (initialized) {
    log.warn('configService sudah di-init');
    return;
  }

  log.info('Init config persistence...');
  _ensureDir();

  // Load dari file
  const fileConfig = _loadFromFile();

  if (fileConfig) {
    // Merge dengan default (untuk jaga-jaga field baru)
    const current = stateService.getConfig();
    const merged = _deepMerge(current, fileConfig);
    stateService.setConfig(merged);
    log.info('Config dari file di-apply ke stateService');
  } else {
    // Pertama kali → tulis default ke file
    log.info('Pertama kali — tulis config default ke file');
    _writeToFile(stateService.getConfig());
  }

  // Subscribe ke perubahan config dari stateService
  stateService.on('config', () => {
    _scheduleSave();
  });

  initialized = true;
  log.info('✅ Config persistence aktif');
}

/**
 * Force save sekarang (bypass debounce).
 */
function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    pendingSave = false;
  }

  const cfg = stateService.getConfig();
  return _writeToFile(cfg);
}

/**
 * Reset ke default & save.
 */
function resetToDefaults() {
  log.warn('Reset config ke default');
  const defaults = JSON.parse(JSON.stringify(config.defaults));

  stateService.setConfig(defaults);

  // setConfig akan emit 'config' → trigger save
  // Force save synchronous juga untuk memastikan
  saveNow();

  return defaults;
}

/**
 * Export config sebagai JSON string (untuk backup).
 */
function exportJSON() {
  const cfg = stateService.getConfig();
  return JSON.stringify({
    _meta: {
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString()
    },
    ...cfg
  }, null, 2);
}

/**
 * Import config dari JSON string.
 * @returns {{ok: boolean, error?: string}}
 */
function importJSON(jsonStr) {
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'JSON bukan object' };
    }

    const { _meta, ...configOnly } = parsed;
    const current = stateService.getConfig();
    const merged = _deepMerge(current, configOnly);

    stateService.setConfig(merged);
    saveNow();

    log.info('Config di-import dari JSON');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Hapus file config (untuk fresh start).
 */
function deleteFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
      log.warn('File config dihapus');
      stats.fileExists = false;
      return true;
    }
    return false;
  } catch (err) {
    log.error('Gagal hapus file config:', err.message);
    return false;
  }
}

/**
 * Get stats.
 */
function getStats() {
  return {
    initialized,
    filePath: CONFIG_FILE,
    fileExists: stats.fileExists,
    fileSize: stats.fileSize,
    schemaVersion: SCHEMA_VERSION,
    loads: stats.loads,
    saves: stats.saves,
    saveErrors: stats.saveErrors,
    loadErrors: stats.loadErrors,
    migrations: stats.migrations,
    lastLoadedAt,
    lastSavedAt,
    pendingSave,
    debounceMs: SAVE_DEBOUNCE_MS
  };
}

/**
 * Flush save saat shutdown.
 */
function shutdown() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pendingSave || initialized) {
    saveNow();
  }
  initialized = false;
  log.info('Config service shutdown');
}

// ------------------------------------------------------------
// Export
// ------------------------------------------------------------
module.exports = {
  init,
  saveNow,
  resetToDefaults,
  exportJSON,
  importJSON,
  deleteFile,
  getStats,
  shutdown
};
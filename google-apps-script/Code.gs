/**
 * ============================================================
 * Code.gs — Google Apps Script Web App
 * ------------------------------------------------------------
 * STEP 12: appendRow (write)
 * STEP 13: + read (query), count, clear
 * STEP 14: + HourlyAvg aggregation + auto-purge Log
 *
 * TABEL:
 *   Log       — data realtime (append tiap 1 menit dari backend)
 *               Auto-purge > LOG_RETENTION_DAYS hari
 *   HourlyAvg — rata-rata per jam (agregasi Log)
 *               Akumulasi SELAMANYA (arsip historis)
 *   Alerts    — log alert (dari backend)
 *
 * SETUP TRIGGER (jalankan sekali):
 *   1. Buka spreadsheet → menu "Smart Ulat" → "Setup Auto Triggers"
 *   2. Ini akan buat 2 trigger:
 *      - hourlyAggregation → jalan tiap jam (agregasi 2 jam terakhir)
 *      - dailyMaintenance  → jalan tiap hari 00:30 (purge + re-aggregate 24h)
 * ============================================================
 */

// ============================================================
// KONFIGURASI
// ============================================================
var TOKEN = 'smartulat-a1b2c3d4e5f6g7h8';
var SHEET_ID = '1x2ZUZJr1Jfmf-LFHUzeMmNjgFlK0GyoG4PvuE-z_sW0';
var SHEET_LOG = 'Log';
var SHEET_ALERTS = 'Alerts';
var SHEET_HOURLY = 'HourlyAvg';
var TIMEZONE = 'Asia/Jakarta';

// ═══════════════════════════════════════════════════════════════
// KONFIGURASI RETENSI — ubah sesuai kebutuhan
// ═══════════════════════════════════════════════════════════════
var LOG_RETENTION_DAYS = 7;      // Log otomatis hapus data > 7 hari
var HOURLY_MAX_BACK_HOURS = 168; // Safety: max scan 1 minggu ke belakang (168h)

var HEADERS_LOG = [
  'Timestamp', 'Temperature (°C)', 'Humidity (%RH)', 'NH3 (ppm)',
  'Voltage (V)', 'Current (A)', 'Power (W)',
  'Peltier Status', 'Peltier PWM', 'Exhaust PWM', 'Heatsink PWM',
  'System Status', 'Safe Mode',
  'Error (°C)', 'Delta Error (°C/s)', 'Kp', 'Ki', 'Kd', 'PID Output',
  'Power Status', 'Uptime (s)', 'SHT31', 'MQ135', 'INA219'
];

var HEADERS_ALERTS = ['Timestamp', 'Severity', 'Title', 'Message'];

var HEADERS_HOURLY = [
  'Timestamp', 'Temperature (°C)', 'Humidity (%RH)', 'NH3 (ppm)',
  'Voltage (V)', 'Current (A)', 'Power (W)', 'Samples'
];

// ============================================================
// HTTP HANDLERS
// ============================================================
function doPost(e) {
  try {
    var body;
    try { body = JSON.parse(e.postData.contents); }
    catch (err) { return jsonResp({ success: false, error: 'Invalid JSON' }); }

    if (TOKEN && body.token !== TOKEN) {
      return jsonResp({ success: false, error: 'Unauthorized' });
    }

    var action = body.action || 'append';

    switch (action) {
      case 'ping':      return jsonResp({ success: true, pong: true, time: new Date().toISOString() });
      case 'append':    return handleAppend(body);
      case 'read':      return handleRead(body);
      case 'count':     return handleCount(body);
      case 'clear':     return handleClear(body);
      case 'aggregate': return handleAggregate(body);   // ← BARU
      case 'purge':     return handlePurge(body);       // ← BARU
      default:          return jsonResp({ success: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonResp({ success: false, error: 'Server error: ' + err.message });
  }
}

function doGet(e) {
  var params = (e && e.parameter) || {};
  var action = params.action || 'info';

  if (action === 'ping') {
    return jsonResp({ success: true, pong: true, time: new Date().toISOString() });
  }

  if (action === 'read' || action === 'count') {
    if (TOKEN && params.token && params.token !== TOKEN) {
      return jsonResp({ success: false, error: 'Unauthorized' });
    }
    var payload = {
      action: action,
      sheet: params.sheet || SHEET_LOG,
      limit: parseInt(params.limit, 10) || 100,
      offset: parseInt(params.offset, 10) || 0,
      from: params.from || '',
      to: params.to || '',
      search: params.search || ''
    };
    return action === 'read' ? handleRead(payload) : handleCount(payload);
  }

  return jsonResp({
    success: true,
    service: 'smart-ulat-gas',
    version: '1.2.0',
    message: 'GAS Web App aktif.',
    retention: {
      logRetentionDays: LOG_RETENTION_DAYS,
      hourlySheet: SHEET_HOURLY
    },
    timestamp: new Date().toISOString()
  });
}

// ============================================================
// APPEND
// ============================================================
function handleAppend(body) {
  var sheetName = body.sheet || SHEET_LOG;
  var row = body.row;

  if (!Array.isArray(row)) {
    return jsonResp({ success: false, error: 'body.row harus array' });
  }

  var sheet = getSheet(sheetName);
  if (!sheet) return jsonResp({ success: false, error: 'Sheet tidak ditemukan: ' + sheetName });

  ensureHeaders(sheet, sheetName);

  if (typeof row[0] === 'string') {
    var d = new Date(row[0]);
    if (!isNaN(d.getTime())) {
      row[0] = Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    }
  }

  sheet.appendRow(row);

  return jsonResp({
    success: true,
    sheet: sheetName,
    rowCount: sheet.getLastRow(),
    timestamp: new Date().toISOString()
  });
}

// ============================================================
// READ
// ============================================================
function handleRead(body) {
  var sheetName = body.sheet || SHEET_LOG;
  var limit = Math.min(parseInt(body.limit, 10) || 100, 1000);
  var offset = Math.max(parseInt(body.offset, 10) || 0, 0);
  var fromStr = body.from || '';
  var toStr = body.to || '';
  var search = (body.search || '').toLowerCase();

  var sheet = getSheet(sheetName);
  if (!sheet) return jsonResp({ success: false, error: 'Sheet tidak ditemukan: ' + sheetName });

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow <= 1) {
    return jsonResp({ success: true, sheet: sheetName, rows: [], total: 0, offset: offset, limit: limit });
  }

  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  var fromDate = fromStr ? new Date(fromStr + 'T00:00:00') : null;
  var toDate   = toStr   ? new Date(toStr   + 'T23:59:59') : null;

  var filtered = values.filter(function (row) {
    var ts = row[0];
    if (fromDate || toDate) {
      var d = new Date(String(ts).replace(' ', 'T'));
      if (isNaN(d.getTime())) return false;
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
    }
    if (search) {
      var haystack = row.map(function (v) { return String(v).toLowerCase(); }).join(' ');
      if (haystack.indexOf(search) === -1) return false;
    }
    return true;
  });

  filtered.sort(function (a, b) {
    var ta = new Date(String(a[0]).replace(' ', 'T')).getTime() || 0;
    var tb = new Date(String(b[0]).replace(' ', 'T')).getTime() || 0;
    return tb - ta;
  });

  var total = filtered.length;
  var page = filtered.slice(offset, offset + limit);

  var rows = page.map(function (r) {
    var obj = {};
    for (var i = 0; i < headers.length; i++) {
      obj[headers[i]] = r[i];
    }
    return obj;
  });

  return jsonResp({
    success: true,
    sheet: sheetName,
    headers: headers,
    rows: rows,
    total: total,
    offset: offset,
    limit: limit,
    hasMore: (offset + limit) < total,
    timestamp: new Date().toISOString()
  });
}

// ============================================================
// COUNT
// ============================================================
function handleCount(body) {
  var sheetName = body.sheet || SHEET_LOG;
  var sheet = getSheet(sheetName);
  if (!sheet) return jsonResp({ success: false, error: 'Sheet tidak ditemukan' });

  var lastRow = sheet.getLastRow();
  var count = lastRow > 1 ? lastRow - 1 : 0;
  return jsonResp({ success: true, sheet: sheetName, count: count });
}

// ============================================================
// CLEAR
// ============================================================
function handleClear(body) {
  var sheetName = body.sheet || SHEET_LOG;
  var confirm = body.confirm || '';
  if (confirm !== 'YES_CLEAR_ALL') {
    return jsonResp({ success: false, error: 'Kirim confirm: "YES_CLEAR_ALL" untuk konfirmasi' });
  }

  var sheet = getSheet(sheetName);
  if (!sheet) return jsonResp({ success: false, error: 'Sheet tidak ditemukan' });

  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }

  return jsonResp({ success: true, sheet: sheetName, cleared: lastRow - 1 });
}

// ============================================================
// AGGREGATE — bangun HourlyAvg dari Log
// Dipanggil via:
//   - trigger hourlyAggregation (otomatis tiap jam)
//   - POST {action: 'aggregate', hoursBack: 2}
//   - Menu "Aggregate Now"
// ============================================================
function handleAggregate(body) {
  try {
    var hoursBack = parseInt(body.hoursBack, 10) || 2;
    if (hoursBack < 1) hoursBack = 1;
    if (hoursBack > HOURLY_MAX_BACK_HOURS) hoursBack = HOURLY_MAX_BACK_HOURS;
    var result = aggregateHourlyAvg(hoursBack);
    return jsonResp({
      success: true,
      action: 'aggregate',
      hoursBack: hoursBack,
      appended: result.appended,
      updated: result.updated,
      totalHours: result.appended + result.updated,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return jsonResp({ success: false, error: 'Aggregate error: ' + err.message });
  }
}

// ============================================================
// PURGE — hapus data Log yang lebih tua dari LOG_RETENTION_DAYS
// ============================================================
function handlePurge(body) {
  try {
    var result = purgeOldLogRows();
    return jsonResp({
      success: true,
      action: 'purge',
      deleted: result.deleted,
      retentionDays: LOG_RETENTION_DAYS,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return jsonResp({ success: false, error: 'Purge error: ' + err.message });
  }
}

// ============================================================
// CORE: Hourly aggregation
// ────────────────────────────────────────────────────────────
// Algoritma:
//   1. Baca Log rows dalam window [now - hoursBack, now)
//   2. Group by hour bucket (yyyy-MM-dd HH:00:00)
//   3. Untuk tiap hour: hitung rata-rata kolom numerik
//   4. Cek apakah hour tsb sudah ada di HourlyAvg
//      - Ada     → update (overwrite)
//      - Belum   → append
//   5. Return count appended/updated
// ============================================================
function aggregateHourlyAvg(hoursBack) {
  var result = { appended: 0, updated: 0 };

  var logSheet = getSheet(SHEET_LOG);
  if (!logSheet) throw new Error('Sheet ' + SHEET_LOG + ' tidak ditemukan');

  var lastRow = logSheet.getLastRow();
  if (lastRow <= 1) return result;   // hanya header, no data

  var lastCol = logSheet.getLastColumn();
  var logHeaders = logSheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // Index kolom by header name
  var colIdx = {};
  logHeaders.forEach(function (h, i) { colIdx[h] = i; });

  var logData = logSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  // Window: [now - hoursBack, now)
  var now = new Date();
  var cutoffStart = new Date(now.getTime() - hoursBack * 3600000);

  // Group by hour key
  var groups = {};
  logData.forEach(function (row) {
    var ts = new Date(String(row[0]).replace(' ', 'T'));
    if (isNaN(ts.getTime())) return;
    if (ts < cutoffStart || ts >= now) return;
    var hourKey = Utilities.formatDate(ts, TIMEZONE, 'yyyy-MM-dd HH:00:00');
    if (!groups[hourKey]) groups[hourKey] = [];
    groups[hourKey].push(row);
  });

  var hourKeys = Object.keys(groups);
  if (hourKeys.length === 0) return result;

  // Prepare HourlyAvg sheet
  var hourlySheet = getSheet(SHEET_HOURLY);
  if (!hourlySheet) throw new Error('Sheet ' + SHEET_HOURLY + ' tidak ditemukan');
  ensureHeaders(hourlySheet, SHEET_HOURLY);

  // Build existing index: hourKey → rowNumber (2-indexed)
  var existing = {};
  var lastHourlyRow = hourlySheet.getLastRow();
  if (lastHourlyRow > 1) {
    var existingCol = hourlySheet.getRange(2, 1, lastHourlyRow - 1, 1).getValues();
    existingCol.forEach(function (r, i) {
      var key = String(r[0]);
      if (key) existing[key] = i + 2;
    });
  }

  // Helper: safe average of numeric column
  function avg(rows, headerName) {
    var idx = colIdx[headerName];
    if (idx === undefined) return '';
    var sum = 0, n = 0;
    rows.forEach(function (r) {
      var v = Number(r[idx]);
      if (isFinite(v)) { sum += v; n++; }
    });
    if (n === 0) return '';
    return Math.round((sum / n) * 100) / 100;
  }

  // Compute + write each hour
  hourKeys.sort().forEach(function (hourKey) {
    var rows = groups[hourKey];
    var newRow = [
      hourKey,
      avg(rows, 'Temperature (°C)'),
      avg(rows, 'Humidity (%RH)'),
      avg(rows, 'NH3 (ppm)'),
      avg(rows, 'Voltage (V)'),
      avg(rows, 'Current (A)'),
      avg(rows, 'Power (W)'),
      rows.length
    ];

    if (existing[hourKey]) {
      // Update existing
      hourlySheet.getRange(existing[hourKey], 1, 1, newRow.length).setValues([newRow]);
      result.updated++;
    } else {
      // Append new
      hourlySheet.appendRow(newRow);
      result.appended++;
    }
  });

  Logger.log('aggregateHourlyAvg: hoursBack=' + hoursBack +
             ', appended=' + result.appended + ', updated=' + result.updated);
  return result;
}

// ============================================================
// CORE: Purge old Log rows
// ────────────────────────────────────────────────────────────
// Asumsi: Log append-only kronologis (baris lama di atas,
// baris baru di bawah). Ini selalu benar karena appendRow.
//
// Strategi:
//   1. Cutoff = now - LOG_RETENTION_DAYS
//   2. Cari baris pertama dengan timestamp >= cutoff
//   3. Delete semua baris [2 .. firstKeepRow-1]
// ============================================================
function purgeOldLogRows() {
  var sheet = getSheet(SHEET_LOG);
  if (!sheet) throw new Error('Sheet ' + SHEET_LOG + ' tidak ditemukan');

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { deleted: 0 };

  var cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400000);
  var timestamps = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

  var firstKeepRow = -1;   // spreadsheet row number (1-indexed)
  for (var i = 0; i < timestamps.length; i++) {
    var ts = new Date(String(timestamps[i][0]).replace(' ', 'T'));
    if (isNaN(ts.getTime())) continue;
    if (ts >= cutoff) {
      firstKeepRow = i + 2;
      break;
    }
  }

  // Semua data lebih tua dari cutoff → hapus semua
  if (firstKeepRow === -1) {
    sheet.deleteRows(2, lastRow - 1);
    Logger.log('purgeOldLogRows: deleted ALL ' + (lastRow - 1) + ' rows');
    return { deleted: lastRow - 1 };
  }

  // Baris pertama sudah fresh → tidak ada yang perlu dihapus
  if (firstKeepRow === 2) {
    Logger.log('purgeOldLogRows: nothing to delete');
    return { deleted: 0 };
  }

  // Hapus baris [2 .. firstKeepRow-1]
  var toDelete = firstKeepRow - 2;
  sheet.deleteRows(2, toDelete);
  Logger.log('purgeOldLogRows: deleted ' + toDelete + ' rows (cutoff ' +
             Utilities.formatDate(cutoff, TIMEZONE, 'yyyy-MM-dd HH:mm') + ')');
  return { deleted: toDelete };
}

// ============================================================
// TRIGGER HANDLERS
// ============================================================

/**
 * Dipanggil oleh trigger tiap jam (nearMinute 5).
 * Aggregasi 2 jam terakhir → cover current hour (partial)
 * dan previous hour (full). Re-run dalam jam yang sama akan
 * update, bukan duplikat.
 */
function hourlyAggregation() {
  try {
    var res = aggregateHourlyAvg(2);
    Logger.log('hourlyAggregation: appended=' + res.appended + ', updated=' + res.updated);
  } catch (err) {
    Logger.log('hourlyAggregation ERROR: ' + err.message);
  }
}

/**
 * Dipanggil oleh trigger harian 00:30.
 * 1. Purge Log rows > LOG_RETENTION_DAYS
 * 2. Re-aggregate 24 jam terakhir (safety net kalau ada
 *    hourly trigger yang terlewat)
 */
function dailyMaintenance() {
  try {
    var purged = purgeOldLogRows();
    var agg = aggregateHourlyAvg(24);
    Logger.log('dailyMaintenance: purged=' + purged.deleted +
               ', appended=' + agg.appended + ', updated=' + agg.updated);
  } catch (err) {
    Logger.log('dailyMaintenance ERROR: ' + err.message);
  }
}

// ============================================================
// TRIGGER MANAGEMENT (bisa dipanggil via menu)
// ============================================================
function setupTriggers() {
  // Hapus trigger lama dulu (idempotent)
  removeTriggers();

  // Hourly aggregate — offset 5 menit supaya hour sudah complete
  ScriptApp.newTrigger('hourlyAggregation')
    .timeBased()
    .everyHours(1)
    .nearMinute(5)
    .create();

  // Daily maintenance — 00:30
  ScriptApp.newTrigger('dailyMaintenance')
    .timeBased()
    .everyDays(1)
    .atHour(0)
    .nearMinute(30)
    .create();

  Logger.log('setupTriggers: 2 triggers created');
}

function removeTriggers() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'hourlyAggregation' || fn === 'dailyMaintenance') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log('removeTriggers: ' + removed + ' removed');
}

// ============================================================
// HELPERS
// ============================================================
function getSheet(name) {
  var ss;
  if (SHEET_ID) {
    try { ss = SpreadsheetApp.openById(SHEET_ID); }
    catch (err) { Logger.log('Gagal buka SHEET_ID: ' + err.message); return null; }
  } else {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }
  if (!ss) return null;

  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    try { sheet = ss.insertSheet(name); } catch (err) { return null; }
  }
  return sheet;
}

function ensureHeaders(sheet, sheetName) {
  var headers;
  if (sheetName === SHEET_ALERTS) headers = HEADERS_ALERTS;
  else if (sheetName === SHEET_HOURLY) headers = HEADERS_HOURLY;
  else headers = HEADERS_LOG;

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow === 0 || lastCol === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeader(sheet, headers.length);
    return;
  }

  var firstRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (firstRow[0] !== headers[0]) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeader(sheet, headers.length);
  }
}

function styleHeader(sheet, colCount) {
  var range = sheet.getRange(1, 1, 1, colCount);
  range.setBackground('#070b14');
  range.setFontColor('#e2e8f0');
  range.setFontWeight('bold');
  range.setFontFamily('Roboto Mono');
  range.setFontSize(10);
  sheet.setFrozenRows(1);
}

function jsonResp(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// MENU
// ============================================================
function onOpen() {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('Smart Ulat')
      .addItem('🔧 Setup Auto Triggers', 'menuSetupTriggers')
      .addItem('⏸️ Remove Triggers', 'menuRemoveTriggers')
      .addSeparator()
      .addItem('📊 Aggregate Now (last 2h)', 'menuAggregateNow')
      .addItem('📊 Re-aggregate 24h', 'menuAggregate24h')
      .addItem('🗑️ Purge Old Log (>7 days)', 'menuPurgeNow')
      .addSeparator()
      .addItem('Inisialisasi Header', 'menuInitHeaders')
      .addItem('Hapus Semua Data', 'menuClearData')
      .addToUi();
  } catch (e) {}
}

function menuSetupTriggers() {
  setupTriggers();
  SpreadsheetApp.getUi().alert(
    '✅ Auto triggers terpasang:\n\n' +
    '• hourlyAggregation — tiap jam (nearMinute 5)\n' +
    '• dailyMaintenance — tiap hari 00:30\n\n' +
    'Retensi Log: ' + LOG_RETENTION_DAYS + ' hari'
  );
}

function menuRemoveTriggers() {
  removeTriggers();
  SpreadsheetApp.getUi().alert('✅ Semua trigger dihapus.');
}

function menuAggregateNow() {
  try {
    var res = aggregateHourlyAvg(2);
    SpreadsheetApp.getUi().alert(
      '✅ Aggregate selesai:\n\n' +
      '• Appended: ' + res.appended + '\n' +
      '• Updated: ' + res.updated
    );
  } catch (err) {
    SpreadsheetApp.getUi().alert('❌ Error: ' + err.message);
  }
}

function menuAggregate24h() {
  try {
    var res = aggregateHourlyAvg(24);
    SpreadsheetApp.getUi().alert(
      '✅ Re-aggregate 24h selesai:\n\n' +
      '• Appended: ' + res.appended + '\n' +
      '• Updated: ' + res.updated
    );
  } catch (err) {
    SpreadsheetApp.getUi().alert('❌ Error: ' + err.message);
  }
}

function menuPurgeNow() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert(
    'Purge Log > ' + LOG_RETENTION_DAYS + ' hari?\n\n' +
    'Data lama di tab Log akan DIHAPUS.\n' +
    'Tab HourlyAvg TIDAK terpengaruh.',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  try {
    var res = purgeOldLogRows();
    SpreadsheetApp.getUi().alert('✅ Purge selesai: ' + res.deleted + ' baris dihapus.');
  } catch (err) {
    SpreadsheetApp.getUi().alert('❌ Error: ' + err.message);
  }
}

function menuInitHeaders() {
  ensureHeaders(getSheet(SHEET_LOG), SHEET_LOG);
  ensureHeaders(getSheet(SHEET_ALERTS), SHEET_ALERTS);
  ensureHeaders(getSheet(SHEET_HOURLY), SHEET_HOURLY);
  SpreadsheetApp.getUi().alert('Header siap (Log, Alerts, HourlyAvg).');
}

function menuClearData() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert(
    'Yakin hapus SEMUA data (Log, Alerts, HourlyAvg)?\n\n' +
    'Header tetap dipertahankan.',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  [SHEET_LOG, SHEET_ALERTS, SHEET_HOURLY].forEach(function (name) {
    var s = getSheet(name);
    if (s && s.getLastRow() > 1) s.deleteRows(2, s.getLastRow() - 1);
  });
  ui.alert('Data dihapus.');
}
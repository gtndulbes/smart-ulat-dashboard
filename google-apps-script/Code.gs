/**
 * ============================================================
 * Code.gs — Google Apps Script Web App
 * ------------------------------------------------------------
 * STEP 12: appendRow (write)
 * STEP 13: + read (query), count, clear
 * ============================================================
 */

// ============================================================
// KONFIGURASI
// ============================================================
var TOKEN = 'GANTI_DENGAN_TOKEN_RAHASIA_ANDA';
var SHEET_ID = '';
var SHEET_LOG = 'Log';
var SHEET_ALERTS = 'Alerts';
var TIMEZONE = 'Asia/Jakarta';

var HEADERS_LOG = [
  'Timestamp', 'Temperature (°C)', 'Humidity (%RH)', 'NH3 (ppm)',
  'Voltage (V)', 'Current (A)', 'Power (W)',
  'Peltier Status', 'Peltier PWM', 'Exhaust PWM', 'Heatsink PWM',
  'System Status', 'Safe Mode',
  'Error (°C)', 'Delta Error (°C/s)', 'Kp', 'Ki', 'Kd', 'PID Output',
  'Power Status', 'Uptime (s)', 'SHT31', 'MQ135', 'INA219'
];

var HEADERS_ALERTS = ['Timestamp', 'Severity', 'Title', 'Message'];

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
      case 'ping':   return jsonResp({ success: true, pong: true, time: new Date().toISOString() });
      case 'append': return handleAppend(body);
      case 'read':   return handleRead(body);
      case 'count':  return handleCount(body);
      case 'clear':  return handleClear(body);
      default:       return jsonResp({ success: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonResp({ success: false, error: 'Server error: ' + err.message });
  }
}

function doGet(e) {
  var params = (e && e.parameter) || {};
  var action = params.action || 'info';

  // Allow GET read/count tanpa token untuk kemudahan testing
  // (production: wajib token via POST)
  if (action === 'ping') {
    return jsonResp({ success: true, pong: true, time: new Date().toISOString() });
  }

  if (action === 'read' || action === 'count') {
    // Cek token kalau ada
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
    version: '1.1.0',
    message: 'GAS Web App aktif.',
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

  // Ambil semua data (baris 2 s/d akhir)
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  // Header untuk mapping kolom
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // Filter by date & search
  var fromDate = fromStr ? new Date(fromStr + 'T00:00:00') : null;
  var toDate   = toStr   ? new Date(toStr   + 'T23:59:59') : null;

  var filtered = values.filter(function (row) {
    // row[0] = timestamp string
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

  // Sort by timestamp desc (terbaru dulu)
  filtered.sort(function (a, b) {
    var ta = new Date(String(a[0]).replace(' ', 'T')).getTime() || 0;
    var tb = new Date(String(b[0]).replace(' ', 'T')).getTime() || 0;
    return tb - ta;
  });

  var total = filtered.length;

  // Paginate
  var page = filtered.slice(offset, offset + limit);

  // Convert ke object rows
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
// CLEAR (danger — gunakan dengan hati-hati)
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
  var headers = sheetName === SHEET_ALERTS ? HEADERS_ALERTS : HEADERS_LOG;

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
      .addItem('Inisialisasi Header', 'menuInitHeaders')
      .addItem('Hapus Data (header only)', 'menuClearData')
      .addToUi();
  } catch (e) {}
}

function menuInitHeaders() {
  ensureHeaders(getSheet(SHEET_LOG), SHEET_LOG);
  ensureHeaders(getSheet(SHEET_ALERTS), SHEET_ALERTS);
  SpreadsheetApp.getUi().alert('Header siap.');
}

function menuClearData() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert('Yakin hapus semua data?', ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  [SHEET_LOG, SHEET_ALERTS].forEach(function (name) {
    var s = getSheet(name);
    if (s && s.getLastRow() > 1) s.deleteRows(2, s.getLastRow() - 1);
  });
  ui.alert('Data dihapus.');
}
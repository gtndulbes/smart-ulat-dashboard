/**
 * ============================================================
 * historyRoutes.js
 * ------------------------------------------------------------
 * Proxy endpoint untuk baca data historis dari GAS.
 *
 * Endpoints:
 *   GET /api/history          — query dengan filter + pagination
 *   GET /api/history/stats    — statistik GAS
 *
 * Query params:
 *   ?from=YYYY-MM-DD
 *   &to=YYYY-MM-DD
 *   &page=1
 *   &limit=50
 *   &search=keyword
 *   &sheet=Log|Alerts
 * ============================================================
 */

'use strict';

const express = require('express');
const router = express.Router();

const config = require('../config/config');
const logger = require('../utils/logger');
const gasService = require('../services/googleAppsScriptService');

const log = logger.scope('API-HIST');

// ------------------------------------------------------------
// GET /api/history
// ------------------------------------------------------------
router.get('/history', async (req, res) => {
  const startedAt = Date.now();

  // Parse query
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
  const offset = (page - 1) * limit;
  const from = (req.query.from || '').trim();
  const to = (req.query.to || '').trim();
  const search = (req.query.search || '').trim();
  const sheet = (req.query.sheet || 'Log').trim();

  // Validasi sheet name
  if (!['Log', 'Alerts'].includes(sheet)) {
    return res.status(400).json({
      success: false,
      error: 'sheet harus "Log" atau "Alerts"'
    });
  }

  if (!config.gas.enabled) {
    return res.status(503).json({
      success: false,
      error: 'GAS belum dikonfigurasi (GAS_WEB_APP_URL kosong)',
      rows: [],
      total: 0
    });
  }

  try {
    const result = await gasService.readSheet({
      sheet, limit, offset, from, to, search
    });

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Gagal baca GAS',
        rows: [],
        total: 0
      });
    }

    const total = result.total;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.json({
      success: true,
      simulated: result.simulated || false,
      sheet,
      rows: result.rows,
      headers: result.headers || [],
      pagination: {
        page,
        limit,
        offset,
        total,
        totalPages,
        hasMore: page < totalPages
      },
      elapsedMs: Date.now() - startedAt,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log.error('history error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      rows: [],
      total: 0
    });
  }
});

// ------------------------------------------------------------
// GET /api/history/stats
// ------------------------------------------------------------
router.get('/history/stats', (req, res) => {
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  res.json({
    gas: safe(() => gasService.getStats()),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
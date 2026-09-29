/**
 * ============================================================
 * statusRoutes.js
 * ------------------------------------------------------------
 * REST API untuk status realtime sistem.
 *
 * Endpoints:
 *   GET  /api/status              — summary state (ringan)
 *   GET  /api/status/full         — full state snapshot
 *   GET  /api/status/alerts       — daftar alert
 *   POST /api/status/alerts/read  — tandai alert terbaca
 *   POST /api/status/alerts/clear — hapus semua alert
 *
 * Catatan:
 *   Endpoint ini utamanya untuk debugging, monitoring eksternal,
 *   dan fallback kalau WebSocket tidak tersedia.
 *   Dashboard utama pakai WebSocket untuk realtime.
 * ============================================================
 */

'use strict';

const express = require('express');
const router = express.Router();

const config = require('../config/config');
const logger = require('../utils/logger');
const stateService = require('../services/stateService');

const log = logger.scope('API-STATUS');

// ------------------------------------------------------------
// GET /api/status — ringkasan
// ------------------------------------------------------------
router.get('/status', (req, res) => {
  try {
    const summary = stateService.getSummary();
    const stats = stateService.getStats();

    res.json({
      success: true,
      service: config.service,
      version: config.version,
      simulation: config.simulationMode,
      timestamp: new Date().toISOString(),
      summary,
      stats: {
        alerts: stats.alerts,
        unreadAlerts: stats.unreadAlerts,
        commandResponses: stats.commandResponses,
        updateCount: stats.updateCount,
        lastUpdate: stats.lastUpdate
      }
    });
  } catch (err) {
    log.error('GET /status error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ------------------------------------------------------------
// GET /api/status/full — full snapshot
// ------------------------------------------------------------
router.get('/status/full', (req, res) => {
  try {
    const state = stateService.getState();
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      state
    });
  } catch (err) {
    log.error('GET /status/full error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ------------------------------------------------------------
// GET /api/status/alerts — daftar alert
// ------------------------------------------------------------
// Query params:
//   ?unread=1   → hanya yang belum dibaca
//   ?limit=20   → batasi jumlah
//   ?severity=CRITICAL,WARNING → filter by severity
// ------------------------------------------------------------
router.get('/status/alerts', (req, res) => {
  try {
    let alerts = stateService.getAlerts();

    // Filter unread
    if (req.query.unread === '1' || req.query.unread === 'true') {
      alerts = alerts.filter((a) => !a.read);
    }

    // Filter severity
    if (req.query.severity) {
      const filter = String(req.query.severity)
        .toUpperCase()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      if (filter.length > 0) {
        alerts = alerts.filter((a) => filter.includes(a.severity));
      }
    }

    // Limit
    const limit = Math.max(
      1,
      Math.min(parseInt(req.query.limit, 10) || 50, 100)
    );
    const sliced = alerts.slice(0, limit);

    res.json({
      success: true,
      total: alerts.length,
      returned: sliced.length,
      unread: alerts.filter((a) => !a.read).length,
      alerts: sliced,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log.error('GET /status/alerts error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ------------------------------------------------------------
// POST /api/status/alerts/read — tandai alert terbaca
// ------------------------------------------------------------
// Body:
//   { id: "alert-..." }   → tandai satu
//   { all: true }         → tandai semua
// ------------------------------------------------------------
router.post('/status/alerts/read', (req, res) => {
  try {
    const body = req.body || {};

    // Mark all
    if (body.all === true) {
      const alerts = stateService.getAlerts();
      let marked = 0;
      alerts.forEach((a) => {
        if (!a.read) {
          if (stateService.markAlertRead(a.id)) marked += 1;
        }
      });
      log.info(`Mark all alerts read: ${marked} alert(s)`);
      return res.json({
        success: true,
        marked,
        message: `${marked} alert ditandai terbaca`
      });
    }

    // Mark satu
    if (!body.id || typeof body.id !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Field "id" atau "all: true" wajib'
      });
    }

    const ok = stateService.markAlertRead(body.id);
    if (!ok) {
      return res.status(404).json({
        success: false,
        error: `Alert dengan id "${body.id}" tidak ditemukan`
      });
    }

    log.info(`Mark alert read: ${body.id}`);
    res.json({
      success: true,
      id: body.id,
      message: 'Alert ditandai terbaca'
    });
  } catch (err) {
    log.error('POST /status/alerts/read error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ------------------------------------------------------------
// POST /api/status/alerts/clear — hapus semua alert
// ------------------------------------------------------------
router.post('/status/alerts/clear', (req, res) => {
  try {
    const before = stateService.getAlerts().length;
    stateService.clearAlerts();
    log.warn(`Clear all alerts: ${before} alert dihapus`);

    res.json({
      success: true,
      cleared: before,
      message: `${before} alert dihapus`
    });
  } catch (err) {
    log.error('POST /status/alerts/clear error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ------------------------------------------------------------
// GET /api/status/config — snapshot config aktif
// ------------------------------------------------------------
router.get('/status/config', (req, res) => {
  try {
    const cfg = stateService.getConfig();
    res.json({
      success: true,
      config: cfg,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
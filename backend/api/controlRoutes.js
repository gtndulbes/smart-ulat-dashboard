/**
 * ============================================================
 * controlRoutes.js
 * ------------------------------------------------------------
 * REST API untuk manual control aktuator.
 *
 * Endpoints:
 *   POST /api/control             — kirim command ke ESP32
 *   GET  /api/control/schema      — daftar command yang valid
 *   GET  /api/control/stats       — statistik command
 *
 * Alur:
 *   Dashboard → POST /api/control
 *        ↓
 *   commandValidation.validate()
 *        ↓
 *   mqttPublisher.sendCommand()   ← tunggu response ESP32
 *        ↓
 *   Response ke dashboard
 * ============================================================
 */

'use strict';

const express = require('express');
const router = express.Router();

const config = require('../config/config');
const logger = require('../utils/logger');
const commandValidation = require('../validation/commandValidation');
const mqttPublisher = require('../mqtt/mqttPublisher');
const stateService = require('../services/stateService');

const log = logger.scope('API-CTRL');

// ------------------------------------------------------------
// POST /api/control
// ------------------------------------------------------------
router.post('/control', async (req, res) => {
  const startedAt = Date.now();

  // ----------------------------------------
  // 1) Validate
  // ----------------------------------------
  const v = commandValidation.validate(req.body);
  if (!v.ok) {
    log.warn('Command ditolak:', v.error, '→', req.body);
    return res.status(400).json({
      success: false,
      error: v.error,
      allowed: v.allowed,
      timestamp: new Date().toISOString()
    });
  }

  // ----------------------------------------
  // 2) Cek simulation mode
  // ----------------------------------------
  if (config.simulationMode) {
    log.info(`[SIM] Command: ${v.command}${v.value !== undefined ? ` = ${v.value}` : ''}`);
    return res.json({
      success: true,
      simulated: true,
      command: v.command,
      value: v.value,
      message: `Simulated OK (SIMULATION_MODE=true)`,
      elapsedMs: Date.now() - startedAt
    });
  }

  // ----------------------------------------
  // 3) Cek MQTT connected
  // ----------------------------------------
  const mqttClient = require('../mqtt/mqttClient');
  if (!mqttClient.isConnected()) {
    log.warn('Command ditolak: MQTT tidak terhubung');
    return res.status(503).json({
      success: false,
      command: v.command,
      error: 'MQTT tidak terhubung ke broker',
      timestamp: new Date().toISOString()
    });
  }

  // ----------------------------------------
  // 4) Kirim & tunggu response
  // ----------------------------------------
  const timeoutMs = Math.max(
    3000,
    Math.min(15000, config.intervals.commandResponseTimeoutMs || 10000)
  );

  log.info(`→ Command [${v.command}]${v.value !== undefined ? ` = ${v.value}` : ''}`);

  try {
    const cmdObj = { command: v.command };
    if (v.value !== undefined) cmdObj.value = v.value;

    const resp = await mqttPublisher.sendCommand(cmdObj, timeoutMs);

    const elapsed = Date.now() - startedAt;
    log.info(`← Command [${v.command}] ${resp.success ? 'OK' : 'FAIL'} (${elapsed}ms)`);

    // Update state kalau sukses
    if (resp.success) {
      // Reflect perubahan di state (optimistic) — ESP32 juga akan
      // update via MQTT actuator/status berikutnya
      if (v.command === 'SET_MODE' && v.value) {
        stateService.updateStatus({ mode: v.value === 'manual' ? 1 : 0 });
      }
    }

    return res.json({
      success: resp.success,
      timeout: resp.timeout || false,
      simulated: resp.simulated || false,
      command: v.command,
      value: v.value,
      message: resp.message,
      elapsedMs: elapsed
    });
  } catch (err) {
    log.error(`Command [${v.command}] error:`, err.message);
    return res.status(500).json({
      success: false,
      command: v.command,
      value: v.value,
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ------------------------------------------------------------
// GET /api/control/schema
// ------------------------------------------------------------
router.get('/control/schema', (req, res) => {
  res.json({
    commands: commandValidation.getSchema(),
    simulation: config.simulationMode,
    timestamp: new Date().toISOString()
  });
});

// ------------------------------------------------------------
// GET /api/control/stats
// ------------------------------------------------------------
router.get('/control/stats', (req, res) => {
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  res.json({
    publisher: safe(() => mqttPublisher.getStats()),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
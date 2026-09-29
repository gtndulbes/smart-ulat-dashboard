/**
 * ============================================================
 * configRoutes.js
 * ============================================================
 */

'use strict';

const express = require('express');
const router = express.Router();

const config = require('../config/config');
const logger = require('../utils/logger');
const configValidation = require('../validation/configValidation');
const configService = require('../services/configService');
const mqttPublisher = require('../mqtt/mqttPublisher');
const stateService = require('../services/stateService');

const log = logger.scope('API-CFG');

// GET /api/config
router.get('/config', (req, res) => {
  const current = stateService.getConfig();
  res.json({
    config: current,
    simulation: config.simulationMode,
    timestamp: new Date().toISOString()
  });
});

// GET /api/config/schema
router.get('/config/schema', (req, res) => {
  res.json({
    schema: configValidation.SCHEMA,
    timestamp: new Date().toISOString()
  });
});

// GET /api/config/export — download JSON
router.get('/config/export', (req, res) => {
  try {
    const json = configService.exportJSON();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="smart-ulat-config-${ts}.json"`);
    res.send(json);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/config/import — upload JSON
router.post('/config/import', (req, res) => {
  try {
    const body = req.body;
    const jsonStr = typeof body === 'string' ? body : JSON.stringify(body);

    const result = configService.importJSON(jsonStr);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error });
    }

    log.info('Config di-import dari dashboard');
    res.json({
      success: true,
      config: stateService.getConfig(),
      message: 'Config berhasil di-import'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/config/reset — reset ke default
router.post('/config/reset', (req, res) => {
  try {
    const defaults = configService.resetToDefaults();
    log.warn('Config di-reset ke default dari dashboard');
    res.json({
      success: true,
      config: defaults,
      message: 'Config di-reset ke default'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/config
router.post('/config', async (req, res) => {
  const startedAt = Date.now();

  const current = stateService.getConfig();
  const v = configValidation.validate(req.body, current);

  if (!v.ok) {
    log.warn('Config ditolak:', v.error);
    return res.status(400).json({
      success: false,
      error: v.error,
      errors: v.errors,
      timestamp: new Date().toISOString()
    });
  }

  const newConfig = v.config;

  try {
    stateService.setConfig(newConfig);
    // setConfig emit 'config' → configService debounce save (1s)
  } catch (err) {
    log.error('setConfig error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Gagal update state: ' + err.message
    });
  }

  if (config.simulationMode) {
    log.info('[SIM] Config di-update (state only):', Object.keys(req.body));
    return res.json({
      success: true,
      simulated: true,
      config: newConfig,
      message: 'Config updated (SIMULATION_MODE=true)',
      elapsedMs: Date.now() - startedAt
    });
  }

  const mqttClient = require('../mqtt/mqttClient');
  if (!mqttClient.isConnected()) {
    log.warn('Config: state updated tapi MQTT tidak terhubung');
    return res.json({
      success: true,
      mqttSent: false,
      config: newConfig,
      message: 'State updated, tapi MQTT tidak terhubung',
      elapsedMs: Date.now() - startedAt
    });
  }

  try {
    const flat = configValidation.toFlat(newConfig);
    const resp = await mqttPublisher.publishConfig(flat, 10000);
    const elapsed = Date.now() - startedAt;

    return res.json({
      success: true,
      mqttSent: true,
      esp32Ack: Boolean(resp.success),
      config: newConfig,
      message: resp.success
        ? 'Config tersimpan di ESP32 NVS'
        : `State updated, ESP32 reply: ${resp.message || 'timeout'}`,
      elapsedMs: elapsed
    });
  } catch (err) {
    log.error('Publish config gagal:', err.message);
    return res.json({
      success: true,
      mqttSent: false,
      config: newConfig,
      message: 'State updated tapi MQTT publish gagal: ' + err.message,
      elapsedMs: Date.now() - startedAt
    });
  }
});

module.exports = router;
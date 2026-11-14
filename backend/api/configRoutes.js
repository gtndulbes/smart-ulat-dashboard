/**
 * ============================================================
 * configRoutes.js
 * ------------------------------------------------------------
 * Endpoint untuk manage configuration.
 *
 * Response field (POST /api/config):
 *   success        — operation berhasil (state + file terupdate)
 *   published      — config publish ke MQTT broker (QoS 1)
 *   acked          — ESP32 reply ACK via TOPIC_RESPONSE
 *   mqttConnected  — backend ke broker MQTT terhubung
 *   esp32Online    — ESP32 kirim telemetry < 15s lalu
 *   simulated      — SIMULATION_MODE aktif
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
    esp32Online: stateService.getEsp32Online ? stateService.getEsp32Online() : null,
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

  // ─────────────────────────────────────────────────────────────
  // 1. Validate
  // ─────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────
  // 2. Update state (persisted via configService debounce)
  // ─────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────
  // 3. Sync mode ke systemStatus (kalau berubah)
  //
  // stateService.setConfig hanya merge ke state.configuration, tapi
  // state.systemStatus.mode TIDAK otomatis update. Frontend baca
  // indicator mode dari systemStatus.mode. Jadi harus sync manual.
  // ─────────────────────────────────────────────────────────────
  if (req.body.mode !== undefined) {
    const newMode = Number(req.body.mode) || 0;
    try {
      stateService.updateStatus({ mode: newMode });
      log.info(`Mode di-sync ke systemStatus: ${newMode === 1 ? 'manual' : 'auto'}`);
    } catch (err) {
      log.warn('updateStatus error:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 4. Simulation mode — tidak publish ke MQTT
  // ─────────────────────────────────────────────────────────────
  if (config.simulationMode) {
    log.info('[SIM] Config di-update (state only):', Object.keys(req.body));
    return res.json({
      success: true,
      simulated: true,
      published: false,
      acked: false,
      mqttConnected: false,
      esp32Online: false,
      config: newConfig,
      message: 'Config updated (SIMULATION_MODE=true)',
      elapsedMs: Date.now() - startedAt
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 5. MQTT backend → broker tidak terhubung
  // ─────────────────────────────────────────────────────────────
  const mqttClient = require('../mqtt/mqttClient');
  if (!mqttClient.isConnected()) {
    log.warn('Config: state updated tapi MQTT tidak terhubung');
    return res.json({
      success: true,
      published: false,
      acked: false,
      mqttConnected: false,
      esp32Online: false,
      config: newConfig,
      message: 'State tersimpan di backend. MQTT offline — akan disinkronkan saat MQTT reconnect.',
      elapsedMs: Date.now() - startedAt
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 6. ESP32 offline (MQTT broker OK, tapi ESP32 tidak kirim telemetry)
  //
  // Kasus: broker EMQX OK, backend connect OK, tapi ESP32 WiFi putus
  // atau MQTT ESP32 putus. Kalau kita publish dengan timeout 10s,
  // pasti timeout — karena tidak ada subscriber (ESP32) yang balas.
  //
  // Solusi: fire-and-forget (QoS 1, timeout 0). Broker akan simpan
  // sebagai pending message; ESP32 akan terima saat reconnect
  // (kalau clean session = false di firmware, atau reconnect subscription).
  //
  // Namun untuk safety, kita juga bisa trigger republish saat
  // esp32Online transition false→true (lihat catatan di bawah).
  // ─────────────────────────────────────────────────────────────
  const esp32Online = stateService.getEsp32Online ? stateService.getEsp32Online() : true;

  if (!esp32Online) {
    log.warn('Config: state updated, ESP32 offline — fire-and-forget publish');
    try {
      const flat = configValidation.toFlat(newConfig);
      // timeout=0 → fire and forget, tidak tunggu ACK
      await mqttPublisher.publishConfig(flat, 0);
      return res.json({
        success: true,
        published: true,
        acked: false,
        mqttConnected: true,
        esp32Online: false,
        config: newConfig,
        message: 'State tersimpan. ESP32 offline — config akan disinkronkan saat ESP32 online.',
        elapsedMs: Date.now() - startedAt
      });
    } catch (err) {
      log.error('Publish config (fire-forget) gagal:', err.message);
      return res.json({
        success: true,
        published: false,
        acked: false,
        mqttConnected: true,
        esp32Online: false,
        config: newConfig,
        message: 'State tersimpan, tapi publish gagal: ' + err.message,
        elapsedMs: Date.now() - startedAt
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 7. Normal flow — publish dan tunggu ACK dari ESP32
  // ─────────────────────────────────────────────────────────────
  try {
    const flat = configValidation.toFlat(newConfig);
    const resp = await mqttPublisher.publishConfig(flat, 10000);
    const elapsed = Date.now() - startedAt;

    return res.json({
      success: true,
      published: true,
      acked: Boolean(resp.success),
      mqttConnected: true,
      esp32Online: true,
      config: newConfig,
      message: resp.success
        ? 'Config tersimpan di ESP32 NVS'
        : `State tersimpan, tapi ESP32 timeout. Akan di-retry otomatis saat ESP32 reconnect.`,
      elapsedMs: elapsed
    });
  } catch (err) {
    log.error('Publish config gagal:', err.message);
    return res.json({
      success: true,
      published: false,
      acked: false,
      mqttConnected: true,
      esp32Online: true,
      config: newConfig,
      message: 'State tersimpan, tapi publish gagal: ' + err.message,
      elapsedMs: Date.now() - startedAt
    });
  }
});

module.exports = router;
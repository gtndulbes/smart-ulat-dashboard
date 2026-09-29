'use strict';

const express = require('express');
const router = express.Router();

const config = require('../config/config');
const mqttClient = require('../mqtt/mqttClient');
const mqttHandlers = require('../mqtt/mqttHandlers');
const mqttPublisher = require('../mqtt/mqttPublisher');
const stateService = require('../services/stateService');
const configService = require('../services/configService');
const historyService = require('../services/historyService');
const alertService = require('../services/alertService');
const websocketServer = require('../websocket/websocketServer');

router.get('/health', (req, res) => {
  const safe = (fn) => { try { return fn(); } catch { return null; } };

  res.json({
    status: 'ok',
    service: config.service,
    version: config.version,
    env: config.env,
    uptime: Number(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
    simulation: config.simulationMode,
    telegram: config.telegram.enabled,
    gas: config.gas.enabled,
    mqtt: safe(() => mqttClient.getStatus()),
    mqttHandlers: safe(() => mqttHandlers.getStats()),
    mqttPublisher: safe(() => mqttPublisher.getStats()),
    state: safe(() => stateService.getStats()),
    configPersistence: safe(() => configService.getStats()),
    websocket: safe(() => websocketServer.getStats()),
    history: safe(() => historyService.getStats()),
    alerts: safe(() => alertService.getStats())
  });
});

module.exports = router;
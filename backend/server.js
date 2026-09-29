/**
 * ============================================================
 * server.js — Entry point
 * ------------------------------------------------------------
 * STEP 16: (frontend only)
 * STEP 17: + Security middleware + error handler
 * ============================================================
 */

'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');

const config = require('./config/config');
const logger = require('./utils/logger');

const security = require('./middleware/security');
const {
  errorHandler,
  notFoundHandler,
  setupProcessHandlers
} = require('./middleware/errorHandler');

const healthRoutes  = require('./api/healthRoutes');
const statusRoutes  = require('./api/statusRoutes');
const controlRoutes = require('./api/controlRoutes');
const configRoutes  = require('./api/configRoutes');
const historyRoutes = require('./api/historyRoutes');

const mqttClient = require('./mqtt/mqttClient');
const mqttHandlers = require('./mqtt/mqttHandlers');
const mqttPublisher = require('./mqtt/mqttPublisher');

const stateService = require('./services/stateService');
const configService = require('./services/configService');
const historyService = require('./services/historyService');
const alertService = require('./services/alertService');
const websocketServer = require('./websocket/websocketServer');

const log = logger.scope('SERVER');

// ------------------------------------------------------------
const configErrors = config.validate();
if (configErrors.length > 0) {
  console.error('\n❌ Konfigurasi tidak valid:\n');
  configErrors.forEach((e) => console.error('   • ' + e));
  process.exit(1);
}

// Setup process-level handlers
setupProcessHandlers();

// ------------------------------------------------------------
const app = express();
app.set('trust proxy', config.security.trustProxy ? 1 : false);
app.disable('x-powered-by');

// === SECURITY MIDDLEWARE (urutan penting!) ===
app.use(security.securityHeaders);
app.use(security.requestId);
app.use(security.enforceHttps);
app.use(security.payloadGuard);

// CORS — whitelist atau all
const corsOrigins = config.security.corsOrigins.length
  ? config.security.corsOrigins
  : true;

app.use(cors({
  origin: corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  maxAge: 86400
}));

// Body parser
app.use(express.json({ limit: config.security.maxBodySize }));
app.use(express.urlencoded({ extended: true, limit: config.security.maxBodySize }));

// Sanitize body
app.use(security.sanitizeMiddleware);

// Rate limiter global (kecuali /api/health)
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  return security.rateLimiter()(req, res, next);
});

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error'
                : res.statusCode >= 400 ? 'warn'
                : 'info';
    log[level](`[${req.id}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Static frontend
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR, {
  extensions: ['html'],
  index: ['index.html'],
  maxAge: config.isProduction ? '1h' : 0,
  etag: true,
  lastModified: true
}));

// === API ROUTES ===
app.use('/api', healthRoutes);
app.use('/api', statusRoutes);

// Tulis endpoint dengan rate limit ketat
app.use('/api', security.writeRateLimiter(), controlRoutes);
app.use('/api', security.writeRateLimiter(), configRoutes);

app.use('/api', historyRoutes);

// 404 API
app.use('/api', notFoundHandler);

// SPA fallback
app.get('*', (req, res, next) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'), (err) => {
    if (err) {
      log.error('Gagal kirim index.html:', err.message);
      next(err);
    }
  });
});

// === GLOBAL ERROR HANDLER (WAJIB paling akhir) ===
app.use(errorHandler);

// ------------------------------------------------------------
function initServices(httpServer) {
  logger.info('--------------------------------------------------');
  logger.info('  SERVICES INIT');

  stateService.init();
  logger.info('  ✓ stateService initialized');

  // Config persistence (Step 17 patch)
  configService.init();
  logger.info('  ✓ configService initialized');

  mqttHandlers.setStateService(stateService);
  logger.info('  ✓ mqttHandlers terhubung ke stateService');

  websocketServer.init(httpServer);
  logger.info('  ✓ WebSocket server attached');

  if (config.gas.enabled) {
    historyService.start();
    logger.info('  ✓ historyService started');
  } else {
    logger.warn('  ⚠ historyService TIDAK dijalankan');
  }

  alertService.init();
  logger.info('  ✓ alertService initialized');

  if (config.simulationMode) {
    logger.warn('  SIMULATION_MODE=true — MQTT TIDAK akan connect');
    return;
  }

  mqttHandlers.init();
  logger.info('  ✓ mqttHandlers initialized');

  mqttClient.on('connected', () => log.info('MQTT event: connected'));
  mqttClient.on('disconnected', () => log.warn('MQTT event: disconnected'));
  mqttClient.on('reconnecting', (a) => log.warn(`MQTT event: reconnecting (#${a})`));
  mqttClient.on('error', (err) => log.error('MQTT event: error →', err.message));

  mqttClient.connect();
}

const server = http.createServer(app);
const PORT = config.port;

server.listen(PORT, () => {
  logger.info('==================================================');
  logger.info('  SMART ULAT HONGKONG — BACKEND');
  logger.info('==================================================');
  logger.info(`  Service     : ${config.service}`);
  logger.info(`  Version     : ${config.version}`);
  logger.info(`  Environment : ${config.env}`);
  logger.info(`  Port        : ${PORT}`);
  logger.info(`  Log Level   : ${config.logLevel}`);
  logger.info(`  Simulation  : ${config.simulationMode}`);
  logger.info(`  Frontend    : ${FRONTEND_DIR}`);
  logger.info(`  Telegram    : ${config.telegram.enabled ? 'ENABLED' : 'disabled'}`);
  logger.info(`  GAS         : ${config.gas.enabled ? 'ENABLED' : 'disabled'}`);
  logger.info('--------------------------------------------------');
  logger.info('  SECURITY');
  logger.info(`    Headers   : ${config.security.headers.enableHelmet ? 'ON' : 'off'}`);
  logger.info(`    Rate Limit: ${config.security.rateLimit.maxRequests} req/menit`);
  logger.info(`    Write Max : ${config.security.rateLimit.writeMaxRequests} req/menit`);
  logger.info(`    CORS      : ${config.security.corsOrigins.length ? config.security.corsOrigins.join(',') : 'all'}`);
  logger.info(`    HSTS      : ${config.isProduction ? 'ON' : 'off (dev)'}`);
  logger.info('--------------------------------------------------');
  logger.info(`  Local       : http://localhost:${PORT}`);
  logger.info(`  Health      : http://localhost:${PORT}/api/health`);
  logger.info(`  WebSocket   : ws://localhost:${PORT}${config.websocket.path}`);
  logger.info('==================================================');

  initServices(server);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${PORT} sudah dipakai.`);
    process.exit(1);
  }
  log.error('Server error:', err);
  process.exit(1);
});

// Graceful shutdown
let shuttingDown = false;
async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn(`Shutting down (${reason})...`);

  const force = setTimeout(() => { log.error('Force exit'); process.exit(1); }, 8000);
  force.unref();

  try { alertService.shutdown(); } catch {}
  try { historyService.stop(); } catch {}
  try { configService.shutdown(); } catch {}
  try { mqttPublisher.cancelAllPending('Server shutdown'); } catch {}
  try { await mqttClient.disconnect(); } catch {}
  try { await websocketServer.shutdown(); } catch {}

  server.close((err) => {
    if (err) { log.error('Error close:', err); process.exit(1); }
    log.info('HTTP server closed. Bye.');
    process.exit(exitCode);
  });
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server, stateService };
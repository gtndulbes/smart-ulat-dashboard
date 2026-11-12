/**
 * ============================================================
 * server.js — Entry point
 * ------------------------------------------------------------
 * Fix untuk request berlebihan:
 *   - SPA fallback hanya untuk non-file
 *   - /api/health di-rate-limit (60/menit)
 *   - Request audit log
 *   - Static cache lebih agresif
 *   - Logger hanya untuk API + error + slow
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

setupProcessHandlers();

// ============================================================
// REQUEST AUDIT — diagnosa "banyak GET"
// ============================================================
const _reqStats = new Map();

setInterval(() => {
  if (_reqStats.size === 0) return;
  const sorted = [..._reqStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  log.warn('📊 Top request paths (last 60s):');
  for (const [pathKey, count] of sorted) {
    log.warn(`   ${String(count).padStart(5)}x  ${pathKey}`);
  }
  _reqStats.clear();
}, 60000).unref();

// ------------------------------------------------------------
const app = express();
app.set('trust proxy', config.security.trustProxy ? 1 : false);
app.disable('x-powered-by');

// === SECURITY MIDDLEWARE ===
app.use(security.securityHeaders);
app.use(security.requestId);
app.use(security.enforceHttps);
app.use(security.payloadGuard);

// CORS
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

// Rate limiter global — health punya limit ringan
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/health/full') {
    return security.rateLimiter({ max: 60 })(req, res, next);
  }
  return security.rateLimiter()(req, res, next);
});

// ============================================================
// REQUEST LOGGER + AUDIT
// ============================================================
app.use((req, res, next) => {
  const start = Date.now();

  const pathKey = `${req.method} ${req.baseUrl || ''}${req.path.split('?')[0]}`;
  _reqStats.set(pathKey, (_reqStats.get(pathKey) || 0) + 1);

  res.on('finish', () => {
    const ms = Date.now() - start;
    const isApi = req.originalUrl.startsWith('/api');
    const isSlow = ms > 500;
    const isError = res.statusCode >= 400;

    // Log hanya API, error, atau slow
    if (!isApi && !isSlow && !isError) return;

    const level = isError
      ? (res.statusCode >= 500 ? 'error' : 'warn')
      : 'info';
    log[level](`[${req.id}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });

  next();
});

// ============================================================
// STATIC FRONTEND — cache lebih agresif
// ============================================================
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

app.use(express.static(FRONTEND_DIR, {
  extensions: ['html'],
  index: ['index.html'],
  maxAge: config.isProduction ? '7d' : '1d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // File dengan hash → cache selamanya
    if (/\.[a-f0-9]{6,}\.(js|css|png|jpg|jpeg|svg|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// ============================================================
// API ROUTES
// ============================================================
app.use('/api', healthRoutes);
app.use('/api', statusRoutes);
app.use('/api', security.writeRateLimiter(), controlRoutes);
app.use('/api', security.writeRateLimiter(), configRoutes);
app.use('/api', historyRoutes);

// 404 API
app.use('/api', notFoundHandler);

// ============================================================
// KUNCI FIX: file request yang tidak match
// ============================================================
// Jangan biarkan SPA fallback return HTML untuk file requests.
// Cegah loop: browser minta .js → dapat HTML → gagal parse → retry.

// Silence common browser requests
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /api\n');
});

// SPA fallback — hanya untuk route non-file
app.get('*', (req, res, next) => {
  // Path dengan ekstensi file → 404
  if (/\.[a-zA-Z0-9]+$/.test(req.path)) {
    return res.status(404).type('text/plain').send('Not Found');
  }
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'), (err) => {
    if (err) {
      log.error('Gagal kirim index.html:', err.message);
      next(err);
    }
  });
});

// GLOBAL ERROR HANDLER
app.use(errorHandler);

// ------------------------------------------------------------
function initServices(httpServer) {
  logger.info('--------------------------------------------------');
  logger.info('  SERVICES INIT');

  stateService.init();
  logger.info('  ✓ stateService initialized');

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
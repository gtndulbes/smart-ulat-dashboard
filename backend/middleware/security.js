/**
 * ============================================================
 * security.js
 * ------------------------------------------------------------
 * Middleware keamanan — tanpa dependency eksternal.
 *
 * Fitur:
 *   - Security headers (helmet-like, tanpa package helmet)
 *   - Rate limiter (in-memory, per IP)
 *   - IP whitelist
 *   - Request ID
 *   - Payload size guard
 *   - Sanitization helpers
 *
 * Tidak pakai library eksternal supaya:
 *   - Zero dependency
 *   - Mudah dipahami mahasiswa
 *   - Cukup untuk TA/UMKM
 *
 * Untuk production skala besar, ganti dengan `helmet` + `express-rate-limit`.
 * ============================================================
 */

'use strict';

const crypto = require('crypto');
const config = require('../config/config');
const logger = require('../utils/logger');

const log = logger.scope('SEC');

// ============================================================
// 1) SECURITY HEADERS
// ============================================================
function securityHeaders(req, res, next) {
  if (!config.security.headers.enableHelmet) return next();

  // Jangan sniff MIME type
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Jangan tampilkan di iframe
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // XSS protection (legacy, tapi masih berguna)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Permissions policy
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), payment=(), usb=()'
  );

  // HSTS hanya di production (HTTPS)
  if (config.isProduction) {
    res.setHeader(
      'Strict-Transport-Security',
      `max-age=${config.security.headers.hstsMaxAge}; includeSubDomains`
    );
  }

  // CSP — default off; aktifkan kalau sudah tune asset
  if (config.security.headers.enableCSP) {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'self'",
      "base-uri 'self'"
    ].join('; ');
    res.setHeader('Content-Security-Policy', csp);
  }

  next();
}

// ============================================================
// 2) REQUEST ID — untuk tracing
// ============================================================
function requestId(req, res, next) {
  const id = req.headers['x-request-id'] ||
             crypto.randomBytes(8).toString('hex');
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

// ============================================================
// 3) RATE LIMITER — sliding window per IP
// ============================================================
const buckets = new Map();  // ip → { count, resetAt }

// Cleanup bucket lama tiap 5 menit
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of buckets.entries()) {
    if (bucket.resetAt < now) buckets.delete(ip);
  }
}, 5 * 60 * 1000).unref?.();

function _getClientIp(req) {
  // Trust proxy → ambil dari X-Forwarded-For
  if (config.security.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function rateLimiter(opts = {}) {
  const windowMs = opts.windowMs ?? config.security.rateLimit.windowMs;
  const max = opts.max ?? config.security.rateLimit.maxRequests;
  const whitelist = config.security.rateLimit.whitelist;

  return function (req, res, next) {
    const ip = _getClientIp(req);

    // Whitelist
    if (whitelist.includes(ip)) return next();

    // Localhost selalu boleh (dev)
    if (config.isDevelopment &&
        (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) {
      return next();
    }

    const now = Date.now();
    let bucket = buckets.get(ip);

    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, bucket);
    }

    bucket.count += 1;

    // Set headers
    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      log.warn(`Rate limit HIT: ${ip} (${bucket.count}/${max})`);
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Coba lagi dalam ${Math.ceil((bucket.resetAt - now) / 1000)}s.`,
        retryAfter: Math.ceil((bucket.resetAt - now) / 1000)
      });
    }

    next();
  };
}

// ============================================================
// 4) WRITE RATE LIMITER — lebih ketat untuk POST
// ============================================================
function writeRateLimiter() {
  return rateLimiter({
    max: config.security.rateLimit.writeMaxRequests
  });
}

// ============================================================
// 5) PAYLOAD GUARD
// ============================================================
function payloadGuard(req, res, next) {
  const len = parseInt(req.headers['content-length'] || '0', 10);
  const maxBytes = 1024 * 1024;  // 1 MB

  if (len > maxBytes) {
    log.warn(`Payload too large: ${len} bytes from ${_getClientIp(req)}`);
    return res.status(413).json({
      error: 'Payload too large',
      maxBytes
    });
  }
  next();
}

// ============================================================
// 6) SIMPLE JSON SANITIZER (untuk string fields)
// ============================================================
/**
 * Batasi panjang string di object nested (max depth & length).
 * Cegah payload DOS (deep nested / string sangat panjang).
 */
function sanitizePayload(obj, maxDepth = 5, maxStrLen = 1000, currentDepth = 0) {
  if (currentDepth > maxDepth) return null;
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return obj.length > maxStrLen ? obj.slice(0, maxStrLen) : obj;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;

  if (Array.isArray(obj)) {
    if (obj.length > 100) obj = obj.slice(0, 100);
    return obj.map((v) => sanitizePayload(v, maxDepth, maxStrLen, currentDepth + 1));
  }

  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length > 50) return {};    // object terlalu banyak field
    const out = {};
    for (const k of keys) {
      out[k] = sanitizePayload(obj[k], maxDepth, maxStrLen, currentDepth + 1);
    }
    return out;
  }
  return null;
}

function sanitizeMiddleware(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizePayload(req.body);
  }
  next();
}

// ============================================================
// 7) STRICT HTTPS (production only)
// ============================================================
function enforceHttps(req, res, next) {
  if (!config.isProduction) return next();
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();

  // Kecuali health check (biar load balancer tetap bisa probe)
  if (req.path === '/api/health') return next();

  log.warn(`HTTP request di production: ${req.originalUrl}`);
  return res.status(403).json({
    error: 'HTTPS required',
    message: 'Akses harus melalui HTTPS'
  });
}

// ============================================================
// EXPORT
// ============================================================
module.exports = {
  securityHeaders,
  requestId,
  rateLimiter,
  writeRateLimiter,
  payloadGuard,
  sanitizeMiddleware,
  sanitizePayload,
  enforceHttps,
  _getClientIp
};
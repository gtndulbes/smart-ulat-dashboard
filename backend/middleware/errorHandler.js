/**
 * ============================================================
 * errorHandler.js
 * ------------------------------------------------------------
 * Global error handler + custom error classes.
 *
 * Fitur:
 *   - Custom error classes (AppError, ValidationError, dll)
 *   - Central error handler → JSON response
 *   - Async wrapper (catch promise rejection)
 *   - 404 handler
 * ============================================================
 */

'use strict';

const config = require('../config/config');
const logger = require('../utils/logger');

const log = logger.scope('ERROR');

// ============================================================
// Custom Error classes
// ============================================================
class AppError extends Error {
  constructor(message, status = 500, code = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.details = details;
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

class ServiceUnavailableError extends AppError {
  constructor(message = 'Service unavailable') {
    super(message, 503, 'SERVICE_UNAVAILABLE');
    this.name = 'ServiceUnavailableError';
  }
}

// ============================================================
// Async wrapper — bungkus async handler
// ============================================================
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ============================================================
// Not Found handler
// ============================================================
function notFoundHandler(req, res) {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} tidak ditemukan`,
    requestId: req.id
  });
}

// ============================================================
// Error handler utama
// ============================================================
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const isOperational = err.isOperational === true;

  // Log error
  const logMsg = `[${req.id}] ${req.method} ${req.originalUrl} → ${status}: ${err.message}`;

  if (status >= 500) {
    log.error(logMsg);
    if (config.isDevelopment) log.error(err.stack);
  } else if (status >= 400) {
    log.warn(logMsg);
  } else {
    log.info(logMsg);
  }

  // Response body
  const body = {
    error: err.name || 'Internal Server Error',
    message: config.isDevelopment
      ? err.message
      : (isOperational ? err.message : 'Internal server error'),
    requestId: req.id,
    timestamp: new Date().toISOString()
  };

  if (err.code) body.code = err.code;
  if (err.details && config.isDevelopment) body.details = err.details;
  if (config.isDevelopment && err.stack) body.stack = err.stack;

  // Jangan kirim response kalau headers sudah terkirim
  if (res.headersSent) {
    return next(err);
  }

  res.status(status).json(body);
}

// ============================================================
// Handler untuk unhandled promise
// ============================================================
function setupProcessHandlers() {
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException:', err);
    // Beri waktu log flush, lalu exit
    setTimeout(() => process.exit(1), 500);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection:', reason);
    // Jangan exit — biarkan server hidup
  });
}

// ============================================================
// EXPORT
// ============================================================
module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ServiceUnavailableError,
  asyncHandler,
  notFoundHandler,
  errorHandler,
  setupProcessHandlers
};
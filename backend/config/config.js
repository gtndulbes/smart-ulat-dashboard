'use strict';

require('dotenv').config();

const toBool = (v, fallback = false) => {
  if (v === undefined || v === null || v === '') return fallback;
  return String(v).toLowerCase() === 'true';
};
const toInt = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

const config = {
  service: 'smart-ulat-backend',
  version: '1.0.0',
  env: process.env.NODE_ENV || 'development',

  get isDevelopment() { return this.env === 'development'; },
  get isProduction()  { return this.env === 'production'; },

  port: toInt(process.env.PORT, 3000),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  // ============================================
  // SECURITY (Step 17)
  // ============================================
  security: {
    // Rate limit per IP
    rateLimit: {
      windowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 60000),   // 1 menit
      maxRequests: toInt(process.env.RATE_LIMIT_MAX, 120),        // 120 req/menit
      // Limit khusus untuk endpoint POST (control, config)
      writeMaxRequests: toInt(process.env.RATE_LIMIT_WRITE_MAX, 30),
      // Whitelist IP yang bebas rate limit (kosong = tidak ada)
      whitelist: (process.env.RATE_LIMIT_WHITELIST || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    },

    // CORS
    corsOrigins: (process.env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    // Body size limit
    maxBodySize: process.env.MAX_BODY_SIZE || '1mb',

    // Trust proxy (untuk baca X-Forwarded-For)
    trustProxy: toBool(process.env.TRUST_PROXY, true),

    // Headers
    headers: {
      enableHelmet: toBool(process.env.ENABLE_HELMET, true),
      hstsMaxAge: toInt(process.env.HSTS_MAX_AGE, 31536000),     // 1 tahun
      enableCSP: toBool(process.env.ENABLE_CSP, false)           // default off (butuh tuning)
    }
  },

  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL || '',
    username: process.env.MQTT_USERNAME || '',
    password: process.env.MQTT_PASSWORD || '',
    clientId: process.env.MQTT_CLIENT_ID || 'smart-ulat-backend',
    caCert: process.env.MQTT_CA_CERT || '',
    reconnectPeriod: 5000,
    connectTimeout: 30000,
    keepalive: 60,
    clean: true,
    resubscribe: true,
    topics: {
      telemetry:      'smartulat/telemetry',
      actuator:       'smartulat/actuator',
      power:          'smartulat/power',
      selfMonitoring: 'smartulat/selfmonitoring',
      status:         'smartulat/status',
      alert:          'smartulat/alert',
      response:       'smartulat/response',
      fuzzyPid:       'smartulat/fuzzypid',
      control:        'smartulat/control',
      config:         'smartulat/config',
      wildcard:       'smartulat/#'
    }
  },

  gas: {
    webAppUrl:   process.env.GAS_WEB_APP_URL   || '',
    webAppToken: process.env.GAS_WEB_APP_TOKEN || '',
    timeoutMs:   15000,
    maxRetries:  3,
    retryDelayMs: 2000
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId:   process.env.TELEGRAM_CHAT_ID   || '',
    apiBase:  'https://api.telegram.org',
    enabled:  false
  },

  simulationMode: toBool(process.env.SIMULATION_MODE, true),

  websocket: {
    path: '/ws',
    heartbeatIntervalMs: 30000,
    maxClients: 100,
    allowedOrigins: []
  },

  safety: {
    sensor: {
      tempMin: -40, tempMax: 125,
      humidityMin: 0, humidityMax: 100,
      nh3Min: 0, nh3Max: 500,
      voltageMin: 0, voltageMax: 26
    },
    priority: [
      'SAFETY', 'SENSOR_ERROR', 'POWER_CRITICAL',
      'NH3_EMERGENCY', 'NORMAL_FUZZY_PID'
    ]
  },

  defaults: {
    setpoint: {
      temperature: 27.5,
      humidity: 75.0,
      nh3: 20.0,
      nh3Emergency: 25.0
    },
    pid: {
      peltier:  { kp: 30.0, ki: 0.5,  kd: 5.0  },
      fanTemp:  { kp: 15.0, ki: 0.3,  kd: 2.0  },
      fanHum:   { kp: 2.0,  ki: 0.05, kd: 0.3  },
      fanNH3:   { kp: 6.0,  ki: 0.2,  kd: 0.8  }
    },
    peltier: { coolLimit: 3.0, heatLimit: 3.0, pwmMin: 0, pwmMax: 255 },
    fan: { pwmMin: 0, pwmMax: 255 },
    heatsink: { minPwm: 60, maxPwm: 255, curve: 0.7 },
    power: { voltageMin: 10.5, voltageMax: 13.5, currentMax: 6.0, powerMax: 60.0 }
  },

  intervals: {
    historyLogMs: 60000,
    historyMinIntervalMs: 15000,
    stateBroadcastMs: 1000,
    commandResponseTimeoutMs: 10000
  }
};

config.telegram.enabled =
  Boolean(config.telegram.botToken) && Boolean(config.telegram.chatId);

config.gas.enabled = Boolean(config.gas.webAppUrl);

function validate() {
  const errors = [];

  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    errors.push(`PORT tidak valid: ${config.port}`);
  }

  if (!config.simulationMode) {
    // Broker URL wajib ada saat bukan simulation
    if (!config.mqtt.brokerUrl) {
      errors.push('MQTT_BROKER_URL wajib diisi saat SIMULATION_MODE=false');
    }

    // Protokol harus valid
    if (config.mqtt.brokerUrl &&
        !config.mqtt.brokerUrl.startsWith('mqtts://') &&
        !config.mqtt.brokerUrl.startsWith('mqtt://') &&
        !config.mqtt.brokerUrl.startsWith('ws://') &&
        !config.mqtt.brokerUrl.startsWith('wss://')) {
      errors.push('MQTT_BROKER_URL harus diawali mqtts:// / mqtt:// / ws:// / wss://');
    }

    // Credential: OPSIONAL. Hanya wajib kalau broker butuh auth.
    // Public broker (broker.emqx.io, test.mosquitto.org, dll) tidak butuh auth.
    // Kalau user isi salah satu (username/password), keduanya harus ada.
    const hasUser = Boolean(config.mqtt.username);
    const hasPass = Boolean(config.mqtt.password);

    if (hasUser && !hasPass) {
      errors.push('MQTT_PASSWORD wajib diisi jika MQTT_USERNAME sudah diisi');
    }
    if (hasPass && !hasUser) {
      errors.push('MQTT_USERNAME wajib diisi jika MQTT_PASSWORD sudah diisi');
    }

    // Warning (bukan error) kalau pakai mqtts:// tanpa credential
    if (config.mqtt.brokerUrl?.startsWith('mqtts://') && !hasUser) {
      console.warn('');
      console.warn('⚠️  WARNING: MQTT_BROKER_URL pakai TLS (mqtts://) tapi tidak ada MQTT_USERNAME.');
      console.warn('   EMQX Cloud & broker privat biasanya butuh credential.');
      console.warn('   Kalau broker tidak butuh auth, ini OK.');
      console.warn('');
    }
  }

  if (!['development', 'production', 'test'].includes(config.env)) {
    errors.push(`NODE_ENV tidak dikenal: ${config.env}`);
  }

  return errors;
}

config.validate = validate;
module.exports = config;
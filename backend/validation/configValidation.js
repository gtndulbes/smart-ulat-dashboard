/**
 * ============================================================
 * configValidation.js
 * ------------------------------------------------------------
 * Validasi payload konfigurasi dari dashboard.
 *
 * Fitur:
 *   - Deep merge dengan config existing (partial update OK)
 *   - Range check per field
 *   - Cross-field validation (vMin < vMax, dst)
 *
 * Cara pakai:
 *   const v = require('./validation/configValidation');
 *   const r = v.validate(req.body, currentConfig);
 *   if (!r.ok) return res.status(400).json({ error: r.error });
 *   // r.config — config lengkap yang sudah valid
 * ============================================================
 */

'use strict';

// ------------------------------------------------------------
// Schema nested — min/max per field
// ------------------------------------------------------------
const SCHEMA = {
  setpoint: {
    temperature:  { min: 20,   max: 35   },
    humidity:     { min: 40,   max: 95   },
    nh3:          { min: 5,    max: 50   },
    nh3Emergency: { min: 15,   max: 100  }
  },
  pid: {
    peltier: {
      kp: { min: 0, max: 200 },
      ki: { min: 0, max: 10  },
      kd: { min: 0, max: 50  }
    },
    fanTemp: {
      kp: { min: 0, max: 100 },
      ki: { min: 0, max: 5   },
      kd: { min: 0, max: 20  }
    },
    fanHum: {
      kp: { min: 0, max: 50 },
      ki: { min: 0, max: 2  },
      kd: { min: 0, max: 10 }
    },
    fanNH3: {
      kp: { min: 0, max: 50 },
      ki: { min: 0, max: 2  },
      kd: { min: 0, max: 10 }
    }
  },
  peltier: {
    coolLimit: { min: 0.5, max: 10  },
    heatLimit: { min: 0.5, max: 10  },
    pwmMin:    { min: 0,   max: 255 },
    pwmMax:    { min: 0,   max: 255 }
  },
  fan: {
    pwmMin: { min: 0, max: 255 },
    pwmMax: { min: 0, max: 255 }
  },
  heatsink: {
    minPwm: { min: 0,   max: 255 },
    maxPwm: { min: 0,   max: 255 },
    curve:  { min: 0.1, max: 2.0 }
  },
  power: {
    voltageMin: { min: 5,   max: 15  },
    voltageMax: { min: 10,  max: 20  },
    currentMax: { min: 0.5, max: 20  },
    powerMax:   { min: 10,  max: 200 }
  }
};

// ------------------------------------------------------------
// Helper
// ------------------------------------------------------------
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source || {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function getNested(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

// ------------------------------------------------------------
// Walk schema → validate
// ------------------------------------------------------------
function _walk(schema, merged, prefix, errors) {
  for (const [key, spec] of Object.entries(schema)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;

    // Field leaf? (ada min/max)
    if (typeof spec === 'object' && spec.min !== undefined && spec.max !== undefined) {
      const value = getNested(merged, fullPath);

      if (value === undefined || value === null) continue;

      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${fullPath} harus angka`);
        continue;
      }
      if (value < spec.min) errors.push(`${fullPath} minimal ${spec.min}`);
      if (value > spec.max) errors.push(`${fullPath} maksimal ${spec.max}`);
    } else if (isPlainObject(spec)) {
      // Section: recurse
      _walk(spec, merged, fullPath, errors);
    }
  }
}

// ------------------------------------------------------------
// Cross-field checks
// ------------------------------------------------------------
function _crossChecks(cfg, errors) {
  const p = cfg.power;
  if (p) {
    if (p.voltageMin !== undefined && p.voltageMax !== undefined &&
        p.voltageMin >= p.voltageMax) {
      errors.push('power.voltageMin harus lebih kecil dari power.voltageMax');
    }
    if (p.currentMax !== undefined && p.currentMax <= 0) {
      errors.push('power.currentMax harus > 0');
    }
  }

  const hs = cfg.heatsink;
  if (hs && hs.minPwm !== undefined && hs.maxPwm !== undefined &&
      hs.minPwm > hs.maxPwm) {
    errors.push('heatsink.minPwm harus ≤ heatsink.maxPwm');
  }

  const sp = cfg.setpoint;
  if (sp && sp.nh3 !== undefined && sp.nh3Emergency !== undefined &&
      sp.nh3 >= sp.nh3Emergency) {
    errors.push('setpoint.nh3 harus lebih kecil dari setpoint.nh3Emergency');
  }

  const plt = cfg.peltier;
  if (plt && plt.pwmMin !== undefined && plt.pwmMax !== undefined &&
      plt.pwmMin > plt.pwmMax) {
    errors.push('peltier.pwmMin harus ≤ peltier.pwmMax');
  }

  const fan = cfg.fan;
  if (fan && fan.pwmMin !== undefined && fan.pwmMax !== undefined &&
      fan.pwmMin > fan.pwmMax) {
    errors.push('fan.pwmMin harus ≤ fan.pwmMax');
  }
}

// ------------------------------------------------------------
// Validate — public API
// ------------------------------------------------------------
/**
 * @param {object} input     — payload dari dashboard (partial OK)
 * @param {object} current   — config existing dari state
 * @returns {object}         — { ok: true, config } | { ok: false, error, errors }
 */
function validate(input, current) {
  if (!isPlainObject(input)) {
    return { ok: false, error: 'body harus object JSON', errors: ['body bukan object'] };
  }

  // Reject field yang tidak dikenal (top-level)
  const allowedTopKeys = new Set([
    ...Object.keys(SCHEMA),
    'mode'
  ]);
  const unknownTop = Object.keys(input).filter((k) => !allowedTopKeys.has(k));
  if (unknownTop.length > 0) {
    return {
      ok: false,
      error: `field tidak dikenal: ${unknownTop.join(', ')}`,
      errors: [`field tidak dikenal: ${unknownTop.join(', ')}`]
    };
  }

  // Deep merge dengan current
  const merged = deepMerge(current || {}, input);

  const errors = [];
  _walk(SCHEMA, merged, '', errors);
  _crossChecks(merged, errors);

  if (errors.length > 0) {
    return { ok: false, error: errors.join('; '), errors };
  }

  return { ok: true, config: merged };
}

// ------------------------------------------------------------
// To flat (untuk MQTT ke ESP32 firmware)
// ------------------------------------------------------------
/**
 * Konversi nested config → flat (sesuai firmware ESP32).
 */
function toFlat(cfg) {
  return {
    spTemp:   cfg.setpoint?.temperature,
    spHum:    cfg.setpoint?.humidity,
    spNH3:    cfg.setpoint?.nh3,
    nh3Emerg: cfg.setpoint?.nh3Emergency,

    peltKp:   cfg.pid?.peltier?.kp,
    peltKi:   cfg.pid?.peltier?.ki,
    peltKd:   cfg.pid?.peltier?.kd,
    coolLim:  cfg.peltier?.coolLimit,
    heatLim:  cfg.peltier?.heatLimit,

    fanTKp:   cfg.pid?.fanTemp?.kp,
    fanTKi:   cfg.pid?.fanTemp?.ki,
    fanTKd:   cfg.pid?.fanTemp?.kd,

    fanHKp:   cfg.pid?.fanHum?.kp,
    fanHKi:   cfg.pid?.fanHum?.ki,
    fanHKd:   cfg.pid?.fanHum?.kd,

    fanNKp:   cfg.pid?.fanNH3?.kp,
    fanNKi:   cfg.pid?.fanNH3?.ki,
    fanNKd:   cfg.pid?.fanNH3?.kd,

    hsMin:    cfg.heatsink?.minPwm,
    hsMax:    cfg.heatsink?.maxPwm,
    hsCurve:  cfg.heatsink?.curve,

    vMin:     cfg.power?.voltageMin,
    vMax:     cfg.power?.voltageMax,
    iMax:     cfg.power?.currentMax,
    pMax:     cfg.power?.powerMax,

    mode:     cfg.mode
  };
}

module.exports = { validate, toFlat, SCHEMA };
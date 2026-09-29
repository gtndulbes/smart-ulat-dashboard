/**
 * ============================================================
 * commandValidation.js
 * ------------------------------------------------------------
 * Validasi command dari dashboard sebelum dikirim ke ESP32.
 *
 * Prinsip:
 *   - Whitelist command (hanya yang terdaftar)
 *   - Type checking (number / string / boolean)
 *   - Range checking (min/max)
 *   - Enum checking (value harus salah satu dari daftar)
 *   - Sanitasi (trim string, toNumber)
 *
 * Cara pakai:
 *   const v = require('./validation/commandValidation');
 *   const result = v.validate({ command: 'SET_PELTIER_PWM', value: 120 });
 *   if (!result.ok) return res.status(400).json({ error: result.error });
 *   // result.command, result.value  → siap dikirim MQTT
 * ============================================================
 */

'use strict';

// ------------------------------------------------------------
// Schema per command
// ------------------------------------------------------------
const COMMANDS = {
  // --------------------------------
  // Peltier
  // --------------------------------
  SET_PELTIER_PWM: {
    value: { type: 'number', min: 0, max: 255, integer: true },
    desc: 'Set PWM Peltier (0–255)'
  },
  SET_PELTIER_MODE: {
    value: { type: 'enum', values: ['OFF', 'COOLING', 'HEATING'] },
    desc: 'Set arah Peltier'
  },

  // --------------------------------
  // Exhaust Fan
  // --------------------------------
  SET_EXHAUST_PWM: {
    value: { type: 'number', min: 0, max: 255, integer: true },
    desc: 'Set PWM Exhaust Fan (0–255)'
  },
  SET_EXHAUST_ON_OFF: {
    value: { type: 'enum', values: [0, 1, 'ON', 'OFF'] },
    desc: 'On/off Exhaust Fan'
  },

  // --------------------------------
  // Heatsink Fan
  // --------------------------------
  SET_HEATSINK_PWM: {
    value: { type: 'number', min: 0, max: 255, integer: true },
    desc: 'Set PWM Heatsink Fan (0–255)'
  },

  // --------------------------------
  // Mode Global
  // --------------------------------
  SET_MODE: {
    value: { type: 'enum', values: ['auto', 'manual'] },
    desc: 'Ganti mode kontrol (auto / manual)'
  },

  // --------------------------------
  // Buzzer
  // --------------------------------
  SET_BUZZER: {
    value: { type: 'enum', values: ['OFF', 'TEST', 'SILENT'] },
    desc: 'Kontrol buzzer manual'
  },

  // --------------------------------
  // Tanpa value
  // --------------------------------
  SAVE_CONFIG: { value: null, desc: 'Trigger ESP32 simpan config ke NVS' },
  REBOOT:      { value: null, desc: 'Reboot ESP32' },
  EMERGENCY_STOP: {
    value: null,
    desc: 'Emergency stop — Peltier OFF, Exhaust 255, SAFE_MODE'
  },
  CLEAR_SAFE_MODE: {
    value: null,
    desc: 'Reset SAFE_MODE (hati-hati!)'
  }
};

// ------------------------------------------------------------
// Helper
// ------------------------------------------------------------
function _isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function _validateValue(value, spec) {
  // ----------------------------------------
  // Type: number
  // ----------------------------------------
  if (spec.type === 'number') {
    let n = value;

    // Coerce string number → number
    if (typeof n === 'string') n = Number(n);
    if (!_isFiniteNumber(n)) return { ok: false, error: 'value harus angka' };

    if (spec.integer && !Number.isInteger(n)) {
      return { ok: false, error: 'value harus integer' };
    }
    if (spec.min !== undefined && n < spec.min) {
      return { ok: false, error: `value minimal ${spec.min}` };
    }
    if (spec.max !== undefined && n > spec.max) {
      return { ok: false, error: `value maksimal ${spec.max}` };
    }
    return { ok: true, value: n };
  }

  // ----------------------------------------
  // Type: enum
  // ----------------------------------------
  if (spec.type === 'enum') {
    // Cek case-insensitive untuk string
    let v = value;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      // Exact match dulu
      if (spec.values.includes(trimmed)) return { ok: true, value: trimmed };
      // Case-insensitive match
      const upper = trimmed.toUpperCase();
      for (const allowed of spec.values) {
        if (typeof allowed === 'string' && allowed.toUpperCase() === upper) {
          return { ok: true, value: allowed };
        }
      }
    } else if (spec.values.includes(v)) {
      return { ok: true, value: v };
    }
    return {
      ok: false,
      error: `value harus salah satu dari: ${spec.values.join(' | ')}`
    };
  }

  return { ok: false, error: 'spec type tidak dikenal' };
}

// ------------------------------------------------------------
// Validate — public API
// ------------------------------------------------------------
/**
 * Validasi command objek.
 * @param {object} input — { command, value? }
 * @returns {object} — { ok: true, command, value } | { ok: false, error }
 */
function validate(input) {
  // ----------------------------------------
  // 0) Basic shape
  // ----------------------------------------
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'payload harus object' };
  }
  if (typeof input.command !== 'string' || !input.command.trim()) {
    return { ok: false, error: 'field "command" wajib diisi' };
  }

  const cmd = input.command.trim().toUpperCase();

  // ----------------------------------------
  // 1) Whitelist
  // ----------------------------------------
  const spec = COMMANDS[cmd];
  if (!spec) {
    return {
      ok: false,
      error: `command tidak dikenal: ${cmd}`,
      allowed: Object.keys(COMMANDS)
    };
  }

  // ----------------------------------------
  // 2) Cek value presence
  // ----------------------------------------
  const expectsValue = spec.value !== null;

  if (expectsValue && input.value === undefined) {
    return { ok: false, error: `command ${cmd} butuh field "value"` };
  }

  // ----------------------------------------
  // 3) Command tanpa value — ignore value
  // ----------------------------------------
  if (!expectsValue) {
    return { ok: true, command: cmd, value: undefined };
  }

  // ----------------------------------------
  // 4) Validasi value
  // ----------------------------------------
  const r = _validateValue(input.value, spec.value);
  if (!r.ok) return { ok: false, error: r.error };

  return { ok: true, command: cmd, value: r.value };
}

// ------------------------------------------------------------
// Metadata helper — untuk endpoint /schema
// ------------------------------------------------------------
function getSchema() {
  const out = {};
  for (const [cmd, spec] of Object.entries(COMMANDS)) {
    out[cmd] = {
      desc: spec.desc,
      expectsValue: spec.value !== null,
      valueSpec: spec.value ? { ...spec.value } : null
    };
  }
  return out;
}

function getAllCommands() {
  return Object.keys(COMMANDS);
}

// ------------------------------------------------------------
// Export
// ------------------------------------------------------------
module.exports = {
  validate,
  getSchema,
  getAllCommands,
  COMMANDS
};
// ============================================
// SaveHatke — Security audit log
// ============================================
// Append-only writer for the SecurityAudit sheet: the single place the app
// records "something security-relevant happened to this account", and what the
// user-facing Login History page and the admin security panel both read back.
//
// This module used to be the two-factor service. Two-factor authentication has
// been removed from SaveHatke, and so has every TOTP/secret/recovery-code
// concern it owned — but the audit writer it also hosted is NOT two-factor
// machinery: it is shared by the Google login path (new-device and
// new-location alerts) and is the reason those alerts still appear in Login
// History. It lives here under its own name so that "2FA" no longer implies a
// live feature.
//
// Contract: best-effort and never throwing. A logging failure must not block
// or fail the action being described, so callers can fire these off the
// response path without a try/catch of their own.

const { v4: uuidv4 } = require('uuid');
const db = require('./googleSheets');

function normEmail(v) {
  return String(v || '').toLowerCase().trim();
}

function nowIso() {
  return new Date().toISOString();
}

// ── Event names ───────────────────────────────────────────────────────────
// The wire values are append-only strings: rows already in the sheet use them,
// so renaming one would orphan that history. Only the names the app still
// writes are declared here; older values (2fa_*, etc.) are read for display
// only, in the EVENT_LABEL map in routes/auth.js.
const EVENTS = Object.freeze({
  NEW_DEVICE: 'new_device_signin',
  NEW_LOCATION: 'new_location_signin',
  LOGIN_FAILED: 'login_failed',
});

/**
 * Append one row to the SecurityAudit sheet.
 *
 * @param {object} e
 * @param {string} [e.userId]
 * @param {string} [e.email]   normalised to lower case before it is stored
 * @param {string} e.event     one of EVENTS (or any legacy string, for history)
 * @param {string} [e.outcome] 'success' (default) or 'failure'
 * @param {string} [e.ip]
 * @param {string} [e.device]
 * @param {string} [e.detail]  human-readable note. Never a code, secret or hash.
 * @returns {Promise<void>} always resolves, whatever the sheet does.
 */
async function logSecurityEvent({ userId, email, event, outcome = 'success', ip = '', device = '', detail = '' }) {
  try {
    await db.appendRow(db.SHEETS.SECURITY_AUDIT, {
      id: uuidv4(),
      userId: userId || '',
      email: normEmail(email),
      event: String(event || ''),
      outcome: String(outcome || ''),
      ipAddress: String(ip || ''),
      device: String(device || ''),
      detail: String(detail || ''),
      createdAt: nowIso(),
    });
  } catch (e) {
    console.warn('[audit] security audit write failed:', e.message);
  }
}

module.exports = {
  logSecurityEvent,
  EVENTS,
  normEmail,
  nowIso,
};
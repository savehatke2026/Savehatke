// Credential alert policy. Pure logic only: no Supabase, SMTP or network access.
// Run: node server/tests/credentialAlertPolicy.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const policy = require(path.join(__dirname, '..', 'services', 'credentialAlertPolicy'));
const { evaluateCredential, isSendDue, istDay, WARNING_WINDOW_MS, SERVICE_LABELS } = policy;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-13T06:00:00Z');

let passed = 0;
let failed = 0;
const lines = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    lines.push(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    lines.push(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const iso = (ms) => new Date(ms).toISOString();

// ── Four-day boundary ─────────────────────────────────────────────────────
check('window is exactly 4 days', () => {
  assert.equal(WARNING_WINDOW_MS, 4 * DAY);
});

check('expiry exactly 4 days away → warning (inclusive boundary)', () => {
  const e = evaluateCredential({ status: 'active', estimatedExpiresAt: iso(NOW + 4 * DAY) }, NOW);
  assert.equal(e.severity, 'warning');
  assert.equal(e.state, 'reconnect_soon');
});

check('expiry 4 days + 1 minute away → healthy (no alert)', () => {
  const e = evaluateCredential({ status: 'active', estimatedExpiresAt: iso(NOW + 4 * DAY + 60000) }, NOW);
  assert.equal(e.severity, 'none');
  assert.equal(e.state, 'healthy');
});

check('expiry 1 minute inside the window → warning', () => {
  const e = evaluateCredential({ status: 'active', estimatedExpiresAt: iso(NOW + 4 * DAY - 60000) }, NOW);
  assert.equal(e.severity, 'warning');
});

check('expiry in the past → critical expired', () => {
  const e = evaluateCredential({ status: 'active', estimatedExpiresAt: iso(NOW - 1000) }, NOW);
  assert.equal(e.severity, 'critical');
  assert.equal(e.state, 'expired');
});

// ── Unknown expiry must never fabricate a countdown ───────────────────────
check('unknown expiry + active → no alert, no countdown', () => {
  const e = evaluateCredential({ status: 'active', estimatedExpiresAt: null }, NOW);
  assert.equal(e.severity, 'none');
  assert.equal(e.remainingMs, null);
});

check('unknown expiry + reauthorization_required → critical (Google reported it)', () => {
  const e = evaluateCredential({ status: 'reauthorization_required', estimatedExpiresAt: null }, NOW);
  assert.equal(e.severity, 'critical');
  assert.equal(e.state, 'reauthorization_required');
});

// ── Revoked / error / disconnected ────────────────────────────────────────
check('revoked (reauthorization_required) → critical immediately', () => {
  const e = evaluateCredential({ status: 'reauthorization_required' }, NOW);
  assert.equal(e.severity, 'critical');
});

check('error status → critical', () => {
  const e = evaluateCredential({ status: 'error', lastError: 'invalid_grant' }, NOW);
  assert.equal(e.severity, 'critical');
  assert.equal(e.state, 'error');
});

check('disconnected never alerts even with a near expiry', () => {
  const e = evaluateCredential({ status: 'disconnected', estimatedExpiresAt: iso(NOW + DAY) }, NOW);
  assert.equal(e.severity, 'none');
});

check('absent row never alerts', () => {
  assert.equal(evaluateCredential({ exists: false }, NOW).severity, 'none');
  assert.equal(evaluateCredential(null, NOW).severity, 'none');
});

// ── Cadence and duplicate prevention ──────────────────────────────────────
const WARN = { severity: 'warning', state: 'reconnect_soon' };
const CRIT = { severity: 'critical', state: 'expired' };

check('first alert is due immediately', () => {
  assert.deepEqual(isSendDue({ evaluation: WARN, last: null, today: '2026-10-13' }), { due: true, reason: 'first_alert' });
});

check('same state, same IST day → NOT due (duplicate prevention)', () => {
  const r = isSendDue({ evaluation: WARN, last: { state: 'reconnect_soon', day: '2026-10-13' }, today: '2026-10-13' });
  assert.equal(r.due, false);
  assert.equal(r.reason, 'already_sent_today');
});

check('same state, next IST day → daily reminder due', () => {
  const r = isSendDue({ evaluation: WARN, last: { state: 'reconnect_soon', day: '2026-10-12' }, today: '2026-10-13' });
  assert.equal(r.due, true);
  assert.equal(r.reason, 'daily_reminder');
});

check('state change sends immediately even on the same day', () => {
  const r = isSendDue({ evaluation: CRIT, last: { state: 'reconnect_soon', day: '2026-10-13' }, today: '2026-10-13' });
  assert.equal(r.due, true);
  assert.equal(r.reason, 'state_changed');
});

check('healthy evaluation never sends', () => {
  assert.equal(isSendDue({ evaluation: { severity: 'none', state: 'healthy' }, last: null, today: '2026-10-13' }).due, false);
});

check('reconnection (healthy after warning) produces no alert', () => {
  const healthy = evaluateCredential({ status: 'active', estimatedExpiresAt: iso(NOW + 20 * DAY) }, NOW);
  assert.equal(isSendDue({ evaluation: healthy, last: { state: 'reconnect_soon', day: '2026-10-12' }, today: '2026-10-13' }).due, false);
});

// ── IST day bucketing ─────────────────────────────────────────────────────
check('IST day rolls at 18:30 UTC (midnight IST)', () => {
  assert.equal(istDay(Date.parse('2026-10-13T18:29:59Z')), '2026-10-13');
  assert.equal(istDay(Date.parse('2026-10-13T18:30:00Z')), '2026-10-14');
});

// ── Isolation between the three services ──────────────────────────────────
check('service labels cover exactly the three integrations', () => {
  assert.deepEqual(Object.keys(SERVICE_LABELS).sort(), ['google_drive', 'payment_gmail', 'support_gmail']);
});

check('each service evaluates independently', () => {
  const support = evaluateCredential({ status: 'reauthorization_required' }, NOW);
  const drive = evaluateCredential({ status: 'active', estimatedExpiresAt: null }, NOW);
  const payment = evaluateCredential({ status: 'active', estimatedExpiresAt: iso(NOW + 2 * DAY) }, NOW);
  assert.equal(support.severity, 'critical');
  assert.equal(drive.severity, 'none');
  assert.equal(payment.severity, 'warning');
});

console.log(`credentialAlertPolicy tests: ${passed} passed, ${failed} failed`);
console.log(lines.join('\n'));

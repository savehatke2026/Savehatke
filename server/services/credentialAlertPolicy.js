// ============================================
// SaveHatke — Credential alert policy (pure, no I/O)
// ============================================
// Decides WHAT to tell admins about each OAuth integration and WHETHER a
// notification is due today. It never reads or writes storage and never sends
// mail; the notifier (credentialAlertNotifier.js) supplies state and transport.
//
// Rules:
//   * A known expiry inside the warning window (<= 4 days) → 'warning'.
//   * Expired, revoked (reauthorization_required) or error → 'critical'.
//   * Unknown expiry (null) never produces a countdown and never alone triggers
//     a warning. Only an explicit Google-reported failure triggers 'critical'.
//   * 'disconnected' is intentional and never alerts.
//   * 'connected' (healthy, outside the window) never alerts.
//
// Cadence:
//   * A state change (e.g. healthy → warning, warning → critical) is sent at once.
//   * While the same state persists, a reminder is due once per IST calendar day.
//   * Duplicate prevention is per (service, recipient, IST day) in the notifier.

// Dependency-free on purpose: the warning window and the warning math live here
// so the policy and tests never load Supabase. securityCredentialsStore imports
// the same constant, so the admin panel and the alerts can never disagree.
const WARNING_WINDOW_MS = 4 * 24 * 60 * 60 * 1000; // 4 days
const RECONNECT_SOON_MS = WARNING_WINDOW_MS;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Admin-panel warning level. Pure. Unknown expiry never yields a countdown. */
function computeWarning({ status, estimatedExpiresAt, lastError } = {}, nowMs = Date.now()) {
  const expMs = estimatedExpiresAt ? Date.parse(estimatedExpiresAt) : NaN;
  const remainingMs = Number.isFinite(expMs) ? expMs - nowMs : null;
  if (status === 'reauthorization_required') {
    return { level: 'reauth', color: 'red', remainingMs, message: 'Authorization has expired or was revoked. Reconnect to resume this integration.' };
  }
  if (status === 'disconnected') {
    return { level: 'not_connected', color: 'grey', remainingMs: null, message: 'Not connected.' };
  }
  if (status === 'error') {
    return { level: 'error', color: 'red', remainingMs, message: lastError || 'This integration reported an error.' };
  }
  if (remainingMs != null) {
    if (remainingMs <= 0) return { level: 'expired', color: 'red', remainingMs, message: 'Authorization has expired. Reconnect to resume this integration.' };
    if (remainingMs <= RECONNECT_SOON_MS) return { level: 'reconnect_soon', color: 'yellow', remainingMs, message: 'Authorization will expire soon. Reconnect to keep this integration active.' };
  }
  return { level: 'connected', color: 'green', remainingMs, message: 'Authorization active.' };
}

const SERVICE_LABELS = Object.freeze({
  support_gmail: 'Support Gmail',
  google_drive: 'Database (Google Drive)',
  payment_gmail: 'Payment Gmail',
});

/** Calendar day in IST as YYYY-MM-DD, used as the dedup bucket. */
function istDay(nowMs = Date.now()) {
  const d = new Date(nowMs + IST_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

/**
 * Classify one credential row. Returns
 *   { severity: 'none'|'warning'|'critical', state, message, remainingMs }
 * `state` is the stable key used for change detection.
 */
function evaluateCredential(row, nowMs = Date.now()) {
  if (!row || row.exists === false) {
    return { severity: 'none', state: 'absent', message: '', remainingMs: null };
  }
  const status = row.status || null;
  if (status === 'disconnected') {
    return { severity: 'none', state: 'disconnected', message: '', remainingMs: null };
  }
  if (status === 'reauthorization_required') {
    return { severity: 'critical', state: 'reauthorization_required',
      message: 'Google reported this authorization as expired or revoked. Reconnect required.', remainingMs: null };
  }
  if (status === 'error') {
    return { severity: 'critical', state: 'error',
      message: row.lastError || 'The integration reported an error. Reconnect or check the account.', remainingMs: null };
  }

  const w = computeWarning({
    status,
    estimatedExpiresAt: row.estimatedExpiresAt || null,
    lastError: row.lastError || null,
  }, nowMs);

  if (w.level === 'expired') {
    return { severity: 'critical', state: 'expired',
      message: 'Authorization has expired. Reconnect to resume this integration.', remainingMs: w.remainingMs };
  }
  if (w.level === 'reconnect_soon') {
    return { severity: 'warning', state: 'reconnect_soon',
      message: 'Authorization expires within 4 days (estimated). Reconnect before it lapses.', remainingMs: w.remainingMs };
  }
  return { severity: 'none', state: 'healthy', message: '', remainingMs: w.remainingMs };
}

/**
 * Decide whether a notification is due.
 *
 * @param {object} p
 * @param {{severity:string,state:string}} p.evaluation    result of evaluateCredential
 * @param {{state:string,day:string}|null} p.last          last notified state + IST day
 * @param {string} p.today                                 istDay() result
 * @returns {{due:boolean, reason:string}}
 */
function isSendDue({ evaluation, last, today }) {
  if (!evaluation || evaluation.severity === 'none') return { due: false, reason: 'no_alert' };
  if (!last) return { due: true, reason: 'first_alert' };
  if (last.state !== evaluation.state) return { due: true, reason: 'state_changed' };
  if (last.day !== today) return { due: true, reason: 'daily_reminder' };
  return { due: false, reason: 'already_sent_today' };
}

module.exports = {
  WARNING_WINDOW_MS,
  RECONNECT_SOON_MS,
  computeWarning,
  SERVICE_LABELS,
  istDay,
  evaluateCredential,
  isSendDue,
};

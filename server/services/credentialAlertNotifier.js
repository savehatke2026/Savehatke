// ============================================
// SaveHatke — Credential alert notifier (I/O layer)
// ============================================
// Runs the daily refresh-token check for the three admin OAuth integrations
// (support_gmail, google_drive, payment_gmail) and emails the active admin
// roster when a warning or critical state is due.
//
// Guarantees:
//   * Isolation: each service is evaluated and notified separately.
//   * Recipients: the server-owned admin roster (configuredAdminEmails), read from
//     Supabase admin_allowlist via config/security. No address is hard-coded here,
//     and no extra admin list or environment variable is introduced.
//   * Sender: sendCustomEmail with sender 'security', the existing security
//     channel. Its From is security.savehatke@gmail.com only when the server's
//     SMTP login is that account (resolveMainFromAddress enforces alignment and
//     never spoofs a From). It never uses the monitored OAuth connection.
//   * Dedup: one row per (service, recipient, IST day, state). Written only after
//     a successful send, so a failed send is retried on the next run.
//   * Secrets: nothing here reads or logs a refresh token. Only the safe status
//     (no token) is used.
//   * Failure isolation: a Supabase or SMTP error for one recipient or service is
//     recorded in the result and never aborts the run for the others.

// Heavy integrations (Supabase, SMTP, roster) are loaded lazily so this module,
// and its tests, load without touching the network or the Supabase client. The
// pure policy module is loaded eagerly: it has no dependencies.
const policy = require('./credentialAlertPolicy');

// Lazy, cached: resolves the real dependency only when the default path is used.
const lazy = (file) => {
  let mod = null;
  return () => { if (!mod) mod = require(file); return mod; };
};
const securityCredentialsLazy = lazy('./securityCredentialsStore');
const emailServiceLazy = lazy('./emailService');
const supabaseLazy = lazy('./supabase');
const monthlyReportsLazy = lazy('./monthlyReports');
const configLazy = lazy('../config/security');

const TABLE = 'credential_alert_state';
const SERVICES = ['support_gmail', 'google_drive', 'payment_gmail'];

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Read the last recorded alert for (service, recipient). Null when none or on error. */
async function readLastAlert(client, service, recipient) {
  const { data, error } = await client.from(TABLE)
    .select('alert_state, ist_day, sent_at')
    .eq('service', service)
    .eq('recipient', recipient)
    .order('sent_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`alert state read failed: ${error.code || error.message}`);
  if (!data || !data.length) return null;
  return { state: data[0].alert_state, day: data[0].ist_day };
}

/** Record a successful send. Throws on failure so the caller can log it. */
async function recordAlert(client, service, recipient, state, day) {
  const { error } = await client.from(TABLE).upsert(
    { service, recipient, alert_state: state, ist_day: day, sent_at: new Date().toISOString() },
    { onConflict: 'service,recipient,ist_day,alert_state' },
  );
  if (error) throw new Error(`alert state write failed: ${error.code || error.message}`);
}

function buildEmail({ service, evaluation, recipient, email }) {
  const label = policy.SERVICE_LABELS[service] || service;
  const critical = evaluation.severity === 'critical';
  const subject = critical
    ? `[SaveHatke] ${label} needs reconnecting`
    : `[SaveHatke] ${label} authorization expires within 4 days`;
  const remaining = evaluation.remainingMs != null && evaluation.remainingMs > 0
    ? `Estimated time remaining: ${Math.ceil(evaluation.remainingMs / 86400000)} day(s).`
    : 'Expiry date is not known for this integration.';
  const acct = email ? `Account: ${esc(email)}` : '';
  const text = [
    `${label}: ${evaluation.message}`,
    acct,
    remaining,
    'Reconnect from the SaveHatke admin panel (Settings → Integrations).',
    'You will receive a reminder each day until the integration is reconnected.',
  ].filter(Boolean).join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111827">`
    + `<p><strong>${esc(label)}</strong>: ${esc(evaluation.message)}</p>`
    + (acct ? `<p>${acct}</p>` : '')
    + `<p>${esc(remaining)}</p>`
    + `<p>Reconnect from the SaveHatke admin panel. You will receive a reminder each day until reconnected.</p>`
    + `</div>`;
  return { subject, text, html };
}

/**
 * Run one credential check across all services.
 * @param {object} [opts]
 * @param {number} [opts.nowMs]     test hook
 * @param {Function} [opts.send]    test hook; defaults to emailService.sendCustomEmail
 * @returns {Promise<{ok:boolean, checked:number, sent:number, skipped:number, failed:number, results:Array}>}
 */
async function runCredentialAlertCheck(opts = {}) {
  const deps = {
    getSafeStatus: (...a) => securityCredentialsLazy().getSafeStatus(...a),
    getClient: () => supabaseLazy().getClient(),
    configuredAdminEmails: () => monthlyReportsLazy().configuredAdminEmails(),
    // Roster hydration: wait for the Supabase admin_allowlist read, then report
    // whether the roster is still the env fallback (which must never receive mail).
    ensureRosterReady: () => configLazy().ensureAdminRosterReady(),
    isRosterStale: () => configLazy().isAdminRosterStale(),
    ...(opts.deps || {}),
  };
  await deps.ensureRosterReady();
  if (deps.isRosterStale()) {
    return {
      ok: false,
      error: 'Admin roster is not loaded from Supabase yet; alerts were not sent.',
      checked: 0, sent: 0, skipped: 0, failed: 0, results: [],
    };
  }
  const nowMs = opts.nowMs || Date.now();
  // 'security' is the existing server-side security sender (SMTP_USER/SMTP_FROM,
  // resolved by resolveMainFromAddress). It is independent of every monitored
  // OAuth connection, so a broken Gmail token cannot block its own alert.
  const send = opts.send || ((p) => emailServiceLazy().sendCustomEmail({ ...p, sender: 'security' }));
  const today = policy.istDay(nowMs);
  const recipients = deps.configuredAdminEmails();
  const client = deps.getClient();
  const results = [];

  if (!recipients.length) {
    return { ok: false, error: 'No active admin recipients configured.', checked: 0, sent: 0, skipped: 0, failed: 0, results };
  }
  if (!client) {
    return { ok: false, error: 'Supabase is not configured; alert state cannot be tracked.', checked: 0, sent: 0, skipped: 0, failed: 0, results };
  }

  for (const service of SERVICES) {
    let row;
    try {
      row = await deps.getSafeStatus(service, null);
    } catch (e) {
      results.push({ service, outcome: 'status_read_failed', error: e.message });
      continue;
    }
    const evaluation = policy.evaluateCredential({
      exists: row.exists,
      status: row.status,
      estimatedExpiresAt: row.estimatedExpiresAt,
      lastError: row.lastError,
    }, nowMs);
    const email = row.email || null;

    for (const recipient of recipients) {
      const entry = { service, recipient: maskRecipient(recipient), state: evaluation.state };
      let last;
      try {
        last = await readLastAlert(client, service, recipient);
      } catch (e) {
        results.push({ ...entry, outcome: 'state_read_failed', error: e.message });
        continue;
      }
      const due = policy.isSendDue({ evaluation, last, today });
      if (!due.due) { results.push({ ...entry, outcome: 'skipped', reason: due.reason }); continue; }

      const mail = buildEmail({ service, evaluation, recipient, email });
      const sent = await send({ to: recipient, subject: mail.subject, text: mail.text, html: mail.html });
      if (!sent || !sent.success) {
        results.push({ ...entry, outcome: 'send_failed', error: sent && sent.error ? String(sent.error).slice(0, 200) : 'unknown' });
        continue; // no state row → retried on the next run
      }
      try {
        await recordAlert(client, service, recipient, evaluation.state, today);
        results.push({ ...entry, outcome: 'sent', reason: due.reason });
      } catch (e) {
        // Email went out but the dedup row failed; the next run may resend once.
        results.push({ ...entry, outcome: 'sent_unrecorded', error: e.message });
      }
    }
  }

  const count = (o) => results.filter((r) => r.outcome === o).length;
  const failed = results.filter((r) => /failed|unrecorded/.test(r.outcome)).length;
  return {
    ok: failed === 0,
    checked: SERVICES.length,
    sent: count('sent'),
    skipped: count('skipped'),
    failed,
    results,
  };
}

/** Mask a recipient for logs/results: rup***as2024@gmail.com. Never the full address. */
function maskRecipient(addr) {
  const at = String(addr || '').indexOf('@');
  if (at < 1) return '***';
  return `${String(addr).slice(0, 1)}***${String(addr).slice(at)}`;
}

module.exports = { runCredentialAlertCheck, buildEmail, maskRecipient, TABLE };

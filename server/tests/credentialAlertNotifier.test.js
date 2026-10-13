// Credential alert notifier. Uses an in-memory fake Supabase client and injected
// status/send functions, so no network, database or SMTP is touched.
// Run: node server/tests/credentialAlertNotifier.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const notifier = require(path.join(__dirname, '..', 'services', 'credentialAlertNotifier'));
const policy = require(path.join(__dirname, '..', 'services', 'credentialAlertPolicy'));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-13T06:00:00Z'); // 11:30 IST, 2026-10-13
const TODAY = policy.istDay(NOW);
const TOMORROW = policy.istDay(NOW + DAY);
const ADMINS = ['alpha@example.com', 'beta@example.com'];
const iso = (ms) => new Date(ms).toISOString();

// ── Fake Supabase: supports the exact chain the notifier uses ─────────────
function fakeClient({ readError = null, writeError = null } = {}) {
  const rows = [];
  const client = {
    rows,
    from(table) {
      const filters = {};
      let order = null;
      const q = {
        select() { return q; },
        eq(col, val) { filters[col] = val; return q; },
        order(col) { order = col; return q; },
        limit() {
          if (readError) return Promise.resolve({ data: null, error: readError });
          let r = rows.filter((x) => Object.entries(filters).every(([k, v]) => x[k] === v));
          r = r.slice().sort((a, b) => (b.sent_at > a.sent_at ? 1 : -1));
          return Promise.resolve({ data: r.slice(0, 1).map((x) => ({ alert_state: x.alert_state, ist_day: x.ist_day, sent_at: x.sent_at })), error: null });
        },
        upsert(payload, { onConflict }) {
          if (writeError) return Promise.resolve({ error: writeError });
          const cols = onConflict.split(',');
          const exists = rows.find((x) => cols.every((c) => x[c] === payload[c]));
          if (exists) Object.assign(exists, payload);
          else rows.push({ ...payload });
          return Promise.resolve({ error: null });
        },
      };
      return q;
    },
  };
  return client;
}

// Status fixture: one row per service, keyed by service name.
function statusFor(map) {
  return async (service) => {
    const row = map[service];
    if (!row) return { service, exists: false, status: null };
    return { service, exists: true, email: row.email || `${service}@example.com`, ...row };
  };
}

async function run(opts) {
  return notifier.runCredentialAlertCheck({ nowMs: NOW, ...opts });
}

const tests = [];
const t = (name, fn) => tests.push({ name, fn });

// ── Boundary and first alert ───────────────────────────────────────────────
t('warning inside 4 days sends to every admin on first run', async () => {
  const sent = [];
  const client = fakeClient();
  const r = await run({
    deps: {
      getClient: () => client,
      configuredAdminEmails: () => ADMINS,
      getSafeStatus: statusFor({ payment_gmail: { status: 'active', estimatedExpiresAt: iso(NOW + 3 * DAY) } }),
    },
    send: async (p) => { sent.push(p); return { success: true }; },
  });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 2, 'one email per admin');
  assert.ok(sent.every((m) => /within 4 days/.test(m.subject)));
  assert.equal(client.rows.length, 2);
});

t('expiry at exactly 4 days triggers the warning', async () => {
  const sent = [];
  await run({
    deps: {
      getClient: () => fakeClient(),
      configuredAdminEmails: () => ['solo@example.com'],
      getSafeStatus: statusFor({ payment_gmail: { status: 'active', estimatedExpiresAt: iso(NOW + 4 * DAY) } }),
    },
    send: async (p) => { sent.push(p); return { success: true }; },
  });
  assert.equal(sent.length, 1);
});

t('expiry 4 days + 1 minute away sends nothing', async () => {
  const sent = [];
  await run({
    deps: {
      getClient: () => fakeClient(),
      configuredAdminEmails: () => ['solo@example.com'],
      getSafeStatus: statusFor({ payment_gmail: { status: 'active', estimatedExpiresAt: iso(NOW + 4 * DAY + 60000) } }),
    },
    send: async (p) => { sent.push(p); return { success: true }; },
  });
  assert.equal(sent.length, 0);
});

// ── Daily reminders and duplicate prevention ───────────────────────────────
t('a second run the same IST day sends nothing (duplicate prevention)', async () => {
  const sent = [];
  const client = fakeClient();
  const deps = {
    getClient: () => client,
    configuredAdminEmails: () => ['solo@example.com'],
    getSafeStatus: statusFor({ payment_gmail: { status: 'active', estimatedExpiresAt: iso(NOW + 2 * DAY) } }),
  };
  const send = async (p) => { sent.push(p); return { success: true }; };
  await run({ deps, send });
  const second = await run({ deps, send, nowMs: NOW + 60 * 60 * 1000 });
  assert.equal(sent.length, 1, 'only the first run sends');
  assert.equal(second.results.find((x) => x.service === 'payment_gmail').outcome, 'skipped');
});

t('next IST day sends a daily reminder while still in the window', async () => {
  const sent = [];
  const client = fakeClient();
  const deps = {
    getClient: () => client,
    configuredAdminEmails: () => ['solo@example.com'],
    getSafeStatus: statusFor({ payment_gmail: { status: 'active', estimatedExpiresAt: iso(NOW + 2 * DAY) } }),
  };
  const send = async (p) => { sent.push(p); return { success: true }; };
  await run({ deps, send });
  await run({ deps, send, nowMs: NOW + DAY });
  assert.equal(sent.length, 2, 'one reminder per IST day');
});

// ── Revoked, critical and state changes ───────────────────────────────────
t('revoked token sends an immediate critical alert', async () => {
  const sent = [];
  await run({
    deps: {
      getClient: () => fakeClient(),
      configuredAdminEmails: () => ['solo@example.com'],
      getSafeStatus: statusFor({ google_drive: { status: 'reauthorization_required', email: 'db@example.com' } }),
    },
    send: async (p) => { sent.push(p); return { success: true }; },
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /needs reconnecting/);
});

t('state change from warning to critical sends on the same day', async () => {
  const sent = [];
  const client = fakeClient();
  let status = { status: 'active', estimatedExpiresAt: iso(NOW + 2 * DAY) };
  const deps = {
    getClient: () => client,
    configuredAdminEmails: () => ['solo@example.com'],
    getSafeStatus: async (s) => (s === 'payment_gmail'
      ? { service: s, exists: true, email: 'p@example.com', ...status }
      : { service: s, exists: false, status: null }),
  };
  const send = async (p) => { sent.push(p); return { success: true }; };
  await run({ deps, send });
  status = { status: 'reauthorization_required' };
  await run({ deps, send, nowMs: NOW + 60 * 60 * 1000 });
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /needs reconnecting/);
});

// ── Unknown expiry ────────────────────────────────────────────────────────
t('unknown expiry (Drive) never produces a countdown or warning', async () => {
  const sent = [];
  await run({
    deps: {
      getClient: () => fakeClient(),
      configuredAdminEmails: () => ['solo@example.com'],
      getSafeStatus: statusFor({ google_drive: { status: 'active', estimatedExpiresAt: null } }),
    },
    send: async (p) => { sent.push(p); return { success: true }; },
  });
  assert.equal(sent.length, 0);
});

// ── Reconnection ──────────────────────────────────────────────────────────
t('reconnection (healthy again) stops reminders', async () => {
  const sent = [];
  const client = fakeClient();
  let status = { status: 'active', estimatedExpiresAt: iso(NOW + 2 * DAY) };
  const deps = {
    getClient: () => client,
    configuredAdminEmails: () => ['solo@example.com'],
    getSafeStatus: async (s) => (s === 'payment_gmail'
      ? { service: s, exists: true, email: 'p@example.com', ...status }
      : { service: s, exists: false, status: null }),
  };
  const send = async (p) => { sent.push(p); return { success: true }; };
  await run({ deps, send });
  status = { status: 'active', estimatedExpiresAt: iso(NOW + 30 * DAY) };
  const after = await run({ deps, send, nowMs: NOW + DAY });
  assert.equal(sent.length, 1, 'no reminder after reconnection');
  assert.equal(after.results.find((x) => x.service === 'payment_gmail').outcome, 'skipped');
});

// ── Failure handling ──────────────────────────────────────────────────────
t('email failure writes no state so the next run retries', async () => {
  const client = fakeClient();
  const deps = {
    getClient: () => client,
    configuredAdminEmails: () => ['solo@example.com'],
    getSafeStatus: statusFor({ payment_gmail: { status: 'active', estimatedExpiresAt: iso(NOW + DAY) } }),
  };
  const failed = await run({ deps, send: async () => ({ success: false, error: 'SMTP down' }) });
  assert.equal(failed.ok, false);
  assert.equal(client.rows.length, 0, 'no dedup row on failure');
  const retried = [];
  const ok = await run({ deps, send: async (p) => { retried.push(p); return { success: true }; }, nowMs: NOW + 60000 });
  assert.equal(retried.length, 1, 'retried successfully');
  assert.equal(ok.ok, true);
});

t('Supabase state read failure is reported, not silently sent', async () => {
  const sent = [];
  const r = await run({
    deps: {
      getClient: () => fakeClient({ readError: { code: '42P01', message: 'relation missing' } }),
      configuredAdminEmails: () => ['solo@example.com'],
      getSafeStatus: statusFor({ payment_gmail: { status: 'active', estimatedExpiresAt: iso(NOW + DAY) } }),
    },
    send: async (p) => { sent.push(p); return { success: true }; },
  });
  assert.equal(r.ok, false);
  assert.equal(sent.length, 0, 'does not send without state');
  assert.ok(r.results.some((x) => x.outcome === 'state_read_failed'));
});

t('Supabase write failure after a send is reported as sent_unrecorded', async () => {
  const r = await run({
    deps: {
      getClient: () => fakeClient({ writeError: { code: '42501', message: 'denied' } }),
      configuredAdminEmails: () => ['solo@example.com'],
      getSafeStatus: statusFor({ payment_gmail: { status: 'active', estimatedExpiresAt: iso(NOW + DAY) } }),
    },
    send: async () => ({ success: true }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.results.some((x) => x.outcome === 'sent_unrecorded'));
});

t('missing Supabase client fails closed and sends nothing', async () => {
  const sent = [];
  const r = await run({
    deps: { getClient: () => null, configuredAdminEmails: () => ['solo@example.com'], getSafeStatus: statusFor({}) },
    send: async (p) => { sent.push(p); return { success: true }; },
  });
  assert.equal(r.ok, false);
  assert.equal(sent.length, 0);
});

t('no admin recipients fails closed', async () => {
  const r = await run({
    deps: { getClient: () => fakeClient(), configuredAdminEmails: () => [], getSafeStatus: statusFor({}) },
    send: async () => ({ success: true }),
  });
  assert.equal(r.ok, false);
});

t('one service status read failure does not block the others', async () => {
  const sent = [];
  const r = await run({
    deps: {
      getClient: () => fakeClient(),
      configuredAdminEmails: () => ['solo@example.com'],
      getSafeStatus: async (s) => {
        if (s === 'support_gmail') throw new Error('boom');
        if (s === 'payment_gmail') return { service: s, exists: true, email: 'p@example.com', status: 'reauthorization_required' };
        return { service: s, exists: false, status: null };
      },
    },
    send: async (p) => { sent.push(p); return { success: true }; },
  });
  assert.equal(sent.length, 1, 'payment alert still sent');
  assert.ok(r.results.some((x) => x.service === 'support_gmail' && x.outcome === 'status_read_failed'));
});

// ── Isolation ─────────────────────────────────────────────────────────────
t('dedup rows are keyed per service: one service never suppresses another', async () => {
  const sent = [];
  const client = fakeClient();
  const deps = {
    getClient: () => client,
    configuredAdminEmails: () => ['solo@example.com'],
    getSafeStatus: statusFor({
      payment_gmail: { status: 'active', estimatedExpiresAt: iso(NOW + DAY) },
      support_gmail: { status: 'active', estimatedExpiresAt: iso(NOW + DAY) },
    }),
  };
  await run({ deps, send: async (p) => { sent.push(p); return { success: true }; } });
  assert.equal(sent.length, 2, 'each service alerts independently');
  assert.deepEqual(client.rows.map((r) => r.service).sort(), ['payment_gmail', 'support_gmail']);
});

t('recipient addresses are masked in results', () => {
  assert.equal(notifier.maskRecipient('rupayandas2024@gmail.com'), 'r***@gmail.com');
  assert.ok(!notifier.maskRecipient('rupayandas2024@gmail.com').includes('rupayandas2024'));
});

t('email body never includes a token-shaped value', () => {
  const m = notifier.buildEmail({
    service: 'payment_gmail',
    evaluation: { severity: 'warning', message: 'x', remainingMs: DAY },
    recipient: 'a@b.com',
    email: 'p@example.com',
  });
  assert.ok(!/refresh|1\/\/0|client_secret/i.test(m.text + m.html));
});

// ── Runner ────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  const lines = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      lines.push(`  ok   ${name}`);
    } catch (e) {
      failed += 1;
      lines.push(`  FAIL ${name}\n       ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`credentialAlertNotifier tests: ${passed} passed, ${failed} failed`);
  console.log(lines.join('\n'));
})();

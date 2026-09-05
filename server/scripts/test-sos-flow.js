// ============================================
// SOS backup-access flow — offline integration checks
// ============================================
// Run: node server/scripts/test-sos-flow.js
//
// Mounts the real routes/sos.js on a throwaway Express app and drives it over
// HTTP, with MongoDB, Turnstile, the mailer and the admin-session helpers stubbed
// in the require cache. The point is the gate: /check-code is the only step that
// accepts a backup code, and nothing further in the flow can be reached without
// the session it issues.

process.env.JWT_SECRET = 'test_secret_for_harness_only';
process.env.TURNSTILE_SECRET_KEY = 'test_secret_for_harness_only';

const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const express = require('express');

const { hashAnswer } = require('../utils/sosAnswers');

// ── In-memory stand-in for the collections and tables the flow touches ──────
// `codes` is the MongoDB store, `sbCodes` the Supabase one. A code may sit in
// either or both, which is the whole point of services/backupCodeStore.js.
const store = { codes: [], sbCodes: [], sessions: [], audits: [], admins: [] };

// Flipped by the tests to simulate a store being unreachable. `supabaseTable`
// off means the migration has not been applied — the service reports that as
// "cannot answer", not as "no such code".
const stores = { mongo: true, supabase: true, supabaseTable: true };

/** Equality matcher with the one operator these routes use ($gte on a date). */
function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, want]) => {
    if (want && typeof want === 'object' && !Array.isArray(want) && !(want instanceof Date)) {
      if ('$gte' in want) return new Date(doc[key]) >= new Date(want.$gte);
      return false;
    }
    return doc[key] === want;
  });
}

/** Thenable that answers .select()/.lean()/.sort()/.limit() like a Mongoose query. */
function query(getter) {
  const q = {
    select: () => q,
    lean: () => q,
    sort: () => q,
    limit: () => q,
    then: (ok, no) => Promise.resolve().then(getter).then(ok, no),
    catch: (no) => q.then(undefined, no),
  };
  return q;
}

function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let sessionSeq = 0;
let auditSeq = 0;

function makeSessionDoc(fields) {
  return {
    attempt_id: `SOS-test-${++sessionSeq}`,
    reason: '',
    stage: 'reason',
    selected_admin_id: null,
    selected_admin_name: '',
    question_keys: [],
    failed_attempts: 0,
    captcha_passed: false,
    ip: '',
    user_agent_hash: '',
    closed_reason: '',
    created_at: new Date(),
    ...fields,
    isLive() {
      return this.stage !== 'closed' && this.expires_at instanceof Date && this.expires_at > new Date();
    },
    async save() { return this; },
  };
}

stub('../config/db', {
  isMongoReady: () => stores.mongo,
  waitForMongoReady: async () => stores.mongo,
});

// The Supabase table, behind the same contract as services/supabase.js: null
// from a list means "this store cannot answer".
stub('../services/supabase', {
  isConfigured: () => stores.supabase,
  listActiveBackupCodes: async () => {
    if (!stores.supabase || !stores.supabaseTable) return null;
    return store.sbCodes.filter((c) => c.isActive).map((c) => ({ ...c }));
  },
  listAllBackupCodes: async ({ includeInactive = true } = {}) => {
    if (!stores.supabase || !stores.supabaseTable) return null;
    return store.sbCodes.filter((c) => includeInactive || c.isActive).map((c) => ({ ...c }));
  },
  findBackupCodeById: async (id) => {
    if (!stores.supabase || !stores.supabaseTable) return null;
    const row = store.sbCodes.find((c) => c.id === id);
    return row ? { ...row } : null;
  },
  updateBackupCode: async (id, updates) => {
    if (!stores.supabase || !stores.supabaseTable) return null;
    const row = store.sbCodes.find((c) => c.id === id);
    if (!row) return null;
    Object.assign(row, updates);
    return { ...row };
  },
  stampBackupCodeUsage: async (id, { ip = '', reason = '' } = {}) => {
    if (!stores.supabase || !stores.supabaseTable) return null;
    const row = store.sbCodes.find((c) => c.id === id);
    if (!row) return null;
    row.usageCount = (row.usageCount || 0) + 1;
    row.lastUsedAt = new Date();
    row.lastUsedIp = ip;
    row.lastUsedReason = reason;
    return { ...row };
  },
  createBackupCode: async (fields) => {
    if (!stores.supabase || !stores.supabaseTable) return null;
    const row = { usageCount: 0, maxUses: null, expiresAt: null, isActive: true, ...fields };
    store.sbCodes.push(row);
    return { ...row };
  },
});

// Mutable so a test can make the challenge fail on the next call only.
const captcha = { next: { ok: true, result: 'passed' } };
stub('../utils/turnstile', {
  verifyTurnstile: async () => ({ ok: true }),
  verifyTurnstileStrict: async () => captcha.next,
  isLoopbackOrPrivate: () => false,
});

stub('../models/BackupCode', {
  find: (filter) => query(() => store.codes.filter((c) => matches(c, filter)).map((c) => ({ ...c }))),
  findOne: (filter) => query(() => {
    const row = store.codes.find((c) => matches(c, filter));
    return row ? { ...row, save: async () => row, toObject: () => ({ ...row }) } : null;
  }),
  updateOne: async (filter, update) => {
    const row = store.codes.find((c) => matches(c, filter));
    if (!row) return { matchedCount: 0 };
    if (update.$inc) for (const [k, n] of Object.entries(update.$inc)) row[k] = (row[k] || 0) + n;
    if (update.$set) Object.assign(row, update.$set);
    return { matchedCount: 1 };
  },
});

stub('../models/SosSession', {
  create: async (fields) => {
    const doc = makeSessionDoc(fields);
    store.sessions.push(doc);
    return doc;
  },
  // Returns the live object, so a route's save() is visible to the next request.
  findOne: (filter) => query(() => store.sessions.find((s) => matches(s, filter)) || null),
});

stub('../models/SosAuditLog', {
  create: async (fields) => {
    const doc = { _id: `audit-${++auditSeq}`, audit_ref: `SOSA-test-${auditSeq}`, created_at: new Date(), ...fields };
    store.audits.push(doc);
    return doc;
  },
  countDocuments: (filter) => query(() => store.audits.filter((a) => matches(a, filter)).length),
  updateOne: async () => ({ matchedCount: 1 }),
});

stub('../models/Admin', {
  find: (filter) => query(() => store.admins.filter((a) => matches(a, filter)).map((a) => ({ ...a }))),
  findOne: (filter) => query(() => {
    const found = store.admins.find((a) => matches(a, filter));
    return found ? { ...found } : null;
  }),
});

stub('../services/emailService', {
  sendSosAccessAlertEmail: async () => ({ success: true, isSimulated: true }),
});

// routes/sos.js requires this lazily, inside /verify.
stub('../routes/auth', {
  createLoginSession: async () => ({ sessionId: 'admin-session-1', token: 'raw-admin-session-token', ttlMs: 2 * 60 * 60 * 1000 }),
  issueLoginToken: () => 'admin.jwt.for.harness',
  setSessionCookie: () => {},
});

// Keep the real User-Agent parsing; skip the outbound geo lookup.
const realSosContext = require('../utils/sosContext');
stub('../utils/sosContext', {
  ...realSosContext,
  resolveApproxLocation: async () => ({ ...realSosContext.UNKNOWN_LOCATION }),
});

// ── The real router, loaded only now that every dependency is stubbed ───────
const sosRouter = require('../routes/sos');

const app = express();
app.use(express.json());
app.use('/api/admin/sos', sosRouter);

const server = http.createServer(app);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SosHarness/1.0';

function post(pathname, body, ip) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        method: 'POST',
        path: pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': UA,
          'x-forwarded-for': ip || '203.0.113.10',
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = {};
          try { json = text ? JSON.parse(text) : {}; } catch (e) { /* leave empty */ }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

// ── Assertions ─────────────────────────────────────────────────────────────
const G = '\x1b[32m', R = '\x1b[31m', C = '\x1b[36m', X = '\x1b[0m';
let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ${G}✓${X} ${label}`);
  } else {
    failures.push(label);
    console.log(`  ${R}✗ ${label}${X}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── Fixtures. Never a real code: these are invented for the harness. ────────
const LIVE_CODE = 'SH-BK-AAAA-BBBB-CCCC-DDDD';
const SPENT_CODE = 'SH-BK-1111-2222-3333-4444';
const REVOKED_CODE = 'SH-BK-5555-6666-7777-8888';
const EXPIRED_CODE = 'SH-BK-9999-AAAA-BBBB-CCCC';
// Registered in Supabase only — the case that has to keep working when the
// MongoDB collection is empty or the cluster is unreachable.
const SB_ONLY_CODE = 'SH-BK-5B00-5B01-5B02-5B03';
// A second Supabase code, kept unspent so the store-outage checks have
// something live to work with.
const SB_SPARE_CODE = 'SH-BK-5B10-5B11-5B12-5B13';

const ANSWERS = { q_mother: 'Kanika  DAS ', q_school: "St. Xavier's", q_born: '04-11-2010' };

async function seed() {
  const codeRow = async (cleartext, extra) => ({
    id: `code-${cleartext.slice(6, 10)}`,
    codeHash: await bcrypt.hash(cleartext, 10),
    codePrefix: cleartext.slice(6, 12).toLowerCase(),
    isActive: true,
    usageCount: 0,
    maxUses: null,
    expiresAt: null,
    ...extra,
  });

  store.codes.push(await codeRow(LIVE_CODE));
  store.codes.push(await codeRow(SPENT_CODE, { usageCount: 1 }));
  store.codes.push(await codeRow(REVOKED_CODE, { isActive: false }));
  store.codes.push(await codeRow(EXPIRED_CODE, { expiresAt: new Date(Date.now() - 86400e3) }));

  store.sbCodes.push(await codeRow(SB_ONLY_CODE, { label: 'Supabase-only SOS code' }));
  store.sbCodes.push(await codeRow(SB_SPARE_CODE, { label: 'Supabase spare' }));

  store.admins.push({
    id: 'admin-rupayan',
    name: 'Rupayan',
    email: 'admin@example.com',
    role: 'Super Admin',
    profile_image: '',
    is_active: true,
    sos_enabled: true,
    sos_available: true,
    sos_questions_required: 3,
    security_questions: [
      { key: 'q_mother', question: "Mother's name?", kind: 'text', enabled: true, answer_hash: await hashAnswer(ANSWERS.q_mother, 'text') },
      { key: 'q_school', question: 'First school?', kind: 'text', enabled: true, answer_hash: await hashAnswer(ANSWERS.q_school, 'text') },
      { key: 'q_born', question: 'Date of birth?', kind: 'date', enabled: true, answer_hash: await hashAnswer(ANSWERS.q_born, 'date') },
    ],
  });
}

const GENERIC = 'Unable to continue with SOS recovery.';
const REASON = 'Locked out of OTP and the takedown cannot wait.';

async function run() {
  await seed();

  console.log(`\n${C}[1] The gate refuses anything that is not a live code${X}`);
  const sessionsBefore = store.sessions.length;

  const wrong = await post('/api/admin/sos/check-code', { code: 'SH-BK-DEAD-BEEF-DEAD-BEEF' }, '203.0.113.11');
  check('unknown code → 401 generic', wrong.status === 401 && wrong.body.error === GENERIC, `got ${wrong.status} ${JSON.stringify(wrong.body)}`);

  const junk = await post('/api/admin/sos/check-code', { code: 'hello' }, '203.0.113.12');
  check('too-short value → 401 generic', junk.status === 401 && junk.body.error === GENERIC, `got ${junk.status}`);

  const empty = await post('/api/admin/sos/check-code', {}, '203.0.113.13');
  check('missing code → 401 generic', empty.status === 401, `got ${empty.status}`);

  const spent = await post('/api/admin/sos/check-code', { code: SPENT_CODE }, '203.0.113.14');
  check('already-spent code → 401 generic', spent.status === 401 && spent.body.error === GENERIC, `got ${spent.status}`);

  const revoked = await post('/api/admin/sos/check-code', { code: REVOKED_CODE }, '203.0.113.15');
  check('revoked code → 401 generic', revoked.status === 401, `got ${revoked.status}`);

  const expired = await post('/api/admin/sos/check-code', { code: EXPIRED_CODE }, '203.0.113.16');
  check('expired code → 401 generic', expired.status === 401, `got ${expired.status}`);

  check('no attempt session was opened by any refusal', store.sessions.length === sessionsBefore,
    `${store.sessions.length - sessionsBefore} session(s) appeared`);
  check('every refusal is audited', store.audits.filter((a) => !a.success).length >= 6,
    `${store.audits.filter((a) => !a.success).length} failure rows`);
  check('no refusal leaks a code prefix for an unknown code',
    !store.audits.some((a) => a.failure_category === 'CODE_INVALID' && a.backup_code_prefix));

  console.log(`\n${C}[2] A live code opens an attempt${X}`);
  const ok = await post('/api/admin/sos/check-code', { code: LIVE_CODE }, '203.0.113.20');
  check('live code → 200 with an attempt token', ok.status === 200 && typeof ok.body.sosToken === 'string' && ok.body.sosToken.length >= 32,
    `got ${ok.status} ${JSON.stringify(ok.body)}`);
  check('response carries no admin roster yet', !('admins' in ok.body));
  const opened = store.sessions[store.sessions.length - 1];
  check('session starts at the reason stage', opened && opened.stage === 'reason', opened && opened.stage);
  check('session records the code it was opened with', Boolean(opened && opened.backup_code_id));
  check('session stores only the token hash', !JSON.stringify(store.sessions).includes(ok.body.sosToken));

  const lower = await post('/api/admin/sos/check-code', { code: `  ${LIVE_CODE.toLowerCase()} ` }, '203.0.113.21');
  check('lower-case / padded paste of the same code is accepted', lower.status === 200 && Boolean(lower.body.sosToken),
    `got ${lower.status} ${JSON.stringify(lower.body)}`);

  console.log(`\n${C}[3] The reason step cannot be reached without that attempt${X}`);
  const noToken = await post('/api/admin/sos/start', { reason: REASON }, '203.0.113.20');
  check('no token → 401 generic', noToken.status === 401 && noToken.body.error === GENERIC, `got ${noToken.status}`);

  const bogus = await post('/api/admin/sos/start', { sosToken: 'f'.repeat(64), reason: REASON }, '203.0.113.20');
  check('unknown token → 401 generic', bogus.status === 401, `got ${bogus.status}`);

  const oldWay = await post('/api/admin/sos/start', { code: LIVE_CODE, reason: REASON }, '203.0.113.20');
  check('the retired code+reason shape is refused', oldWay.status === 401, `got ${oldWay.status}`);

  const short = await post('/api/admin/sos/start', { sosToken: ok.body.sosToken, reason: 'too short' }, '203.0.113.20');
  check('reason under 10 chars → 400', short.status === 400 && /at least 10/.test(short.body.error || ''), `got ${short.status}`);

  const wrongIp = await post('/api/admin/sos/start', { sosToken: ok.body.sosToken, reason: REASON }, '198.51.100.9');
  check('token replayed from another IP → 401', wrongIp.status === 401, `got ${wrongIp.status}`);
  check('the mismatch closed the session', opened.stage === 'closed' && opened.closed_reason === 'CONTEXT_MISMATCH',
    `${opened.stage}/${opened.closed_reason}`);

  console.log(`\n${C}[4] The whole chain, end to end${X}`);
  const IP = '203.0.113.30';
  const gate = await post('/api/admin/sos/check-code', { code: LIVE_CODE }, IP);
  const token = gate.body.sosToken;
  check('stage 0 — code accepted', gate.status === 200 && Boolean(token), `got ${gate.status}`);

  const started = await post('/api/admin/sos/start', { sosToken: token, reason: REASON }, IP);
  check('stage 1 — reason accepted, roster returned',
    started.status === 200 && Array.isArray(started.body.admins) && started.body.admins.length === 1,
    `got ${started.status} ${JSON.stringify(started.body)}`);
  check('roster publishes no email address', !JSON.stringify(started.body.admins).includes('admin@example.com'));
  const session = store.sessions.find((s) => s.attempt_id === started.body.attemptId);
  check('reason is recorded on the session', session && session.reason === REASON, session && session.reason);
  check('session advanced to select-admin', session && session.stage === 'select-admin', session && session.stage);

  const replay = await post('/api/admin/sos/start', { sosToken: token, reason: REASON }, IP);
  check('stage 1 cannot be replayed', replay.status === 401, `got ${replay.status}`);

  const picked = await post('/api/admin/sos/select-admin', { sosToken: token, adminRef: 'admin-rupayan' }, IP);
  check('stage 2 — questions issued', picked.status === 200 && Array.isArray(picked.body.questions) && picked.body.questions.length === 3,
    `got ${picked.status} ${JSON.stringify(picked.body)}`);
  check('questions carry no answers or hashes', !JSON.stringify(picked.body).includes('answer_hash') && !JSON.stringify(picked.body).toLowerCase().includes('kanika'));

  const keys = picked.body.questions.map((q) => q.key);
  const badAnswers = {};
  keys.forEach((k) => { badAnswers[k] = 'nope'; });
  const failedVerify = await post('/api/admin/sos/verify', { sosToken: token, answers: badAnswers }, IP);
  check('stage 3 — wrong answers refused', failedVerify.status === 401 && failedVerify.body.attemptsRemaining === 4,
    `got ${failedVerify.status} ${JSON.stringify(failedVerify.body)}`);
  check('no admin session was minted on failure', !failedVerify.body.token);

  // Deliberately sloppy: the normaliser is meant to forgive case and spacing.
  const goodAnswers = {};
  keys.forEach((k) => {
    goodAnswers[k] = k === 'q_born' ? '2010-11-04' : `  ${ANSWERS[k].toUpperCase()}  `;
  });
  const granted = await post('/api/admin/sos/verify', { sosToken: token, answers: goodAnswers }, IP);
  check('stage 3 — correct answers grant an admin session',
    granted.status === 200 && granted.body.token === 'admin.jwt.for.harness' && granted.body.user.email === 'admin@example.com',
    `got ${granted.status} ${JSON.stringify(granted.body)}`);
  check('grant is audited as a success', store.audits.some((a) => a.success && a.attempt_id === started.body.attemptId));
  check('login method is labelled as SOS', granted.body.user && granted.body.user.login_method === 'Backup Code (SOS)');

  const liveRow = store.codes.find((c) => c.id === 'code-AAAA');
  check('the code was spent', liveRow && liveRow.usageCount === 1, liveRow && String(liveRow.usageCount));
  const reuse = await post('/api/admin/sos/check-code', { code: LIVE_CODE }, '203.0.113.31');
  check('a spent code no longer opens the gate', reuse.status === 401, `got ${reuse.status}`);

  console.log(`\n${C}[5] CAPTCHA and throttling sit in front of the hashing${X}`);
  const codesSeenBefore = store.audits.length;
  captcha.next = { ok: false, result: 'failed', error: 'CAPTCHA verification failed.' };
  const noCaptcha = await post('/api/admin/sos/check-code', { code: SPENT_CODE }, '203.0.113.40');
  captcha.next = { ok: true, result: 'passed' };
  check('a failed challenge → 400, before any code lookup',
    noCaptcha.status === 400 && noCaptcha.body.error === 'CAPTCHA verification failed.', `got ${noCaptcha.status}`);
  check('the CAPTCHA refusal is audited without a code reference',
    store.audits.slice(codesSeenBefore).every((a) => a.failure_category === 'CAPTCHA_FAILED' && !a.backup_code_id));

  const HOT = '203.0.113.50';
  for (let i = 0; i < 5; i++) {
    // eslint-disable-next-line no-await-in-loop
    await post('/api/admin/sos/check-code', { code: `SH-BK-0000-0000-0000-000${i}` }, HOT);
  }
  const sessionsBeforeThrottle = store.sessions.length;
  const throttled = await post('/api/admin/sos/check-code', { code: LIVE_CODE }, HOT);
  check('the 6th failure in the window → 429', throttled.status === 429 && /Too many attempts/.test(throttled.body.error || ''),
    `got ${throttled.status} ${JSON.stringify(throttled.body)}`);
  check('a throttled request opens nothing', store.sessions.length === sessionsBeforeThrottle);

  const stillFine = await post('/api/admin/sos/check-code', { code: 'SH-BK-0000-0000-0000-0009' }, '203.0.113.51');
  check('the throttle is per IP, not global', stillFine.status === 401, `got ${stillFine.status}`);

  console.log(`\n${C}[6] A code stored in Supabase works the same as one in MongoDB${X}`);
  const sb = await post('/api/admin/sos/check-code', { code: SB_ONLY_CODE }, '203.0.113.60');
  check('a Supabase-only code opens the gate', sb.status === 200 && Boolean(sb.body.sosToken),
    `got ${sb.status} ${JSON.stringify(sb.body)}`);
  const sbSession = store.sessions[store.sessions.length - 1];
  check('the session records which store authorised it', sbSession && sbSession.backup_code_store === 'supabase',
    sbSession && sbSession.backup_code_store);

  const sbStarted = await post('/api/admin/sos/start', { sosToken: sb.body.sosToken, reason: REASON }, '203.0.113.60');
  check('the reason step accepts a Supabase-backed attempt', sbStarted.status === 200, `got ${sbStarted.status}`);
  await post('/api/admin/sos/select-admin', { sosToken: sb.body.sosToken, adminRef: 'admin-rupayan' }, '203.0.113.60');
  const sbAnswers = {};
  store.sessions.find((s) => s.attempt_id === sbStarted.body.attemptId).question_keys.forEach((k) => {
    sbAnswers[k] = k === 'q_born' ? '2010-11-04' : ANSWERS[k];
  });
  const sbGranted = await post('/api/admin/sos/verify', { sosToken: sb.body.sosToken, answers: sbAnswers }, '203.0.113.60');
  check('a Supabase-backed attempt can be granted', sbGranted.status === 200 && Boolean(sbGranted.body.token),
    `got ${sbGranted.status} ${JSON.stringify(sbGranted.body)}`);
  const sbRow = store.sbCodes.find((c) => c.id === 'code-5B00');
  check('the use was stamped in Supabase, not MongoDB', sbRow && sbRow.usageCount === 1, sbRow && String(sbRow.usageCount));
  check('the MongoDB copy was left alone', !store.codes.some((c) => c.id === 'code-5B00'));
  check('the audit trail names the store',
    store.audits.some((a) => a.success && a.backup_code_store === 'supabase'));

  console.log(`\n${C}[7] Either store being down is survivable; both being down is not${X}`);
  stores.mongo = false;
  const mongoDown = await post('/api/admin/sos/check-code', { code: LIVE_CODE }, '203.0.113.70');
  // The code lives only in MongoDB, so with Mongo down it cannot be recognised.
  check('with MongoDB down, a Mongo-only code is refused', mongoDown.status === 401, `got ${mongoDown.status}`);

  // A Supabase code is still recognised with MongoDB down — that is the point of
  // storing it there. The attempt itself cannot open, because SosSession lives in
  // MongoDB, so the refusal is 503 "unavailable" rather than 401 "wrong code",
  // and the audit row names the code that was accepted.
  const auditsBefore = store.audits.length;
  const sbDuringOutage = await post('/api/admin/sos/check-code', { code: SB_SPARE_CODE }, '203.0.113.72');
  check('with MongoDB down, a Supabase code is still recognised → 503 (attempt store), not 401',
    sbDuringOutage.status === 503, `got ${sbDuringOutage.status} ${JSON.stringify(sbDuringOutage.body)}`);
  const outageAudit = store.audits.slice(auditsBefore).find((a) => a.failure_category === 'STORE_UNAVAILABLE');
  check('the outage audit shows the code was accepted first',
    Boolean(outageAudit && outageAudit.backup_code_store === 'supabase' && outageAudit.backup_code_id),
    JSON.stringify(outageAudit && { store: outageAudit.backup_code_store, id: outageAudit.backup_code_id }));

  stores.supabaseTable = false;
  const nothingUp = await post('/api/admin/sos/check-code', { code: SB_ONLY_CODE }, '203.0.113.71');
  check('with no store reachable → 503, not a wrong-code answer',
    nothingUp.status === 503 && /temporarily unavailable/i.test(nothingUp.body.error || ''),
    `got ${nothingUp.status} ${JSON.stringify(nothingUp.body)}`);
  check('the outage is audited as STORE_UNAVAILABLE',
    store.audits.some((a) => a.failure_category === 'STORE_UNAVAILABLE'));
  stores.supabaseTable = true;
  stores.mongo = true;
}

server.listen(0, '127.0.0.1', () => {
  console.log(`\x1b[33m╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  SOS backup-access flow — offline integration checks        ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝\x1b[0m`);

  run()
    .then(() => {
      console.log('');
      if (failures.length) {
        console.log(`${R}${failures.length} check(s) failed${X} (${passed} passed):`);
        failures.forEach((f) => console.log(`  ${R}·${X} ${f}`));
      } else {
        console.log(`${G}All ${passed} checks passed.${X}`);
      }
      server.close();
      process.exit(failures.length ? 1 : 0);
    })
    .catch((err) => {
      console.error(`\n${R}Harness error:${X}`, err);
      server.close();
      process.exit(1);
    });
});

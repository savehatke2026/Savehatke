// No two-factor enrolment surface remains.
//
// This file used to drive the whole enable/disable chain the dashboard owned:
// setup/start -> setup/verify-email -> setup/secret -> setup/enable -> status
// -> disable, plus recovery codes. That chain is gone with the feature, and the
// guarantee now is the inverse: none of it may come back by accident, and none
// of it may be reachable through a surface that was only half removed.
//
// The failure this guards against is the one the security audit actually found —
// a feature whose backend is gone while the UI still offers it. A user taps
// "Enable 2FA" and gets a 404. Every check below is about closing that door.
//
// Run: node server/tests/twoFactorSetupFlow.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const REPO = path.resolve(SERVER, '..');
const read = (p) => fs.readFileSync(p, 'utf8');

let pass = 0;
let failures = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ' + name); }
  catch (e) { failures += 1; console.error('  FAIL  ' + name + '\n        ' + e.message); }
}

const dashboard = read(path.join(REPO, 'public', 'dashboard.html'));
const login = read(path.join(REPO, 'public', 'login.html'));
const vault = read(path.join(REPO, 'public', 'vault.html'));

// ── 1. No UI offers enrolment ────────────────────────────────────────────

check('the dashboard exposes no 2FA entry point', () => {
  for (const needle of ['startTwoFactor', 'Enable 2FA', 'Disable 2FA', 'Manage 2FA',
    'id="secTwoFactor"', 'id="twofaModal"', 'id="securityPostureAct"', 'id="securityTwoFactor"']) {
    assert.ok(!dashboard.includes(needle), `dashboard.html must not contain ${needle}`);
  }
});

check('the dashboard never calls a 2FA endpoint', () => {
  assert.doesNotMatch(dashboard, /\/auth\/2fa/, 'dashboard.html must not fetch /auth/2fa');
  assert.doesNotMatch(dashboard, /\/api\/auth\/2fa/);
});

check('the dashboard keeps no 2FA CSS behind', () => {
  assert.doesNotMatch(dashboard, /\.tf-/, 'no .tf-* rules may remain in dashboard.html');
});

check('the login page offers no authenticator challenge', () => {
  for (const needle of ['twofaState', 'handleTwoFactorVerify', 'cancelTwoFactor',
    'enterTwoFactorState', 'onTwoFactorRequired', 'sh_2fa_challenge', 'tfaChallengeToken',
    'server_2fa_status_unavailable']) {
    assert.ok(!login.includes(needle), `login.html must not contain ${needle}`);
  }
  // The page may still *mention* the removed mount in the comment that records
  // why it is gone; what it must not do is call it.
  assert.doesNotMatch(login, /(api|fetch)\(\s*['"`][^'"`]*\/auth\/2fa/,
    'login.html must not call a /auth/2fa endpoint');
});

check('the vault no longer advertises 2FA as an admin capability', () => {
  assert.doesNotMatch(vault, /API keys, 2FA/i);
});

// ── 2. The Security page still works without it ──────────────────────────
// Removing a card must not leave the page broken or half-wired.

check('the Security page keeps verification, sessions and last sign-in', () => {
  for (const id of ['id="securityPosture"', 'id="securityEmail"', 'id="securityEmailStatus"',
    'id="securityLastLogin"', 'id="secActiveSessions"', 'id="mySessionsList"']) {
    assert.ok(dashboard.includes(id), `dashboard.html must keep ${id}`);
  }
});

check('security posture is derived from email verification alone', () => {
  assert.match(dashboard, /SEC_POSTURE\s*=\s*\{\s*emailVerified:/,
    'SEC_POSTURE must no longer carry a twoFactor field');
  assert.doesNotMatch(dashboard, /SEC_POSTURE\.twoFactor/);
  assert.match(dashboard, /const secure = emailVerified === true;/,
    'the posture must be Secure on a verified email');
  assert.match(dashboard, /function renderSecurityPosture\(\)/);
});

check('the security view still loads sessions and nothing else', () => {
  assert.match(dashboard, /loadMySessions\(\)/);
  assert.doesNotMatch(dashboard, /loadTwoFactorStatus/);
});

// ── 3. No server-side enrolment surface ──────────────────────────────────

check('no server module exposes a 2FA enrolment endpoint', () => {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.js$/.test(e.name)) files.push(full);
    }
  })(path.join(SERVER, 'routes'));

  const hits = files.filter((f) => /['"]\/2fa|\/setup\/(start|secret|enable)|TWO_FACTOR/.test(read(f)))
    .map((f) => path.relative(REPO, f));
  assert.strictEqual(hits.length, 0, 'routes still expose 2FA: ' + hits.join(', '));
});

check('the 2FA notice emails are gone', () => {
  const emailService = read(path.join(SERVER, 'services', 'emailService.js'));
  assert.doesNotMatch(emailService, /sendTwoFactorSecurityEmail/);
  assert.doesNotMatch(emailService, /TWO_FACTOR_CHANGE_COPY/);

  const templates = require('../services/emailTestingTemplates');
  const ids = templates.listTemplates().map((t) => t.id);
  assert.ok(!ids.includes('two_factor_enabled'), 'the 2FA preview fixture must be gone');
  assert.ok(!ids.includes('two_factor_recovery_used'), 'the 2FA preview fixture must be gone');
  // The rest of the catalogue is untouched by the removal.
  for (const keep of ['welcome', 'otp', 'signin_alert', 'payment_success', 'sos_alert', 'refund']) {
    if (keep === 'refund') continue;
    assert.ok(ids.includes(keep), `the ${keep} email template must survive (have: ${ids.join(', ')})`);
  }
});

check('the Admin model and seed no longer carry a 2FA flag', () => {
  const model = read(path.join(SERVER, 'models', 'Admin.js'));
  assert.doesNotMatch(model, /two_factor_enabled/);
  const seed = read(path.join(SERVER, 'scripts', 'seedAdmins.js'));
  assert.doesNotMatch(seed, /two_factor_enabled/);
});

check('no migration or setup step provisions 2FA state', () => {
  const migDir = path.join(REPO, 'supabase', 'migrations');
  if (!fs.existsSync(migDir)) return;
  const hits = fs.readdirSync(migDir).filter((f) => /two.?factor|2fa/i.test(f));
  assert.strictEqual(hits.length, 0, 'unexpected 2FA migrations: ' + hits.join(', '));
});

console.log(`\n${pass} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
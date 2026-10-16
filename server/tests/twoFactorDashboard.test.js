// The dashboard's Security page renders correctly with two-factor removed.
//
// This file used to drive the 2FA card's three visual states — enabled,
// disabled, and service-unavailable — and assert that the "Account Security
// Status" banner stayed in step with them. With the feature gone there is no
// card to drive, so the coverage moves to the part that actually regresses: the
// Security page must still render, the posture banner must still be correct,
// and nothing about the removal may leave a dangling hook that throws at load.
//
// Every assertion runs against the real shipped HTML/JS, and the scripts are
// compiled (not just string-matched) so a syntax break cannot hide here.
//
// Run: node server/tests/twoFactorDashboard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const dashboard = fs.readFileSync(path.join(REPO, 'public', 'dashboard.html'), 'utf8');

let pass = 0;
let failures = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ' + name); }
  catch (e) { failures += 1; console.error('  FAIL  ' + name + '\n        ' + e.message); }
}

// Every inline script must at least parse — a removal that broke a brace would
// otherwise show up only as a blank page in the browser.
check('every inline script in dashboard.html still parses', () => {
  const scripts = [...dashboard.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, 'dashboard.html should still have inline scripts');
  scripts.forEach((m, i) => {
    try { new Function(m[1]); }                    // eslint-disable-line no-new-func
    catch (e) { throw new Error(`inline script #${i + 1} does not parse: ${e.message}`); }
  });
});

// ── 1. The 2FA card is gone, and nothing was left pointing at it ─────────

check('no element id belonging to the 2FA card survives', () => {
  const removedIds = ['secTwoFactor', 'twofaModal', 'tfStatusPill', 'tfStatusDot', 'tfStatusText',
    'tfBlurb', 'tfMeta', 'tfEnabledAt', 'tfCodesLeft', 'tfActionsDisabled', 'tfActionsEnabled',
    'tfUnavailable', 'tfUnavailableTxt', 'tfConfirmBtn', 'tfResendBtn', 'tfVerifyEmailBtn',
    'tfCodeSubmitBtn', 'tfDisableBtn', 'tfRecoveryBtn', 'tfRecoveryInput',
    'securityTwoFactor', 'securityTwoFactorTag', 'securityPostureAct'];
  const present = removedIds.filter((id) => dashboard.includes(`id="${id}"`));
  assert.strictEqual(present.length, 0, 'still present: ' + present.join(', '));
});

check('no function from the 2FA module survives', () => {
  const fns = ['loadTwoFactorStatus', 'renderTwoFactorStatus', 'startTwoFactor', 'closeTwoFactor',
    'confirmTwoFactorStart', 'requestTwoFactorEmailCode', 'resendTwoFactorEmail',
    'submitTwoFactorEmail', 'goToTwoFactorCode', 'submitTwoFactorCode', 'submitTwoFactorDisable',
    'showTfPanel', 'flashCodeError', 'buildCodeBoxes'];
  const present = fns.filter((f) => new RegExp(`function ${f}\\s*\\(`).test(dashboard));
  assert.strictEqual(present.length, 0, 'still defined: ' + present.join(', '));
});

check('no handler survives that would call a removed function', () => {
  // Inline onclick attributes are the risk: they fail silently until clicked.
  const handlers = [...dashboard.matchAll(/onclick="([^"]+)"/g)].map((m) => m[1]);
  const bad = handlers.filter((h) => /TwoFactor|closeTwoFactor|startTwoFactor|tf[A-Z]/.test(h));
  assert.strictEqual(bad.length, 0, 'stale handlers: ' + bad.join(' | '));
});

// ── 2. The Security page is intact and self-consistent ───────────────────

check('the Security view keeps its live cards', () => {
  for (const id of ['view-security', 'securityPosture', 'securityPostureIco',
    'securityAccountStatusTag', 'securityAccountStatus', 'securityEmail',
    'securityEmailStatus', 'securityLastLogin', 'secActiveSessions', 'mySessionsList']) {
    assert.ok(dashboard.includes(`id="${id}"`), `the Security page must keep #${id}`);
  }
});

check('the posture banner still reports both states', () => {
  assert.match(dashboard, /title\.textContent = secure \? 'Secure' : 'Action Required'/);
  assert.match(dashboard, /wrap\.classList\.toggle\('secure', secure\)/);
  assert.match(dashboard, /wrap\.classList\.toggle\('action', !secure\)/);
});

check('the posture still gets its input from the session, with no fetch', () => {
  // Email verification arrives with the profile, so the banner is painted with
  // no request of its own — exactly as before, minus the 2FA poll.
  assert.match(dashboard, /SEC_POSTURE\.emailVerified = Boolean\(email\)/);
  assert.doesNotMatch(dashboard, /renderSecurityPosture\(\)[\s\S]{0,80}await\s/);
});

check('entering the Security view still loads sessions', () => {
  assert.match(dashboard, /name === 'security'[\s\S]{0,300}loadMySessions\(\)/);
});

check('the session list and its revoke controls are untouched', () => {
  for (const needle of ['sess-logout', 'sess-name', 'sess-tag', 'sess-meta']) {
    assert.ok(dashboard.includes(needle), 'session styling must survive: ' + needle);
  }
});

// ── 3. Removal hygiene ───────────────────────────────────────────────────

check('no orphaned .tf-* CSS remains', () => {
  assert.doesNotMatch(dashboard, /\.tf-/, '2FA-only CSS must be removed with the card');
});

check('the CSS for the kept Security cards is still present', () => {
  for (const cls of ['.sec-posture', '.sec-grid', '.sec-tile', '.sec-status', '.sess-row', '.sess-act']) {
    assert.ok(dashboard.includes(cls), 'shared Security CSS must survive: ' + cls);
  }
});

check('the page makes no request to a route that cannot exist', () => {
  const calls = [...dashboard.matchAll(/api\(\s*['"`]([^'"`]+)/g)].map((m) => m[1]);
  const twoFa = calls.filter((c) => /2fa|two-factor/i.test(c));
  assert.strictEqual(twoFa.length, 0, 'dead endpoint calls: ' + twoFa.join(', '));
});

console.log(`\n${pass} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
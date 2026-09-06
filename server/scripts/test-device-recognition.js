// ============================================
// New-device sign-in alert — offline unit checks
// ============================================
// Run: node server/scripts/test-device-recognition.js
//
// Stubs the Supabase service before services/deviceRecognition.js loads, then
// exercises the decision that gates the "New device detected" email: which
// devices count as recognised, what the signed device token is allowed to do,
// and that one login event can only ever produce one alert.
//
// Offline by design — no database, no SMTP, no live account touched. Each case
// uses its own account address, because the recognition ledger and the
// duplicate-alert guard are both scoped per account.

process.env.DEVICE_ID_SECRET = 'test_device_secret_for_harness_only';

const UAParser = require('ua-parser-js');

// ── Stub Supabase in the require cache BEFORE deviceRecognition loads it ──
const supabasePath = require.resolve('../services/supabase');
const ledger = new Map(); // account email -> session rows
let ledgerReadable = true;
require(supabasePath);
require.cache[supabasePath].exports = {
  getAccountSessionHistory: async (email) => {
    if (!ledgerReadable) return null;
    return (ledger.get(String(email || '').toLowerCase().trim()) || []).slice();
  },
};

const device = require('../services/deviceRecognition');

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  chromeWinNewer: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/161.0.0.0 Safari/537.36',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  // The same Android handset before and after "Request desktop site": one
  // phone, but ua-parser reads Mobile Chrome/mobile vs Chrome/tablet.
  androidMobile: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
  androidDesktopSite: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
};

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); } else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

let accountSeq = 0;
const account = () => `case${++accountSeq}@example.test`;

// A session row shaped exactly as the login path writes it.
function row(userAgent) {
  const parsed = new UAParser(userAgent);
  const d = parsed.getDevice();
  return {
    session_id: Math.random().toString(36).slice(2),
    login_time: new Date().toISOString(),
    user_agent: userAgent,
    browser: [parsed.getBrowser().name, String(parsed.getBrowser().version || '').split('.')[0]].filter(Boolean).join(' '),
    os: [parsed.getOS().name, parsed.getOS().version].filter(Boolean).join(' '),
    device: d.vendor && d.model ? `${d.vendor} ${d.model}` : (d.type ? d.type[0].toUpperCase() + d.type.slice(1) : 'Desktop'),
  };
}

// Captures Set-Cookie exactly like Express's res.append does.
function response() {
  const cookies = [];
  return {
    cookies,
    append: (name, value) => { if (name === 'Set-Cookie') cookies.push(value); },
    cookieHeader: () => cookies.map((c) => c.split(';')[0]).join('; '),
  };
}

async function signIn(email, userAgent, { cookie, res } = {}) {
  const labels = row(userAgent);
  return device.evaluateSignInDevice({
    req: { headers: { 'user-agent': userAgent, ...(cookie ? { cookie } : {}) } },
    res,
    email,
    userAgent,
    device: labels.device,
    os: labels.os,
    browser: labels.browser,
  });
}

(async () => {
  console.log('\nNew-device recognition');

  // ── First sign-in on an empty ledger ────────────────────────────────────
  let email = account();
  let res = response();
  let verdict = await signIn(email, UA.chromeWin, { res });
  check('first recorded sign-in for an account → new device', verdict.isNewDevice && verdict.evaluated, verdict.reason);
  check('a signed device token is issued, HttpOnly and path-scoped',
    res.cookies.length === 1 && /HttpOnly/.test(res.cookies[0])
    && /Path=\//.test(res.cookies[0]) && /SameSite=Lax/.test(res.cookies[0]), res.cookies[0]);

  // ── Same device once the ledger has recorded it ──────────────────────────
  email = account();
  ledger.set(email, [row(UA.chromeWin)]);
  verdict = await signIn(email, UA.chromeWin);
  check('same browser/OS after it is recorded → recognised', !verdict.isNewDevice, verdict.reason);

  // ── A genuinely different browser or device ─────────────────────────────
  verdict = await signIn(email, UA.firefoxWin);
  check('different browser, same machine → new device', verdict.isNewDevice, verdict.reason);
  verdict = await signIn(email, UA.iphone);
  check('different device class → new device', verdict.isNewDevice, verdict.reason);

  // ── Version churn must not look like a new device ────────────────────────
  verdict = await signIn(email, UA.chromeWinNewer);
  check('browser auto-update (Chrome 152 → 161) → still recognised', !verdict.isNewDevice, verdict.reason);

  // ── Recognition is scoped to one account ────────────────────────────────
  const stranger = account();
  verdict = await signIn(stranger, UA.chromeWin);
  check('a device known to one account is new to another', verdict.isNewDevice, verdict.reason);

  // ── Signed device token: what it can and cannot do ──────────────────────
  // "Request desktop site" rewrites the User-Agent of the same phone. The
  // token carries the fingerprint the ledger already holds, so it stays known.
  email = account();
  ledger.set(email, [row(UA.androidMobile)]);
  res = response();
  await signIn(email, UA.androidMobile, { res }); // issues the token
  const token = res.cookieHeader();
  verdict = await signIn(email, UA.androidDesktopSite, { cookie: token });
  check('signed token keeps one phone recognised after its User-Agent changes',
    !verdict.isNewDevice && /token/.test(verdict.reason), verdict.reason);

  const withoutToken = account();
  ledger.set(withoutToken, [row(UA.androidMobile)]);
  verdict = await signIn(withoutToken, UA.androidDesktopSite);
  check('the same change without a token is reported as a new device', verdict.isNewDevice, verdict.reason);

  const tampered = account();
  ledger.set(tampered, [row(UA.androidMobile)]);
  verdict = await signIn(tampered, UA.androidDesktopSite, { cookie: token.replace(/\.[0-9a-f]{32}$/, `.${'f'.repeat(32)}`) });
  check('a tampered device token is rejected', verdict.isNewDevice, verdict.reason);

  const borrowed = account();
  ledger.set(borrowed, [row(UA.androidMobile)]);
  verdict = await signIn(borrowed, UA.androidDesktopSite, { cookie: token });
  check("another account's device token does not apply", verdict.isNewDevice, verdict.reason);

  const unbacked = account();
  res = response();
  await signIn(unbacked, UA.firefoxWin, { res }); // token issued, ledger still empty
  ledger.set(unbacked, []);
  verdict = await signIn(account(), UA.firefoxWin, { cookie: res.cookieHeader() });
  check('a token for a device absent from the ledger suppresses nothing', verdict.isNewDevice, verdict.reason);

  // ── One login event, one alert ───────────────────────────────────────────
  const racing = account();
  const [a, b] = await Promise.all([signIn(racing, UA.iphone), signIn(racing, UA.iphone)]);
  check('two simultaneous sign-ins from one new device → exactly one alert',
    [a.isNewDevice, b.isNewDevice].filter(Boolean).length === 1, `${a.reason} / ${b.reason}`);

  // ── Legacy rows written before user_agent was stored ────────────────────
  const legacyAccount = account();
  const legacy = row(UA.chromeWin);
  delete legacy.user_agent;
  ledger.set(legacyAccount, [legacy]);
  verdict = await signIn(legacyAccount, UA.chromeWin);
  check('a row without a stored User-Agent still matches on its labels', !verdict.isNewDevice, verdict.reason);

  // ── Degraded ledger must not guess ───────────────────────────────────────
  ledgerReadable = false;
  verdict = await signIn(account(), UA.iphone);
  check('unreadable session history → no verdict, so no alert',
    !verdict.evaluated && !verdict.isNewDevice, verdict.reason);
  ledgerReadable = true;

  // ── No account email means no decision ──────────────────────────────────
  verdict = await signIn('', UA.chromeWin);
  check('missing account email → no verdict', !verdict.evaluated && !verdict.isNewDevice, verdict.reason);

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });

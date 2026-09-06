// ============================================
// SaveHatke — New-device recognition for sign-in alerts
// ============================================
// Answers one question, once per successful login: has this account signed in
// from this device before? A "no" is what triggers the "new device detected"
// security email; a "yes" stays silent.
//
// The ledger is the account's own session history in Supabase (user_sessions +
// admin_sessions). Those rows already record the User-Agent of every
// successful sign-in, are written for users and admins alike, and are never
// deleted — logout and expiry only flip `status` — so they are a durable
// record of which devices an account has actually used.
//
// SECURITY
//   Nothing the browser sends can declare itself trusted. The comparison keys
//   are HMACs computed on the server from a server-held secret, so they cannot
//   be produced, replayed across accounts, or read out of a database leak; the
//   trust state itself lives only in the session rows. The one client-held
//   value, the device token cookie, is signed by this server and bound to the
//   account, so a client can present one but never mint one — and on its own
//   it still only matches a device the ledger already knows.

const crypto = require('crypto');
const UAParser = require('ua-parser-js');
const supabase = require('./supabase');

// Per-account cookie name, so signing into a second account in the same
// browser does not overwrite the first account's device token.
const COOKIE_PREFIX = 'sh_dev_';
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60; // browsers clamp Max-Age to 400 days

// How far back to look for a matching device. Session rows accumulate rather
// than rotate, so this is a real history and not a live-session list.
const HISTORY_LIMIT = 200;

// A double-submitted sign-in can run its check before the first request's
// session row has landed, which would make one login event look like two new
// devices. The first claim wins for this window.
const ALERT_DEDUPE_TTL_MS = 10 * 60 * 1000;
const recentAlerts = new Map();

function deviceSecret() {
  return process.env.DEVICE_ID_SECRET || process.env.JWT_SECRET || 'savehatke_dev_secret_key';
}

// Namespaced so a value computed for one purpose can never collide with
// another: a label-derived fingerprint must not match a User-Agent-derived
// one, and neither can be replayed as a cookie signature.
function hmac(namespace, ...parts) {
  return crypto.createHmac('sha256', deviceSecret())
    .update([namespace, ...parts].join('\u0000'))
    .digest('hex');
}

// The account key is the email, never the user id: hardcoded admin logins mint
// a fresh uuid on every sign-in, so keying on the id would make every admin
// login look like a brand-new account with no device history at all.
function accountKeyOf(email) {
  return String(email || '').toLowerCase().trim();
}

const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Versions are deliberately left out: Chrome ships a new major every few weeks
// and Windows 10 renames itself to 11 under the user, and neither is a new
// device. Browser *name* still separates Chrome from Firefox, and "Mobile
// Chrome" from desktop Chrome.
function signatureFromUserAgent(userAgent) {
  const parsed = new UAParser(String(userAgent || ''));
  const browser = parsed.getBrowser();
  const os = parsed.getOS();
  const device = parsed.getDevice();
  return [
    norm(browser.name),
    norm(os.name),
    norm(device.type) || 'desktop',
    norm(device.vendor),
    norm(device.model),
  ].join('|');
}

// Compatibility path for session rows written before user_agent was stored.
// Those columns carry versions ("Chrome 152", "Windows 10"), so they are
// trimmed back to the same granularity the User-Agent signature uses.
const stripVersion = (v) => norm(v).replace(/[\s/v]*\d[\d.]*$/, '').trim();

function signatureFromLabels(row) {
  return [
    stripVersion(row && row.browser),
    stripVersion(row && row.os),
    norm(row && row.device) || 'desktop',
  ].join('|');
}

function fingerprintsFor(accountKey, descriptor) {
  return {
    fromUserAgent: hmac('device-ua', accountKey, signatureFromUserAgent(descriptor.userAgent)),
    fromLabels: hmac('device-labels', accountKey, signatureFromLabels(descriptor)),
  };
}

// Every fingerprint the account has already been seen under. Rows contribute
// both forms so a history written before user_agent existed still matches.
function seenFingerprints(accountKey, rows) {
  const seen = new Set();
  for (const row of rows) {
    if (row && row.user_agent) {
      seen.add(hmac('device-ua', accountKey, signatureFromUserAgent(row.user_agent)));
    }
    seen.add(hmac('device-labels', accountKey, signatureFromLabels(row)));
  }
  return seen;
}

// ── Signed device token cookie ─────────────────────────────────────────────
// Corroborating signal only. It carries the fingerprint this browser was last
// recognised under, which keeps a device known if its User-Agent later drifts
// (an OS rename, a changed model string). It is HttpOnly, account-bound and
// HMAC-signed, and it can only ever match a fingerprint the ledger already
// holds — presenting one for a device the account has never used proves
// nothing and suppresses nothing.

function cookieNameFor(accountKey) {
  return COOKIE_PREFIX + hmac('cookie-name', accountKey).slice(0, 12);
}

function readRawCookie(req, name) {
  const header = req && req.headers && req.headers.cookie;
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function readDeviceToken(req, accountKey) {
  const raw = readRawCookie(req, cookieNameFor(accountKey));
  if (!raw) return '';
  const [fingerprint, issuedAt, signature] = raw.split('.');
  if (!fingerprint || !issuedAt || !signature) return '';
  const expected = hmac('cookie-sig', accountKey, fingerprint, issuedAt).slice(0, 32);
  if (signature.length !== expected.length) return '';
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return '';
  } catch (e) {
    return '';
  }
  return fingerprint;
}

function issueDeviceToken(res, accountKey, fingerprint) {
  if (!res || typeof res.append !== 'function' || !accountKey || !fingerprint) return;
  const issuedAt = String(Date.now());
  const signature = hmac('cookie-sig', accountKey, fingerprint, issuedAt).slice(0, 32);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${cookieNameFor(accountKey)}=${fingerprint}.${issuedAt}.${signature}`
    + `; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${secure}`,
  );
}

function claimAlertSlot(key) {
  const now = Date.now();
  for (const [existing, at] of recentAlerts) {
    if (now - at > ALERT_DEDUPE_TTL_MS) recentAlerts.delete(existing);
  }
  if (recentAlerts.has(key)) return false;
  recentAlerts.set(key, now);
  return true;
}

/**
 * Decide whether a successful sign-in came from a device this account has used
 * before. Called once per login, for users and admins alike.
 *
 * @param {object}  params
 * @param {object}  params.req         Express request (User-Agent + cookies)
 * @param {object} [params.res]        Express response; when present the
 *                                     device token cookie is (re)issued on it
 * @param {string}  params.email       Account email — the account key
 * @param {string}  params.userAgent   Raw User-Agent as stored on the session row
 * @param {string}  params.device      Parsed device label
 * @param {string}  params.os          Parsed OS label
 * @param {string}  params.browser     Parsed browser label
 * @returns {Promise<{isNewDevice:boolean, evaluated:boolean, reason:string,
 *                    fingerprint:string, previousSessions:Array}>}
 *   `evaluated:false` means no decision could be made (no account email, or
 *   the ledger was unreadable); the caller must not alert in that case.
 */
async function evaluateSignInDevice({ req, res, email, userAgent, device, os, browser }) {
  const accountKey = accountKeyOf(email);
  const descriptor = { userAgent, device, os, browser };

  if (!accountKey) {
    return {
      isNewDevice: false, evaluated: false, reason: 'no account email',
      fingerprint: '', previousSessions: [],
    };
  }

  const current = fingerprintsFor(accountKey, descriptor);
  const tokenFingerprint = readDeviceToken(req, accountKey);
  const history = await supabase.getAccountSessionHistory(accountKey, HISTORY_LIMIT);

  // Re-issued on every successful login so an active device keeps a fresh
  // token, and so a device recorded by this login carries its fingerprint
  // forward even if its User-Agent later changes shape.
  issueDeviceToken(res, accountKey, current.fromUserAgent);

  if (history === null) {
    // Only the ledger knows which devices this account has used. With it
    // unreachable, "new" is unknowable: alerting anyway would mail the user on
    // every recognised device, and inventing a "known" would be a false
    // reassurance. The login is left unflagged and the outage is reported.
    return {
      isNewDevice: false, evaluated: false, reason: 'session history unavailable',
      fingerprint: current.fromUserAgent, previousSessions: [],
    };
  }

  const seen = seenFingerprints(accountKey, history);
  let recognisedBy = '';
  if (seen.has(current.fromUserAgent)) recognisedBy = 'device signature';
  else if (seen.has(current.fromLabels)) recognisedBy = 'device signature (legacy row)';
  else if (tokenFingerprint && seen.has(tokenFingerprint)) recognisedBy = 'signed device token';

  if (recognisedBy) {
    return {
      isNewDevice: false, evaluated: true, reason: `recognised by ${recognisedBy}`,
      fingerprint: current.fromUserAgent, previousSessions: history,
    };
  }

  if (!claimAlertSlot(`${accountKey}|${current.fromUserAgent}`)) {
    return {
      isNewDevice: false, evaluated: true, reason: 'already alerted for this device moments ago',
      fingerprint: current.fromUserAgent, previousSessions: history,
    };
  }

  return {
    isNewDevice: true,
    evaluated: true,
    reason: history.length ? 'no earlier sign-in from this device' : 'first recorded sign-in for this account',
    fingerprint: current.fromUserAgent,
    previousSessions: history,
  };
}

module.exports = {
  evaluateSignInDevice,
  // Exported for tests and for the diagnostics in scripts/.
  accountKeyOf,
  signatureFromUserAgent,
  signatureFromLabels,
  fingerprintsFor,
  seenFingerprints,
  cookieNameFor,
  readDeviceToken,
  issueDeviceToken,
  HISTORY_LIMIT,
};

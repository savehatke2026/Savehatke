// ============================================
// SaveHatke — Cloudflare Turnstile Verification
// ============================================
// One shared verifier for every route that sits behind the CAPTCHA
// (email OTP, support tickets). It exists because a naive check
// ("no token → reject") silently breaks real logins in two situations
// that have nothing to do with bots:
//
//   1. The visitor's browser cannot reach challenges.cloudflare.com
//      (corporate proxy, ad-blocker, offline dev, an unregistered
//      hostname such as localhost), so the widget never renders and
//      the page has no token to send.
//   2. Cloudflare's siteverify endpoint is slow or down, so our own
//      server-side check cannot complete.
//
// In both cases the user is stuck: the verification email never leaves,
// with no way to recover. So the verifier fails OPEN on infrastructure
// problems and on local/private-network traffic, and fails CLOSED only
// when Cloudflare actually answers "this token is not valid" — which is
// the case that identifies an attacker. The endpoints behind it stay
// protected by their own per-email and per-IP rate limits.

const getClientIP = require('../middleware/getClientIP');

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5000;

function isLoopbackOrPrivate(ip) {
  const v = String(ip || '');
  if (!v || v === 'unknown') return true;
  const bare = v.startsWith('::ffff:') ? v.slice(7) : v;
  if (bare === '::1' || bare === '127.0.0.1' || bare.startsWith('127.')) return true;
  if (bare.startsWith('10.') || bare.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(bare)) return true;
  if (bare.startsWith('169.254.') || bare.startsWith('fe80:')) return true;
  return false;
}

/**
 * Verify the Turnstile token attached to a request.
 *
 * @param {import('express').Request} req  Express request (reads req.body.cfTurnstileToken)
 * @param {string} label                  Short tag for log lines, e.g. 'support-ticket'
 * @returns {Promise<{ok: boolean, reason?: string, error?: string, skipped?: string}>}
 *          ok:true when the request may proceed. ok:false carries `error`,
 *          a message safe to return to the client.
 */
async function verifyTurnstile(req, label = 'request') {
  const secret = (process.env.TURNSTILE_SECRET_KEY || '').trim();
  if (!secret) {
    console.error(`[turnstile] ${label}: refused because verification is not configured.`);
    return { ok: false, unavailable: true, reason: 'not-configured', error: 'Security check is temporarily unavailable. Please try again later.' };
  }

  const token = String((req.body && req.body.cfTurnstileToken) || '').trim();

  if (!token) {
    return { ok: false, reason: 'missing-token', error: 'Security check required. Please complete the CAPTCHA.' };
  }

  // Token present — ask Cloudflare, but never hang the login on it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  let data = null;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: getClientIP(req) }),
      signal: controller.signal,
    });
    data = await res.json();
  } catch (err) {
    console.warn(`[turnstile] ${label}: verification provider unavailable (${err.name === 'AbortError' ? 'timeout' : err.name || 'network-error'}).`);
    return { ok: false, unavailable: true, reason: 'siteverify-unreachable', error: 'Security check is temporarily unavailable. Please try again later.' };
  } finally {
    clearTimeout(timer);
  }

  if (data && data.success) return { ok: true };

  const codes = (data && data['error-codes']) || [];
  // Distinguish operator configuration failures from an invalid visitor token.
  const configErrors = ['invalid-input-secret', 'missing-input-secret', 'bad-request'];
  if (codes.some((c) => configErrors.includes(c))) {
    console.error(`[turnstile] ${label}: verification configuration error (${codes.join(', ')}).`);
    return { ok: false, unavailable: true, reason: 'misconfigured', error: 'Security check is temporarily unavailable. Please try again later.' };
  }

  console.warn(`[turnstile] ${label}: verification failed (${codes.join(', ') || 'no error code'}).`);
  return { ok: false, reason: codes.join(',') || 'failed', error: 'Security check failed. Please try again.' };
}

/**
 * Strict verification for break-glass paths (SOS backup access).
 *
 * verifyTurnstile() above deliberately fails OPEN in five situations so an
 * ordinary login is never blocked by our own outage. That trade is wrong for
 * admin recovery: there, a CAPTCHA that can be skipped by being on a private
 * network is not a control at all. This variant only passes when Cloudflare
 * itself confirms the token.
 *
 * The single escape hatch is explicit and auditable: SOS_CAPTCHA_REQUIRED=false
 * lets an operator accept the risk (e.g. Turnstile is not configured for this
 * deployment at all). The returned `result` is recorded in the SOS audit trail
 * and shown in the administrator alert email either way.
 *
 * @returns {Promise<{ok: boolean, result: 'passed'|'failed'|'skipped', reason?: string, error?: string}>}
 */
async function verifyTurnstileStrict(req, label = 'sos') {
  const relaxed = String(process.env.SOS_CAPTCHA_REQUIRED || '').toLowerCase() === 'false';
  const secret = (process.env.TURNSTILE_SECRET_KEY || '').trim();

  if (!secret) {
    if (relaxed) {
      console.warn(`[turnstile] ${label}: no secret configured and SOS_CAPTCHA_REQUIRED=false — proceeding without CAPTCHA.`);
      return { ok: true, result: 'skipped', reason: 'not-configured' };
    }
    console.error(`[turnstile] ${label}: refused — TURNSTILE_SECRET_KEY is not configured and this path requires a real CAPTCHA.`);
    return { ok: false, result: 'failed', reason: 'not-configured', error: 'CAPTCHA verification failed.' };
  }

  const token = String((req.body && req.body.cfTurnstileToken) || '').trim();
  if (!token) {
    if (relaxed) {
      console.warn(`[turnstile] ${label}: missing token but SOS_CAPTCHA_REQUIRED=false — proceeding.`);
      return { ok: true, result: 'skipped', reason: 'missing-token' };
    }
    return { ok: false, result: 'failed', reason: 'missing-token', error: 'CAPTCHA verification failed.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  let data = null;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: getClientIP(req) }),
      signal: controller.signal,
    });
    data = await res.json();
  } catch (err) {
    // Unlike the ordinary path, an unreachable siteverify is a refusal here.
    const why = err.name === 'AbortError' ? 'timeout' : err.message;
    if (relaxed) {
      console.warn(`[turnstile] ${label}: siteverify unreachable (${why}) but SOS_CAPTCHA_REQUIRED=false — proceeding.`);
      return { ok: true, result: 'skipped', reason: `siteverify-${why}` };
    }
    console.warn(`[turnstile] ${label}: siteverify unreachable (${why}) — refusing.`);
    return { ok: false, result: 'failed', reason: 'siteverify-unreachable', error: 'CAPTCHA verification failed.' };
  } finally {
    clearTimeout(timer);
  }

  if (data && data.success) return { ok: true, result: 'passed' };

  const codes = (data && data['error-codes']) || [];
  console.warn(`[turnstile] ${label}: verification failed (${codes.join(', ') || 'no error code'}).`);
  return { ok: false, result: 'failed', reason: codes.join(',') || 'failed', error: 'CAPTCHA verification failed.' };
}

module.exports = { verifyTurnstile, verifyTurnstileStrict, isLoopbackOrPrivate };

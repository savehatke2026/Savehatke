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
 * @param {string} label                  Short tag for log lines, e.g. 'send-otp'
 * @returns {Promise<{ok: boolean, reason?: string, error?: string, skipped?: string}>}
 *          ok:true when the request may proceed. ok:false carries `error`,
 *          a message safe to return to the client.
 */
async function verifyTurnstile(req, label = 'request') {
  const secret = (process.env.TURNSTILE_SECRET_KEY || '').trim();
  if (!secret) return { ok: true, skipped: 'not-configured' };

  const token = String((req.body && req.body.cfTurnstileToken) || '').trim();

  if (!token) {
    // The widget never produced a token. Refusing here would lock out
    // anyone whose browser cannot load Cloudflare, so allow it when the
    // deployment opts in (TURNSTILE_REQUIRED=false) or the caller is on
    // the local network — a bot farm is not coming from 127.0.0.1.
    const optional = String(process.env.TURNSTILE_REQUIRED || '').toLowerCase() === 'false';
    const local = isLoopbackOrPrivate(getClientIP(req));
    if (optional || local) {
      console.warn(`[turnstile] ${label}: no CAPTCHA token — allowing (${optional ? 'TURNSTILE_REQUIRED=false' : 'local/private client'}).`);
      return { ok: true, skipped: optional ? 'optional' : 'local-client' };
    }
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
    // Cloudflare unreachable or too slow. This is our outage, not the
    // visitor's fault — let them through rather than blocking every login.
    console.warn(`[turnstile] ${label}: siteverify unreachable (${err.name === 'AbortError' ? 'timeout' : err.message}) — allowing.`);
    return { ok: true, skipped: 'siteverify-unreachable' };
  } finally {
    clearTimeout(timer);
  }

  if (data && data.success) return { ok: true };

  const codes = (data && data['error-codes']) || [];
  // A configuration mistake on our side (bad/missing secret, hostname not
  // registered for this widget) must not present as "you failed the CAPTCHA".
  const configErrors = ['invalid-input-secret', 'missing-input-secret', 'bad-request'];
  if (codes.some((c) => configErrors.includes(c))) {
    console.error(`[turnstile] ${label}: MISCONFIGURED (${codes.join(', ')}) — allowing so logins keep working. Fix TURNSTILE_SECRET_KEY / widget hostnames.`);
    return { ok: true, skipped: 'misconfigured' };
  }

  console.warn(`[turnstile] ${label}: verification failed (${codes.join(', ') || 'no error code'}).`);
  return { ok: false, reason: codes.join(',') || 'failed', error: 'Security check failed. Please try again.' };
}

module.exports = { verifyTurnstile, isLoopbackOrPrivate };

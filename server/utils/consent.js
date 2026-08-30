// ============================================
// SaveHatke — Consent (server side)
// ============================================
// Reads the `sh_consent` cookie written by public/js/cookie-consent.js.
//
// The browser owns the decision; this module exists so server-side code can ask
// the same question the client asks and get the same answer, instead of a second
// consent system growing on the server. Use it before recording anything that is
// not strictly necessary:
//
//     const consent = require('../utils/consent');
//     if (consent.hasConsent(req, 'analytics')) { ...record the metric... }
//
// The cookie is intentionally readable by JavaScript (not HttpOnly) because the
// client has to check it on every page load to decide whether an optional script
// may run. That is safe here: it holds two booleans, a version and a timestamp —
// no identifier, no email, no token. It must never be trusted as an
// authorisation signal; authentication remains the `sh_session` HttpOnly cookie
// handled in middleware/auth.js.

const CONSENT_COOKIE_NAME = 'sh_consent';
const CONSENT_VERSION = 1; // keep in step with COOKIE_VERSION in cookie-consent.js
const OPTIONAL_CATEGORIES = ['analytics', 'marketing'];

/** Pull one cookie out of the raw Cookie header. */
function readCookie(req, name) {
  // express.cookieParser is not in use here; parse the header directly so this
  // works on any route regardless of middleware order.
  const header = req && req.headers && req.headers.cookie;
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch (e) {
      return null; // malformed percent-encoding
    }
  }
  return null;
}

/**
 * The visitor's recorded consent, or null when they have not answered yet.
 * A payload from an older policy version counts as "not answered", exactly as
 * the client treats it, so the two never disagree.
 *
 * @returns {{ essential: true, analytics: boolean, marketing: boolean, decidedAt: string }|null}
 */
function readConsent(req) {
  const raw = readCookie(req, CONSENT_COOKIE_NAME);
  if (!raw) return null;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return null; // corrupted or hand-edited
  }
  if (!data || typeof data !== 'object') return null;
  if (Number(data.v) !== CONSENT_VERSION) return null;

  return {
    essential: true, // never optional
    analytics: data.analytics === true,
    marketing: data.marketing === true,
    decidedAt: typeof data.ts === 'string' ? data.ts : '',
  };
}

/**
 * Whether this request may use a given cookie category.
 * Essential is always true. Anything optional defaults to FALSE when no consent
 * has been recorded — the safe direction, and what the law requires.
 */
function hasConsent(req, category) {
  if (category === 'essential') return true;
  if (!OPTIONAL_CATEGORIES.includes(category)) return false;
  const consent = readConsent(req);
  return !!consent && consent[category] === true;
}

module.exports = {
  CONSENT_COOKIE_NAME,
  CONSENT_VERSION,
  OPTIONAL_CATEGORIES,
  readCookie,
  readConsent,
  hasConsent,
};

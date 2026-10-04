'use strict';

// Server-owned authorization policy. Changing the administrator roster is a
// deployment operation; no public API can add, remove, or promote an admin.
const ADMIN_ACCOUNTS = Object.freeze([
  Object.freeze({ id: '1', name: 'Rupayan', email: 'rupayandas2024@gmail.com', active: true }),
  Object.freeze({ id: '2', name: 'Jaggik', email: 'jaggik8888@gmail.com', active: true }),
]);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getAdminAccount(email) {
  const normalized = normalizeEmail(email);
  return ADMIN_ACCOUNTS.find((account) => account.email === normalized && account.active) || null;
}

function isAuthorizedAdminEmail(email) {
  return Boolean(getAdminAccount(email));
}

function getPublicOrigin(req) {
  const configured = String(process.env.APP_BASE_URL || process.env.SITE_URL || '').trim();
  if (configured) {
    const base = new URL(configured);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
        (process.env.NODE_ENV === 'production' && base.protocol !== 'https:')) {
      throw new Error('Invalid public application URL configuration.');
    }
    return base.origin;
  }

  const allowed = new Set([
    'https://savehatke.com', 'https://www.savehatke.com', 'https://savehatke.vercel.app',
    ...(process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
  ]);
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || '').split(',')[0].trim().toLowerCase();
  const host = String((req && typeof req.get === 'function' && req.get('host')) || '').trim();
  if (host && ['http', 'https'].includes(forwardedProto)) {
    try {
      const candidate = new URL(`${forwardedProto}://${host}`);
      if (allowed.has(candidate.origin)) return candidate.origin;
      if (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(candidate.hostname)) {
        return candidate.origin;
      }
    } catch (e) { /* use fixed fallback below */ }
  }

  if (process.env.NODE_ENV === 'production') return 'https://savehatke.com';
  return `http://localhost:${String(process.env.PORT || '3000')}`;
}

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '');
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 bytes.');
  }
  return secret;
}

function assertSecurityConfiguration() {
  getJwtSecret();

  // Google OAuth callback sanity check. In production the redirect_uri sent to
  // Google is the *only* thing that decides whether sign-in works or fails with
  // redirect_uri_mismatch — so a missing / http / wrong-path value must abort
  // startup rather than be discovered at the first failed login.
  if (process.env.NODE_ENV === 'production') {
    const raw = String(process.env.GOOGLE_REDIRECT_URI || '').trim();
    if (!raw) {
      throw new Error(
        'GOOGLE_REDIRECT_URI is not set in production. Set it in your hosting ' +
        'environment (Vercel → Settings → Environment Variables → Production) to ' +
        '"https://savehatke.vercel.app/api/auth/google-redirect", then redeploy.'
      );
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:') {
        throw new Error(`GOOGLE_REDIRECT_URI must be https in production (got ${parsed.protocol}).`);
      }
      if (parsed.pathname !== '/api/auth/google-redirect') {
        throw new Error(
          `GOOGLE_REDIRECT_URI must end with /api/auth/google-redirect in production ` +
          `(got ${parsed.pathname}).`
        );
      }
    } catch (e) {
      throw new Error(`GOOGLE_REDIRECT_URI is invalid: ${e.message}`);
    }
  }

  // Always log the resolved redirect_uri on startup so a misconfiguration is
  // visible in deploy logs without exposing secrets. We only print host + path,
  // never the env-var raw value, query, fragment, or credentials.
  try {
    const raw = String(process.env.GOOGLE_REDIRECT_URI || '').trim();
    if (raw) {
      const parsed = new URL(raw);
      console.log(`[security] Google OAuth redirect_uri: ${parsed.protocol}//${parsed.host}${parsed.pathname}`);
    } else if (process.env.NODE_ENV !== 'production') {
      console.log('[security] Google OAuth redirect_uri: derived from APP_BASE_URL/SITE_URL or localhost');
    }
  } catch (e) {
    console.warn('[security] Google OAuth redirect_uri could not be parsed for diagnostics.');
  }
}

module.exports = {
  ADMIN_ACCOUNTS,
  normalizeEmail,
  getAdminAccount,
  isAuthorizedAdminEmail,
  getPublicOrigin,
  getJwtSecret,
  assertSecurityConfiguration,
};

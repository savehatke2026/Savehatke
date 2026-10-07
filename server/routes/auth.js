const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');
const UAParser = require('ua-parser-js');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const {
  authenticateToken,
  requireAdmin,
  generateSessionToken,
  hashSessionToken,
  setSessionCookie,
  clearSessionCookie,
  SESSION_TTL_MS,
  ADMIN_SESSION_TTL_MS,
} = require('../middleware/auth');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');
const emailService = require('../services/emailService');
const deviceRecognition = require('../services/deviceRecognition');
const getClientIP = require('../middleware/getClientIP');
const sessionCleanup = require('../services/sessionCleanup');
const twoFactor = require('../services/twoFactorService');
const { getAdminAccount, getJwtSecret, normalizeEmail, isAdminRosterStale, ensureAdminRosterReady } = require('../config/security');

const router = express.Router();

// Google-only authentication. Register the secure handlers before any legacy
// These are the only login handlers. Email and client-token login endpoints
// are retired and cannot create sessions.
const GOOGLE_STATE_COOKIE = 'sh_google_oauth_state';
const GOOGLE_STATE_TTL_SECONDS = 600;
const GOOGLE_OAUTH_REDIRECT_PATH = '/api/auth/google-redirect';
const GOOGLE_CLIENT_ID_FALLBACK = '930893529973-2j5h36csl909m139urdq552n63h1hl1q.apps.googleusercontent.com';

// Single source of truth for the production Google OAuth callback.
//
// Priority (highest first):
//   1. process.env.GOOGLE_REDIRECT_URI        — the canonical value; required in production.
//   2. process.env.APP_BASE_URL / SITE_URL    — derived from a configured base.
//   3. http://localhost:<PORT>/...             — local development only.
//
// NEVER use VERCEL_URL here. On Vercel that env var is the *deployment-specific*
// hostname (e.g. "savehatke-<hash>-save-hatke.vercel.app" on a preview build, or
// "savehatke.vercel.app" on production), which silently changes per redeploy and
// produces "redirect_uri_mismatch" the moment a new deployment is cut. Production
// OAuth must always register against a single, stable, manually-pinned URL — the
// value of GOOGLE_REDIRECT_URI.
function googleRedirectUri() {
  const explicit = String(process.env.GOOGLE_REDIRECT_URI || '').trim();
  if (explicit) {
    // Validate the explicit value — refuse a localhost override when running in
    // production so a developer-side misconfiguration cannot break OAuth in prod.
    if (process.env.NODE_ENV === 'production') {
      try {
        const parsed = new URL(explicit);
        if (parsed.protocol !== 'https:') {
          throw new Error(`GOOGLE_REDIRECT_URI must be https in production (got ${parsed.protocol}).`);
        }
        if (parsed.username || parsed.password) {
          throw new Error('GOOGLE_REDIRECT_URI must not include credentials.');
        }
      } catch (e) {
        if (e instanceof Error && /must (be|not)/.test(e.message)) throw e;
        throw new Error(`GOOGLE_REDIRECT_URI is malformed: ${e.message}`);
      }
    }
    return explicit;
  }
  const configuredBase = String(process.env.APP_BASE_URL || process.env.SITE_URL || '').trim();
  if (configuredBase) {
    try {
      const base = new URL(configuredBase);
      if (base.username || base.password || (process.env.NODE_ENV === 'production' && base.protocol !== 'https:')) {
        throw new Error('Invalid OAuth base URL configuration.');
      }
      return `${base.origin}${GOOGLE_OAUTH_REDIRECT_PATH}`;
    } catch (e) {
      // fall through to localhost
    }
  }
  if (process.env.NODE_ENV === 'production') {
    // No explicit value in production is a misconfiguration: fail loudly rather
    // than letting a server boot with an OAuth flow that is guaranteed to fail.
    throw new Error(
      'GOOGLE_REDIRECT_URI is not set. Set it in your hosting environment ' +
      '(e.g. Vercel → Settings → Environment Variables → Production) to ' +
      '"https://savehatke.vercel.app/api/auth/google-redirect".'
    );
  }
  return `http://localhost:${String(process.env.PORT || '3000')}${GOOGLE_OAUTH_REDIRECT_PATH}`;
}

function setOAuthStateCookie(res, state) {
  const encoded = Buffer.from(JSON.stringify(state)).toString('base64url');
  const signature = crypto.createHmac('sha256', getJwtSecret()).update(encoded).digest('base64url');
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  // Path=/ (not /api/auth/google-redirect). The narrower path is RFC-correct but
  // can drop the cookie on some browser/proxy combos when the redirect lands on
  // a slightly different path (trailing slash, query param parsing). Path=/ is
  // the standard for OAuth state cookies and the cookie is HttpOnly + signed +
  // 10-minute Max-Age, so widening the path does not weaken the security
  // posture. readOAuthStateCookie() then verifies the HMAC on every read.
  res.append('Set-Cookie', `${GOOGLE_STATE_COOKIE}=${encoded}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GOOGLE_STATE_TTL_SECONDS}${secure}`);
}

function clearOAuthStateCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  // Match the attributes of setOAuthStateCookie so the browser treats this as
  // the same cookie and deletes the existing record rather than leaving a stale
  // one behind.
  res.append('Set-Cookie', `${GOOGLE_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function readOAuthStateCookie(req) {
  const part = String(req.headers.cookie || '').split(';').map((value) => value.trim())
    .find((value) => value.startsWith(`${GOOGLE_STATE_COOKIE}=`));
  if (!part) return { state: null, reason: 'absent' };
  const value = part.slice(GOOGLE_STATE_COOKIE.length + 1);
  const dot = value.lastIndexOf('.');
  if (dot < 1) return { state: null, reason: 'malformed' };
  const encoded = value.slice(0, dot);
  const supplied = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(crypto.createHmac('sha256', getJwtSecret()).update(encoded).digest('base64url'));
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return { state: null, reason: 'bad_signature' };
  }
  try {
    const state = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const age = Math.floor(Date.now() / 1000) - Number(state.issuedAt || 0);
    if (age < 0 || age > GOOGLE_STATE_TTL_SECONDS) {
      return { state: null, reason: 'expired', age };
    }
    return { state, reason: 'ok' };
  } catch (e) {
    return { state: null, reason: 'unparseable' };
  }
}

function safeScriptJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029',
  })[char]);
}

// Same allowlist the client uses in safeProfilePictureUrl — keep the two in
// lock-step so a server-persisted avatar can never bypass the panel's CSP.
function isAllowedAvatarUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    return /(^|\.)googleusercontent\.com$/.test(u.hostname)
        || /(^|\.)google\.com$/.test(u.hostname);
  } catch (e) { return false; }
}

function sendGoogleLoginHandoff(res, user, destination) {
  const adminRole = String(user.role || '').toLowerCase();
  const isAdmin = ['admin', 'owner', 'super admin', 'support'].includes(adminRole);
  const target = isAdmin ? '/vault' : destination;
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  return res.status(200).send(`<!doctype html><html><head><meta charset="utf-8"><title>SaveHatke</title></head><body><script>
    try {
      localStorage.removeItem('sh_token');
      localStorage.removeItem('sh_admin_token');
      localStorage.setItem('sh_authenticated', '1');
      localStorage.setItem('sh_user', ${safeScriptJson(JSON.stringify(user))});
      ${isAdmin ? `localStorage.setItem('sh_admin_user', ${safeScriptJson(JSON.stringify(user))});` : `localStorage.removeItem('sh_admin_user');`}
    } catch (e) {}
    window.location.replace(${safeScriptJson(target)});
  </script></body></html>`);
}

async function finishGoogleLogin(req, res, identity) {
  const email = normalizeEmail(identity.email);
  const googleSub = String(identity.sub || '').trim();
  const googleName = String(identity.name || email.split('@')[0]).trim().slice(0, 120);
  const picture = String(identity.picture || '').trim().slice(0, 1000);
  if (!email || !googleSub || identity.email_verified !== true) {
    return res.status(401).json({ error: 'Google authentication failed.', code: 'GOOGLE_IDENTITY_INVALID' });
  }

  // Cold-start gate: on a fresh serverless instance the roster read from boot
  // may still be in flight. Without this await, getAdminAccount misses and a
  // real admin is silently demoted to a regular user (redirected to / instead
  // of /vault). Resolves instantly once the cache is hydrated.
  await ensureAdminRosterReady();
  const adminAccount = getAdminAccount(email);
  if (adminAccount) {
    // Block admin sign-in while the roster is stale (Supabase unreachable, on
    // the env-var fallback). A stale env list must NEVER grant admin access
    // the Supabase roster would have denied.
    if (isAdminRosterStale()) {
      console.warn(`[auth] admin sign-in blocked for ${email} — admin allowlist is on env fallback.`);
      return res.redirect(303, '/login?google=admin_blocked');
    }
    let adminData = null;
    try {
      const AdminModel = require('../models/Admin');
      adminData = await AdminModel.findOne({ email });
    } catch (e) { /* allowlisted identities do not depend on optional profile storage */ }
    if (adminData && adminData.is_active === false) {
      return res.status(403).json({ error: 'This administrator account is inactive.' });
    }
    const name = String((adminData && (adminData.name || adminData.full_name)) || adminAccount.name || googleName).slice(0, 120);
    // Persist the Google avatar to the Admin profile so the panel header keeps
    // the photo across logins. Only Google's own image hosts are accepted
    // (same allowlist safeProfilePictureUrl applies on the client); anything
    // else is left untouched so a hand-edited sheet cell is never clobbered.
    try {
      const AdminModel = require('../models/Admin');
      const safePicture = isAllowedAvatarUrl(picture) ? String(picture).trim().slice(0, 1000) : '';
      if (safePicture) {
        if (adminData && adminData.profile_image !== safePicture) {
          adminData.profile_image = safePicture;
          await adminData.save().catch(() => { /* non-fatal — panel falls back to initials */ });
        } else if (!adminData) {
          // First-time Google login for an allowlisted admin with no Mongo
          // document yet — create a minimal profile so the photo has a home.
          await AdminModel.create({
            id: adminAccount.id,
            name,
            email,
            role: 'Admin',
            profile_image: safePicture,
            last_login: new Date(),
            email_verified: true,
          }).catch(() => { /* dup-key / validation — non-fatal */ });
        }
      }
    } catch (e) { /* avatar persistence is best-effort */ }
    // The Supabase roster rows carry { email, name, active } and no id column
    // (the pre-roster hardcoded list had id: '1'/'2'), so adminAccount.id is
    // undefined today — which made createLoginSession throw "Authenticated
    // account has no stable user id." for every admin sign-in. The allowlist
    // email is the roster's primary key and a stable identifier; historical
    // admin sessions each carried a fresh random UUID, so no specific value
    // is load-bearing and an email user_id is backward-compatible.
    const session = await createLoginSession(req, adminAccount.id || adminAccount.email, 'Google Admin', email, name, res, googleSub);
    setSessionCookie(res, session.token, session.ttlMs);
    return sendGoogleLoginHandoff(res, {
      id: session.userId, userId: session.userId, email, name, picture,
      role: adminAccount.role || 'admin',
    }, '/vault');
  }

  let sheetUser = null;
  try {
    sheetUser = await db.findRow(db.SHEETS.USERS, 'email', email);
  } catch (e) {
    // Sheets outage shouldn't block a sign-in — fall through and create a
    // Supabase-only profile. The user keeps signing in; an admin can backfill
    // the Sheets row when the API recovers.
    console.warn(`[auth] Sheets findRow failed for ${email} (${e.message}); falling through to Supabase-only profile.`);
    sheetUser = null;
  }
  const now = new Date().toISOString();
  let isNewUser = false;
  if (sheetUser) {
    if (sheetUser.status && String(sheetUser.status).toLowerCase() !== 'active') {
      return res.status(403).json({ error: 'This account is not active.' });
    }
    if (sheetUser.google_sub && String(sheetUser.google_sub) !== googleSub) {
      return res.status(403).json({ error: 'This Google identity is not linked to this account.' });
    }
    // Non-critical mirror write (last-login bookkeeping). It used to be
    // awaited, which put a full Sheets write round-trip on the sign-in path;
    // failures were already tolerated below, so it now runs fire-and-forget
    // and the login response no longer waits on it.
    db.updateRow(db.SHEETS.USERS, 'email', email, {
      google_sub: googleSub,
      last_login_at: now,
      updated_at: now,
      ...(picture ? { profile_picture: picture } : {}),
    }).catch((e) => {
      // Mirror write failed — keep going with the existing Sheets row. The
      // session can still be issued; the next successful Sheets read sees the
      // previous values, which is fine for a non-critical mirror.
      console.warn(`[auth] Sheets updateRow failed for ${email} (${e.message}); continuing with cached row.`);
    });
  } else {
    isNewUser = true;
    const id = uuidv4();
    sheetUser = {
      user_ID: id, user_id: id, id, name: googleName, preferred_name: '',
      username: email.split('@')[0], email, google_sub: googleSub, status: 'active',
      ...(picture ? { profile_picture: picture } : {}),
      created_at: now, updated_at: now, last_login_at: now, last_logout_at: '',
    };
    try {
      await db.appendRow(db.SHEETS.USERS, sheetUser);
    } catch (e) {
      // First-time Sheets row failed — fall back to a Supabase-only profile so
      // the sign-in still succeeds. A user object built from the stub above is
      // enough for `setSessionCookie + sendGoogleLoginHandoff` to issue a
      // session; Supabase.createUser below mirrors what the Sheets row would
      // have carried.
      console.warn(`[auth] Sheets appendRow failed for new user ${email} (${e.message}); continuing with Supabase-only profile.`);
    }
    if (supabase.isConfigured()) {
      await supabase.createUser({ user_id: id, name: googleName, email, username: sheetUser.username })
        .catch(() => console.warn('[auth] Supabase profile sync failed.'));
    }
  }

  const userId = String(sheetUser.user_id || sheetUser.user_ID || sheetUser.id || '').trim();
  if (!userId) return res.status(503).json({ error: 'Account storage is temporarily unavailable.' });
  const name = String(sheetUser.preferred_name || sheetUser.name || googleName).trim().slice(0, 120);
  // sheetUser is the row this handler already resolved for the exact same
  // email — hand it to createLoginSession so resolveSessionUserId can skip
  // its redundant Sheets re-read. Admin logins (above) keep the original
  // lookup path.
  const session = await createLoginSession(req, userId, 'Google', email, name, res, googleSub, sheetUser);
  setSessionCookie(res, session.token, session.ttlMs);
  const user = {
    id: userId, userId, email, name, preferred_name: sheetUser.preferred_name || '',
    google_name: googleName,
    needs_name_setup: isNewUser || !String(sheetUser.preferred_name || '').trim(),
    username: sheetUser.username || email.split('@')[0], picture,
    status: 'active', role: 'user',
  };
  // Post-Google-login destination:
  //   admin  → /vault       (set in sendGoogleLoginHandoff when role === 'admin')
  //   user   → /index       ← landing page / marketplace (the only place we want
  //                                  a freshly-signed-in visitor to arrive).
  // We used to send users to /dashboard.html (or /onboarding.html when their
  // preferred display name was still empty). Both pages have an auth-gate that
  // bounces a missing session back to /login.html, so a user whose cookie or
  // localStorage write raced with the redirect would land on the login screen
  // and look like the sign-in "did nothing". Landing on /index is a static
  // page that doesn't bounce on auth, so every successful Google login ends in
  // a consistent, working marketplace view regardless of account state.
  return sendGoogleLoginHandoff(res, user, '/index');
}

router.post(['/register', '/login'], (req, res) => {
  return res.status(410).json({ error: 'Google Login is required.', code: 'GOOGLE_LOGIN_REQUIRED' });
});
router.post(['/google', '/google-redirect'], (req, res) => {
  return res.status(401).json({ error: 'Use the Google sign-in flow.', code: 'GOOGLE_OAUTH_REQUIRED' });
});
router.get('/google-redirect', async (req, res) => {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID_FALLBACK).trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return res.status(503).send('Google sign-in is temporarily unavailable.');

  // Every rejection of the OAuth callback lands on /login?google=failed&reason=
  // <slug> so the UI can show a precise message and the deploy logs + the URL
  // agree on what failed. The slug is a sanitised lowercased token; the full
  // reason still goes to the deploy log.
  const fail = (slug, logLine) => {
    const safe = String(slug || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40) || 'unknown';
    if (logLine) console.warn(`[auth] Google OAuth rejected: ${logLine}`);
    else console.warn(`[auth] Google OAuth rejected: ${safe}`);
    return res.redirect(303, `/login?google=failed&reason=${safe}`);
  };

  try {
    const redirectUri = googleRedirectUri();
    const oauth = new OAuth2Client(clientId, clientSecret, redirectUri);
    const code = String(req.query.code || '').trim();
    if (!code) {
      if (req.query.error) {
        // The user (or the Google consent screen) returned an explicit code:
        // access_denied is consent cancelled; any other value is a real failure.
        clearOAuthStateCookie(res);
        const userCancelled = String(req.query.error || '').toLowerCase() === 'access_denied';
        return fail(
          userCancelled ? 'cancelled' : `google_${req.query.error}`,
          `consent returned error=${req.query.error}`,
        );
      }
      const state = crypto.randomBytes(32).toString('base64url');
      const nonce = crypto.randomBytes(32).toString('base64url');
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      setOAuthStateCookie(res, { state, nonce, verifier, redirectUri, issuedAt: Math.floor(Date.now() / 1000) });
      return res.redirect(302, oauth.generateAuthUrl({
        response_type: 'code', redirect_uri: redirectUri,
        scope: ['openid', 'email', 'profile'], state, nonce,
        code_challenge: challenge, code_challenge_method: 'S256',
        prompt: 'select_account', access_type: 'online',
      }));
    }

    const savedResult = readOAuthStateCookie(req);
    clearOAuthStateCookie(res);
    const saved = savedResult && savedResult.state;
    const returnedState = String(req.query.state || '');
    if (!saved || !saved.state || !returnedState || saved.state.length !== returnedState.length ||
        !crypto.timingSafeEqual(Buffer.from(saved.state), Buffer.from(returnedState)) ||
        saved.redirectUri !== redirectUri || !saved.nonce || !saved.verifier) {
      // Diagnostic — printed in the deploy log so a future "stuck loop" can be
      // triaged from Vercel logs without redeploying with extra logging. The
      // full state payload is NEVER logged (it carries nonce + PKCE verifier
      // that should not leak); only the salt + length + the saved/returned
      // state prefix.
      const sl = saved && saved.state ? saved.state.length : 0;
      const rl = returnedState.length;
      const headerName = (req && req.headers && req.headers['x-forwarded-host'])
        || (req && req.get && req.get('host'))
        || '<unknown>';
      const probeLog = {
        hostHeader: String(headerName).slice(0, 80),
        cookieHeaderPresent: Boolean(req && req.headers && req.headers.cookie),
        cookieReadReason: savedResult ? savedResult.reason : 'no_reader',
        savedStateLen: sl,
        returnedStateLen: rl,
        savedRedirectUri: saved && saved.redirectUri,
        currentRedirectUri: redirectUri,
        ageSeconds: savedResult && savedResult.age,
      };
      console.warn('[auth] OAuth state validation failed:', probeLog);
      // The usual causes, in order: consent was abandoned long enough for the
      // 10-minute state cookie to expire, the callback landed on a different
      // host than the one that started the flow (so the SameSite=Lax cookie
      // was never sent), or GOOGLE_REDIRECT_URI changed between the two legs.
      return fail(
        !saved ? 'state_missing' : 'state_mismatch',
        `OAuth state cookie ${saved ? 'did not match the returned state' : 'was missing'} (host=${probeLog.hostHeader}, cookie_present=${probeLog.cookieHeaderPresent}, read_reason=${probeLog.cookieReadReason}, redirect_uri=${redirectUri}); the sign-in flow must start and finish on the same host.`,
      );
    }

    const { tokens } = await oauth.getToken({ code, codeVerifier: saved.verifier, redirect_uri: redirectUri });
    if (!tokens || !tokens.id_token) return fail('no_id_token', 'google getToken returned no id_token');
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
    const identity = ticket.getPayload();
    const now = Math.floor(Date.now() / 1000);
    const issuerOkay = identity && ['accounts.google.com', 'https://accounts.google.com'].includes(identity.iss);
    const issuedAtOkay = identity && Number.isFinite(Number(identity.iat)) &&
      Number(identity.iat) >= Number(saved.issuedAt) - 60 && Number(identity.iat) <= now + 60;
    const nonceOkay = identity && typeof identity.nonce === 'string' && identity.nonce.length === saved.nonce.length &&
      crypto.timingSafeEqual(Buffer.from(identity.nonce), Buffer.from(saved.nonce));
    if (!issuerOkay || !issuedAtOkay || !nonceOkay) {
      return fail('identity_invalid', `id_token claims failed (issuer=${issuerOkay}, iat=${issuedAtOkay}, nonce=${nonceOkay})`);
    }
    if (identity.email_verified !== true) {
      return fail('email_unverified', `google says email_verified=false for ${identity.email}`);
    }
    if (!identity.sub || !identity.email) {
      return fail('identity_missing_fields', `id_token missing sub/email`);
    }
    return await finishGoogleLogin(req, res, identity);
  } catch (err) {
    // Logged with the real reason so a broken login is diagnosable from the
    // deploy logs; the visitor only ever sees the precise failure banner.
    console.error('[auth] Google OAuth callback failed:', (err && err.message) || err);
    clearOAuthStateCookie(res);
    if (res.headersSent) return;
    const msg = String((err && err.message) || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40) || 'unknown';
    return res.redirect(303, `/login?google=failed&reason=server_${msg}`);
  }
});

/**
 * Extract device info from User-Agent and create a server-side 48-hour
 * session in Supabase. Called on EVERY successful login (users and admins).
 *
 * The returned object carries the raw session token (which the caller places
 * only in the HttpOnly cookie) plus the session id and
 * expiry. The database stores only a SHA-256 hash of the token.
 *
 * The user_id is resolved against the Users Google Sheet first (by email),
 * so Supabase always stores the real user id that exists in the sheet.
 * Geo-IP enrichment runs in the background â€” it never delays the login.
 *
 * @returns {Promise<{token:string, sessionId:string, expiresAt:string}>}
 *   Throws when no enforceable server-side session could be created.
 */

/**
 * Pull the canonical user_id out of a sheet row, no matter how the column
 * is named in the spreadsheet. The configured header is `user_id`, but live
 * sheets sometimes use `userId`, `userid`, `UserID`, `User Id`, or even just
 * `id` / `uuid`. Without this, the session table ends up with the wrong id
 * (or a freshly generated one) and the admin Sessions page can't join the
 * row back to the user.
 */
function extractUserIdFromSheetUser(sheetUser) {
  if (!sheetUser || typeof sheetUser !== 'object') return '';
  // Direct field names first â€” covers the common header variants
  for (const key of ['user_id', 'userId', 'userid', 'id', 'uuid']) {
    if (sheetUser[key]) return String(sheetUser[key]);
  }
  // Fallback: any field whose normalized name collapses to "userid" or "uuid"
  for (const [key, value] of Object.entries(sheetUser)) {
    if (!value) continue;
    const nk = String(key).trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (nk === 'userid' || nk === 'uuid') return String(value);
  }
  return '';
}

/**
 * Resolve the canonical user_id for a session.
 *
 * `preknownRow` is the Users-sheet row the caller already fetched by the same
 * email moments earlier (finishGoogleLogin reads it on every login). Passing
 * it in skips a redundant Sheets round-trip on the sign-in path; the row is
 * the same object the second lookup would have returned, so the resolved id,
 * the backfill branch and the source label are all unchanged. When no row is
 * handed in (admin logins, or the caller's own read failed) the original
 * lookup path runs exactly as before.
 */
async function resolveSessionUserId(userId, cleanEmail, preknownRow) {
  let realUserId = String(userId || '');
  let userIdSource = 'passed-in';
  if (!cleanEmail) return { realUserId, userIdSource };

  let sheetUser = preknownRow
    || await db.findRow(db.SHEETS.USERS, 'email', cleanEmail).catch(() => null);
  if (!sheetUser) {
    // Retry case/whitespace-insensitive â€” sheet rows may hold mixed-case emails
    const allRows = await db.getRows(db.SHEETS.USERS).catch(() => []);
    sheetUser = allRows.find((r) => String(r.email || '').toLowerCase().trim() === cleanEmail) || null;
  }

  let fromSheet = extractUserIdFromSheetUser(sheetUser);

  // â”€â”€ Backfill: sheet has the user row but the user_id cell is empty.
  //    This is the most common cause of "wrong user_id in Supabase" â€”
  //    the row was created before the user_id column was populated, or the
  //    column was added later by ensureSheets(). Generate a UUID,
  //    write it back to the sheet, and use it for the session.
  if (sheetUser && !fromSheet) {
    const newId = uuidv4();
    try {
      await db.updateRow(db.SHEETS.USERS, 'email', cleanEmail, {
        user_id: newId,
        id: newId,
        updated_at: new Date().toISOString(),
      });
      fromSheet = newId;
      userIdSource = 'sheet-row-backfilled';
      console.log(`[session] Backfilled empty user_id for ${cleanEmail} â†’ ${newId}`);
    } catch (e) {
      console.warn(`[session] Failed to backfill user_id for ${cleanEmail}:`, e.message);
    }
  }

  if (fromSheet) {
    realUserId = fromSheet;
    if (userIdSource === 'passed-in') userIdSource = 'google-sheet';
  } else if (sheetUser) {
    userIdSource = 'sheet-row-missing-id';
  } else {
    userIdSource = 'sheet-row-not-found';
  }
  return { realUserId, userIdSource };
}

function parseUserAgent(req) {
  const ua = new UAParser(req.headers['user-agent'] || '');
  const device = ua.getDevice();
  const os = ua.getOS();
  const browser = ua.getBrowser();

  let deviceStr = '';
  if (device.vendor && device.model) {
    deviceStr = `${device.vendor} ${device.model}`;
  } else if (device.vendor) {
    deviceStr = device.vendor;
  } else {
    deviceStr = device.type ? device.type.charAt(0).toUpperCase() + device.type.slice(1) : 'Desktop';
  }

  const osStr = os.name ? `${os.name}${os.version ? ' ' + os.version : ''}` : 'Unknown';
  const browserStr = browser.name ? `${browser.name}${browser.version ? ' ' + browser.version.split('.')[0] : ''}` : 'Unknown';
  return { deviceStr, osStr, browserStr, raw: String(req.headers['user-agent'] || '').slice(0, 300) };
}

/**
 * Background geo enrichment â€” looks up country/state/city for the login IP
 * and updates the session row. Fire-and-forget; failures are harmless.
 */
/**
 * Look up country/state/city for a login IP. Best-effort: private/loopback
 * addresses and total provider failure both yield 'Unknown' fields. Shared by
 * the session-row enrichment and the "new sign-in" alert email, so a login
 * only ever costs one geo lookup.
 */
async function resolveGeo(ip) {
  let country = 'Unknown', state = 'Unknown', city = 'Unknown';
  const isIPv6 = ip.includes(':');
  const lookupable = ip && ip !== 'unknown' && ip !== '127.0.0.1'
    && !/^(10\.|192\.168\.|169\.254\.)/.test(ip) && !/^172\.(1[6-9]|2\d|3[01])\./.test(ip);

  if (lookupable) {
    // Order matters: try HTTPS services first (Vercel allows them), then HTTP
    const services = isIPv6
      ? [
        { name: 'ipwho.is', url: `https://ipwho.is/${ip}`, parse: (j) => ({ ok: j.success === true, country: j.country, state: j.region, city: j.city }) },
        { name: 'ipapi.co', url: `https://ipapi.co/${ip}/json/`, parse: (j) => ({ ok: !j.error, country: j.country_name, state: j.region, city: j.city }) },
      ]
      : [
        { name: 'ipapi.co', url: `https://ipapi.co/${ip}/json/`, parse: (j) => ({ ok: !j.error, country: j.country_name, state: j.region, city: j.city }) },
        { name: 'ipwho.is', url: `https://ipwho.is/${ip}`, parse: (j) => ({ ok: j.success === true, country: j.country, state: j.region, city: j.city }) },
        { name: 'ip-api.com', url: `http://ip-api.com/json/${ip}?fields=status,country,regionName,city`, parse: (j) => ({ ok: j.status === 'success', country: j.country, state: j.regionName, city: j.city }) },
      ];

    for (const svc of services) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const geoRes = await fetch(svc.url, { signal: controller.signal });
        clearTimeout(timer);
        if (geoRes.ok) {
          const geo = await geoRes.json();
          const result = svc.parse(geo);
          if (result.ok) {
            if (result.country) country = result.country;
            if (result.state) state = result.state;
            if (result.city) city = result.city;
            break;
          }
        }
      } catch (e) {
        // Try next service
      }
    }
  }

  return { country, state, city };
}

/**
 * Write the resolved geo onto the session row. Pass an already-resolved `geo`
 * to reuse the login's single lookup. Fire-and-forget: on failure the row just
 * keeps its 'Unknown' placeholders.
 */
async function enrichSessionGeo(sessionId, ip, geo) {
  const { country: rawCountry, state, city } = geo || (await resolveGeo(ip));
  // The admin Sessions view shows a flag beside India; the alert email keeps
  // the plain provider name. Written as escapes so the emoji is not at the
  // mercy of this file's encoding.
  const country = rawCountry === 'India' ? 'India \u{1F1EE}\u{1F1F3}' : rawCountry;

  try {
    const client = supabase.getClient();
    if (client) {
      // The session lives in exactly one of the two tables; updating both is
      // harmless (the non-matching table simply updates zero rows).
      await Promise.all([
        client.from('user_sessions').update({ country, state, city }).eq('session_id', sessionId),
        client.from('admin_sessions').update({ country, state, city }).eq('session_id', sessionId),
      ]);
    }
  } catch (e) { /* enrichment is best-effort */ }
}

/**
 * Record a rejected sign-in attempt in the append-only security audit log.
 *
 * This is what makes the Login History page able to show a "Failed" row at
 * all — a rejected attempt never creates a session, so there is nothing in
 * user_sessions to read. Best-effort: a logging outage must never turn into a
 * login error, so failures here are swallowed.
 */
function logLoginFailure(req, { email, userId = '', detail = '' }) {
  try {
    const { deviceStr, osStr, browserStr } = parseUserAgent(req);
    twoFactor.logSecurityEvent({
      userId,
      email,
      event: 'login_failed',
      outcome: 'failure',
      ip: getClientIP(req),
      device: [browserStr, osStr || deviceStr].filter(Boolean).join(' \u2022 '),
      detail,
    }).catch(() => {});
  } catch (e) { /* audit logging is best-effort */ }
}

/**
 * After a successful sign-in, record the security events that describe how
 * unusual it was. The new-device verdict is decided by
 * services/deviceRecognition.js and passed in, so the audit log, the alert
 * email and the admin/user behaviour can never disagree. The location check
 * compares the geo resolved for this login against the account's earlier
 * sign-ins. Purely informational — the sign-in has already happened — and
 * best-effort: this runs after the login response and swallows its failures.
 */
async function flagUnfamiliarSignIn({ userId, email, ip, device, isNewDevice, geo, previousSessions }) {
  try {
    if (!email) return;

    if (isNewDevice) {
      await twoFactor.logSecurityEvent({
        userId, email, event: twoFactor.EVENTS.NEW_DEVICE, ip, device,
        detail: 'Signed in from a device not used before',
      });
    }

    const place = placeOf(geo || {});
    if (!place) return;

    const previous = Array.isArray(previousSessions) ? previousSessions : [];
    if (!previous.length) return; // first ever sign-in: nothing to compare against
    if (previous.some((r) => placeOf(r).toLowerCase() === place.toLowerCase())) return;

    await twoFactor.logSecurityEvent({
      userId, email, event: twoFactor.EVENTS.NEW_LOCATION, ip, device,
      detail: `Signed in from a new approximate location: ${place}`,
    });
  } catch (e) { /* alerting is best-effort */ }
}

/**
 * Resolve a promise, or give up after `ms` and resolve null.
 *
 * The new-device email has to reach the account within seconds of the sign-in,
 * so the geo lookup gets a short grace period rather than the full provider
 * timeout chain. Location is the one optional field in the alert.
 */
function withDeadline(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), ms);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(finish, () => finish(null));
  });
}

const GEO_WAIT_FOR_EMAIL_MS = 3500;

async function createLoginSession(req, userId, loginMethod, email, userName, res, googleSub, knownUserRow) {
  try {
    const cleanEmail = String(email || '').toLowerCase().trim();
    const verifiedGoogleSub = String(googleSub || '').trim();
    if (!verifiedGoogleSub) throw new Error('Verified Google subject is required.');
    const isAdminLogin = /admin/i.test(String(loginMethod || ''));

    const { deviceStr, osStr, browserStr, raw: userAgentRaw } = parseUserAgent(req);
    const ip = getClientIP(req); // Real client IP only â€” never a sample/hardcoded address

    // One geo lookup per login, shared by the alert email (which prints the
    // Location line) and the session row enrichment below. Never awaited on
    // the login response path.
    const signInAt = new Date().toISOString();
    const geoPromise = resolveGeo(ip).catch(() => null);

    // Is this a device the account has signed in from before? Awaited, because
    // the device token cookie it (re)issues has to be on this response, and
    // because the answer decides whether an email goes out at all. Identical
    // for users and admins — same ledger, same comparison, same secret.
    const deviceCheck = await deviceRecognition.evaluateSignInDevice({
      req,
      res,
      email: cleanEmail,
      userAgent: userAgentRaw,
      device: deviceStr,
      os: osStr,
      browser: browserStr,
    }).catch((e) => {
      console.warn('[Auth] Device recognition failed:', e && e.message ? e.message : e);
      return { isNewDevice: false, evaluated: false, reason: 'device check error', previousSessions: [] };
    });

    // The "New device detected" alert, to the account's own address (user or
    // admin) from the SaveHatke Security mailbox. It fires only when the
    // device is genuinely unrecognised, and only here — after the
    // Google's server-verified OAuth result has already been accepted, so it can never
    // precede a successful authentication or follow a rejected one. A
    // recognised device sends nothing. Opt-out via SIGNIN_ALERT_DISABLED=true.
    if (!deviceCheck.evaluated) {
      console.warn(`[Auth] New-device check inconclusive for ${cleanEmail || 'unknown account'} (${deviceCheck.reason}) — no alert sent.`);
    } else if (!deviceCheck.isNewDevice) {
      console.log(`[Auth] Recognised device for ${cleanEmail} (${deviceCheck.reason}) — no new-device alert.`);
    } else if (process.env.SIGNIN_ALERT_DISABLED === 'true') {
      console.warn(`[Auth] New device for ${cleanEmail} but SIGNIN_ALERT_DISABLED=true — alert suppressed.`);
    } else {
      withDeadline(geoPromise, GEO_WAIT_FOR_EMAIL_MS)
        .then((geo) => emailService.sendSignInAlertEmail({
          to: cleanEmail,
          userName: userName && String(userName).trim() ? String(userName).trim() : '',
          userEmail: cleanEmail,
          signInTime: signInAt,
          ip,
          device: deviceStr,
          browser: browserStr,
          os: osStr,
          city: geo ? geo.city : '',
          state: geo ? geo.state : '',
          country: geo ? geo.country : '',
          loginMethod: loginMethod || (isAdminLogin ? 'Admin' : 'Email'),
          accountType: isAdminLogin ? 'admin' : 'user',
        }))
        .then((r) => {
          if (r && r.success) {
            console.log(`[Auth] New-device alert sent to ${cleanEmail} (IP ${ip}, device ${deviceStr} / ${browserStr} / ${osStr})`);
          } else if (r && r.isSimulated) {
            console.warn(`[Auth] New-device alert NOT sent for ${cleanEmail} -> ${r.error || 'SMTP not configured'}`);
          } else {
            console.warn(`[Auth] New-device alert FAILED for ${cleanEmail}: ${(r && r.error) || 'unknown'}`);
          }
        })
        .catch((e) => console.warn('[Auth] New-device alert unexpected error:', e && e.message ? e.message : e));
    }

    // Cryptographically random session identifier. The raw value goes only in
    // the HttpOnly cookie; only its SHA-256 hash is stored in the database.
    const rawToken = generateSessionToken();

    const { realUserId, userIdSource } = await resolveSessionUserId(userId, cleanEmail, knownUserRow);
    const finalUserId = realUserId || String(userId || '').trim();
    if (!finalUserId) throw new Error('Authenticated account has no stable user id.');

    // Admin sessions are short-lived: automatic logout 2 hours after login.
    // User sessions last 48 hours.
    const ttlMs = isAdminLogin ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS;

    const sessionResult = await supabase.createSession({
      user_id: finalUserId,
      email: cleanEmail,
      device: deviceStr,
      os: osStr,
      browser: browserStr,
      ip_address: ip,
      login_method: loginMethod || 'Email',
      google_sub: verifiedGoogleSub,
      user_agent: userAgentRaw,
      session_token: hashSessionToken(rawToken),
    }, ttlMs);

    if (!sessionResult || !sessionResult.session_token) {
      // No enforceable server-side row means no login. Surface a slug-safe
      // prefix so the failure reason shows up in /login?google=failed&reason=
      // instead of the generic "couldnotcreateenforceablessession" — which
      // gives the user (and us) no way to tell whether the table is missing,
      // a column is wrong, RLS is blocking, or the Supabase client itself
      // is unconfigured. The actual Supabase message stays in the Vercel log.
      throw new Error('Could not create an enforceable session: no row returned from createSession');
    }

    console.log(`âœ… Session created in Supabase: ${sessionResult.session_id} for ${isAdminLogin ? 'ADMIN' : 'user'} ${finalUserId}${cleanEmail ? ' (' + cleanEmail + ')' : ''} | user_id source: ${userIdSource} | ip: ${ip} | expires: ${sessionResult.expires_at} (${isAdminLogin ? '2h' : '48h'})`);

    // Geo-IP enrichment in the background â€” never blocks the login response
    geoPromise
      .then((geo) => enrichSessionGeo(sessionResult.session_id, ip, geo).then(() => geo))
      .then((geo) => flagUnfamiliarSignIn({
        userId: finalUserId,
        email: cleanEmail,
        ip,
        device: [browserStr, osStr || deviceStr].filter(Boolean).join(' \u2022 '),
        isNewDevice: deviceCheck.evaluated && deviceCheck.isNewDevice,
        geo,
        previousSessions: deviceCheck.previousSessions,
      }))
      .catch(() => {});

    return {
      token: rawToken,
      sessionId: sessionResult.session_id,
      userId: finalUserId,
      expiresAt: sessionResult.expires_at,
      ttlMs,
    };
  } catch (err) {
    // Re-throw with the underlying Supabase message so the failure slug
    // surfaces a real reason in /login?google=failed&reason=server_<slug>.
    // The slug-cleaning regex strips punctuation, so any colons/parentheses
    // get normalised but the diagnostic tokens (table missing / RLS denied /
    // schema mismatch) are preserved.
    console.warn('[auth] Session creation failed:', (err && err.message) || err);
    const upstream = String((err && err.message) || 'Could not create an enforceable session.')
      .replace(/^Could not create an enforceable session:?\s*/, '');
    throw new Error(`Could not create an enforceable session: ${upstream || 'no upstream detail'}`);
  }
}

// ─── Login ────────────────────────────────────────────────────────────
// Sign-in is Google OAuth only. Email input is retained by the existing page
// for compatibility, but the email-only API endpoints are disabled.

// GET /api/auth/google-config
router.get('/google-config', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || '930893529973-2j5h36csl909m139urdq552n63h1hl1q.apps.googleusercontent.com';
  res.json({
    clientId,
    configured: !!(clientId && !clientId.includes('your_google_client_id')),
  });
});

// Logout is always scoped to the authenticated request's current session.
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const rawSessionToken = String(req.authSessionToken || '');
    if (!rawSessionToken || !req.sessionId || !req.user || !req.user.id) {
      return res.status(401).json({ error: 'An active session is required.' });
    }
    const now = new Date().toISOString();
    const revoked = await supabase.endSessionByToken(hashSessionToken(rawSessionToken), 'Logged out');
    if (!revoked) {
      return res.status(503).json({ error: 'Could not revoke this session. Please try again.' });
    }
    clearSessionCookie(res);
    db.updateRow(db.SHEETS.USERS, 'email', normalizeEmail(req.user.email), {
        last_logout_at: now,
        updated_at: now,
      }).catch(() => {});
    res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    console.warn('Logout session revocation failed.');
    res.status(503).json({ error: 'Could not revoke this session. Please try again.' });
  }
});

// JWT bearer refresh is retired with localStorage token storage. Sessions are
// authenticated exclusively through the revocable HttpOnly cookie.
router.post('/refresh', (req, res) => {
  res.status(410).json({ error: 'Bearer-token sessions are no longer supported.' });
});

// â”€â”€ Device / session management (user-facing) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Session rows carry a flag emoji beside the country for the admin view. Some
// older rows hold it mis-decoded (the UTF-8 bytes read back as Latin-1 or
// CP1252), so strip the real emoji and both mangled forms — the user-facing
// location line is plain text either way.
const stripFlag = (v) => String(v || '')
  .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
  .replace(/\u00f0[\u009f\u0178][\u0087\u2021][\u0080-\u00bf]/g, '')
  .trim();

// "City, State, Country" from whatever the IP lookup managed to resolve.
// Always approximate: it describes the network, not the person.
const placeOf = (r) => [r.city, r.state, stripFlag(r.country)]
  .map((p) => String(p || '').trim())
  .filter((p) => p && !/^unknown$/i.test(p))
  .filter((p, i, arr) => arr.indexOf(p) === i)
  .join(', ');

// GET /api/auth/sessions â€” List the current user's sessions (device page).
// Never exposes raw session tokens â€” only metadata plus an is_current flag.
router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const rows = await supabase.getUserSessions(req.user.id);

    // req.sessionId was set by the middleware from the validated session â€”
    // use it to flag which row is the device making this request.
    const sessions = rows.map((r) => ({
      session_id: r.session_id,
      device: r.device || 'Unknown device',
      os: r.os || '',
      browser: r.browser || '',
      ip_address: r.ip_address || '',
      // Approximate, derived from the sign-in IP at the time of login.
      location: placeOf(r),
      login_method: r.login_method || '',
      login_time: r.login_time,
      last_active: r.last_active,
      expires_at: r.expires_at,
      status: r.status,
      is_current: Boolean(req.sessionId) && r.session_id === req.sessionId,
    }));

    res.json({ sessions, current_session_id: req.sessionId || null });
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Could not load sessions.' });
  }
});

// POST /api/auth/sessions/revoke â€” "Log out this device".
// The session id must belong to the authenticated user â€” one user can never
// revoke another user's session.
router.post('/sessions/revoke', authenticateToken, async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) {
      return res.status(400).json({ error: 'session_id is required.' });
    }

    const row = await supabase.findSessionById(session_id);
    if (!row) {
      return res.status(404).json({ error: 'Session not found.' });
    }
    if (String(row.user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'You can only manage your own sessions.' });
    }

    await supabase.endSession(session_id, 'Logged out');

    // Revoking the session this request came from? Clear the cookie too.
    if (req.sessionId === session_id) clearSessionCookie(res);

    res.json({ message: 'Device logged out.' });
  } catch (err) {
    console.error('Revoke session error:', err);
    res.status(500).json({ error: 'Could not log out this device.' });
  }
});

// POST /api/auth/sessions/revoke-all â€” "Log out all devices".
// Revokes every Active session for the authenticated user (including the
// current one). The account/profile is untouched.
router.post('/sessions/revoke-all', authenticateToken, async (req, res) => {
  try {
    await supabase.endAllUserSessions(req.user.id);
    clearSessionCookie(res);
    res.json({ message: 'All devices have been logged out.' });
  } catch (err) {
    console.error('Revoke all sessions error:', err);
    res.status(500).json({ error: 'Could not log out all devices.' });
  }
});

// POST /api/auth/sessions/revoke-others - "Log out of all other devices".
// Every other Active session for this user is revoked; the session this
// request came from stays Active, so the current device is NOT signed out.
router.post('/sessions/revoke-others', authenticateToken, async (req, res) => {
  try {
    // Without a known current session id we cannot promise "your current
    // session will remain active" - refuse rather than silently sign the user
    // out of the device they are using.
    if (!req.sessionId) {
      return res.status(409).json({
        error: 'This device\u2019s session could not be identified. Please sign in again and retry.',
      });
    }

    await supabase.endAllUserSessions(req.user.id, { exceptSessionId: req.sessionId });
    res.json({ message: 'All other devices have been logged out.' });
  } catch (err) {
    console.error('Revoke other sessions error:', err);
    res.status(500).json({ error: 'Could not log out the other devices.' });
  }
});

// GET /api/auth/login-history â€” Read-only sign-in log for the security page.
//
// Two sources, merged newest-first:
//   â€¢ user_sessions        â†’ every successful sign-in (a session only exists
//                            because the login succeeded), including ones that
//                            have since expired or been logged out.
//   â€¢ SecurityAudit rows   â†’ rejected attempts (blocked email path, failed 2FA
//                            code), which never produce a session row.
//
// Never exposes session tokens. It does return the sign-in IP: the account
// owner needs it to recognise their own activity, and the route is behind
// authenticateToken so only that owner can read it.
// If the audit log is unreachable the successful history is still returned,
// with failures_available:false so the UI can say so honestly.
router.get('/login-history', authenticateToken, async (req, res) => {
  // The Security page shows the 10 most recent records, so that is the default
  // here too: every entry carries an IP address and an approximate location,
  // and there is no reason to put more of that on the wire than the caller
  // actually displays. An explicit ?limit= is honoured up to MAX_LIMIT.
  const MAX_LIMIT = 50;
  const DEFAULT_LIMIT = 10;
  const asked = Number.parseInt(String(req.query.limit || ''), 10);
  const LIMIT = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_LIMIT) : DEFAULT_LIMIT;

  try {
    // Admin logins are recorded in admin_sessions, and a hardcoded admin login
    // mints a fresh user_id every time, so the id-keyed read finds nothing for
    // those accounts. Falling back to the email-keyed history across both
    // tables makes this endpoint report every successful sign-in for users and
    // admins alike.
    let rows = await supabase.getUserSessions(req.user.id);
    if (!rows.length && req.user.email) {
      rows = (await supabase.getAccountSessionHistory(req.user.email, MAX_LIMIT)) || [];
    }

    const entries = rows.map((r) => ({
      at: r.login_time,
      browser: r.browser || '',
      os: r.os || '',
      device: r.device || '',
      location: placeOf(r),
      ip: r.ip_address || '',
      method: r.login_method || '',
      status: 'Successful',
      detail: '',
      is_current: Boolean(req.sessionId) && r.session_id === req.sessionId,
      session_status: r.status || '',
    }));

    // Failed attempts are keyed by email in the audit log â€” a rejected login
    // may not have resolved a user id at all.
    let failuresAvailable = true;
    try {
      const audit = await db.findRows(db.SHEETS.SECURITY_AUDIT, 'email', String(req.user.email || '').toLowerCase().trim());
      audit
        .filter((r) => String(r.outcome || '').toLowerCase() === 'failure'
          && /login_failed$/.test(String(r.event || '')))
        .forEach((r) => {
          const [browser = '', os = ''] = String(r.device || '').split('\u2022').map((s) => s.trim());
          entries.push({
            at: r.createdAt,
            browser,
            os,
            device: r.device || '',
            location: '',
            ip: r.ipAddress || '',
            method: String(r.event) === '2fa_login_failed' ? 'Two-factor code' : 'Email',
            status: 'Failed',
            detail: r.detail || '',
            is_current: false,
            session_status: '',
          });
        });
    } catch (e) {
      failuresAvailable = false;
    }

    entries.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

    res.json({ entries: entries.slice(0, LIMIT), failures_available: failuresAvailable });
  } catch (err) {
    console.error('Login history error:', err);
    res.status(500).json({ error: 'Could not load your login history.' });
  }
});

// GET /api/auth/security-events â€” Recent security activity for the Security
// page's "Security Alerts" card.
//
// Read-only projection of the append-only SecurityAudit log, scoped to the
// authenticated account's own email. Only the events a user can act on are
// surfaced (new device / new location sign-ins, 2FA changes, recovery-code
// regeneration, rejected sign-ins) â€” internal setup steps are noise. Never
// exposes secrets, codes or hashes: the sheet does not store them.
const ALERT_EVENTS = {
  new_device_signin: { title: 'New device sign-in', tone: 'warn' },
  new_location_signin: { title: 'New location sign-in', tone: 'warn' },
  '2fa_enabled': { title: 'Two-factor authentication enabled', tone: 'good' },
  '2fa_disabled': { title: 'Two-factor authentication disabled', tone: 'warn' },
  '2fa_recovery_codes_regenerated': { title: 'Recovery codes regenerated', tone: 'good' },
  '2fa_recovery_code_used': { title: 'Recovery code used to sign in', tone: 'warn' },
  '2fa_authenticator_changed': { title: 'Authenticator app replaced', tone: 'good' },
  login_failed: { title: 'Failed sign-in attempt', tone: 'bad' },
  '2fa_login_failed': { title: 'Failed two-factor code', tone: 'bad' },
};

router.get('/security-events', authenticateToken, async (req, res) => {
  const LIMIT = 8;
  try {
    const email = String(req.user.email || '').toLowerCase().trim();
    if (!email) return res.json({ events: [] });

    const rows = await db.findRows(db.SHEETS.SECURITY_AUDIT, 'email', email);
    const events = rows
      .filter((r) => ALERT_EVENTS[String(r.event || '')])
      .map((r) => {
        const meta = ALERT_EVENTS[String(r.event)];
        return {
          at: r.createdAt,
          event: String(r.event),
          title: meta.title,
          tone: meta.tone,
          device: r.device || '',
          detail: r.detail || '',
          outcome: String(r.outcome || ''),
        };
      })
      .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
      .slice(0, LIMIT);

    res.json({ events });
  } catch (err) {
    console.error('Security events error:', err);
    res.status(500).json({ error: 'Could not load your recent security activity.' });
  }
});

// GET|POST /api/auth/session-cleanup — cleanup sweep endpoint for external/
// Vercel cron. One pass flips past-expiry sessions to 'Expired', deletes
// ended sessions past the 90-day retention window, and sweeps expired SOS
// recovery sessions in MongoDB. Idempotent — safe to run repeatedly.
//
// Authentication, in order:
//   1. SESSION_CLEANUP_SECRET in the `x-cleanup-secret` header — the dedicated
//      key for this endpoint (never accept secrets in URLs);
//   2. CRON_SECRET as `Authorization: Bearer <secret>` (what Vercel Cron
//      sends automatically) or `x-cron-key` — the same contract as the monthly
//      report run;
//   3. otherwise a logged-in admin, validated through the full session
//      middleware chain (server-side session row, not just a decoded JWT).
//
// The response never includes tokens, emails or row contents — only counts.
router.all('/session-cleanup', async (req, res, next) => {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const dedicatedSecret = process.env.SESSION_CLEANUP_SECRET;
  if (dedicatedSecret) {
    const provided = req.headers['x-cleanup-secret'];
    const a = Buffer.from(String(provided || ''));
    const b = Buffer.from(String(dedicatedSecret));
    if (provided) {
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'Unauthorized.' });
      }
      return handleSessionCleanupRun(req, res);
    }
  }

  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  if (cronSecret) {
    const bearer = String(req.get('authorization') || '').trim();
    const presented = bearer.toLowerCase().startsWith('bearer ')
      ? bearer.slice(7).trim()
      : String(req.get('x-cron-key') || '').trim();
    if (presented) {
      const a = Buffer.from(presented);
      const b = Buffer.from(cronSecret);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return handleSessionCleanupRun(req, res);
      }
      return res.status(401).json({ error: 'Unauthorized.' });
    }
  }

  // No secret configured (or none presented) — require an admin session.
  return authenticateToken(req, res, () => requireAdmin(req, res, () => handleSessionCleanupRun(req, res)));
});

async function handleSessionCleanupRun(req, res) {
  try {
    const result = await sessionCleanup.runSessionCleanup();
    res.json({
      message: 'Session cleanup complete.',
      expired: result.expired,
      purged: result.purged,
      sosPurged: result.sosPurged,
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    // Counts only — never log token hashes or credentials on failure.
    console.error('Session cleanup endpoint error:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Session cleanup failed.' });
  }
}

// GET /api/auth/me
router.get('/me', authenticateToken, async (req, res) => {
  try {
    // Read account status live so a suspension takes effect without waiting
    // for the fixed server-side session expiry.
    let status = 'active';
    let suspendReason = '';
    try {
      let row = null;
      if (req.user.id) {
        row = await db.findRow(db.SHEETS.USERS, 'user_id', req.user.id)
          || await db.findRow(db.SHEETS.USERS, 'id', req.user.id);
      }
      if (!row && req.user.email) {
        row = await db.findRow(db.SHEETS.USERS, 'email', String(req.user.email).toLowerCase().trim());
      }
      let preferredName = '';
      let displayName = req.user.name;
      if (row) {
        status = String(row.status || 'active').toLowerCase();
        if (status !== 'active') suspendReason = String(row.suspend_reason || '');
        if (row.preferred_name && String(row.preferred_name).trim()) {
          preferredName = String(row.preferred_name).trim();
          displayName = preferredName;
        } else if (row.name) {
          displayName = String(row.name).trim();
        }
      }
    } catch (e) {
      // Sheet unreachable — fall back to 'active' rather than locking the user
      // out of their own dashboard on a transient read failure.
      console.warn('[auth/me] account status lookup failed:', e.message);
    }

    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        name: displayName,
        preferred_name: preferredName,
        role: req.user.role,
        status,
        ...(suspendReason ? { suspendReason } : {}),
      },
    });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Notification preferences ───────────────────────────────────────────────
// Every category the user can actually switch, with its default. Account and
// security notices are deliberately not in this map: they are mandatory, so
// there is nothing to store and nothing to switch off. Marketing is the only
// category that starts off.
const NOTIFICATION_DEFAULTS = Object.freeze({
  coupon_activity: true,
  purchases: true,
  sales: true,
  payments: true,
  reviews: true,
  support: true,
  marketing: false,
});

// Reads the stored JSON blob and fills every known key, so a preference added
// after the row was written still comes back with its default instead of
// undefined. A corrupt cell degrades to the defaults rather than a 500.
function parseNotificationPrefs(raw) {
  let stored = {};
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') stored = parsed;
    } catch (e) {
      console.warn('[notification-preferences] unparseable value, using defaults');
    }
  } else if (raw && typeof raw === 'object') {
    stored = raw;
  }

  const out = {};
  for (const [key, dflt] of Object.entries(NOTIFICATION_DEFAULTS)) {
    out[key] = typeof stored[key] === 'boolean' ? stored[key] : dflt;
  }
  return out;
}

// The Users sheet is keyed on user_ID, but older rows were written before the
// id existed, so email is the fallback lookup — same order as /me.
async function findUserRowForRequest(user) {
  if (!user) return null;
  const uid = user.id || user.user_id || user.user_ID;
  if (uid) {
    const byId = await db.findRow(db.SHEETS.USERS, 'user_id', uid)
      || await db.findRow(db.SHEETS.USERS, 'user_ID', uid)
      || await db.findRow(db.SHEETS.USERS, 'id', uid);
    if (byId) return byId;
  }
  if (user.email) {
    return db.findRow(db.SHEETS.USERS, 'email', String(user.email).toLowerCase().trim());
  }
  return null;
}

router.get('/notification-preferences', authenticateToken, async (req, res) => {
  try {
    const row = await findUserRowForRequest(req.user);
    if (!row) return res.status(404).json({ error: 'Account not found.' });

    res.json({
      preferences: parseNotificationPrefs(row.notification_prefs),
      defaults: { ...NOTIFICATION_DEFAULTS },
    });
  } catch (err) {
    console.error('[notification-preferences] read failed:', err.message);
    res.status(500).json({ error: 'Unable to load notification settings.' });
  }
});

router.put('/notification-preferences', authenticateToken, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const incoming = body.preferences && typeof body.preferences === 'object' ? body.preferences : body;

    const unknown = Object.keys(incoming).filter((k) => !(k in NOTIFICATION_DEFAULTS));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown notification setting: ${unknown.join(', ')}` });
    }

    const row = await findUserRowForRequest(req.user);
    if (!row) return res.status(404).json({ error: 'Account not found.' });

    // Merge onto what is already stored so a single-toggle PATCH-style save
    // never silently resets the other categories.
    const merged = parseNotificationPrefs(row.notification_prefs);
    for (const [key, value] of Object.entries(incoming)) {
      if (typeof value === 'boolean') merged[key] = value;
    }

    const idField = row.user_ID !== undefined ? 'user_ID' : (row.user_id !== undefined ? 'user_id' : 'email');
    const idValue = idField === 'email' ? String(row.email || '').toLowerCase().trim() : row[idField];

    await db.updateRow(db.SHEETS.USERS, idField, idValue, {
      notification_prefs: JSON.stringify(merged),
      updated_at: new Date().toISOString(),
    });

    res.json({ preferences: merged });
  } catch (err) {
    console.error('[notification-preferences] save failed:', err.message);
    res.status(500).json({ error: 'Unable to save notification settings.' });
  }
});

// â”€â”€ One-time onboarding flags â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Small booleans that record which product tours the account has already
// seen, so a tutorial auto-opens exactly once per user rather than once per
// browser. Stored as a JSON blob in Users.onboarding_state alongside the
// notification blob above, and read with the same defaults-on-missing rule.
// Signed-out visitors have nowhere to persist this, so the client falls back
// to local storage for them.
const ONBOARDING_DEFAULTS = Object.freeze({
  marketplaceTutorialCompleted: false,
  marketplaceTutorialSkipped: false,
  nameSetupCompleted: false,
});

function parseOnboardingState(raw) {
  let stored = {};
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') stored = parsed;
    } catch (e) {
      console.warn('[onboarding] unparseable value, using defaults');
    }
  } else if (raw && typeof raw === 'object') {
    stored = raw;
  }

  const out = {};
  for (const [key, dflt] of Object.entries(ONBOARDING_DEFAULTS)) {
    out[key] = typeof stored[key] === 'boolean' ? stored[key] : dflt;
  }
  return out;
}

router.get('/onboarding', authenticateToken, async (req, res) => {
  try {
    const row = await findUserRowForRequest(req.user);
    if (!row) return res.status(404).json({ error: 'Account not found.' });

    res.json({
      onboarding: parseOnboardingState(row.onboarding_state),
      defaults: { ...ONBOARDING_DEFAULTS },
    });
  } catch (err) {
    console.error('[onboarding] read failed:', err.message);
    res.status(500).json({ error: 'Unable to load your onboarding state.' });
  }
});

router.put('/onboarding', authenticateToken, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const incoming = body.onboarding && typeof body.onboarding === 'object' ? body.onboarding : body;

    const unknown = Object.keys(incoming).filter((k) => !(k in ONBOARDING_DEFAULTS));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown onboarding flag: ${unknown.join(', ')}` });
    }
    const nonBoolean = Object.entries(incoming).filter(([, v]) => typeof v !== 'boolean');
    if (nonBoolean.length) {
      return res.status(400).json({ error: 'Onboarding flags must be true or false.' });
    }

    const row = await findUserRowForRequest(req.user);
    if (!row) return res.status(404).json({ error: 'Account not found.' });

    // Merge, so marking one tour seen never clears another.
    const merged = { ...parseOnboardingState(row.onboarding_state), ...incoming };

    const idField = row.user_ID !== undefined ? 'user_ID' : (row.user_id !== undefined ? 'user_id' : 'email');
    const idValue = idField === 'email' ? String(row.email || '').toLowerCase().trim() : row[idField];

    await db.updateRow(db.SHEETS.USERS, idField, idValue, {
      onboarding_state: JSON.stringify(merged),
      updated_at: new Date().toISOString(),
    });

    res.json({ onboarding: merged });
  } catch (err) {
    console.error('[onboarding] save failed:', err.message);
    res.status(500).json({ error: 'Unable to save your onboarding state.' });
  }
});

// ── First-login onboarding: Save preferred display name ────────────────────
async function handleUpdatePreferredName(req, res) {
  try {
    const rawName = req.body.preferred_name !== undefined
      ? req.body.preferred_name
      : (req.body.name !== undefined ? req.body.name : '');

    // Trim leading/trailing spaces automatically
    const trimmedName = String(rawName || '').trim();

    // Validation 1: Name cannot be empty
    if (!trimmedName) {
      return res.status(400).json({ error: 'Name cannot be empty.' });
    }

    // Validation 2: Prevent excessively long names
    if (trimmedName.length > 50) {
      return res.status(400).json({ error: 'Name is too long. Please keep it under 50 characters.' });
    }

    // Find user record in Google Sheets
    let row = await findUserRowForRequest(req.user);
    if (!row && req.user && req.user.email) {
      const allRows = await db.getRows(db.SHEETS.USERS).catch(() => []);
      row = (allRows || []).find((r) => {
        const v = (r && r.email) ? String(r.email).toLowerCase().trim() : '';
        return v && v === String(req.user.email).toLowerCase().trim();
      }) || null;
      if (!row) {
        const now = new Date().toISOString();
        const userId = req.user.id || req.user.user_id || uuidv4();
        row = {
          user_ID: userId,
          user_id: userId,
          id: userId,
          name: trimmedName,
          preferred_name: trimmedName,
          username: (req.user.email || '').split('@')[0],
          email: req.user.email,
          status: 'active',
          created_at: now,
          updated_at: now,
          last_login_at: now,
        };
        await db.appendRow(db.SHEETS.USERS, row).catch((e) => console.warn('GSheet fallback append notice:', e.message));
      }
    }
    if (!row) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    const idField = row.user_ID !== undefined ? 'user_ID' : (row.user_id !== undefined ? 'user_id' : 'email');
    const idValue = idField === 'email' ? String(row.email || '').toLowerCase().trim() : row[idField];

    // Mark onboarding state completed for name setup
    const onboarding = parseOnboardingState(row.onboarding_state);
    onboarding.nameSetupCompleted = true;

    const now = new Date().toISOString();

    // Save preferred name & update name in Google Sheets
    await db.updateRow(db.SHEETS.USERS, idField, idValue, {
      name: trimmedName,
      preferred_name: trimmedName,
      onboarding_state: JSON.stringify(onboarding),
      updated_at: now,
    });

    // Sync preferred name to Supabase if configured
    if (supabase.isConfigured() && req.user.id) {
      try {
        await supabase.updateUser(req.user.id, {
          name: trimmedName,
        });
      } catch (spErr) {
        console.warn('Supabase name update notice:', spErr.message);
      }
    }

    // Return updated user profile
    const updatedUser = {
      id: req.user.id || (row ? (row.user_ID || row.user_id || row.id) : ''),
      user_id: req.user.id || (row ? (row.user_ID || row.user_id || row.id) : ''),
      email: req.user.email || (row ? row.email : ''),
      name: trimmedName,
      preferred_name: trimmedName,
      needs_name_setup: false,
      role: req.user.role || 'user',
      ...(row && row.profile_picture ? { picture: row.profile_picture } : {}),
      ...(row && row.username ? { username: row.username } : {}),
    };

    res.json({
      success: true,
      message: 'Preferred name saved successfully!',
      user: updatedUser,
      redirectTo: '/dashboard.html',
    });
  } catch (err) {
    console.error('Preferred name update failed:', err);
    res.status(500).json({ error: 'Failed to save preferred name. Please try again.' });
  }
}

router.put('/preferred-name', authenticateToken, handleUpdatePreferredName);
router.post('/preferred-name', authenticateToken, handleUpdatePreferredName);
router.put('/profile', authenticateToken, handleUpdatePreferredName);

module.exports = router;

// These helpers are also referenced by unmounted legacy recovery routes. The
// session creator requires a verified Google subject, so those routes cannot
// mint an alternate authentication session if accidentally mounted.
module.exports.createLoginSession = createLoginSession;
module.exports.issueLoginToken = () => { throw new Error('Bearer session tokens are retired.'); };
module.exports.setSessionCookie = setSessionCookie;


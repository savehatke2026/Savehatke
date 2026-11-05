// SaveHatke admin passkey authentication.
// All credential/challenge reads and writes use the backend Supabase service
// client. The browser never receives a public key, challenge-store access, or
// AWS credential. Login is allowed only for the current Supabase admin roster.

'use strict';

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { authenticateToken, requireAdmin, hashSessionToken } = require('../middleware/auth');
const supabase = require('../services/supabase');
const {
  ensureAdminRosterReady,
  getAdminAccount,
  isAdminRosterStale,
  normalizeEmail,
  getPublicOrigin,
} = require('../config/security');
const { createBiometricAdminSession } = require('./auth');

const router = express.Router();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many passkey attempts. Please wait before trying again.' },
});

function getStore() {
  const client = supabase.getClient();
  if (!client) throw new Error('Biometric authentication storage is unavailable.');
  return client;
}

function getRpConfig(req) {
  const configuredOrigin = String(process.env.WEBAUTHN_ORIGIN || '').trim();
  const origin = configuredOrigin || getPublicOrigin(req);
  const parsed = new URL(origin);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('WEBAUTHN_ORIGIN must be a site origin without a path.');
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('Passkeys require an HTTPS origin in production.');
  }
  const rpID = String(process.env.WEBAUTHN_RP_ID || parsed.hostname).trim().toLowerCase();
  if (!rpID || parsed.hostname !== rpID && !parsed.hostname.endsWith('.' + rpID)) {
    throw new Error('WEBAUTHN_RP_ID does not match the configured origin.');
  }
  return { rpName: 'SaveHatke Admin', rpID, origin: parsed.origin };
}

async function requireCurrentAdmin(email) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) throw new Error('Administrator account not found.');
  await ensureAdminRosterReady();
  const account = getAdminAccount(cleanEmail);
  if (!account || account.active !== true || isAdminRosterStale()) {
    throw new Error('Administrator access is temporarily unavailable.');
  }
  return { email: cleanEmail, account };
}

async function requireFreshAdminSession(req) {
  // Enrollment and credential revocation are account-security changes. Require
  // a recent authenticated admin session (10 minutes), not merely a still
  // valid two-hour cookie that could have been left unattended.
  const rawToken = String(req.authSessionToken || '');
  if (!rawToken) throw new Error('Sign in again before changing passkeys.');
  const session = await supabase.findSessionByToken(hashSessionToken(rawToken));
  if (!session || session.unavailable || session.status !== 'Active' ||
      normalizeEmail(session.email) !== normalizeEmail(req.user && req.user.email) ||
      !/^(?:google\\s+)?admin(?:\\s|$)/i.test(String(session.login_method || ''))) {
    throw new Error('A recent administrator sign-in is required.');
  }
  const loginAt = Date.parse(session.login_time || '');
  const age = Date.now() - loginAt;
  if (!Number.isFinite(loginAt) || age < -60000 || age > 10 * 60 * 1000) {
    throw new Error('For security, sign in again before changing passkeys.');
  }
}

async function createChallenge(email, purpose, challenge) {
  const client = getStore();
  // Bound table growth on serverless deployments. Challenges are short-lived;
  // expired records are removed opportunistically on each new challenge.
  await client.from('admin_auth_challenges')
    .delete()
    .lt('expires_at', new Date().toISOString());

  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString();
  const { error } = await client.from('admin_auth_challenges').insert({
    id,
    admin_email: email,
    purpose,
    challenge,
    created_at: now.toISOString(),
    expires_at: expiresAt,
  });
  if (error) throw new Error('Could not start passkey verification.');
  return id;
}

async function consumeChallenge(id, email, purpose) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const client = getStore();
  const now = new Date().toISOString();
  // Single conditional UPDATE makes a challenge one-time across concurrent
  // Vercel instances; only one request can claim used_at IS NULL.
  const { data, error } = await client.from('admin_auth_challenges')
    .update({ used_at: now })
    .eq('id', id)
    .eq('admin_email', email)
    .eq('purpose', purpose)
    .is('used_at', null)
    .gt('expires_at', now)
    .select('challenge')
    .maybeSingle();
  if (error || !data || !data.challenge) return null;
  return data.challenge;
}

async function listActiveCredentials(email) {
  const { data, error } = await getStore().from('admin_passkey_credentials')
    .select('id, credential_id, public_key, sign_count, transports, device_type, backed_up, label, created_at, last_used_at')
    .eq('admin_email', email)
    .is('revoked_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error('Could not load registered passkeys.');
  return data || [];
}

async function audit(email, event, outcome, requestId, details = {}) {
  try {
    await getStore().from('admin_biometric_audit').insert({
      admin_email: email,
      method: 'passkey',
      event,
      outcome,
      request_id: String(requestId || '').slice(0, 100) || null,
      details,
    });
  } catch (_) {
    // Audit storage must not leak sensitive response details or mask auth.
  }
}

function safeCredential(row) {
  return {
    id: row.id,
    label: row.label || 'This device',
    deviceType: row.device_type || 'unknown',
    backedUp: Boolean(row.backed_up),
    transports: Array.isArray(row.transports) ? row.transports : [],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
  };
}

// Authenticated admin: show registered devices; credential public keys and IDs
// are not included in the response.
router.get('/passkeys', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const email = normalizeEmail(req.user.email);
    const rows = await listActiveCredentials(email);
    return res.json({ passkeys: rows.map(safeCredential) });
  } catch (error) {
    return res.status(503).json({ error: error.message || 'Passkeys are unavailable.' });
  }
});

// Authenticated admin: create a registration challenge.
router.post('/passkey/register-options', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await requireFreshAdminSession(req);
    const { email, account } = await requireCurrentAdmin(req.user.email);
    const { rpName, rpID } = getRpConfig(req);
    const existing = await listActiveCredentials(email);
    const webauthnUserID = crypto.createHash('sha256')
      .update('savehatke-admin-webauthn:' + email)
      .digest();
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: webauthnUserID,
      userName: email,
      userDisplayName: String(account.name || email).slice(0, 64),
      attestationType: 'none',
      excludeCredentials: existing.map((row) => ({
        id: row.credential_id,
        transports: row.transports || [],
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      supportedAlgorithmIDs: [-7, -257],
      timeout: 60000,
    });
    const challengeId = await createChallenge(email, 'passkey_registration', options.challenge);
    return res.json({ options, challengeId });
  } catch (error) {
    return res.status(503).json({ error: error.message || 'Could not start passkey registration.' });
  }
});

// Authenticated admin: cryptographically verify and store a new passkey.
router.post('/passkey/register-verify', authenticateToken, requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.user.email);
  try {
    await requireFreshAdminSession(req);
    await requireCurrentAdmin(email);
    const challengeId = String(req.body && req.body.challengeId || '');
    const response = req.body && req.body.response;
    const label = String(req.body && req.body.label || 'This device').trim().slice(0, 60) || 'This device';
    if (!response || typeof response !== 'object') {
      return res.status(400).json({ error: 'Passkey response is missing.' });
    }
    const expectedChallenge = await consumeChallenge(challengeId, email, 'passkey_registration');
    if (!expectedChallenge) {
      await audit(email, 'registration', 'failure', req.requestId, { reason: 'invalid_challenge' });
      return res.status(400).json({ error: 'Registration expired. Please try again.' });
    }

    const { rpID, origin } = getRpConfig(req);
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      await audit(email, 'registration', 'failure', req.requestId, { reason: 'verification_failed' });
      return res.status(400).json({ error: 'Passkey registration could not be verified.' });
    }

    const info = verification.registrationInfo;
    const credential = info.credential;
    if (!credential || !credential.id || !credential.publicKey) {
      return res.status(400).json({ error: 'Passkey registration response was incomplete.' });
    }

    const { error } = await getStore().from('admin_passkey_credentials').insert({
      admin_email: email,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey).toString('base64url'),
      sign_count: Number(credential.counter || 0),
      transports: Array.isArray(credential.transports) ? credential.transports : [],
      device_type: info.credentialDeviceType || 'unknown',
      backed_up: Boolean(info.credentialBackedUp),
      label,
    });
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'This passkey is already registered.' });
      }
      throw new Error('Could not save the registered passkey.');
    }

    await audit(email, 'registration', 'enrolled', req.requestId, {
      deviceType: info.credentialDeviceType || 'unknown',
      backedUp: Boolean(info.credentialBackedUp),
    });
    const rows = await listActiveCredentials(email);
    return res.json({ verified: true, passkeys: rows.map(safeCredential) });
  } catch (error) {
    await audit(email, 'registration', 'failure', req.requestId, { reason: 'verification_error' });
    return res.status(400).json({ error: error.message || 'Passkey registration failed.' });
  }
});

// Public login bootstrap: the submitted email is only an account selector.
// The admin allowlist and registered credential list are rechecked server-side.
router.post('/passkey/login-options', loginLimiter, async (req, res) => {
  let email = '';
  try {
    email = normalizeEmail(req.body && req.body.email);
    await requireCurrentAdmin(email);
    const credentials = await listActiveCredentials(email);
    if (!credentials.length) {
      return res.status(404).json({ error: 'No passkey is registered for this administrator.' });
    }
    const { rpID } = getRpConfig(req);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: credentials.map((row) => ({
        id: row.credential_id,
        transports: row.transports || [],
      })),
      userVerification: 'required',
      timeout: 60000,
    });
    const challengeId = await createChallenge(email, 'passkey_login', options.challenge);
    return res.json({ options, challengeId });
  } catch (error) {
    return res.status(503).json({ error: 'Passkey sign-in is unavailable. Check the admin email and try again.' });
  }
});

// Public login verification: no session is created until the assertion,
// one-time challenge, current allowlist membership and credential all verify.
router.post('/passkey/login-verify', loginLimiter, async (req, res) => {
  let email = '';
  try {
    email = normalizeEmail(req.body && req.body.email);
    await requireCurrentAdmin(email);
    const challengeId = String(req.body && req.body.challengeId || '');
    const response = req.body && req.body.response;
    if (!response || typeof response !== 'object' || !response.id) {
      return res.status(400).json({ error: 'Passkey response is missing.' });
    }

    const expectedChallenge = await consumeChallenge(challengeId, email, 'passkey_login');
    if (!expectedChallenge) {
      await audit(email, 'login', 'failure', req.requestId, { reason: 'invalid_challenge' });
      return res.status(401).json({ error: 'Passkey request expired. Please try again.' });
    }

    const { data: credential, error } = await getStore().from('admin_passkey_credentials')
      .select('id, credential_id, public_key, sign_count, transports')
      .eq('admin_email', email)
      .eq('credential_id', String(response.id))
      .is('revoked_at', null)
      .maybeSingle();
    if (error || !credential) {
      await audit(email, 'login', 'failure', req.requestId, { reason: 'credential_not_found' });
      return res.status(401).json({ error: 'Passkey could not be verified.' });
    }

    const { rpID, origin } = getRpConfig(req);
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credential.credential_id,
        publicKey: Buffer.from(credential.public_key, 'base64url'),
        counter: Number(credential.sign_count || 0),
        transports: credential.transports || [],
      },
      requireUserVerification: true,
    });
    if (!verification.verified) {
      await audit(email, 'login', 'failure', req.requestId, { reason: 'assertion_invalid' });
      return res.status(401).json({ error: 'Passkey could not be verified.' });
    }

    const { error: updateError } = await getStore().from('admin_passkey_credentials')
      .update({
        sign_count: Number(verification.authenticationInfo.newCounter || 0),
        last_used_at: new Date().toISOString(),
      })
      .eq('id', credential.id)
      .eq('admin_email', email)
      .is('revoked_at', null);
    if (updateError) throw new Error('Could not update passkey usage.');

    const user = await createBiometricAdminSession(req, res, email, 'Admin Passkey');
    await audit(email, 'login', 'success', req.requestId, {});
    return res.json({ success: true, user });
  } catch (error) {
    if (email) await audit(email, 'login', 'failure', req.requestId, { reason: 'verification_error' });
    return res.status(401).json({ error: 'Passkey sign-in failed. Please try again.' });
  }
});

// Revoke a credential but retain its audit trail. At least one credential
// must remain until face recognition is fully configured and verified.
router.delete('/passkey/:id', authenticateToken, requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.user.email);
  try {
    await requireFreshAdminSession(req);
    await requireCurrentAdmin(email);
    const rows = await listActiveCredentials(email);
    const target = rows.find((row) => row.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Passkey not found.' });
    if (rows.length <= 1) {
      return res.status(409).json({ error: 'Register another passkey before revoking the last one.' });
    }
    const now = new Date().toISOString();
    const { error } = await getStore().from('admin_passkey_credentials')
      .update({ revoked_at: now })
      .eq('id', target.id)
      .eq('admin_email', email)
      .is('revoked_at', null);
    if (error) throw new Error('Could not revoke this passkey.');
    await audit(email, 'revoke', 'revoked', req.requestId, { deviceType: target.device_type || 'unknown' });
    return res.json({ success: true, passkeys: (await listActiveCredentials(email)).map(safeCredential) });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Could not revoke passkey.' });
  }
});

module.exports = router;

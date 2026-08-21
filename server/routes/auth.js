const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const UAParser = require('ua-parser-js');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { authenticateToken, generateToken, refreshToken } = require('../middleware/auth');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');
const emailService = require('../services/emailService');
const otpService = require('../services/otpService');
const getClientIP = require('../middleware/getClientIP');

const router = express.Router();

/**
 * Extract device info from User-Agent and create a session in Supabase.
 * Runs non-blocking (fire-and-forget) so it never delays login response.
 * The user_id is resolved against the Users Google Sheet first (by email),
 * so Supabase always stores the real user id that exists in the sheet.
 */
async function createLoginSession(req, userId, loginMethod, email) {
  try {
    const cleanEmail = String(email || '').toLowerCase().trim();

    // Prefer the real user_id stored in the Users Google Sheet (lookup by email)
    let realUserId = String(userId || '');
    if (cleanEmail) {
      const sheetUser = await db.findRow(db.SHEETS.USERS, 'email', cleanEmail).catch(() => null);
      if (sheetUser && (sheetUser.user_id || sheetUser.id)) {
        realUserId = String(sheetUser.user_id || sheetUser.id);
      }
    }
    if (!realUserId) realUserId = 'user_' + Date.now();

    const ua = new UAParser(req.headers['user-agent'] || '');
    const device = ua.getDevice();
    const os = ua.getOS();
    const browser = ua.getBrowser();

    // Build friendly device string
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

    // Real client IP only — never a sample/hardcoded address
    const ip = getClientIP(req);

    // Geo-IP lookup with fast 800ms timeout; stays 'Unknown' when it fails
    let country = 'Unknown', state = 'Unknown', city = 'Unknown';
    if (ip && !ip.startsWith('192.168') && ip !== '127.0.0.1' && ip !== 'localhost') {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 800);
        const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=country,regionName,city`, { signal: controller.signal });
        clearTimeout(timer);
        if (geoRes.ok) {
          const geo = await geoRes.json();
          if (geo.country) country = geo.country === 'India' ? 'India 🇮🇳' : geo.country;
          if (geo.regionName) state = geo.regionName;
          if (geo.city) city = geo.city;
        }
      } catch (e) {
        // Geo lookup timed out or failed — keep 'Unknown' (accurate, not guessed)
      }
    }

    const sessionResult = await supabase.createSession({
      user_id: realUserId,
      email: cleanEmail,
      device: deviceStr,
      os: osStr,
      browser: browserStr,
      country,
      state,
      city,
      ip_address: ip,
      login_method: loginMethod || 'Email',
    });

    if (sessionResult) {
      console.log(`✅ Session created in Supabase: ${sessionResult.session_id} for user ${realUserId}${cleanEmail ? ' (' + cleanEmail + ')' : ''}`);
    } else {
      console.warn('⚠️ Supabase createSession returned null');
    }
  } catch (err) {
    console.warn('Session creation notice:', err.message);
  }
}

// ── POST /api/auth/send-otp ────────────────────────────────────────────────
// Send OTP to email with full security: rate limiting, hashing, audit trail.
// Identity is derived server-side — never trust frontend-supplied userId or IP.
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // Verify Cloudflare Turnstile token (skip gracefully if secret key not configured)
    const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
    if (turnstileSecret) {
      const { cfTurnstileToken } = req.body;
      if (!cfTurnstileToken) {
        return res.status(400).json({ error: 'Security check required. Please complete the CAPTCHA.' });
      }
      const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: turnstileSecret, response: cfTurnstileToken }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyData.success) {
        console.warn('Turnstile verification failed (send-otp):', verifyData['error-codes']);
        return res.status(400).json({ error: 'Security check failed. Please try again.' });
      }
    }

    // Derive userId server-side (look up existing user, or use a temp ID)
    let userId = '';
    try {
      const existingUser = await db.findRow(db.SHEETS.USERS, 'email', cleanEmail);
      if (existingUser) {
        userId = existingUser.user_id || existingUser.id || '';
      }
    } catch (e) {
      // User lookup failed — continue with empty userId (new user flow)
    }
    if (!userId) {
      userId = `pending_${Date.now()}`;
    }

    // Derive IP address server-side
    const ipAddress = getClientIP(req);

    // Request OTP through the security service
    const result = await otpService.requestOTP(userId, cleanEmail, ipAddress);

    if (!result.success) {
      // Return rate-limit errors with 429 status
      return res.status(429).json({
        error: result.error,
        retryAfter: result.retryAfter || undefined,
      });
    }

    // Send real OTP via Nodemailer email service
    const emailResult = await emailService.sendOTPEmail(cleanEmail, result.otp);

    if (!emailResult.success && !emailResult.isSimulated) {
      console.warn('Email sending failed:', emailResult.error);
    }

    res.json({
      message: 'Verification code sent to ' + cleanEmail + '.',
      // In development or if SMTP is simulated, return OTP for easy testing
      devOtp: process.env.NODE_ENV !== 'production' || emailResult.isSimulated ? result.otp : undefined,
    });
  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
  }
});

// ── POST /api/auth/verify-otp ──────────────────────────────────────────────
// Verify OTP, log the attempt, and create an authenticated session.
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and verification code are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Verify OTP through the security service (handles hash comparison, expiry, attempts)
    const verification = await otpService.verifyOTP(cleanEmail, otp);
    if (!verification.valid) {
      return res.status(400).json({ error: verification.error });
    }

    const now = new Date().toISOString();

    // Find or create user in Google Sheets
    let sheetUser = await db.findRow(db.SHEETS.USERS, 'email', cleanEmail).catch(() => null);
    if (!sheetUser) {
      // New user - create account
      const userId = uuidv4();
      sheetUser = {
        user_id: userId,
        id: userId,
        name: cleanEmail.split('@')[0],
        username: cleanEmail.split('@')[0],
        email: cleanEmail,
        status: 'active',
        created_at: now,
        updated_at: now,
        last_login_at: now,
        last_logout_at: '',
      };
      await db.appendRow(db.SHEETS.USERS, sheetUser).catch((e) => console.warn('GSheet write notice:', e.message));
    } else {
      // Existing user - update last login
      await db.updateRow(db.SHEETS.USERS, 'email', cleanEmail, {
        last_login_at: now,
        updated_at: now,
      }).catch((e) => console.warn('GSheet update notice:', e.message));
    }

    // Generate JWT token
    const token = generateToken({
      id: sheetUser.user_id || sheetUser.id,
      email: cleanEmail,
      name: sheetUser.name || cleanEmail.split('@')[0],
      role: 'user',
    });

    // Fire-and-forget session tracking
    createLoginSession(req, sheetUser.user_id || sheetUser.id, 'Email OTP', cleanEmail).catch(() => {});

    res.json({
      message: 'Email verified successfully!',
      token,
      user: {
        id: sheetUser.user_id || sheetUser.id,
        user_id: sheetUser.user_id || sheetUser.id,
        email: cleanEmail,
        name: sheetUser.name || cleanEmail.split('@')[0],
        username: sheetUser.username || cleanEmail.split('@')[0],
        status: sheetUser.status || 'active',
        role: 'user',
      },
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Failed to verify code. Please try again.' });
  }
});

function getSheetsFallbackError(message) {
  return db.getWriteAvailabilityError(message);
}

// POST /api/auth/register — Save user EXCLUSIVELY to Google Sheets (Users tab)
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, username } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanName = name.trim();
    const cleanUsername = (username || cleanEmail.split('@')[0]).trim();

    // Check for existing user in Google Sheets
    const existingSheetUser = await db.findRow(db.SHEETS.USERS, 'email', cleanEmail);
    if (existingSheetUser) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const now = new Date().toISOString();
    const userId = uuidv4();

    const sheetUser = {
      user_id: userId,
      id: userId,
      name: cleanName,
      username: cleanUsername,
      email: cleanEmail,
      status: 'active',
      created_at: now,
      updated_at: now,
      last_login_at: now,
      last_logout_at: '',
    };

    // Save profile details to Google Sheets (Users tab)
    await db.appendRow(db.SHEETS.USERS, sheetUser);

    // Dual-sync password hash securely to Supabase (not stored in Sheets)
    if (supabase.isConfigured()) {
      try {
        await supabase.createUser({
          user_id: userId,
          name: cleanName,
          email: cleanEmail,
          password_hash: passwordHash,
          username: cleanUsername,
        });
      } catch (spErr) {
        console.warn('Supabase password hash storage notice:', spErr.message);
      }
    }

    // Generate token
    const token = generateToken({
      id: userId,
      email: cleanEmail,
      name: cleanName,
      role: 'user',
    });

    // Fire-and-forget session tracking
    createLoginSession(req, userId, 'Email', cleanEmail).catch(() => {});

    res.status(201).json({
      message: 'Account created successfully in Google Sheets! 📊',
      token,
      user: {
        id: userId,
        user_id: userId,
        name: cleanName,
        username: cleanUsername,
        email: cleanEmail,
        status: 'active',
        role: 'user',
      },
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/auth/login — Read user EXCLUSIVELY from Google Sheets
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const loginEmail = email.toLowerCase().trim();

    // ── 1. Check MongoDB Admin collection ─────────────────────────────
    let Admin;
    try {
      Admin = require('../models/Admin');
    } catch (e) {}

    if (Admin) {
      try {
        const dbAdmin = await Admin.findOne({ email: loginEmail });
        if (dbAdmin) {
          if (!dbAdmin.is_active) {
            return res.status(403).json({ error: 'This admin account is currently deactivated.' });
          }

          const isMatch = await bcrypt.compare(password, dbAdmin.password_hash);
          if (isMatch) {
            dbAdmin.last_login = new Date();
            await dbAdmin.save();

            const token = generateToken({
              id: dbAdmin.id || dbAdmin._id.toString(),
              email: dbAdmin.email,
              name: dbAdmin.name || dbAdmin.full_name,
              role: 'admin',
            }, '12h');

            // Fire-and-forget session tracking
            createLoginSession(req, dbAdmin.id || dbAdmin._id.toString(), 'Email', dbAdmin.email).catch(() => {});

            return res.json({
              message: 'Admin login successful.',
              token,
              user: {
                id: dbAdmin.id || dbAdmin._id.toString(),
                email: dbAdmin.email,
                name: dbAdmin.name || dbAdmin.full_name,
                role: 'admin',
                profile_image: dbAdmin.profile_image,
              },
            });
          }
        }
      } catch (e) {}
    }

    // ── 2. Hardcoded admin fallback ──────────────────────────────────
    const hardcodedAdmins = [
      { email: 'rupayandas2024@gmail.com', password: 'Rupayan', name: 'Rupayan' },
      { email: 'jaggik8888@gmail.com', password: 'Jaggik', name: 'Jaggik' },
    ];

    const hardcoded = hardcodedAdmins.find(a => a.email === loginEmail && a.password === password);
    if (hardcoded) {
      const token = generateToken({
        id: uuidv4(),
        email: hardcoded.email,
        name: hardcoded.name,
        role: 'admin',
      }, '12h');

      const hardcodedId = uuidv4();
      // Fire-and-forget session tracking
      createLoginSession(req, hardcodedId, 'Email', hardcoded.email).catch(() => {});

      return res.json({
        message: 'Admin login successful.',
        token,
        user: {
          id: hardcodedId,
          email: hardcoded.email,
          name: hardcoded.name,
          role: 'admin',
        },
      });
    }

    // ── 3. Read user EXCLUSIVELY from Google Sheets (Users tab) ──────
    let sheetUser = await db.findRow(db.SHEETS.USERS, 'email', loginEmail);

    if (sheetUser) {
      if (sheetUser.status && sheetUser.status !== 'active') {
        return res.status(403).json({ error: `Account is ${sheetUser.status}. Please contact support.` });
      }

      if (password && sheetUser.passwordHash) {
        const validPassword = await bcrypt.compare(password, sheetUser.passwordHash);
        if (!validPassword) {
          return res.status(401).json({ error: 'Invalid password.' });
        }
      }

      const now = new Date().toISOString();
      // Non-blocking background timestamp update to ensure instant response
      db.updateRow(db.SHEETS.USERS, 'email', loginEmail, {
        last_login_at: now,
        updated_at: now,
      }).catch((e) => console.warn('Background timestamp update notice:', e.message));

      const token = generateToken({
        id: sheetUser.user_id || sheetUser.id,
        email: sheetUser.email,
        name: sheetUser.name,
        role: 'user',
      });

      // Fire-and-forget session tracking
      createLoginSession(req, sheetUser.user_id || sheetUser.id, 'Email', loginEmail).catch(() => {});

      return res.json({
        message: 'Login successful.',
        token,
        user: {
          id: sheetUser.user_id || sheetUser.id,
          user_id: sheetUser.user_id || sheetUser.id,
          email: sheetUser.email,
          name: sheetUser.name || 'User',
          username: sheetUser.username || sheetUser.email.split('@')[0],
          status: sheetUser.status || 'active',
          role: 'user',
        },
      });
    }

    // ── 4. Auto-register user in Google Sheets if email-only flow ────
    const nameFromEmail = loginEmail.split('@')[0];
    const displayName = nameFromEmail.charAt(0).toUpperCase() + nameFromEmail.slice(1);
    const newUserId = uuidv4();
    const now = new Date().toISOString();

    sheetUser = {
      user_id: newUserId,
      id: newUserId,
      name: displayName,
      username: nameFromEmail,
      email: loginEmail,
      status: 'active',
      created_at: now,
      updated_at: now,
      last_login_at: now,
      last_logout_at: '',
    };
    await db.appendRow(db.SHEETS.USERS, sheetUser);

    const token = generateToken({
      id: newUserId,
      email: loginEmail,
      name: displayName,
      role: 'user',
    });

    // Fire-and-forget session tracking
    createLoginSession(req, newUserId, 'Email', loginEmail).catch(() => {});

    res.json({
      message: 'Login successful.',
      token,
      user: {
        id: newUserId,
        user_id: newUserId,
        name: displayName,
        username: nameFromEmail,
        email: loginEmail,
        status: 'active',
        role: 'user',
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/auth/google-config
router.get('/google-config', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || '930893529973-2j5h36csl909m139urdq552n63h1hl1q.apps.googleusercontent.com';
  res.json({
    clientId,
    configured: !!(clientId && !clientId.includes('your_google_client_id')),
  });
});

// GET /api/auth/google-redirect — Handle OAuth fragment redirects (#access_token=... or #id_token=...)
// OAuth handoff page — stores auth state and redirects immediately.
// Renders no visible "logging in" window: just the site background and the
// same top progress bar every page shows, so the hop reads as a page load.
function sendAuthHandoff(res, innerScript) {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>SaveHatke</title>
<style>
  body{background:#060d1f;margin:0;min-height:100vh}
  #shPageProgressBar{position:fixed;top:0;left:0;height:3px;width:0;z-index:10000;
    background:linear-gradient(90deg,#00e676,#00c853);box-shadow:0 0 10px rgba(0,230,118,.7);
    border-radius:0 3px 3px 0;transition:width .25s ease,opacity .4s ease;opacity:1;pointer-events:none}
</style>
</head>
<body>
<div id="shPageProgressBar"></div>
<script>
(function(){
  var bar=document.getElementById('shPageProgressBar');
  requestAnimationFrame(function(){bar.style.width='35%';});
  setTimeout(function(){bar.style.width='70%';},160);
})();
</script>
<script>${innerScript}</script>
</body>
</html>`);
}

router.get('/google-redirect', (req, res) => {
  sendAuthHandoff(res, `
    (async function() {
      const hash = window.location.hash;
      if (hash && (hash.includes('id_token=') || hash.includes('access_token='))) {
        const params = new URLSearchParams(hash.substring(1));
        const idToken = params.get('id_token');
        const accessToken = params.get('access_token');
        try {
          let payload = {};
          if (idToken) {
            payload = { credential: idToken };
          } else if (accessToken) {
            const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo?access_token=' + accessToken);
            const profile = await res.json();
            if (profile.email) {
              payload = { email: profile.email, name: profile.name, picture: profile.picture };
            }
          }
          if (payload.credential || payload.email) {
            const apiRes = await fetch('/api/auth/google', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            const data = await apiRes.json();
            if (data.token && data.user) {
              localStorage.setItem('sh_token', data.token);
              localStorage.setItem('sh_user', JSON.stringify(data.user));
              if (data.user.role === 'admin' || data.user.role === 'Super Admin' || data.user.role === 'Admin') {
                localStorage.setItem('sh_admin_token', data.token);
                localStorage.setItem('sh_admin_user', JSON.stringify(data.user));
                window.location.replace('/vault');
              } else {
                window.location.replace('/index');
              }
              return;
            }
          }
        } catch(e) {
          console.error(e);
        }
      }
      window.location.replace('/login');
    })();
  `);
});

// POST /api/auth/google-redirect — Handle Google OAuth redirect mode (same-page login)
router.post('/google-redirect', async (req, res) => {
  try {
    // Google form_post sends the token as 'id_token', but we also support 'credential'
    const credential = req.body.credential || req.body.id_token;
    let userEmail = '';
    let userName = '';
    let userPicture = '';

    if (credential) {
      try {
        let payloadBase64 = credential.split('.')[1];
        if (payloadBase64) {
          payloadBase64 = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
          const pad = payloadBase64.length % 4;
          if (pad) payloadBase64 += '='.repeat(4 - pad);
          const decodedJson = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
          if (decodedJson.email) userEmail = decodedJson.email;
          if (decodedJson.name) userName = decodedJson.name;
          if (decodedJson.picture) userPicture = decodedJson.picture;
        }
      } catch (e) {}
    }

    if (!userEmail) {
      return res.status(400).send('<h3>Google authentication failed: Email missing.</h3><a href="/login">Return to Login</a>');
    }

    userEmail = userEmail.toLowerCase();
    userName = userName || userEmail.split('@')[0];

    // Admin check
    const adminEmails = ['rupayandas2024@gmail.com', 'jaggik8888@gmail.com'];
    let isAdmin = adminEmails.includes(userEmail);
    let adminData = null;

    if (!isAdmin) {
      try {
        const AdminModel = require('../models/Admin');
        adminData = await AdminModel.findOne({ email: userEmail });
        if (adminData && adminData.is_active) isAdmin = true;
      } catch (e) {}
    }

    if (isAdmin) {
      const adminName = adminData ? (adminData.name || adminData.full_name) : userName;
      const adminId = adminData ? (adminData.id || adminData._id.toString()) : uuidv4();

      const token = generateToken({
        id: adminId,
        email: userEmail,
        name: adminName,
        role: 'admin',
      }, '12h');

      createLoginSession(req, adminId, 'Google', userEmail).catch(() => {});

      const adminUser = {
        id: adminId,
        email: userEmail,
        name: adminName,
        picture: userPicture || '',
        role: 'admin',
      };

      return sendAuthHandoff(res, `
        try {
          localStorage.setItem('sh_token', ${JSON.stringify(token)});
          localStorage.setItem('sh_user', JSON.stringify(${JSON.stringify(adminUser)}));
          localStorage.setItem('sh_admin_token', ${JSON.stringify(token)});
          localStorage.setItem('sh_admin_user', JSON.stringify(${JSON.stringify(adminUser)}));
        } catch(e) {}
        window.location.replace('/vault');
      `);
    }

    // Save/Find user in Google Sheets (Users tab) asynchronously
    const now = new Date().toISOString();
    let sheetUser = await db.findRow(db.SHEETS.USERS, 'email', userEmail).catch(() => null);
    if (!sheetUser) {
      const userId = uuidv4();
      sheetUser = {
        user_id: userId,
        id: userId,
        name: userName,
        username: userEmail.split('@')[0],
        email: userEmail,
        status: 'active',
        created_at: now,
        updated_at: now,
        last_login_at: now,
        last_logout_at: '',
      };
      db.appendRow(db.SHEETS.USERS, sheetUser).catch((e) => console.warn('GSheet write notice:', e.message));
    } else {
      db.updateRow(db.SHEETS.USERS, 'email', userEmail, {
        last_login_at: now,
        updated_at: now,
      }).catch((e) => console.warn('GSheet update notice:', e.message));
    }

    const userId = sheetUser.user_id || sheetUser.id;
    const token = generateToken({
      id: userId,
      email: userEmail,
      name: sheetUser.name || userName,
      role: 'user',
    });

    createLoginSession(req, userId, 'Google', userEmail).catch(() => {});

    const regularUser = {
      id: userId,
      email: userEmail,
      name: sheetUser.name || userName,
      username: sheetUser.username || userEmail.split('@')[0],
      picture: userPicture || '',
      role: 'user',
    };

    return sendAuthHandoff(res, `
      try {
        localStorage.setItem('sh_token', ${JSON.stringify(token)});
        localStorage.setItem('sh_user', JSON.stringify(${JSON.stringify(regularUser)}));
      } catch(e) {}
      window.location.replace('/index');
    `);
  } catch (err) {
    console.error('Google redirect handler error:', err);
    res.status(500).send('<h3>Google authentication failed.</h3><a href="/login">Return to Login</a>');
  }
});

// POST /api/auth/google — Google login stored EXCLUSIVELY to Google Sheets
router.post('/google', async (req, res) => {
  try {
    const { credential, email, name, picture } = req.body;

    let userEmail = email;
    let userName = name;
    let userPicture = picture;

    // Parse payload if credential passed
    if (credential) {
      try {
        let payloadBase64 = credential.split('.')[1];
        if (payloadBase64) {
          payloadBase64 = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
          const pad = payloadBase64.length % 4;
          if (pad) payloadBase64 += '='.repeat(4 - pad);
          const decodedJson = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
          if (decodedJson.email) userEmail = decodedJson.email;
          if (decodedJson.name) userName = decodedJson.name;
          if (decodedJson.picture) userPicture = decodedJson.picture;
        }
      } catch (e) {}
    }

    if (!userEmail) {
      return res.status(400).json({ error: 'Google authentication failed: Email missing.' });
    }

    userEmail = userEmail.toLowerCase();
    userName = userName || userEmail.split('@')[0];

    // Admin check
    const adminEmails = ['rupayandas2024@gmail.com', 'jaggik8888@gmail.com'];
    let isAdmin = adminEmails.includes(userEmail);
    let adminData = null;

    if (!isAdmin) {
      try {
        const AdminModel = require('../models/Admin');
        adminData = await AdminModel.findOne({ email: userEmail });
        if (adminData && adminData.is_active) isAdmin = true;
      } catch (e) {}
    }

    if (isAdmin) {
      const adminName = adminData ? (adminData.name || adminData.full_name) : userName;
      const adminId = adminData ? (adminData.id || adminData._id.toString()) : uuidv4();

      const token = generateToken({
        id: adminId,
        email: userEmail,
        name: adminName,
        role: 'admin',
      }, '12h');

      // Fire-and-forget session tracking
      createLoginSession(req, adminId, 'Google', userEmail).catch(() => {});

      return res.json({
        message: 'Admin Google login successful.',
        token,
        user: {
          id: adminId,
          email: userEmail,
          name: adminName,
          picture: userPicture || '',
          role: 'admin',
        },
      });
    }

    // Save/Find user in Google Sheets (Users tab) asynchronously
    const now = new Date().toISOString();
    let sheetUser = await db.findRow(db.SHEETS.USERS, 'email', userEmail).catch(() => null);
    if (!sheetUser) {
      const userId = uuidv4();
      sheetUser = {
        user_id: userId,
        id: userId,
        name: userName,
        username: userEmail.split('@')[0],
        email: userEmail,
        status: 'active',
        created_at: now,
        updated_at: now,
        last_login_at: now,
        last_logout_at: '',
      };
      db.appendRow(db.SHEETS.USERS, sheetUser).catch((e) => console.warn('GSheet write notice:', e.message));
    } else {
      db.updateRow(db.SHEETS.USERS, 'email', userEmail, {
        last_login_at: now,
        updated_at: now,
      }).catch((e) => console.warn('GSheet update notice:', e.message));
    }

    const token = generateToken({
      id: sheetUser.user_id || sheetUser.id,
      email: userEmail,
      name: sheetUser.name || userName,
      role: 'user',
    });

    // Fire-and-forget session tracking
    createLoginSession(req, sheetUser.user_id || sheetUser.id, 'Google', userEmail).catch(() => {});

    res.json({
      message: 'Google login successful.',
      token,
      user: {
        id: sheetUser.user_id || sheetUser.id,
        user_id: sheetUser.user_id || sheetUser.id,
        email: userEmail,
        name: sheetUser.name || userName,
        username: sheetUser.username || userEmail.split('@')[0],
        picture: userPicture,
        status: sheetUser.status || 'active',
        role: 'user',
      },
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Failed to authenticate with Google.' });
  }
});

// POST /api/auth/logout — Record last_logout_at in G Sheet + end Supabase session
router.post('/logout', async (req, res) => {
  try {
    const { email, user_id, session_id } = req.body;
    const now = new Date().toISOString();

    // Update G Sheet user record
    if (email) {
      db.updateRow(db.SHEETS.USERS, 'email', email.toLowerCase().trim(), {
        last_logout_at: now,
        updated_at: now,
      }).catch((e) => console.warn('Logout G Sheet notice:', e.message));
    }

    // End session(s) in Supabase
    if (session_id) {
      supabase.endSession(session_id).catch(() => {});
    } else if (user_id) {
      supabase.endAllUserSessions(user_id).catch(() => {});
    } else if (email) {
      // Find user_id from G Sheet then end sessions
      const sheetUser = await db.findRow(db.SHEETS.USERS, 'email', email.toLowerCase().trim());
      if (sheetUser && (sheetUser.user_id || sheetUser.id)) {
        supabase.endAllUserSessions(sheetUser.user_id || sheetUser.id).catch(() => {});
      }
    }

    res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    console.warn('Logout notice:', err.message);
    res.json({ message: 'Logged out.' });
  }
});

// POST /api/auth/refresh — Issue a new token from an expired one
router.post('/refresh', (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided.' });
    }

    const result = refreshToken(token);
    if (!result) {
      return res.status(403).json({ error: 'Cannot refresh: invalid token.' });
    }

    res.json({ token: result.token, message: 'Token refreshed.' });
  } catch (err) {
    console.error('Token refresh error:', err);
    res.status(500).json({ error: 'Token refresh failed.' });
  }
});

// GET /api/auth/me
router.get('/me', authenticateToken, async (req, res) => {
  try {
    res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role } });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;

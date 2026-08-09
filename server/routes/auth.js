const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { authenticateToken, generateToken } = require('../middleware/auth');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');

const router = express.Router();

function getSheetsFallbackError(message) {
  return db.getWriteAvailabilityError(message);
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, username } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanName = name.trim();

    // 1. Primary Check: Check for existing user in Google Sheets
    const existingSheetUser = await db.findRow(db.SHEETS.USERS, 'email', cleanEmail);
    if (existingSheetUser) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const userId = uuidv4();
    const sheetUser = {
      id: userId,
      email: cleanEmail,
      passwordHash,
      name: cleanName,
      createdAt: new Date().toISOString(),
    };

    // Save to Google Sheets
    await db.appendRow(db.SHEETS.USERS, sheetUser);

    // 2. Dual Sync: Save to Supabase as backup if configured
    if (supabase.isConfigured()) {
      try {
        await supabase.createUser({
          name: cleanName,
          email: cleanEmail,
          password_hash: passwordHash,
          username: username || cleanEmail.split('@')[0],
        });
      } catch (spErr) {
        console.warn('Supabase dual-sync notice:', spErr.message);
      }
    }

    // Generate token
    const token = generateToken({
      id: userId,
      email: cleanEmail,
      name: cleanName,
      role: 'user',
    });

    res.status(201).json({
      message: 'Account created successfully in Google Sheets! 📊',
      token,
      user: {
        id: userId,
        user_id: userId,
        email: cleanEmail,
        name: cleanName,
        role: 'user',
      },
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/auth/login
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

      return res.json({
        message: 'Admin login successful.',
        token,
        user: {
          id: uuidv4(),
          email: hardcoded.email,
          name: hardcoded.name,
          role: 'admin',
        },
      });
    }

    // ── 3. Primary User Check: Google Sheets Users tab ───────────────
    let sheetUser = await db.findRow(db.SHEETS.USERS, 'email', loginEmail);

    if (sheetUser) {
      if (password && sheetUser.passwordHash) {
        const validPassword = await bcrypt.compare(password, sheetUser.passwordHash);
        if (!validPassword) {
          return res.status(401).json({ error: 'Invalid password.' });
        }
      }

      const token = generateToken({
        id: sheetUser.id,
        email: sheetUser.email,
        name: sheetUser.name,
        role: 'user',
      });

      return res.json({
        message: 'Login successful.',
        token,
        user: { id: sheetUser.id, user_id: sheetUser.id, email: sheetUser.email, name: sheetUser.name || 'User', role: 'user' },
      });
    }

    // ── 4. Supabase Lookup Fallback & Sync ───────────────────────────
    if (supabase.isConfigured()) {
      try {
        const spUser = await supabase.findUserByEmail(loginEmail);
        if (spUser) {
          if (spUser.status && spUser.status !== 'active') {
            return res.status(403).json({ error: `Account is ${spUser.status}. Please contact support.` });
          }

          const validPassword = password ? await bcrypt.compare(password, spUser.password_hash) : true;
          if (validPassword) {
            // Auto-sync into Google Sheets
            const syncedUser = {
              id: spUser.user_id,
              email: spUser.email,
              passwordHash: spUser.password_hash,
              name: spUser.name,
              createdAt: spUser.created_at || new Date().toISOString(),
            };
            await db.appendRow(db.SHEETS.USERS, syncedUser);

            const token = generateToken({
              id: spUser.user_id,
              email: spUser.email,
              name: spUser.name,
              role: 'user',
            });

            return res.json({
              message: 'Login successful.',
              token,
              user: {
                id: spUser.user_id,
                user_id: spUser.user_id,
                email: spUser.email,
                name: spUser.name,
                username: spUser.username,
                role: 'user',
              },
            });
          }
          return res.status(401).json({ error: 'Invalid password.' });
        }
      } catch (spErr) {
        console.warn('Supabase login check notice:', spErr.message);
      }
    }

    // ── 5. Auto-register user in Google Sheets if email only flow ────
    const nameFromEmail = loginEmail.split('@')[0];
    const displayName = nameFromEmail.charAt(0).toUpperCase() + nameFromEmail.slice(1);
    const newUserId = uuidv4();
    sheetUser = {
      id: newUserId,
      email: loginEmail,
      passwordHash: password ? await bcrypt.hash(password, 10) : '',
      name: displayName,
      createdAt: new Date().toISOString(),
    };
    await db.appendRow(db.SHEETS.USERS, sheetUser);

    const token = generateToken({
      id: newUserId,
      email: loginEmail,
      name: displayName,
      role: 'user',
    });

    res.json({
      message: 'Login successful.',
      token,
      user: { id: newUserId, user_id: newUserId, email: loginEmail, name: displayName, role: 'user' },
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

// POST /api/auth/google
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

    // Regular user Google login stored directly to Google Sheets
    let sheetUser = await db.findRow(db.SHEETS.USERS, 'email', userEmail);
    if (!sheetUser) {
      sheetUser = {
        id: uuidv4(),
        email: userEmail,
        passwordHash: 'GOOGLE_OAUTH_ACCOUNT',
        name: userName,
        createdAt: new Date().toISOString(),
      };
      await db.appendRow(db.SHEETS.USERS, sheetUser);

      if (supabase.isConfigured()) {
        try {
          await supabase.createUser({
            name: userName,
            email: userEmail,
            password_hash: 'GOOGLE_OAUTH_ACCOUNT',
            username: userEmail.split('@')[0],
          });
        } catch (e) {}
      }
    }

    const token = generateToken({
      id: sheetUser.id,
      email: userEmail,
      name: sheetUser.name || userName,
      role: 'user',
    });

    res.json({
      message: 'Google login successful.',
      token,
      user: {
        id: sheetUser.id,
        user_id: sheetUser.id,
        email: userEmail,
        name: sheetUser.name || userName,
        picture: userPicture,
        role: 'user',
      },
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Failed to authenticate with Google.' });
  }
});

// POST /api/auth/logout — Record last_logout_at timestamp
router.post('/logout', async (req, res) => {
  try {
    const { userId, email } = req.body;

    if (supabase.isConfigured()) {
      let targetId = userId;
      if (!targetId && email) {
        const u = await supabase.findUserByEmail(email);
        if (u) targetId = u.user_id;
      }
      if (targetId) {
        await supabase.updateLogoutTimestamp(targetId);
      }
    }

    res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    console.warn('Logout timestamp error:', err.message);
    res.json({ message: 'Logged out.' });
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

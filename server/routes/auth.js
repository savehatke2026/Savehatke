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

    // Save/Find user EXCLUSIVELY in Google Sheets (Users tab)
    const now = new Date().toISOString();
    let sheetUser = await db.findRow(db.SHEETS.USERS, 'email', userEmail);
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
      await db.appendRow(db.SHEETS.USERS, sheetUser);
    } else {
      await db.updateRow(db.SHEETS.USERS, 'email', userEmail, {
        last_login_at: now,
        updated_at: now,
      });
    }

    const token = generateToken({
      id: sheetUser.user_id || sheetUser.id,
      email: userEmail,
      name: sheetUser.name || userName,
      role: 'user',
    });

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

// POST /api/auth/logout — Record last_logout_at timestamp in Google Sheets
router.post('/logout', async (req, res) => {
  try {
    const { email } = req.body;
    if (email) {
      const now = new Date().toISOString();
      await db.updateRow(db.SHEETS.USERS, 'email', email.toLowerCase().trim(), {
        last_logout_at: now,
        updated_at: now,
      });
    }
    res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    console.warn('Logout timestamp notice:', err.message);
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

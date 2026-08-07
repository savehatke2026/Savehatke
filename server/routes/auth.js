// ============================================
// SaveHatke — Auth Routes
// ============================================

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { authenticateToken, generateToken } = require('../middleware/auth');
const db = require('../services/googleSheets');

const router = express.Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required.' });
    }

    // Check if user already exists
    const existing = await db.findRow(db.SHEETS.USERS, 'email', email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const user = {
      id: uuidv4(),
      email: email.toLowerCase(),
      passwordHash,
      name: name.trim(),
      createdAt: new Date().toISOString(),
    };

    await db.appendRow(db.SHEETS.USERS, user);

    // Generate token
    const token = generateToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: 'user',
    });

    res.status(201).json({
      message: 'Account created successfully.',
      token,
      user: { id: user.id, email: user.email, name: user.name },
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

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await db.findRow(db.SHEETS.USERS, 'email', email.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = generateToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: 'user',
    });

    res.json({
      message: 'Login successful.',
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/auth/google-config
router.get('/google-config', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  res.json({
    clientId,
    configured: !!(process.env.GOOGLE_CLIENT_ID && !process.env.GOOGLE_CLIENT_ID.includes('your_google_client_id')),
  });
});

// POST /api/auth/google
router.post('/google', async (req, res) => {
  try {
    const { credential, email, name, picture } = req.body;

    let userEmail = email;
    let userName = name;
    let userPicture = picture;

    // If ID token is passed, parse payload
    if (credential) {
      try {
        const payloadBase64 = credential.split('.')[1];
        if (payloadBase64) {
          const decodedJson = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
          if (decodedJson.email) userEmail = decodedJson.email;
          if (decodedJson.name) userName = decodedJson.name;
          if (decodedJson.picture) userPicture = decodedJson.picture;
        }
      } catch (e) {
        console.warn('Could not parse Google JWT credential payload, using fallback profile data:', e.message);
      }
    }

    if (!userEmail) {
      return res.status(400).json({ error: 'Google authentication failed: Email missing.' });
    }

    userEmail = userEmail.toLowerCase();
    userName = userName || userEmail.split('@')[0];

    // Find or create user in DB
    let user = await db.findRow(db.SHEETS.USERS, 'email', userEmail);

    if (!user) {
      user = {
        id: uuidv4(),
        email: userEmail,
        passwordHash: 'GOOGLE_OAUTH_ACCOUNT',
        name: userName,
        picture: userPicture || '',
        createdAt: new Date().toISOString(),
      };
      await db.appendRow(db.SHEETS.USERS, user);
    }

    const token = generateToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: 'user',
    });

    res.json({
      message: 'Google login successful.',
      token,
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture },
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Failed to authenticate with Google.' });
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

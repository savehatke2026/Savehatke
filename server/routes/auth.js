// ============================================
// SaveHatke — Auth Routes
// ============================================

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
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

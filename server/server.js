// ============================================
// SaveHatke — Express Server Entry Point
// ============================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const mongoose = require('mongoose');
const db = require('./services/googleSheets');
const { connectDB } = require('./config/db');

// Connect to MongoDB
connectDB();

// Import routes
const authRoutes = require('./routes/auth');
const couponRoutes = require('./routes/coupons');
const trackerRoutes = require('./routes/priceTracker');
const adminRoutes = require('./routes/admin');
const supportRoutes = require('./routes/support');
const chatbotAdminRoutes = require('./routes/chatbot');
const chatRoutes = require('./routes/chat');

const app = express();

// ── Security & Middleware ───────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline styles/scripts for our frontend
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: '*', // In production, restrict to your domain
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: { error: 'Too many requests. Please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // Stricter for auth endpoints
  message: { error: 'Too many login attempts. Please try again later.' },
});

// Serverless async initializer middleware for Vercel
app.use(async (req, res, next) => {
  try {
    await initServices();
  } catch (e) {}
  next();
});

// ── Static Files ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// Handle Google OAuth redirect POSTs to static login page
app.post(['/login', '/login.html'], (req, res) => {
  res.redirect(307, '/api/auth/google-redirect');
});

// ── API Routes ──────────────────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/coupons', apiLimiter, couponRoutes);
app.use('/api/tracker', apiLimiter, trackerRoutes);
app.use('/api/admin', apiLimiter, adminRoutes);
app.use('/api/support', apiLimiter, supportRoutes);
app.use('/api/chatbot', apiLimiter, chatbotAdminRoutes);
app.use('/api/chat', chatRoutes); // /api/chat applies its own service-level rate limits

// Public settings route (for index.html hero stats & platform settings)
app.get('/api/settings', async (req, res) => {
  try {
    let settings = await db.getSettings();

    if (mongoose.connection.readyState === 1) {
      try {
        const Setting = require('./models/Setting');
        const mongoSetting = await Setting.findOne({ key: 'site_settings' });
        if (mongoSetting) {
          settings = {
            ...settings,
            activeUsers: mongoSetting.activeUsers || settings.activeUsers,
            couponsTraded: mongoSetting.couponsTraded || settings.couponsTraded,
            savedByUsers: mongoSetting.savedByUsers || settings.savedByUsers,
            platformName: mongoSetting.platformName || settings.platformName,
            adminEmail: mongoSetting.adminEmail || settings.adminEmail,
            showActiveUsers: mongoSetting.showActiveUsers !== undefined ? mongoSetting.showActiveUsers : settings.showActiveUsers,
            showCouponsTraded: mongoSetting.showCouponsTraded !== undefined ? mongoSetting.showCouponsTraded : settings.showCouponsTraded,
            showSavedByUsers: mongoSetting.showSavedByUsers !== undefined ? mongoSetting.showSavedByUsers : settings.showSavedByUsers,
            heroBadge: mongoSetting.heroBadge || settings.heroBadge,
            showHeroBadge: mongoSetting.showHeroBadge !== undefined ? mongoSetting.showHeroBadge : settings.showHeroBadge,
          };
        }
      } catch (e) {}
    }
    // Normalize toggle booleans — Google Sheets stores as strings ('true'/'false')
    // which breaks strict comparison on the frontend. Force-cast to real booleans.
    const toBool = (v) => v === true || v === 'true';
    settings.showActiveUsers = toBool(settings.showActiveUsers);
    settings.showCouponsTraded = toBool(settings.showCouponsTraded);
    settings.showSavedByUsers = toBool(settings.showSavedByUsers);
    settings.showHeroBadge = toBool(settings.showHeroBadge);

    res.json({ settings });
  } catch (err) {
    console.error('Get public settings error:', err);
    res.json({
      settings: {
        activeUsers: '10K+',
        couponsTraded: '50K+',
        savedByUsers: '₹2L+',
        platformName: 'SaveHatke',
        adminEmail: 'rupayandas2024@gmail.com',
        showActiveUsers: true,
        showCouponsTraded: true,
        showSavedByUsers: true,
        heroBadge: "🚀 India's #1 Coupon Marketplace — Now Live!",
        showHeroBadge: true,
      },
    });
  }
});

// ── Health Check ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const storageStatus = db.getStorageStatus();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    name: 'SaveHatke API',
    storage: {
      connected: storageStatus.connected,
      mode: storageStatus.mode,
      lastError: storageStatus.lastError,
    },
  });
});

// ── SPA Fallback — serve index.html for unmatched routes ────────────────────
app.get('*', (req, res) => {
  // Only serve HTML for non-API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found.' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Error Handler ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ── Initialize DB & Sheets (runs on cold start for both local & Vercel) ─────
let initialized = false;

async function initServices() {
  if (initialized) return;
  initialized = true;

  // Connect to MongoDB Atlas
  await connectDB();

  // Initialize Google Sheets connection
  const sheetsConnected = await db.initialize();
  if (!sheetsConnected) {
    console.warn('⚠️  Google Sheets unavailable. Operating in memory fallback mode.');
  }

  // Ensure Supabase sessions table exists
  const supabase = require('./services/supabase');
  if (supabase.isConfigured()) {
    await supabase.ensureSessionsTable();
  }
}

// Run initialization immediately
initServices().catch((err) => {
  console.error('Service initialization warning:', err.message);
});

// ── Start Server (only when running locally, NOT on Vercel) ─────────────────
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;

  initServices().then(() => {
    app.listen(PORT, () => {
      console.log('');
      console.log('  ╔══════════════════════════════════════╗');
      console.log('  ║        SaveHatke Server v1.0         ║');
      console.log('  ╚══════════════════════════════════════╝');
      console.log('');
      console.log(`🚀 Server running at http://localhost:${PORT}`);
      console.log(`📄 Landing page: http://localhost:${PORT}`);
      console.log(`🔧 Admin panel:  http://localhost:${PORT}/vault.html`);
      console.log(`💡 API health:   http://localhost:${PORT}/api/health`);
      console.log('');
    });
  }).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

// ── Export for Vercel Serverless ─────────────────────────────────────────────
module.exports = app;

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

// ── Static Files ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API Routes ──────────────────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/coupons', apiLimiter, couponRoutes);
app.use('/api/tracker', apiLimiter, trackerRoutes);
app.use('/api/admin', apiLimiter, adminRoutes);
app.use('/api/support', apiLimiter, supportRoutes);

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

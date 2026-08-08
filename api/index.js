// ============================================
// SaveHatke — Vercel Serverless Function Entry
// ============================================
// Wraps the Express app for Vercel's serverless runtime.

const path = require('path');

// Load environment variables (Vercel Dashboard env vars are auto-loaded,
// but dotenv is a fallback for local development)
require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Import the Express app (server.js now exports it)
const app = require('../server/server');

// Export for Vercel serverless
module.exports = app;

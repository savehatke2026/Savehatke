// ============================================
// SaveHatke — Admin Email Testing Routes
// ============================================
// Protected, admin-only tool to preview and send TEST copies of the real
// production email templates to an admin-controlled test address, using safe
// dummy data. Mounted at /api/admin/email-testing.
//
// Hard safety guarantees (see also services/emailTestingTemplates.js):
//   • Every endpoint requires an authenticated admin session.
//   • Templates are validated against a fixed allowlist — the client never
//     supplies HTML, a subject, or an arbitrary recipient for the send.
//   • Test emails are ALWAYS sent to the saved test address only.
//   • Rendering reuses the production templates with dummy data and never
//     creates an order / payment / coupon / refund, never unlocks a coupon,
//     never touches wallet balances or user/coupon data, and never emails a
//     real customer or triggers any production workflow.

const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { waitForMongoReady } = require('../config/db');
const emailService = require('../services/emailService');
const templates = require('../services/emailTestingTemplates');
const EmailTestConfig = require('../models/EmailTestConfig');
const EmailTestLog = require('../models/EmailTestLog');
const Admin = require('../models/Admin');

const router = express.Router();

// ── Config ───────────────────────────────────────────────────────────────
const CONFIG_KEY = 'email_testing';
const HISTORY_LIMIT = 25;
// Rate limit: at most N successful test emails per admin within the window.
const RATE_MAX = 10;
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// RFC-pragmatic email check (mirrors the client-side validation).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(value) {
  const s = String(value || '').trim();
  return s.length > 0 && s.length <= 254 && EMAIL_RE.test(s);
}

// Everything here needs MongoDB (admin data + config + logs). Give a clear
// 503 instead of a buffered-query hang when the DB is mid-reconnect.
async function ensureMongo(res) {
  const ready = await waitForMongoReady(4000).catch(() => false);
  if (!ready) {
    res.status(503).json({ error: 'Service temporarily unavailable. Please try again in a moment.' });
    return false;
  }
  return true;
}

// Resolve the acting admin from the authenticated session → { email, name }.
async function resolveActingAdmin(req) {
  const email = String((req.user && req.user.email) || '').toLowerCase().trim();
  let name = '';
  try {
    const me = await Admin.findOne({ email }).select('name').lean();
    name = (me && me.name) || '';
  } catch (_) { /* fall through to session/email */ }
  if (!name) name = (req.user && req.user.name) ? String(req.user.name).trim() : '';
  if (!name) name = email || 'Admin';
  return { email, name };
}

async function loadConfig() {
  let doc = await EmailTestConfig.findOne({ key: CONFIG_KEY });
  if (!doc) {
    doc = await EmailTestConfig.create({ key: CONFIG_KEY, testEmail: '' }).catch(async (e) => {
      // Concurrent first-create — re-read the winner.
      if (e && e.code === 11000) return EmailTestConfig.findOne({ key: CONFIG_KEY });
      throw e;
    });
  }
  return doc;
}

// All routes are admin-only.
router.use(authenticateToken, requireAdmin);

// ── GET /templates — catalog + filter categories ─────────────────────────
router.get('/templates', (req, res) => {
  res.json({ templates: templates.listTemplates(), categories: templates.CATEGORIES });
});

// ── GET /config — the saved test email address ───────────────────────────
router.get('/config', async (req, res) => {
  if (!(await ensureMongo(res))) return;
  try {
    const doc = await loadConfig();
    res.json({ testEmail: (doc && doc.testEmail) || '' });
  } catch (err) {
    console.error('[email-testing] load config failed:', err.message);
    res.status(500).json({ error: 'Could not load the test email address.' });
  }
});

// ── POST /config — save the test email address ───────────────────────────
router.post('/config', async (req, res) => {
  if (!(await ensureMongo(res))) return;
  try {
    const testEmail = String((req.body && req.body.testEmail) || '').trim().toLowerCase();
    if (!testEmail) {
      return res.status(400).json({ error: 'Please enter a test email address.' });
    }
    if (!isValidEmail(testEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const admin = await resolveActingAdmin(req);
    await EmailTestConfig.findOneAndUpdate(
      { key: CONFIG_KEY },
      { $set: { testEmail, updatedByEmail: admin.email } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.json({ success: true, testEmail, message: 'Test email address saved successfully.' });
  } catch (err) {
    console.error('[email-testing] save config failed:', err.message);
    res.status(500).json({ error: 'Could not save the test email address.' });
  }
});

// ── POST /preview — render a template (NO send) ──────────────────────────
router.post('/preview', async (req, res) => {
  if (!(await ensureMongo(res))) return;
  try {
    const id = String((req.body && req.body.template) || '');
    if (!templates.isValidTemplate(id)) {
      return res.status(400).json({ error: 'Unknown or unsupported email template.' });
    }
    // Show the saved address inside the preview when we have one; otherwise a
    // neutral placeholder. Preview never sends, so the address is display-only.
    const cfg = await loadConfig();
    const previewTo = isValidEmail(cfg && cfg.testEmail) ? cfg.testEmail : 'test@example.com';

    const rendered = await templates.renderTemplate(id, previewTo);
    if (!rendered.ok) {
      return res.status(502).json({ error: rendered.error });
    }
    res.json({ success: true, template: id, name: rendered.name, subject: rendered.subject, html: rendered.html });
  } catch (err) {
    console.error('[email-testing] preview failed:', err.message);
    res.status(500).json({ error: 'Could not render the email preview.' });
  }
});

// ── POST /send — send a test email to the saved address ──────────────────
router.post('/send', async (req, res) => {
  if (!(await ensureMongo(res))) return;
  try {
    const id = String((req.body && req.body.template) || '');
    if (!templates.isValidTemplate(id)) {
      return res.status(400).json({ error: 'Unknown or unsupported email template.' });
    }

    // The recipient is ALWAYS the saved test address — never a client value.
    const cfg = await loadConfig();
    const testEmail = String((cfg && cfg.testEmail) || '').trim().toLowerCase();
    if (!isValidEmail(testEmail)) {
      return res.status(400).json({ error: 'Please save a valid test email address before sending.' });
    }

    const admin = await resolveActingAdmin(req);

    // Per-admin rate limit — count this admin's successful sends in the window.
    const since = new Date(Date.now() - RATE_WINDOW_MS);
    const recentCount = await EmailTestLog.countDocuments({
      sentByEmail: admin.email, status: 'sent', created_at: { $gte: since },
    }).catch(() => 0);
    if (recentCount >= RATE_MAX) {
      return res.status(429).json({ error: 'Too many test emails. Please wait before sending another test email.' });
    }

    const rendered = await templates.renderTemplate(id, testEmail);
    if (!rendered.ok) {
      return res.status(502).json({
        success: false,
        message: 'Test email could not be sent. Please check the email configuration and try again.',
        error: rendered.error,
      });
    }

    const result = await emailService.sendCustomEmail({
      to: testEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    const status = result && result.success ? 'sent' : 'failed';
    await EmailTestLog.create({
      template: id,
      templateName: rendered.name,
      recipient: testEmail,
      sentByEmail: admin.email,
      sentByName: admin.name,
      status,
      error: result && result.success ? '' : String((result && result.error) || 'Unknown error').slice(0, 300),
    }).catch((e) => console.error('[email-testing] log write failed:', e.message));

    if (!result || !result.success) {
      return res.status(502).json({
        success: false,
        message: 'Test email could not be sent. Please check the email configuration and try again.',
        error: (result && result.error) || 'Unknown error',
      });
    }

    res.json({ success: true, message: 'Test email sent successfully.' });
  } catch (err) {
    console.error('[email-testing] send failed:', err.message);
    res.status(500).json({
      success: false,
      message: 'Test email could not be sent. Please check the email configuration and try again.',
    });
  }
});

// ── GET /history — recent test-email activity ────────────────────────────
router.get('/history', async (req, res) => {
  if (!(await ensureMongo(res))) return;
  try {
    const rows = await EmailTestLog.find({})
      .sort({ created_at: -1 })
      .limit(HISTORY_LIMIT)
      .lean();
    const history = rows.map((r) => ({
      template: r.template,
      templateName: r.templateName || r.template,
      recipient: r.recipient || '',
      sentByName: r.sentByName || r.sentByEmail || 'Admin',
      status: r.status || 'sent',
      createdAt: r.created_at,
    }));
    res.json({ history });
  } catch (err) {
    console.error('[email-testing] history failed:', err.message);
    res.status(500).json({ error: 'Could not load the recent test emails.' });
  }
});

module.exports = router;

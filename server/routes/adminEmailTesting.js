// ============================================
// SaveHatke — Admin Email Testing Routes
// ============================================
// Protected, admin-only tool to preview and send TEST copies of the real
// production email templates to an admin-controlled test address, using safe
// dummy data. Mounted at /api/admin/email-testing.
//
// Storage lives in Supabase (the app's always-available store) under the
// shared `site_settings` key/value table — the same place maintenance mode is
// kept — so this tool does NOT depend on MongoDB being connected.
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
const supabase = require('../services/supabase');
const emailService = require('../services/emailService');
const templates = require('../services/emailTestingTemplates');

const router = express.Router();

// ── Config ───────────────────────────────────────────────────────────────
const CONFIG_KEY = 'email_testing_config';   // { testEmail }
const HISTORY_KEY = 'email_testing_history';  // { items: [...] }
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

// Resolve the acting admin from the authenticated session → { email, name }.
// Uses only the session/JWT claims so it never depends on MongoDB.
function actingAdmin(req) {
  const email = String((req.user && req.user.email) || '').toLowerCase().trim();
  let name = (req.user && req.user.name) ? String(req.user.name).trim() : '';
  if (!name) name = email || 'Admin';
  return { email, name };
}

async function loadTestEmail() {
  const row = await supabase.getSiteSetting(CONFIG_KEY);
  const val = (row && row.value) || {};
  return String(val.testEmail || '').trim().toLowerCase();
}

async function saveTestEmail(email, updatedBy) {
  await supabase.setSiteSetting(CONFIG_KEY, { testEmail: email }, updatedBy);
}

async function loadHistory() {
  const row = await supabase.getSiteSetting(HISTORY_KEY);
  const val = (row && row.value) || {};
  return Array.isArray(val.items) ? val.items : [];
}

async function saveHistory(items, updatedBy) {
  await supabase.setSiteSetting(HISTORY_KEY, { items: items.slice(0, HISTORY_LIMIT) }, updatedBy);
}

// All routes are admin-only.
router.use(authenticateToken, requireAdmin);

// Writes need Supabase configured; give a clear message instead of a raw 500.
function requireStore(res) {
  if (!supabase.isConfigured()) {
    res.status(503).json({ error: 'Email testing storage is not configured on the server.' });
    return false;
  }
  return true;
}

// ── GET /templates — catalog + filter categories ─────────────────────────
router.get('/templates', (req, res) => {
  res.json({ templates: templates.listTemplates(), categories: templates.CATEGORIES });
});

// ── GET /config — the saved test email address ───────────────────────────
router.get('/config', async (req, res) => {
  try {
    const testEmail = await loadTestEmail();
    res.json({ testEmail });
  } catch (err) {
    console.error('[email-testing] load config failed:', err.message);
    res.json({ testEmail: '' }); // never block the page on a read hiccup
  }
});

// ── POST /config — save the test email address ───────────────────────────
router.post('/config', async (req, res) => {
  if (!requireStore(res)) return;
  try {
    const testEmail = String((req.body && req.body.testEmail) || '').trim().toLowerCase();
    if (!testEmail) {
      return res.status(400).json({ error: 'Please enter a test email address.' });
    }
    if (!isValidEmail(testEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const admin = actingAdmin(req);
    await saveTestEmail(testEmail, admin.email);
    res.json({ success: true, testEmail, message: 'Test email address saved successfully.' });
  } catch (err) {
    console.error('[email-testing] save config failed:', err.message);
    res.status(500).json({ error: 'Could not save the test email address. Please try again.' });
  }
});

// ── POST /preview — render a template (NO send) ──────────────────────────
router.post('/preview', async (req, res) => {
  try {
    const id = String((req.body && req.body.template) || '');
    if (!templates.isValidTemplate(id)) {
      return res.status(400).json({ error: 'Unknown or unsupported email template.' });
    }
    // Show the saved address inside the preview when we have one; otherwise a
    // neutral placeholder. Preview never sends, so the address is display-only.
    let previewTo = 'test@example.com';
    try {
      const saved = await loadTestEmail();
      if (isValidEmail(saved)) previewTo = saved;
    } catch (_) { /* use placeholder */ }

    // Preview colour scheme — 'light' (the original design) or 'dark'. Preview
    // only; it never changes what a real/test send delivers.
    const rawMode = String((req.body && req.body.mode) || 'light').toLowerCase();
    const mode = rawMode === 'dark' ? 'dark' : 'light';

    const rendered = await templates.renderTemplate(id, previewTo, mode);
    if (!rendered.ok) {
      return res.status(502).json({ error: rendered.error });
    }
    res.json({ success: true, template: id, mode, name: rendered.name, subject: rendered.subject, html: rendered.html });
  } catch (err) {
    console.error('[email-testing] preview failed:', err.message);
    res.status(500).json({ error: 'Could not render the email preview.' });
  }
});

// ── POST /send — send a test email to the saved address ──────────────────
router.post('/send', async (req, res) => {
  if (!requireStore(res)) return;
  try {
    const id = String((req.body && req.body.template) || '');
    if (!templates.isValidTemplate(id)) {
      return res.status(400).json({ error: 'Unknown or unsupported email template.' });
    }

    // The recipient is ALWAYS the saved test address — never a client value.
    const testEmail = await loadTestEmail();
    if (!isValidEmail(testEmail)) {
      return res.status(400).json({ error: 'Please save a valid test email address before sending.' });
    }

    const admin = actingAdmin(req);

    // Per-admin rate limit — count this admin's successful sends in the window.
    const history = await loadHistory();
    const windowStart = Date.now() - RATE_WINDOW_MS;
    const recentCount = history.filter((h) => h
      && h.status === 'sent'
      && String(h.sentByEmail || '').toLowerCase() === admin.email
      && h.createdAt && new Date(h.createdAt).getTime() >= windowStart).length;
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
      sender: rendered.sender,
    });

    const status = result && result.success ? 'sent' : 'failed';
    // Prepend a metadata-only log entry (no email body, no sensitive data).
    const entry = {
      template: id,
      templateName: rendered.name,
      recipient: testEmail,
      sentByEmail: admin.email,
      sentByName: admin.name,
      status,
      error: result && result.success ? '' : String((result && result.error) || 'Unknown error').slice(0, 300),
      createdAt: new Date().toISOString(),
    };
    try {
      await saveHistory([entry, ...history], admin.email);
    } catch (e) {
      console.error('[email-testing] history write failed:', e.message);
    }

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
  try {
    const items = await loadHistory();
    const history = items.slice(0, HISTORY_LIMIT).map((r) => ({
      template: r.template,
      templateName: r.templateName || r.template,
      recipient: r.recipient || '',
      sentByName: r.sentByName || r.sentByEmail || 'Admin',
      status: r.status || 'sent',
      createdAt: r.createdAt,
    }));
    res.json({ history });
  } catch (err) {
    console.error('[email-testing] history failed:', err.message);
    res.json({ history: [] });
  }
});

module.exports = router;

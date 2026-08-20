// ============================================
// SaveHatke — Gmail Admin Routes
// Mounted at /api/admin/gmail behind JWT admin auth.
// All Gmail tokens stay server-side.
// ============================================

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const { authenticateToken, requireAdmin } = require('../middleware/auth');
const GmailConnection = require('../models/GmailConnection');
const GmailAuditLog = require('../models/GmailAuditLog');
const { encryptSecret } = require('../services/gmailCrypto');
const { buildRawMessage, parseAddressList, htmlToText } = require('../services/gmailMime');
const gmailService = require('../services/gmailService');

const router = express.Router();

const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

// ── Rate limits ──────────────────────────────────────────────────────────────
const gmailApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many Gmail requests. Please slow down.' },
});
const gmailAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many OAuth attempts. Please try again later.' },
});

router.use(gmailApiLimiter);

// ── Helpers ──────────────────────────────────────────────────────────────────
function getJwtSecret() {
  return process.env.JWT_SECRET || 'savehatke_dev_secret_key';
}

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
}

// Best-effort audit log — never blocks the main action
async function audit(req, action, targetId = '', details = '') {
  try {
    await GmailAuditLog.create({
      admin_user_id: String(req.user?.id || ''),
      admin_email: String(req.user?.email || ''),
      action,
      target_id: String(targetId || '').slice(0, 200),
      details: String(details || '').slice(0, 500),
      ip: clientIp(req),
    });
  } catch (e) {
    console.warn('Gmail audit log notice:', e.message);
  }
}

/** Map Google API errors to friendly HTTP responses */
function handleGmailError(res, err, context = 'Gmail request failed') {
  const status = err?.response?.status || err?.code || 500;
  const msg = err?.response?.data?.error?.message || err?.message || '';
  if (status === 401 || /invalid_grant|Token has been expired|re-authenticate/i.test(msg)) {
    return res.status(401).json({ error: 'Gmail connection expired. Please disconnect and reconnect Gmail.', expired: true });
  }
  if (status === 403) {
    return res.status(403).json({ error: `Gmail permission denied: ${msg.slice(0, 200)}` });
  }
  if (status === 404) {
    return res.status(404).json({ error: 'Message not found.' });
  }
  if (status === 429) {
    return res.status(429).json({ error: 'Gmail API rate limit reached. Please try again in a moment.' });
  }
  console.error(`${context}:`, msg);
  return res.status(502).json({ error: `${context}. Please try again.` });
}

/** Load an authorized Gmail client for the current admin, or 400/401 out. */
async function requireGmail(req, res) {
  if (!gmailService.isOAuthConfigured()) {
    res.status(503).json({ error: 'Gmail OAuth is not configured. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the server.' });
    return null;
  }
  const auth = await gmailService.getAuthorizedClient(req.user.id);
  if (!auth) {
    res.status(400).json({ error: 'Gmail is not connected.', connected: false });
    return null;
  }
  return auth;
}

// ── Connection status ────────────────────────────────────────────────────────
// GET /api/admin/gmail/status
router.get('/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!gmailService.isOAuthConfigured()) {
      return res.json({ configured: false, connected: false });
    }
    const conn = await GmailConnection.findOne({ admin_user_id: String(req.user.id) });
    if (!conn) return res.json({ configured: true, connected: false });

    let unreadCounts = null;
    try {
      const auth = await gmailService.getAuthorizedClient(req.user.id);
      if (auth) unreadCounts = await gmailService.getUnreadCounts(auth.gmail);
    } catch (e) { /* non-fatal */ }

    res.json({
      configured: true,
      connected: true,
      gmailEmail: conn.gmail_email,
      unreadCounts,
      watchExpiration: conn.watch_expiration,
      connectedAt: conn.created_at,
    });
  } catch (err) {
    console.error('Gmail status error:', err.message);
    res.status(500).json({ error: 'Failed to load Gmail status.' });
  }
});

// ── OAuth flow ───────────────────────────────────────────────────────────────
// POST /api/admin/gmail/auth/url — returns a short-lived signed start URL.
// Browser redirects cannot send Authorization headers, so the admin session is
// exchanged for a 5-minute single-purpose token carried in the query string.
router.post('/auth/url', gmailAuthLimiter, authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!gmailService.isOAuthConfigured()) {
      return res.status(503).json({ error: 'Gmail OAuth is not configured on the server.' });
    }
    const ot = jwt.sign(
      { adminId: req.user.id, email: req.user.email, purpose: 'gmail-oauth-start' },
      getJwtSecret(),
      { expiresIn: '5m' }
    );
    res.json({ url: `/api/admin/gmail/auth?ot=${encodeURIComponent(ot)}` });
  } catch (err) {
    console.error('Gmail auth url error:', err.message);
    res.status(500).json({ error: 'Failed to prepare Gmail connection.' });
  }
});

// GET /api/admin/gmail/auth — redirect admin to Google consent screen
router.get('/auth', gmailAuthLimiter, async (req, res) => {
  try {
    // Accept either a Bearer admin token or the signed one-time start token
    let admin = req.user;
    if (!admin && req.query.ot) {
      try {
        const decoded = jwt.verify(String(req.query.ot), getJwtSecret());
        if (decoded.purpose === 'gmail-oauth-start' && decoded.adminId) {
          admin = { id: decoded.adminId, email: decoded.email };
        }
      } catch (e) { /* invalid/expired start token */ }
    }
    if (!admin) return res.status(401).json({ error: 'Admin authentication required.' });

    if (!gmailService.isOAuthConfigured()) {
      return res.status(503).send('Gmail OAuth is not configured on the server.');
    }
    // Signed, short-lived state — prevents CSRF on the OAuth callback
    const state = jwt.sign(
      { adminId: admin.id, email: admin.email, nonce: crypto.randomBytes(8).toString('hex') },
      getJwtSecret(),
      { expiresIn: '10m' }
    );
    const url = gmailService.buildAuthUrl(state);
    res.redirect(url);
  } catch (err) {
    console.error('Gmail auth redirect error:', err.message);
    res.status(500).json({ error: 'Failed to start Gmail connection.' });
  }
});

// GET /api/admin/gmail/callback — Google redirects back here
router.get('/callback', gmailAuthLimiter, async (req, res) => {
  const done = (ok, message = '') => {
    const qs = ok ? '?gmail=connected' : `?gmail=error&msg=${encodeURIComponent(message || 'Connection failed')}`;
    res.redirect(`${APP_BASE_URL}/admin-gmail.html${qs}`);
  };

  try {
    const { code, state, error } = req.query;
    if (error) return done(false, 'Google sign-in was cancelled.');
    if (!code || !state) return done(false, 'Missing OAuth parameters.');

    // Validate state signature + expiry (binds the flow to the admin session)
    let decoded;
    try {
      decoded = jwt.verify(String(state), getJwtSecret());
    } catch (e) {
      return done(false, 'OAuth state validation failed. Please try again.');
    }
    if (!decoded.adminId) return done(false, 'Invalid OAuth state.');

    const tokens = await gmailService.exchangeCode(String(code));
    if (!tokens.refresh_token) {
      return done(false, 'Google did not return a refresh token. Disconnect SaveHatke from your Google account and reconnect.');
    }

    // Identify the connected Gmail address via Gmail profile
    const { google } = require('googleapis');
    const oauth2 = gmailService.getOAuth2Client();
    oauth2.setCredentials({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const gmailEmail = String(profile.data.emailAddress || '').toLowerCase();
    if (!gmailEmail) return done(false, 'Could not read the Gmail address.');

    const encrypted = encryptSecret(tokens.refresh_token);

    await GmailConnection.findOneAndUpdate(
      { admin_user_id: String(decoded.adminId) },
      {
        $set: {
          admin_email: String(decoded.email || ''),
          gmail_email: gmailEmail,
          encrypted_refresh_token: encrypted,
          granted_scopes: String(tokens.scope || ''),
          access_token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          history_id: String(profile.data.historyId || ''),
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    req.user = { id: decoded.adminId, email: decoded.email };
    await audit(req, 'gmail.connect', gmailEmail);
    return done(true);
  } catch (err) {
    console.error('Gmail callback error:', err.message);
    return done(false, 'Token exchange failed. Please try again.');
  }
});

// POST /api/admin/gmail/disconnect
router.post('/disconnect', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const conn = await GmailConnection.findOne({ admin_user_id: String(req.user.id) });
    await gmailService.disconnect(req.user.id);
    await audit(req, 'gmail.disconnect', conn?.gmail_email || '');
    res.json({ ok: true });
  } catch (err) {
    console.error('Gmail disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect Gmail.' });
  }
});

// ── Labels ───────────────────────────────────────────────────────────────────
// GET /api/admin/gmail/labels
router.get('/labels', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;
    const labels = await gmailService.listLabels(auth.gmail);
    const counts = await gmailService.getUnreadCounts(auth.gmail);
    res.json({ labels, unreadCounts: counts });
  } catch (err) {
    handleGmailError(res, err, 'Failed to load labels');
  }
});

// ── Message list ─────────────────────────────────────────────────────────────
// GET /api/admin/gmail/messages?folder=inbox&labelId=&q=&pageToken=&maxResults=
router.get('/messages', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;

    const result = await gmailService.listMessages(auth.gmail, {
      folder: req.query.folder,
      labelId: req.query.labelId,
      q: req.query.q,
      pageToken: req.query.pageToken,
      maxResults: req.query.maxResults,
    });
    res.json(result);
  } catch (err) {
    handleGmailError(res, err, 'Failed to load messages');
  }
});

// ── Message detail ───────────────────────────────────────────────────────────
// GET /api/admin/gmail/messages/:id
router.get('/messages/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;
    if (!/^[\w-]{1,200}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid message id.' });

    const message = await gmailService.getMessageFull(auth.gmail, req.params.id);
    await audit(req, 'gmail.read', req.params.id, message.subject);
    res.json({ message });
  } catch (err) {
    handleGmailError(res, err, 'Failed to load message');
  }
});

// ── Label operations (read/unread/star/archive/trash/restore/move) ──────────
const LABEL_OPS = {
  read: { remove: ['UNREAD'], add: [] },
  unread: { add: ['UNREAD'], remove: [] },
  star: { add: ['STARRED'], remove: [] },
  unstar: { remove: ['STARRED'], add: [] },
  archive: { remove: ['INBOX'], add: [] },
  trash: { remove: ['INBOX', 'SENT', 'DRAFT', 'SPAM'], add: ['TRASH'] },
  restore: { remove: ['TRASH', 'SPAM'], add: ['INBOX'] },
};

async function applyLabelOp(gmail, id, op) {
  const def = LABEL_OPS[op];
  if (!def) throw new Error('Unknown operation');
  await gmail.users.messages.modify({
    userId: 'me',
    id,
    requestBody: { addLabelIds: def.add, removeLabelIds: def.remove },
  });
}

// POST /api/admin/gmail/messages/:id/(read|unread|star|unstar|archive|trash|restore)
Object.keys(LABEL_OPS).forEach((op) => {
  router.post(`/messages/:id/${op}`, authenticateToken, requireAdmin, async (req, res) => {
    try {
      const auth = await requireGmail(req, res);
      if (!auth) return;
      if (!/^[\w-]{1,200}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid message id.' });

      await applyLabelOp(auth.gmail, req.params.id, op);
      await audit(req, `gmail.${op}`, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      handleGmailError(res, err, `Failed to ${op} message`);
    }
  });
});

// POST /api/admin/gmail/messages/:id/move — move between labels/folders
router.post('/messages/:id/move', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;
    if (!/^[\w-]{1,200}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid message id.' });

    const { addLabelIds, removeLabelIds } = req.body || {};
    const sanitizeIds = (ids) => (Array.isArray(ids) ? ids.filter((i) => /^[\w-]{1,100}$/.test(String(i))).slice(0, 20) : []);

    await auth.gmail.users.messages.modify({
      userId: 'me',
      id: req.params.id,
      requestBody: { addLabelIds: sanitizeIds(addLabelIds), removeLabelIds: sanitizeIds(removeLabelIds) },
    });
    await audit(req, 'gmail.move', req.params.id, JSON.stringify({ addLabelIds, removeLabelIds }).slice(0, 200));
    res.json({ ok: true });
  } catch (err) {
    handleGmailError(res, err, 'Failed to move message');
  }
});

// ── Bulk actions ─────────────────────────────────────────────────────────────
// POST /api/admin/gmail/messages/bulk — { ids: [], action: read|unread|star|unstar|archive|trash|restore }
router.post('/messages/bulk', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;

    const { ids, action } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) {
      return res.status(400).json({ error: 'Provide 1–100 message ids.' });
    }
    if (!LABEL_OPS[action]) return res.status(400).json({ error: 'Unknown bulk action.' });

    const cleanIds = ids.filter((i) => /^[\w-]{1,200}$/.test(String(i)));
    const def = LABEL_OPS[action];
    await auth.gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: { ids: cleanIds, addLabelIds: def.add, removeLabelIds: def.remove },
    });
    await audit(req, `gmail.bulk.${action}`, '', `${cleanIds.length} messages`);
    res.json({ ok: true, count: cleanIds.length });
  } catch (err) {
    handleGmailError(res, err, 'Bulk action failed');
  }
});

// DELETE /api/admin/gmail/messages/:id — permanent delete
router.delete('/messages/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;
    if (!/^[\w-]{1,200}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid message id.' });

    await auth.gmail.users.messages.delete({ userId: 'me', id: req.params.id });
    await audit(req, 'gmail.delete', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleGmailError(res, err, 'Failed to delete message');
  }
});

// ── Send / Reply / Forward ───────────────────────────────────────────────────
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB each

function validateAttachments(attachments) {
  if (!attachments) return [];
  if (!Array.isArray(attachments)) throw new Error('Attachments must be an array.');
  if (attachments.length > MAX_ATTACHMENTS) throw new Error(`Maximum ${MAX_ATTACHMENTS} attachments allowed.`);

  return attachments.map((att) => {
    const filename = String(att.filename || 'attachment').slice(0, 200);
    const data = String(att.data || '').replace(/\s+/g, '');
    const byteSize = Math.floor(data.length * 0.75);
    if (byteSize > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment "${filename}" exceeds 10 MB.`);
    if (data.length > 14 * 1024 * 1024) throw new Error(`Attachment "${filename}" is too large.`);
    return { filename, mimeType: att.mimeType, data };
  });
}

function validateComposeBody(body) {
  const to = parseAddressList(body.to);
  const cc = parseAddressList(body.cc);
  const bcc = parseAddressList(body.bcc);
  if (!to.length && !cc.length && !bcc.length) throw new Error('At least one recipient is required.');
  const subject = String(body.subject || '').slice(0, 1000);
  const bodyHtml = String(body.bodyHtml || '').slice(0, 500 * 1024);
  const bodyText = String(body.bodyText || htmlToText(bodyHtml)).slice(0, 500 * 1024);
  const attachments = validateAttachments(body.attachments);
  return { to, cc, bcc, subject, bodyHtml, bodyText, attachments };
}

// POST /api/admin/gmail/send
router.post('/send', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;

    let fields;
    try {
      fields = validateComposeBody(req.body || {});
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const raw = buildRawMessage(fields);
    const sendBody = { raw };
    if (req.body.threadId && /^[\w-]{1,200}$/.test(String(req.body.threadId))) {
      sendBody.threadId = String(req.body.threadId);
    }
    const r = await auth.gmail.users.messages.send({ userId: 'me', requestBody: sendBody });
    await audit(req, 'gmail.send', r.data.id, fields.subject);
    res.json({ ok: true, id: r.data.id, threadId: r.data.threadId });
  } catch (err) {
    handleGmailError(res, err, 'Failed to send email');
  }
});

// POST /api/admin/gmail/messages/:id/reply — { to, cc, bcc, bodyText/bodyHtml, replyAll }
router.post('/messages/:id/reply', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;
    if (!/^[\w-]{1,200}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid message id.' });

    const original = await gmailService.getMessageFull(auth.gmail, req.params.id);
    const body = req.body || {};

    // Recipients: explicit values win; otherwise derive from original headers
    let fields;
    try {
      fields = validateComposeBody({
        to: body.to || '',
        cc: body.cc || '',
        bcc: body.bcc || '',
        subject: original.subject?.startsWith('Re:') ? original.subject : `Re: ${original.subject || ''}`,
        bodyHtml: body.bodyHtml,
        bodyText: body.bodyText,
        attachments: [],
      });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const raw = buildRawMessage({
      ...fields,
      inReplyTo: original.messageIdHeader || undefined,
      references: [original.references, original.messageIdHeader].filter(Boolean).join(' '),
    });

    const r = await auth.gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId: original.threadId },
    });
    await audit(req, 'gmail.reply', req.params.id, original.subject);
    res.json({ ok: true, id: r.data.id });
  } catch (err) {
    handleGmailError(res, err, 'Failed to send reply');
  }
});

// POST /api/admin/gmail/messages/:id/forward — { to, cc, bcc, comment }
router.post('/messages/:id/forward', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;
    if (!/^[\w-]{1,200}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid message id.' });

    const original = await gmailService.getMessageFull(auth.gmail, req.params.id);
    const body = req.body || {};

    const comment = String(body.comment || '').slice(0, 20000);
    const forwardedBlock = [
      comment ? `${comment}\n\n` : '',
      '---------- Forwarded message ----------',
      `From: ${original.from}`,
      `Date: ${original.date}`,
      `Subject: ${original.subject}`,
      `To: ${original.to}`,
      '',
      original.bodyText || '(HTML-only message)',
    ].join('\n');

    let fields;
    try {
      fields = validateComposeBody({
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        subject: original.subject?.startsWith('Fwd:') ? original.subject : `Fwd: ${original.subject || ''}`,
        bodyText: forwardedBlock,
        bodyHtml: '',
      });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const raw = buildRawMessage(fields);
    const r = await auth.gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    await audit(req, 'gmail.forward', req.params.id, original.subject);
    res.json({ ok: true, id: r.data.id });
  } catch (err) {
    handleGmailError(res, err, 'Failed to forward email');
  }
});

// ── Drafts ───────────────────────────────────────────────────────────────────
// POST /api/admin/gmail/drafts — create draft
router.post('/drafts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;

    let fields;
    try {
      fields = validateComposeBody({ ...(req.body || {}), to: req.body?.to || req.body?.cc || req.body?.bcc ? req.body.to : '' });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const raw = buildRawMessage(fields);
    const r = await auth.gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
    await audit(req, 'gmail.draft.create', r.data.id, fields.subject);
    res.json({ ok: true, id: r.data.id });
  } catch (err) {
    handleGmailError(res, err, 'Failed to save draft');
  }
});

// PUT /api/admin/gmail/drafts/:id — update draft
router.put('/drafts/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;
    if (!/^[\w-]{1,200}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid draft id.' });

    let fields;
    try {
      fields = validateComposeBody(req.body || {});
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const raw = buildRawMessage(fields);
    const r = await auth.gmail.users.drafts.update({
      userId: 'me',
      id: req.params.id,
      requestBody: { message: { raw } },
    });
    await audit(req, 'gmail.draft.update', req.params.id, fields.subject);
    res.json({ ok: true, id: r.data.id });
  } catch (err) {
    handleGmailError(res, err, 'Failed to update draft');
  }
});

// POST /api/admin/gmail/drafts/:id/send — send an existing draft
router.post('/drafts/:id/send', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;
    if (!/^[\w-]{1,200}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid draft id.' });

    const r = await auth.gmail.users.drafts.send({ userId: 'me', requestBody: { id: req.params.id } });
    await audit(req, 'gmail.draft.send', req.params.id);
    res.json({ ok: true, id: r.data.id });
  } catch (err) {
    handleGmailError(res, err, 'Failed to send draft');
  }
});

// DELETE /api/admin/gmail/drafts/:id — discard draft
router.delete('/drafts/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;
    if (!/^[\w-]{1,200}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid draft id.' });

    await auth.gmail.users.drafts.delete({ userId: 'me', id: req.params.id });
    await audit(req, 'gmail.draft.delete', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleGmailError(res, err, 'Failed to delete draft');
  }
});

// ── Attachments ──────────────────────────────────────────────────────────────
// GET /api/admin/gmail/attachments/:messageId/:attachmentId
router.get('/attachments/:messageId/:attachmentId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;

    const { messageId, attachmentId } = req.params;
    if (!/^[\w-]{1,200}$/.test(messageId) || !/^[\w-]{1,300}$/.test(attachmentId)) {
      return res.status(400).json({ error: 'Invalid attachment reference.' });
    }

    // Filename + size come from message metadata (server-side, not client-supplied)
    const meta = await gmailService.getMessageFull(auth.gmail, messageId);
    const att = (meta.attachments || []).find((a) => a.attachmentId === attachmentId);
    const filename = (att?.filename || 'attachment').replace(/[^\w.\- ()]/g, '_').slice(0, 200);
    const size = att?.size || 0;

    // Hard server-side size guard (25 MB)
    if (size > 25 * 1024 * 1024) {
      return res.status(413).json({ error: 'Attachment exceeds the 25 MB download limit.' });
    }

    const r = await auth.gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
    const data = Buffer.from(String(r.data.data || ''), 'base64url');

    await audit(req, 'gmail.attachment.download', messageId, filename);

    res.setHeader('Content-Type', /^[\w./+-]+$/.test(att?.mimeType || '') ? att.mimeType : 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', data.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.send(data);
  } catch (err) {
    handleGmailError(res, err, 'Failed to download attachment');
  }
});

// ── Sync / changes ───────────────────────────────────────────────────────────
// GET /api/admin/gmail/changes — lightweight change detection via historyId
router.get('/changes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;

    const profile = await auth.gmail.users.getProfile({ userId: 'me' });
    const currentHistoryId = String(profile.data.historyId || '');
    const stored = String(auth.conn.history_id || '');

    const changed = currentHistoryId !== stored;
    if (changed && currentHistoryId) {
      await GmailConnection.updateOne({ _id: auth.conn._id }, { $set: { history_id: currentHistoryId } });
    }

    res.json({
      changed,
      historyId: currentHistoryId,
      unreadCount: profile.data.messagesUnread || 0,
      watchExpired: !!(auth.conn.watch_expiration && new Date(auth.conn.watch_expiration) < new Date()),
    });
  } catch (err) {
    handleGmailError(res, err, 'Failed to check for changes');
  }
});

// POST /api/admin/gmail/watch — (re)start Pub/Sub push watch (best-effort)
router.post('/watch', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const auth = await requireGmail(req, res);
    if (!auth) return;

    const project = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const topic = process.env.GOOGLE_PUBSUB_TOPIC;
    if (!project || !topic) {
      return res.status(400).json({ error: 'Push notifications are not configured (GOOGLE_CLOUD_PROJECT_ID / GOOGLE_PUBSUB_TOPIC missing). Polling fallback is active.' });
    }

    const pushToken = crypto.randomBytes(16).toString('hex');
    const r = await auth.gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: `projects/${project}/topics/${topic}`,
        labelFilterBehavior: 'INCLUDE',
        labelIds: ['INBOX'],
      },
    });

    await GmailConnection.updateOne(
      { _id: auth.conn._id },
      { $set: { watch_expiration: new Date(Number(r.data.expiration)), watch_push_token: pushToken, history_id: String(r.data.historyId || '') } }
    );
    await audit(req, 'gmail.watch.start', '', `expires ${r.data.expiration}`);
    res.json({ ok: true, expiration: r.data.expiration });
  } catch (err) {
    handleGmailError(res, err, 'Failed to start Gmail watch');
  }
});

// POST /api/admin/gmail/push — Google Pub/Sub push endpoint (no admin session).
// Secured by a per-connection signed push token embedded in the subscription URL.
router.post('/push', async (req, res) => {
  try {
    const msg = req.body?.message;
    if (!msg?.data) return res.status(400).json({ error: 'Bad notification.' });

    let payload = {};
    try {
      payload = JSON.parse(Buffer.from(String(msg.data), 'base64').toString('utf8'));
    } catch (e) {
      return res.status(400).json({ error: 'Bad notification payload.' });
    }

    const email = String(payload.emailAddress || '').toLowerCase();
    const pushToken = String(msg.attributes?.pushToken || req.query.token || '');
    if (!email || !pushToken) return res.status(400).json({ error: 'Incomplete notification.' });

    const conn = await GmailConnection.findOne({ gmail_email: email });
    if (!conn || conn.watch_push_token !== pushToken) {
      // Never reveal whether the account exists
      return res.status(200).json({ ok: true });
    }

    // Refresh historyId so the admin panel picks up the change on next poll
    await GmailConnection.updateOne({ _id: conn._id }, { $set: { history_id: String(payload.historyId || conn.history_id) } });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.warn('Gmail push notice:', err.message);
    res.status(200).json({ ok: true });
  }
});

// ── Audit log viewer (admin) ─────────────────────────────────────────────────
// GET /api/admin/gmail/audit
router.get('/audit', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const logs = await GmailAuditLog.find().sort({ created_at: -1 }).limit(200).lean();
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load audit logs.' });
  }
});

module.exports = router;

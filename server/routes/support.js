// ============================================
// SaveHatke — Support Routes
// ============================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { optionalAuth, authenticateToken } = require('../middleware/auth');
const db = require('../services/googleSheets');
const emailService = require('../services/emailService');
const { verifyTurnstile } = require('../utils/turnstile');

const router = express.Router();

const ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024; // 3MB
const ATTACHMENT_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain'];
const ATTACHMENT_BUCKET = 'support-attachments';

const REPLY_MAX_CHARS = 4000;
// A user may only add to a case support is still working on. A resolved or
// closed case is read-only; reopening it is an admin action.
const REPLYABLE_STATUSES = ['open', 'inprogress'];

/** Canonical status key: 'in_progress' / 'In Progress' / 'investigating' → 'inprogress'. */
function normStatus(s) {
  const v = String(s || 'open').toLowerCase().trim().replace(/[\s_-]+/g, '');
  if (v === 'investigating') return 'inprogress';
  return ['open', 'inprogress', 'resolved', 'closed'].includes(v) ? v : 'open';
}

/**
 * Read a ticket's reply thread.
 *
 * The `messages` column was added after the sheet already held tickets, so an
 * older row has no value there. Those cases still have one real support reply —
 * the admin's `resolution` note — so it is folded into the thread here instead
 * of being surfaced as a separate orphan field in the UI.
 */
function parseThread(ticket) {
  let thread = [];
  const raw = ticket.messages;
  if (raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        thread = parsed
          .filter((m) => m && m.body)
          .map((m) => ({
            from: m.from === 'support' ? 'support' : 'user',
            body: String(m.body).slice(0, REPLY_MAX_CHARS),
            at: m.at || '',
          }));
      }
    } catch (e) {
      // A hand-edited cell must not break the whole case list.
      console.warn(`[support] Could not parse messages for ticket ${ticket.id}:`, e.message);
    }
  }

  const resolution = String(ticket.resolution || '').trim();
  if (resolution && !thread.some((m) => m.from === 'support' && m.body === resolution)) {
    thread.push({
      from: 'support',
      body: resolution,
      at: ticket.resolvedAt || ticket.updatedAt || ticket.createdAt || '',
    });
  }

  return thread.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
}

/** Shape one ticket for its owner's dashboard. */
function toClientTicket(t) {
  const thread = parseThread(t);
  const lastReplyAt = thread.length ? thread[thread.length - 1].at : '';
  return {
    id: t.id,
    subject: t.subject,
    message: t.message,
    status: normStatus(t.status),
    createdAt: t.createdAt,
    // Newest real signal wins, so a case replied to today does not still read
    // "updated 3 weeks ago" from its created date.
    updatedAt: [t.updatedAt, t.resolvedAt, lastReplyAt, t.createdAt]
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || t.createdAt,
    resolvedAt: t.resolvedAt,
    messages: thread,
    attachmentUrl: t.attachmentUrl || '',
    attachmentName: t.attachmentName || '',
  };
}

// POST /api/support/attachment — Upload a support ticket attachment to Supabase Storage
router.post('/attachment', optionalAuth, async (req, res) => {
  try {
    const { filename, contentType, dataBase64 } = req.body;

    if (!dataBase64 || !filename) {
      return res.status(400).json({ error: 'filename and dataBase64 are required.' });
    }
    const type = String(contentType || '').toLowerCase().split(';')[0].trim();
    if (!ATTACHMENT_ALLOWED_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Unsupported file type. Allowed: PNG, JPG, WEBP, GIF, PDF, TXT.' });
    }

    const buffer = Buffer.from(dataBase64, 'base64');
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: 'File could not be read.' });
    }
    if (buffer.length > ATTACHMENT_MAX_BYTES) {
      return res.status(400).json({ error: 'File is too large. Maximum size is 3MB.' });
    }

    const supabase = require('../services/supabase').getClient();
    if (!supabase) {
      return res.status(503).json({ error: 'Attachment uploads are temporarily unavailable.' });
    }

    // Ensure the bucket exists (created once, then reused)
    const buckets = await supabase.storage.listBuckets();
    const exists = (buckets.data || []).some((b) => b.name === ATTACHMENT_BUCKET);
    if (!exists) {
      const created = await supabase.storage.createBucket(ATTACHMENT_BUCKET, { public: true });
      if (created.error) throw new Error(created.error.message);
    }

    const ext = (String(filename).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const path = `tickets/${uuidv4()}-${safeName || 'attachment' + ext}`;

    const upload = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .upload(path, buffer, { contentType: type, upsert: false });
    if (upload.error) throw new Error(upload.error.message);

    const { data: urlData } = supabase.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path);
    res.status(201).json({ url: urlData.publicUrl, path, name: filename });
  } catch (err) {
    console.error('Support attachment error:', err);
    res.status(500).json({ error: 'Failed to upload attachment.' });
  }
});

// POST /api/support/ticket — Submit a support ticket
router.post('/ticket', optionalAuth, async (req, res) => {
  try {
    const { name, email, subject, message, attachmentUrl, attachmentName } = req.body;

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ error: 'All fields are required: name, email, subject, message.' });
    }

    // Same shared CAPTCHA verifier as the OTP route: fails open when the
    // Turnstile infrastructure is the thing that's broken, closed on a real
    // rejection from Cloudflare.
    const captcha = await verifyTurnstile(req, 'support-ticket');
    if (!captcha.ok) {
      return res.status(400).json({ error: captcha.error });
    }

    // Only accept attachment URLs that point at our own storage
    let safeAttachmentUrl = '';
    if (attachmentUrl) {
      const supabaseUrl = process.env.SUPABASE_URL || '';
      if (supabaseUrl && String(attachmentUrl).startsWith(supabaseUrl + '/storage/')) {
        safeAttachmentUrl = String(attachmentUrl).slice(0, 500);
      }
    }

    const storageError = db.getWriteAvailabilityError(
      'Support ticket submission is temporarily unavailable because Google Sheets is not connected.'
    );
    if (storageError) {
      return res.status(503).json(storageError);
    }

    const ticket = {
      id: uuidv4(),
      name: name.trim(),
      userEmail: email.toLowerCase().trim(),
      subject: subject.trim(),
      message: message.trim(),
      status: 'open',
      createdAt: new Date().toISOString(),
      resolvedAt: '',
      resolution: '',
      attachmentUrl: safeAttachmentUrl,
      attachmentName: attachmentName ? String(attachmentName).slice(0, 120) : '',
      // A new case starts with no replies. The opening message stays in
      // `message` so it keeps rendering as the original report, separate from
      // the thread that grows underneath it.
      updatedAt: new Date().toISOString(),
      messages: '[]',
    };

    await db.appendRow(db.SHEETS.SUPPORT_TICKETS, ticket);

    // Send the "request received" acknowledgment email.
    // IMPORTANT: this MUST be awaited, not fire-and-forget. On Vercel the
    // serverless function is frozen the instant the HTTP response is sent,
    // which kills any in-flight SMTP connection — so a detached
    // .then()/.catch() send never actually goes out in production (this was
    // the root cause of "support email not going"). We await it and swallow
    // any error so a mail failure still can't fail the submission: the ticket
    // row was already saved above.
    try {
      const r = await emailService.sendSupportAckEmail({
        to: ticket.userEmail,
        userName: ticket.name,
        caseId: ticket.id,
        subject: ticket.subject,
        createdAt: ticket.createdAt,
        message: ticket.message,
      });
      if (r && r.success) {
        console.log(`📧 [Support] Ack email sent to ${ticket.userEmail} for case #${ticket.id} (messageId=${r.messageId})`);
      } else if (r && r.isSimulated) {
        console.warn(`📧 [Support] Ack email NOT sent for case #${ticket.id} → ${ticket.userEmail}`);
        console.warn(`   Reason: ${r.error || 'SMTP not configured'}`);
        console.warn(`   Fix: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in your .env (or SUPPORT_EMAIL + SUPPORT_EMAIL_PASSWORD for a dedicated support mailbox).`);
      } else {
        console.warn(`📧 [Support] Ack email FAILED for case #${ticket.id} → ${ticket.userEmail}: ${(r && r.error) || 'unknown error'}`);
      }
    } catch (e) {
      console.warn('📧 [Support] Ack email unexpected error:', e && e.message ? e.message : e);
    }

    res.status(201).json({
      message: 'Support ticket submitted successfully. We will get back to you within 24 hours.',
      ticketId: ticket.id,
    });
  } catch (err) {
    console.error('Support ticket error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/support/tickets — Get tickets (for logged-in users or all for admin)
router.get('/tickets', optionalAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Login required to view your tickets.' });
    }

    let tickets;
    if (req.user.role === 'admin') {
      tickets = await db.getRows(db.SHEETS.SUPPORT_TICKETS);
    } else {
      tickets = await db.findRows(db.SHEETS.SUPPORT_TICKETS, 'userEmail', req.user.email);
    }

    // Newest first — the dashboard shows the most recent case at the top.
    const list = tickets
      .map(toClientTicket)
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    res.json({ tickets: list });
  } catch (err) {
    console.error('List tickets error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/support/tickets/:id/reply — Add the user's own reply to their case.
//
// authenticateToken, not optionalAuth: writing into someone's support thread
// requires a real session. Ownership is then checked against the ticket's
// userEmail, so a logged-in user cannot post into another user's case.
router.post('/tickets/:id/reply', authenticateToken, async (req, res) => {
  try {
    const { message } = req.body || {};
    const body = String(message == null ? '' : message).trim();
    if (!body) {
      return res.status(400).json({ error: 'Please type a reply before sending.' });
    }

    const storageError = db.getWriteAvailabilityError(
      'Replying is temporarily unavailable because Google Sheets is not connected.'
    );
    if (storageError) {
      return res.status(503).json(storageError);
    }

    const ticket = await db.findRow(db.SHEETS.SUPPORT_TICKETS, 'id', req.params.id);
    if (!ticket) {
      return res.status(404).json({ error: 'Support case not found.' });
    }

    // Ownership. An admin replies through the admin panel, not here.
    const owner = String(ticket.userEmail || '').toLowerCase().trim();
    if (owner !== String(req.user.email || '').toLowerCase().trim()) {
      return res.status(403).json({ error: 'This support case belongs to another account.' });
    }

    const status = normStatus(ticket.status);
    if (!REPLYABLE_STATUSES.includes(status)) {
      return res.status(409).json({
        error: 'This case is closed. Please create a new case if you still need help.',
      });
    }

    const now = new Date().toISOString();
    // Rebuild from parseThread so a legacy row's `resolution` is preserved into
    // the stored thread on its first write instead of being dropped.
    const thread = parseThread(ticket);
    thread.push({ from: 'user', body: body.slice(0, REPLY_MAX_CHARS), at: now });

    await db.updateRow(db.SHEETS.SUPPORT_TICKETS, 'id', ticket.id, {
      messages: JSON.stringify(thread),
      updatedAt: now,
    });

    res.status(201).json({
      message: 'Reply sent. Our support team will get back to you.',
      ticket: toClientTicket({ ...ticket, messages: JSON.stringify(thread), updatedAt: now }),
    });
  } catch (err) {
    console.error('Support reply error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;

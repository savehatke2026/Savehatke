// ============================================
// SaveHatke — Support Routes
// ============================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { optionalAuth, authenticateToken } = require('../middleware/auth');
const db = require('../services/googleSheets');
const emailService = require('../services/emailService');
const googleDrive = require('../services/googleDrive');
const { sniffImage, looksComplete } = require('../utils/imageSniff');
const { verifyTurnstile } = require('../utils/turnstile');

const router = express.Router();

// Screenshots live in a private Google Drive folder and are served back only
// through the authenticated proxy (routes/driveProxy.js). Nothing about them is
// publicly linkable, and the browser's claimed MIME type is not trusted: the
// bytes are sniffed server-side and anything that is not a real PNG, JPEG or
// WebP is refused.
const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024; // 5MB per screenshot
const ATTACHMENT_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
// Drive reference stored on the ticket: 'drive:<fileId>'.
const DRIVE_REF_RE = /^drive:[a-zA-Z0-9_-]{10,80}$/;

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
    // Screenshot metadata. The file id is safe to expose to an authorised
    // viewer: the proxy re-checks who is asking before it streams anything.
    attachmentMime: t.attachmentMime || '',
    attachmentSize: t.attachmentSize ? Number(t.attachmentSize) || 0 : 0,
    attachmentFileId: t.attachmentFileId || '',
    attachmentUploadedAt: t.attachmentUploadedAt || '',
  };
}

// POST /api/support/attachment — Upload a support screenshot to private Drive
//
// The browser sends base64 plus a claimed filename and content type. None of
// that is trusted:
//   - the bytes are sniffed for a real PNG / JPEG / WebP signature, and checked
//     for a complete trailer, so a renamed executable, an SVG carrying script,
//     or a truncated upload is refused;
//   - the size limit is enforced here, not just in the browser;
//   - the Drive filename is generated server-side, so a crafted name (traversal
//     sequences, control characters, overlong strings) never reaches storage.
//
// Success returns a reference, never a public URL. The file is only ever served
// back through GET /api/proxy/drive/:fileId, which authorises the viewer.
router.post('/attachment', optionalAuth, async (req, res) => {
  const { filename, dataBase64 } = req.body || {};

  try {
    if (!dataBase64) {
      return res.status(400).json({ error: 'No screenshot was received. Please try again.' });
    }

    let buffer;
    try {
      buffer = Buffer.from(String(dataBase64), 'base64');
    } catch (e) {
      buffer = null;
    }
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: 'That screenshot could not be read. Please try another file.' });
    }
    if (buffer.length > ATTACHMENT_MAX_BYTES) {
      return res.status(413).json({ error: 'That screenshot is too large. The maximum size is 5MB.' });
    }

    // Content decides the type, not the upload's claim about itself.
    const sniffed = sniffImage(buffer);
    if (!sniffed || !ATTACHMENT_ALLOWED_TYPES.includes(sniffed.mime)) {
      return res.status(400).json({ error: 'Please attach a PNG, JPG or WebP screenshot.' });
    }
    if (!looksComplete(buffer, sniffed.mime)) {
      return res.status(400).json({ error: 'That screenshot looks incomplete. Please re-save it and try again.' });
    }

    if (!googleDrive.isConfigured()) {
      // Deliberately loud on the server, deliberately vague to the caller.
      console.error(
        '[support/attachment] Google Drive is not configured — refusing the upload. ' +
        'Set GOOGLE_DRIVE_FOLDER_ID (and GOOGLE_DRIVE_SUPPORT_FOLDER_ID) plus ' +
        'GOOGLE_DRIVE_REFRESH_TOKEN in .env.'
      );
      return res.status(503).json({
        error: 'Screenshot uploads are temporarily unavailable. Please submit your request without one, or try again later.',
      });
    }

    const uploaded = await googleDrive.uploadSupportScreenshot({
      buffer,
      ext: sniffed.ext,
      mimeType: sniffed.mime,
      uploaderEmail: req.user && req.user.email ? req.user.email : '',
    });

    // The original filename travels back for display only; it is recorded as
    // ticket metadata and never used as a path or a Drive name.
    const displayName = String(filename || 'screenshot')
      .replace(/[\\/]/g, '_')
      .replace(/[^a-zA-Z0-9._ -]/g, '_')
      .slice(0, 120) || 'screenshot';

    return res.status(201).json({
      url: uploaded.url,               // 'drive:<fileId>' — the stored reference
      fileId: uploaded.fileId,
      storage: 'google-drive',
      name: displayName,
      mimeType: sniffed.mime,
      size: buffer.length,
      uploadedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Google's own error text can name folders, accounts and internal reasons,
    // so it stays in the server log. The caller gets one neutral sentence.
    console.error(`[support/attachment] upload failed (${err.code || 'error'}): ${err.message}`);
    return res.status(502).json({
      error: 'We could not attach that screenshot right now. Please try again in a moment.',
    });
  }
});

// POST /api/support/ticket — Submit a support ticket
router.post('/ticket', optionalAuth, async (req, res) => {
  try {
    const {
      name, email, subject, message,
      attachmentUrl, attachmentName, attachmentMime, attachmentSize,
    } = req.body;

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

    // Accept only a reference this server issued. A screenshot lives in the
    // private Drive folder and is quoted as 'drive:<fileId>'; anything else —
    // including a public URL a caller invented — is dropped rather than stored,
    // so a ticket can never carry a link we do not control.
    //
    // Historic tickets hold Supabase storage URLs. Those are still accepted so a
    // resubmission from an older client does not lose its attachment, and the
    // renderers understand both shapes.
    let safeAttachmentUrl = '';
    if (attachmentUrl) {
      const candidate = String(attachmentUrl).slice(0, 500);
      const supabaseUrl = process.env.SUPABASE_URL || '';
      if (DRIVE_REF_RE.test(candidate)) {
        safeAttachmentUrl = candidate;
      } else if (supabaseUrl && candidate.startsWith(supabaseUrl + '/storage/')) {
        safeAttachmentUrl = candidate;
      } else {
        console.warn('[support/ticket] rejected an attachment reference that is not ours.');
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
      // Screenshot metadata, recorded only when the reference is one of ours.
      // Values are re-derived from the upload response rather than trusted
      // wholesale: the type and size are what the server measured.
      attachmentMime: safeAttachmentUrl && ATTACHMENT_ALLOWED_TYPES.includes(String(attachmentMime))
        ? String(attachmentMime) : '',
      attachmentSize: safeAttachmentUrl && Number.isFinite(Number(attachmentSize))
        ? String(Math.max(0, Math.min(ATTACHMENT_MAX_BYTES, Number(attachmentSize)))) : '',
      attachmentFileId: DRIVE_REF_RE.test(safeAttachmentUrl) ? safeAttachmentUrl.slice('drive:'.length) : '',
      attachmentUploadedAt: safeAttachmentUrl ? new Date().toISOString() : '',
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

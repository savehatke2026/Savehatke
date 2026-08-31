// ============================================
// SaveHatke — Google Drive Image Proxy
// ============================================
// Streams Google Drive files (coupon proof screenshots) through the server
// so we don't have to make the Drive file publicly linkable. Each request
// must be authenticated; only admins or the original seller of the coupon
// linked to the file can view it.
//
// Endpoints:
//   GET /api/proxy/drive/:fileId  — auth required
//   GET /api/proxy/drive/config   — public, returns isConfigured flag
// ============================================

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const googleDrive = require('../services/googleDrive');
const supabase = require('../services/supabase');
const db = require('../services/googleSheets');

const router = express.Router();

const FILE_ID_RE = /^[a-zA-Z0-9_-]{10,80}$/;

function isAdmin(req) {
  const role = req.user?.role ? String(req.user.role).toLowerCase() : '';
  return role === 'admin' || role === 'super admin' || role === 'support';
}

async function findCouponByProofFileId(fileId) {
  // Supabase first (faster + authoritative when configured)
  if (supabase.isConfigured()) {
    try {
      const all = await supabase.getCoupons({});
      const match = (all || []).find(
        (c) => c && typeof c.proofUrl === 'string' && c.proofUrl === 'drive:' + fileId
      );
      if (match) return match;
    } catch (e) {}
  }
  try {
    const rows = await db.findRows(db.SHEETS.COUPONS, 'proofUrl', 'drive:' + fileId);
    if (rows && rows.length) return rows[0];
  } catch (e) {}
  return null;
}

// GET /api/proxy/drive/config — public, tells the client if Drive is on
router.get('/config', (req, res) => {
  res.json({
    configured: googleDrive.isConfigured(),
    proxyBase: '/api/proxy/drive',
  });
});

/**
 * A support screenshot's only owner is the person whose ticket it is attached
 * to. Looked up by the stored 'drive:<fileId>' reference, so a caller cannot
 * reach someone else's screenshot by swapping a ticket id — the file id is what
 * gets matched, and the ticket's own email is the answer.
 */
async function findTicketByAttachmentFileId(fileId) {
  try {
    const rows = await db.getRows(db.SHEETS.SUPPORT_TICKETS);
    const ref = 'drive:' + fileId;
    return (rows || []).find(
      (t) => t && (t.attachmentUrl === ref || t.attachmentFileId === fileId)
    ) || null;
  } catch (e) {
    return null;
  }
}

// GET /api/proxy/drive/:fileId — auth + ownership check, then stream
router.get('/:fileId', authenticateToken, async (req, res) => {
  const fileId = String(req.params.fileId || '');
  if (!FILE_ID_RE.test(fileId)) {
    return res.status(400).json({ error: 'Invalid file id.' });
  }
  if (!googleDrive.isConfigured()) {
    return res.status(503).json({ error: 'Google Drive is not configured on the server.' });
  }

  // Access control: staff, or the one user the file belongs to — the seller of
  // the coupon it proves, or the author of the support ticket it is attached to.
  let authorized = isAdmin(req);
  if (!authorized) {
    try {
      const coupon = await findCouponByProofFileId(fileId);
      if (coupon && coupon.sellerEmail && req.user?.email) {
        authorized =
          String(coupon.sellerEmail).toLowerCase() === String(req.user.email).toLowerCase();
      }
    } catch (e) {
      // If the lookup itself fails, fall through to 403 — don't leak the file.
    }
  }
  if (!authorized) {
    try {
      const ticket = await findTicketByAttachmentFileId(fileId);
      if (ticket && ticket.userEmail && req.user?.email) {
        authorized =
          String(ticket.userEmail).toLowerCase() === String(req.user.email).toLowerCase();
      }
    } catch (e) {
      // Same rule: an unresolvable lookup is a denial, never a pass.
    }
  }
  if (!authorized) {
    return res.status(403).json({ error: 'You do not have permission to view this file.' });
  }

  // Fetch metadata first so we can return proper Content-Type + filename
  let meta;
  try {
    meta = await googleDrive.getFileMeta(fileId);
  } catch (err) {
    const status = err?.code === 404 || err?.status === 404 ? 404 : 502;
    return res.status(status).json({ error: 'File not found in Drive.' });
  }

  res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
  if (meta.size) res.setHeader('Content-Length', String(meta.size));
  res.setHeader('Cache-Control', 'private, max-age=300'); // 5-min client cache
  if (meta.name) {
    const safe = String(meta.name).replace(/[^a-zA-Z0-9._\- ]/g, '_');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`
    );
  }

  // Stream the body, clean up on disconnect
  const onAbort = () => {
    try { res.end(); } catch (_) {}
  };
  req.on('aborted', onAbort);
  req.on('close', onAbort);

  try {
    const stream = await googleDrive.downloadFile(fileId);
    stream.on('error', (e) => {
      console.error('[driveProxy] stream error:', e.message);
      if (!res.headersSent) res.status(502).end();
      else res.end();
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[driveProxy] download error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Failed to fetch file from Drive.' });
  }
});

module.exports = router;

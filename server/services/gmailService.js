// ============================================
// SaveHatke — Gmail Service
// Google OAuth 2.0 + Gmail API helpers.
// All token handling stays server-side.
// ============================================

const { google } = require('googleapis');
const GmailConnection = require('../models/GmailConnection');
const { decryptSecret } = require('./gmailCrypto');

// gmail.modify covers read/send/labels/trash without full mailbox access.
// openid+email are only used to display the connected account address.
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
];

// The support mailbox uses its own OAuth client (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET).
// Falls back to the shared GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET when not set.
function getGmailClientId() {
  return process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
}

function getGmailClientSecret() {
  return process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
}

function isOAuthConfigured() {
  return !!(getGmailClientId() && getGmailClientSecret());
}

function getRedirectUri() {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/api/admin/gmail/callback`;
}

function getOAuth2Client() {
  return new google.auth.OAuth2(
    getGmailClientId(),
    getGmailClientSecret(),
    getRedirectUri()
  );
}

/**
 * Build the Google consent URL the admin is redirected to.
 */
function buildAuthUrl(state) {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // ensure a refresh token is always returned
    scope: GMAIL_SCOPES,
    state,
    include_granted_scopes: false,
  });
}

/**
 * Exchange an authorization code for tokens.
 */
async function exchangeCode(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens; // { refresh_token, access_token, expiry_date, scope }
}

/**
 * Load the current admin's Gmail connection and return an authorized
 * Gmail API client. Returns null if not connected or token is broken.
 */
async function getAuthorizedClient(adminUserId) {
  const conn = await GmailConnection.findOne({ admin_user_id: String(adminUserId) });
  if (!conn) return null;

  const refreshToken = decryptSecret(conn.encrypted_refresh_token);
  if (!refreshToken) return null;

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({ refresh_token: refreshToken });

  // Persist refreshed access token metadata (best-effort)
  oauth2.on('tokens', async (tokens) => {
    try {
      const update = {};
      if (tokens.expiry_date) update.access_token_expires_at = new Date(tokens.expiry_date);
      if (tokens.refresh_token) {
        const { encryptSecret } = require('./gmailCrypto');
        update.encrypted_refresh_token = encryptSecret(tokens.refresh_token);
      }
      if (Object.keys(update).length) {
        await GmailConnection.updateOne({ _id: conn._id }, { $set: update });
      }
    } catch (e) {
      console.warn('Gmail token metadata update failed:', e.message);
    }
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  return { gmail, oauth2, conn };
}

/**
 * Revoke tokens and remove the connection.
 */
async function disconnect(adminUserId) {
  const conn = await GmailConnection.findOne({ admin_user_id: String(adminUserId) });
  if (!conn) return;

  // Best-effort revoke on Google's side
  try {
    const refreshToken = decryptSecret(conn.encrypted_refresh_token);
    if (refreshToken) {
      const oauth2 = getOAuth2Client();
      oauth2.setCredentials({ refresh_token: refreshToken });
      await oauth2.revokeCredentials();
    }
  } catch (e) {
    console.warn('Gmail token revoke notice:', e.message);
  }

  await GmailConnection.deleteOne({ _id: conn._id });
}

// ── Well-known Gmail label IDs ─────────────────────────────────────────────
const SYSTEM_LABELS = {
  INBOX: 'INBOX',
  SENT: 'SENT',
  DRAFT: 'DRAFT',
  STARRED: 'STARRED',
  TRASH: 'TRASH',
  SPAM: 'SPAM',
};

/**
 * Map a frontend folder name to Gmail list parameters.
 */
function folderToListParams(folder, labelId) {
  switch (String(folder || 'inbox').toLowerCase()) {
    case 'inbox':
      return { labelIds: ['INBOX'], q: '-in:sent -in:draft' };
    case 'starred':
      return { labelIds: ['STARRED'] };
    case 'sent':
      return { labelIds: ['SENT'] };
    case 'drafts':
    case 'draft':
      return { labelIds: ['DRAFT'] };
    case 'spam':
      return { labelIds: ['SPAM'] };
    case 'trash':
      return { labelIds: ['TRASH'] };
    case 'label':
      return labelId ? { labelIds: [String(labelId)] } : { labelIds: ['INBOX'] };
    default:
      return { labelIds: ['INBOX'] };
  }
}

/**
 * Extract headers + body + attachments metadata from a Gmail message payload.
 */
function parsePayload(payload, headers = {}) {
  if (!payload) return headers;

  (payload.headers || []).forEach((h) => {
    headers[String(h.name).toLowerCase()] = h.value;
  });

  const body = payload.body || {};
  if (payload.mimeType === 'text/plain' && body.data) {
    headers.__text = (headers.__text || '') + Buffer.from(body.data, 'base64url').toString('utf8');
  } else if (payload.mimeType === 'text/html' && body.data) {
    headers.__html = (headers.__html || '') + Buffer.from(body.data, 'base64url').toString('utf8');
  }

  if (body.attachmentId) {
    headers.__attachments = headers.__attachments || [];
    headers.__attachments.push({
      attachmentId: body.attachmentId,
      filename: payload.filename || 'attachment',
      mimeType: payload.mimeType || 'application/octet-stream',
      size: body.size || 0,
      partId: payload.partId,
    });
  }

  (payload.parts || []).forEach((part) => parsePayload(part, headers));
  return headers;
}

/**
 * Build a normalized message summary from metadata-format messages.
 */
function summarizeMessage(msg) {
  const h = {};
  (msg.payload?.headers || []).forEach((x) => { h[String(x.name).toLowerCase()] = x.value; });

  const attachments = [];
  const collectAttachments = (payload) => {
    if (!payload) return;
    if (payload.body?.attachmentId) {
      attachments.push({ filename: payload.filename || 'attachment', mimeType: payload.mimeType, size: payload.body.size || 0 });
    }
    (payload.parts || []).forEach(collectAttachments);
  };
  collectAttachments(msg.payload);

  return {
    id: msg.id,
    threadId: msg.threadId,
    snippet: msg.snippet || '',
    from: h.from || '',
    to: h.to || '',
    cc: h.cc || '',
    subject: h.subject || '(no subject)',
    date: h.date || '',
    internalDate: msg.internalDate,
    unread: (msg.labelIds || []).includes('UNREAD'),
    starred: (msg.labelIds || []).includes('STARRED'),
    labels: msg.labelIds || [],
    hasAttachments: attachments.length > 0,
    attachments,
  };
}

/**
 * List messages for a folder/label/search with pagination.
 * Metadata is fetched concurrently in small batches.
 */
async function listMessages(gmail, { folder = 'inbox', labelId, q, pageToken, maxResults = 20 }) {
  const params = folderToListParams(folder, labelId);
  const listParams = { userId: 'me', maxResults: Math.min(Number(maxResults) || 20, 50) };

  // Search query takes precedence over folder defaults
  if (q && String(q).trim()) {
    listParams.q = String(q).trim().slice(0, 500);
  } else if (params.q) {
    listParams.q = params.q;
  }
  if (params.labelIds) listParams.labelIds = params.labelIds;
  if (pageToken) listParams.pageToken = String(pageToken);

  const list = await gmail.users.messages.list(listParams);
  const ids = (list.data.messages || []).map((m) => m.id);

  // Fetch metadata in parallel (bounded by maxResults)
  const metas = await Promise.all(ids.map(async (id) => {
    try {
      const r = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata',
        metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] });
      return r.data;
    } catch (e) {
      return null;
    }
  }));

  return {
    messages: metas.filter(Boolean).map(summarizeMessage),
    nextPageToken: list.data.nextPageToken || null,
    resultSizeEstimate: list.data.resultSizeEstimate || 0,
  };
}

/**
 * Fetch one full message with sanitized body + attachment metadata.
 */
async function getMessageFull(gmail, id) {
  const { sanitizeEmailHtml } = require('./gmailSanitizer');
  const r = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const msg = r.data;
  const parsed = parsePayload(msg.payload);
  const summary = summarizeMessage(msg);

  // Prefer html body; fall back to plain text
  let bodyHtml = '';
  if (parsed.__html) {
    bodyHtml = sanitizeEmailHtml(parsed.__html);
  } else if (parsed.__text) {
    const { escapeHtml } = require('./gmailSanitizer');
    bodyHtml = `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(parsed.__text)}</pre>`;
  }

  return {
    ...summary,
    bcc: parsed.bcc || '',
    replyTo: parsed['reply-to'] || '',
    references: parsed.references || '',
    inReplyTo: parsed['in-reply-to'] || '',
    messageIdHeader: parsed['message-id'] || '',
    bodyHtml,
    bodyText: parsed.__text || '',
    attachments: parsed.__attachments || summary.attachments,
  };
}

/**
 * Fetch labels (user + system) for sidebar rendering.
 */
async function listLabels(gmail) {
  const r = await gmail.users.labels.list({ userId: 'me' });
  return (r.data.labels || [])
    .filter((l) => l.type !== 'hidden' || SYSTEM_LABELS[l.id])
    .map((l) => ({ id: l.id, name: l.name, type: l.type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Unread count per system label + total inbox unread.
 */
async function getUnreadCounts(gmail) {
  const r = await gmail.users.labels.list({ userId: 'me' });
  const counts = {};
  (r.data.labels || []).forEach((l) => {
    if (SYSTEM_LABELS[l.id] || l.id === 'INBOX') {
      counts[l.id] = l.messagesUnread || 0;
    }
  });
  return counts;
}

module.exports = {
  GMAIL_SCOPES,
  isOAuthConfigured,
  getRedirectUri,
  getOAuth2Client,
  buildAuthUrl,
  exchangeCode,
  getAuthorizedClient,
  disconnect,
  SYSTEM_LABELS,
  folderToListParams,
  parsePayload,
  summarizeMessage,
  listMessages,
  getMessageFull,
  listLabels,
  getUnreadCounts,
};

// ============================================
// SaveHatke — Gmail Service
// Google OAuth 2.0 + Gmail API helpers.
// All token handling stays server-side. No database is used:
// the single support mailbox's refresh token lives in
// GMAIL_REFRESH_TOKEN / the local token file (see gmailTokenStore).
// ============================================

const { google } = require('googleapis');
const tokenStore = require('./gmailTokenStore');

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

function getRedirectUri(requestBase) {
  const base = (requestBase || process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const override = String(process.env.GOOGLE_REDIRECT_URI || '').trim();

  // Use the explicit override only when it belongs to the domain that is
  // actually serving this request. Otherwise a localhost override in .env
  // would break the OAuth flow on the deployed domain (and vice versa).
  if (override) {
    if (!base) return override;
    try {
      if (new URL(override).origin === new URL(base).origin) return override;
    } catch (e) { /* malformed override — fall through to derivation */ }
  }

  return `${(base || 'http://localhost:3000')}/api/admin/gmail/callback`;
}

function getOAuth2Client(requestBase) {
  return new google.auth.OAuth2(
    getGmailClientId(),
    getGmailClientSecret(),
    getRedirectUri(requestBase)
  );
}

/**
 * Build the Google consent URL the admin is redirected to.
 */
function buildAuthUrl(state, requestBase) {
  const client = getOAuth2Client(requestBase);
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
async function exchangeCode(code, requestBase) {
  const client = getOAuth2Client(requestBase);
  const { tokens } = await client.getToken(code);
  return tokens; // { refresh_token, access_token, expiry_date, scope }
}

/**
 * Return an authorized Gmail API client for the shared support mailbox.
 * Returns null when the mailbox has not been connected yet.
 * No database lookup — the refresh token comes from gmailTokenStore.
 */
async function getAuthorizedClient() {
  const conn = tokenStore.getConnection();
  if (!conn || !conn.refresh_token) return null;

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({ refresh_token: conn.refresh_token });

  // Keep access-token metadata and any rotated refresh token in step.
  oauth2.on('tokens', (tokens) => {
    try {
      if (tokens.expiry_date) {
        tokenStore.updateMeta({ access_token_expires_at: new Date(tokens.expiry_date).toISOString() });
      }
      if (tokens.refresh_token && tokens.refresh_token !== conn.refresh_token) {
        tokenStore.rotateRefreshToken(tokens.refresh_token);
      }
    } catch (e) {
      console.warn('Gmail token metadata update failed:', e.message);
    }
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  return { gmail, oauth2, conn };
}

/**
 * Revoke the token with Google and forget it locally.
 */
async function disconnect() {
  const conn = tokenStore.getConnection();
  if (!conn) return { revoked: false, envStillSet: false };

  // Best-effort revoke on Google's side
  let revoked = false;
  try {
    const oauth2 = getOAuth2Client();
    oauth2.setCredentials({ refresh_token: conn.refresh_token });
    await oauth2.revokeCredentials();
    revoked = true;
  } catch (e) {
    console.warn('Gmail token revoke notice:', e.message);
  }

  const cleared = tokenStore.clearConnection();
  return { revoked, ...cleared };
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
 * Badge counts for the sidebar.
 *
 * IMPORTANT: users.labels.list returns a PARTIAL Label resource — only
 * id/name/type, never messagesTotal / messagesUnread. The counts are only
 * available from users.labels.get, so each badge label is fetched directly
 * (in parallel). Reading them off labels.list silently yields 0 for everything.
 *
 * INBOX / SPAM / STARRED report unread; DRAFT reports its total, because a
 * draft is never "unread".
 */
const BADGE_LABELS = ['INBOX', 'SPAM', 'STARRED', 'DRAFT'];

async function getUnreadCounts(gmail) {
  const results = await Promise.all(
    BADGE_LABELS.map(async (id) => {
      try {
        const r = await gmail.users.labels.get({ userId: 'me', id });
        const useTotal = id === 'DRAFT';
        return [id, (useTotal ? r.data.messagesTotal : r.data.messagesUnread) || 0];
      } catch (e) {
        return [id, 0];
      }
    })
  );
  return Object.fromEntries(results);
}

/**
 * Unread message count for the inbox only (used by the change poller).
 */
async function getInboxUnread(gmail) {
  try {
    const r = await gmail.users.labels.get({ userId: 'me', id: 'INBOX' });
    return r.data.messagesUnread || 0;
  } catch (e) {
    return 0;
  }
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
  getInboxUnread,
};

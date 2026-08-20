// ============================================
// SaveHatke — Gmail MIME Builder
// Builds RFC 2822 raw messages for send/draft/reply/forward.
// ============================================

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Encode header values safely (ASCII passthrough, UTF-8 basic encoding) */
function encodeHeader(value) {
  const s = String(value || '').replace(/[\r\n]/g, ' ').trim();
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** Validate a single email address loosely; returns trimmed string or null */
function normalizeAddress(addr) {
  const s = String(addr || '').trim().slice(0, 320);
  if (!s) return null;
  // Accept "Name <email@domain>" or plain email@domain
  const m = s.match(/<([^<>]+)>/);
  const target = m ? m[1] : s;
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(target.trim())) return null;
  return s;
}

/** Split comma-separated addresses, validate each. Throws on invalid. */
function parseAddressList(input) {
  const raw = String(input || '').trim();
  if (!raw) return [];
  // Split on commas not inside quotes
  const parts = raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const valid = [];
  for (const p of parts) {
    const norm = normalizeAddress(p);
    if (!norm) throw new Error(`Invalid email address: ${p.trim()}`);
    valid.push(norm);
  }
  return valid;
}

/**
 * Build a raw MIME message.
 * options: { to: [], cc: [], bcc: [], subject, bodyHtml, bodyText,
 *            inReplyTo, references, attachments: [{filename, mimeType, data(base64)}] }
 * Returns base64url-encoded raw string ready for Gmail API.
 */
function buildRawMessage(options) {
  const boundaryMixed = `mixed_${crypto.randomBytes(12).toString('hex')}`;
  const boundaryAlt = `alt_${crypto.randomBytes(12).toString('hex')}`;

  const headers = [
    'MIME-Version: 1.0',
    `Message-ID: <${crypto.randomUUID()}@savehatke.local>`,
    `Date: ${new Date().toUTCString()}`,
  ];

  if (options.to?.length) headers.push(`To: ${options.to.map(encodeHeader).join(', ')}`);
  if (options.cc?.length) headers.push(`Cc: ${options.cc.map(encodeHeader).join(', ')}`);
  if (options.bcc?.length) headers.push(`Bcc: ${options.bcc.map(encodeHeader).join(', ')}`);
  if (options.subject) headers.push(`Subject: ${encodeHeader(options.subject)}`);
  if (options.inReplyTo) headers.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options.references) headers.push(`References: ${options.references}`);

  const attachments = (options.attachments || []).filter((a) => a && a.data);
  const hasText = !!options.bodyText;
  const hasHtml = !!options.bodyHtml;

  let body = '';

  if (attachments.length) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundaryMixed}"`);
    const parts = [];
    parts.push(`--${boundaryMixed}`);

    if (hasText && hasHtml) {
      parts.push(`Content-Type: multipart/alternative; boundary="${boundaryAlt}"`, '');
      parts.push(`--${boundaryAlt}`);
      parts.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '');
      parts.push(Buffer.from(options.bodyText, 'utf8').toString('base64'));
      parts.push(`--${boundaryAlt}`);
      parts.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '');
      parts.push(Buffer.from(options.bodyHtml, 'utf8').toString('base64'));
      parts.push(`--${boundaryAlt}--`, '');
    } else {
      const content = options.bodyHtml || options.bodyText || '';
      const type = hasHtml ? 'text/html' : 'text/plain';
      parts.push(`Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '');
      parts.push(Buffer.from(content, 'utf8').toString('base64'));
    }

    for (const att of attachments) {
      const safeName = String(att.filename || 'attachment').replace(/[\r\n"]/g, '_').slice(0, 200);
      const mimeType = /^[\w./+-]+$/.test(att.mimeType || '') ? att.mimeType : 'application/octet-stream';
      parts.push(`--${boundaryMixed}`);
      parts.push(`Content-Type: ${mimeType}; name="${safeName}"`);
      parts.push('Content-Transfer-Encoding: base64');
      parts.push(`Content-Disposition: attachment; filename="${safeName}"`);
      parts.push('');
      // Re-chunk the provided base64 data to 76-char lines
      const b64 = String(att.data).replace(/\s+/g, '');
      parts.push(b64.match(/.{1,76}/g)?.join('\n') || '');
    }
    parts.push(`--${boundaryMixed}--`);
    body = parts.join('\r\n');
  } else if (hasText && hasHtml) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundaryAlt}"`);
    body = [
      `--${boundaryAlt}`,
      'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(options.bodyText, 'utf8').toString('base64'),
      `--${boundaryAlt}`,
      'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(options.bodyHtml, 'utf8').toString('base64'),
      `--${boundaryAlt}--`,
    ].join('\r\n');
  } else {
    const content = options.bodyHtml || options.bodyText || '';
    const type = hasHtml ? 'text/html' : 'text/plain';
    headers.push(`Content-Type: ${type}; charset=UTF-8`);
    headers.push('Content-Transfer-Encoding: base64');
    body = Buffer.from(content, 'utf8').toString('base64');
  }

  const raw = headers.join('\r\n') + '\r\n\r\n' + body;
  return base64url(raw);
}

/**
 * Convert a sanitized/simple HTML body to plain text for multipart fallback.
 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

module.exports = { buildRawMessage, parseAddressList, htmlToText, base64url };

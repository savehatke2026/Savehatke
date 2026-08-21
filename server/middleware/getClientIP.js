// ============================================
// SaveHatke — Client IP Extraction Utility
// ============================================
// Extracts the real client IP from request headers,
// handling proxies (CDN headers, x-forwarded-for, x-real-ip)
// and skipping private/spoofed/internal addresses.

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

function isValidIP(ip) {
  if (!ip) return false;
  if (IPV4_RE.test(ip)) return ip.split('.').every((p) => Number(p) <= 255);
  return IPV6_RE.test(ip);
}

function isPrivateOrLoopback(ip) {
  if (!ip) return true;
  if (ip.startsWith('::ffff:')) return isPrivateOrLoopback(ip.slice(7));
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith('169.254.') || ip.startsWith('fe80:')) return true;
  return false;
}

function normalize(ip) {
  return (ip === '::1' || ip === '::ffff:127.0.0.1') ? '127.0.0.1' : ip;
}

/**
 * Extract the real client IP address from an Express request.
 * Priority: CDN-provided client IP headers first (Cloudflare, Akamai),
 * then the x-forwarded-for chain (first valid PUBLIC address wins,
 * so spoofed or internal entries are skipped), then socket addresses.
 *
 * @param {import('express').Request} req
 * @returns {string} Client IP address
 */
function getClientIP(req) {
  const headers = req.headers || {};
  const candidates = [];

  // CDN / trusted-proxy headers that carry the true client IP
  for (const h of ['cf-connecting-ip', 'true-client-ip', 'x-real-ip']) {
    const v = String(headers[h] || '').split(',')[0].trim();
    if (v) candidates.push(v);
  }

  // x-forwarded-for: full chain, left to right
  for (const part of String(headers['x-forwarded-for'] || '').split(',')) {
    const v = part.trim();
    if (v) candidates.push(v);
  }

  // Transport-level addresses (accurate when no proxy is in front)
  candidates.push(req.connection?.remoteAddress, req.socket?.remoteAddress, req.ip);

  // 1st pass — first valid PUBLIC IP (the real visitor)
  for (const c of candidates) {
    if (isValidIP(c) && !isPrivateOrLoopback(c)) return c;
  }

  // 2nd pass — first valid IP (local dev / internal traffic)
  for (const c of candidates) {
    if (isValidIP(c)) return normalize(c);
  }

  return 'unknown';
}

module.exports = getClientIP;

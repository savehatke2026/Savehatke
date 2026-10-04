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
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) — validate the embedded IPv4
  if (ip.startsWith('::ffff:')) return isValidIP(ip.slice(7));
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
  if (!ip) return ip;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) → plain IPv4 so Geo-IP lookups work
  if (ip.startsWith('::ffff:')) return normalize(ip.slice(7));
  return (ip === '::1' || ip === '127.0.0.1') ? '127.0.0.1' : ip;
}

/**
 * Extract the real client IP address from an Express request.
 *
 * SECURITY — why the header list is this short.
 *
 * This value is not cosmetic: it is the rate-limit key for the chatbot
 * (services/chatbotService.js), the IP written into every session row and shown
 * on the user's and admin's login-history screens, the input to the
 * new-device/new-location alerts, and the `remoteip` sent to Cloudflare
 * Turnstile. A caller-controlled value therefore lets an attacker rotate the
 * key to defeat per-IP throttling AND forge the IP recorded for incident
 * response.
 *
 * `cf-connecting-ip`, `true-client-ip` and `x-real-ip` are NOT set by Vercel,
 * so any client can send them. They used to be read first, which meant a
 * request with `cf-connecting-ip: <random public IP>` overrode the genuine
 * `x-vercel-forwarded-for` and the app's own `app.set('trust proxy', 1)`.
 * They are deliberately no longer consulted: Cloudflare/Akamai-style headers
 * only become trustworthy once a proxy that strips inbound copies is actually
 * in front of the app, and none is configured here.
 *
 * The order is now:
 *   1. x-vercel-forwarded-for — set by Vercel's edge from the proxy's own view.
 *      Overridable with TRUSTED_IP_HEADER for a deployment that fronts the app
 *      with a different proxy that sets its own single-value header.
 *   2. req.ip — Express's answer, bounded to exactly one trusted hop by
 *      `app.set('trust proxy', 1)`.
 *   3. raw socket address — accurate when nothing is in front (local dev).
 *
 * The subtle part is step 2. `trust proxy: 1` makes Express read the LEFTMOST
 * entry of X-Forwarded-For. That is only safe if the trusted proxy OVERWRITES
 * the header with the real client address. If a proxy instead APPENDS the real
 * address to an inbound header, a caller who sends `X-Forwarded-For: <fake>`
 * ends up leftmost, and Express hands back the fake — which is a fresh
 * rate-limit bucket and a forged audit IP on every request.
 *
 * Since that behaviour depends on the platform and cannot be verified from
 * here, the X-Forwarded-For chain is NOT trusted as a fallback: when a caller
 * supplies X-Forwarded-For but no trusted single-value header, the chain is
 * ignored and the real socket address is used. Under Vercel that case does not
 * arise (the edge always sets x-vercel-forwarded-for), so legitimate traffic
 * keeps its true IP; an off-platform or misconfigured deployment degrades to
 * over-limiting a shared address, which is the safe direction.
 *
 * @param {import('express').Request} req
 * @returns {string} Client IP address
 */
// A deployment that uses a different proxy can name its own single-value
// client-IP header (e.g. 'cf-connecting-ip' behind a Cloudflare setup that
// strips inbound copies). Unset by default.
const TRUSTED_IP_HEADER = String(process.env.TRUSTED_IP_HEADER || '').trim().toLowerCase();

function getClientIP(req) {
  const headers = (req && req.headers) || {};
  const candidates = [];

  // The proxy's own single-value header — the only proxy input trusted here.
  const trustedHeader = TRUSTED_IP_HEADER || 'x-vercel-forwarded-for';
  const fromTrustedProxy = String(headers[trustedHeader] || '').split(',')[0].trim();
  if (fromTrustedProxy) candidates.push(fromTrustedProxy);

  // Express's answer, but only when the request did not arrive with an
  // untrusted X-Forwarded-For chain to poison it (see the note above).
  const hasUntrustedChain = !fromTrustedProxy && Boolean(String(headers['x-forwarded-for'] || '').trim());
  if (!hasUntrustedChain) {
    candidates.push(req && req.ip);
  }

  // Transport-level addresses (accurate when no proxy is in front).
  candidates.push(req && req.connection && req.connection.remoteAddress,
    req && req.socket && req.socket.remoteAddress);

  // 1st pass — first valid PUBLIC IP (the real visitor)
  for (const c of candidates) {
    if (isValidIP(c) && !isPrivateOrLoopback(c)) return normalize(c);
  }

  // 2nd pass — first valid IP (local dev / internal traffic)
  for (const c of candidates) {
    if (isValidIP(c)) return normalize(c);
  }

  return 'unknown';
}

module.exports = getClientIP;

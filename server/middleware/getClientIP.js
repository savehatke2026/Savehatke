// ============================================
// SaveHatke — Client IP Extraction Utility
// ============================================
// Extracts the real client IP from request headers,
// handling proxies (x-forwarded-for, x-real-ip) and
// normalizing loopback addresses.

/**
 * Extract the real client IP address from an Express request.
 * Handles reverse proxies (Vercel, Cloudflare, Nginx) by reading
 * x-forwarded-for and x-real-ip headers.
 *
 * @param {import('express').Request} req
 * @returns {string} Client IP address
 */
function getClientIP(req) {
  let ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.ip ||
    'unknown';

  // Normalize IPv6 loopback
  if (ip === '::1' || ip === '::ffff:127.0.0.1') {
    ip = '127.0.0.1';
  }

  return ip;
}

module.exports = getClientIP;

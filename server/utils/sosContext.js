// ============================================
// SaveHatke — SOS Request Context
// ============================================
// Client description and approximate IP location for the SOS audit trail and
// the administrator alert email.
//
// This is deliberately its own helper rather than a refactor of the private
// resolveGeo/parseUserAgent pair inside routes/auth.js: the login path is
// security-critical and in active use, and SOS needs two fields (timezone, ISP)
// that the login lookup does not request.
//
// Everything here is best-effort and non-blocking by design. A geolocation
// outage must never stop a legitimate break-glass login, so failures degrade to
// 'Unknown' rather than throwing.

const UAParser = require('ua-parser-js');

const LOOKUP_TIMEOUT_MS = 4000;

/** True for addresses no public geolocation service can place. */
function isPrivateAddress(ip) {
  const v = String(ip || '').trim();
  if (!v) return true;
  if (v === '::1' || v === '127.0.0.1' || v.startsWith('::ffff:127.')) return true;
  if (/^10\./.test(v) || /^192\.168\./.test(v) || /^169\.254\./.test(v)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(v)) return true;
  return false;
}

/** Browser / OS / device, from the User-Agent. Never trusted, only described. */
function describeClient(req) {
  const raw = String((req && req.headers && req.headers['user-agent']) || '');
  let browser = '';
  let os = '';
  let device = '';
  try {
    const parsed = new UAParser(raw).getResult();
    browser = [parsed.browser.name, parsed.browser.version].filter(Boolean).join(' ');
    os = [parsed.os.name, parsed.os.version].filter(Boolean).join(' ');
    device = parsed.device.type
      ? [parsed.device.vendor, parsed.device.model, `(${parsed.device.type})`].filter(Boolean).join(' ')
      : 'Desktop';
  } catch (e) { /* an unparseable UA is still recorded raw below */ }

  return {
    browser: browser || 'Unknown browser',
    os: os || 'Unknown OS',
    device: device || 'Unknown device',
    // Capped: the audit record keeps a readable fingerprint, not a novel.
    userAgent: raw.slice(0, 400),
  };
}

const UNKNOWN_LOCATION = Object.freeze({
  country: 'Unknown',
  region: 'Unknown',
  city: 'Unknown',
  timezone: '',
  isp: '',
  approximate: true,
});

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Approximate location for an IP. Two providers, first usable answer wins.
 *
 * The result is always described as approximate: IP geolocation places the
 * network, not the person, and VPNs, proxies and mobile carriers move it.
 */
async function resolveApproxLocation(ip) {
  const clean = String(ip || '').trim();
  if (!clean || isPrivateAddress(clean)) return { ...UNKNOWN_LOCATION };

  const who = await fetchJson(`https://ipwho.is/${encodeURIComponent(clean)}`);
  if (who && who.success !== false) {
    return {
      country: who.country || 'Unknown',
      region: who.region || 'Unknown',
      city: who.city || 'Unknown',
      timezone: (who.timezone && (who.timezone.id || who.timezone)) || '',
      isp: (who.connection && (who.connection.isp || who.connection.org)) || '',
      approximate: true,
    };
  }

  const api = await fetchJson(
    `http://ip-api.com/json/${encodeURIComponent(clean)}?fields=status,country,regionName,city,timezone,isp`
  );
  if (api && api.status === 'success') {
    return {
      country: api.country || 'Unknown',
      region: api.regionName || 'Unknown',
      city: api.city || 'Unknown',
      timezone: api.timezone || '',
      isp: api.isp || '',
      approximate: true,
    };
  }

  return { ...UNKNOWN_LOCATION };
}

/** "City, Region, Country" with the unknown parts dropped. */
function formatLocation(loc) {
  const parts = [loc && loc.city, loc && loc.region, loc && loc.country]
    .map((p) => String(p || '').trim())
    .filter((p) => p && !/^unknown$/i.test(p))
    .filter((p, i, arr) => arr.indexOf(p) === i);
  return parts.length ? parts.join(', ') : 'Unknown';
}

module.exports = {
  isPrivateAddress,
  describeClient,
  resolveApproxLocation,
  formatLocation,
  UNKNOWN_LOCATION,
};

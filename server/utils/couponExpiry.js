// ============================================
// SaveHatke — coupon expiry parser (server side)
// ============================================
// One parser for every server check that asks "has this coupon expired?":
// the purchase price gate (dynamicPricing), the listing filter (routes/coupons)
// and the admin price path. It mirrors parseExpiry() in public/js/coupon-meta.js
// so the countdown the buyer sees and the expiry the server enforces agree.
//
// Accepted stored shapes (expiry_date is TEXT):
//   "2026-10-11"                 → end of that day (23:59:59.999 IST)
//   "2026-10-11T18:30" / "... "  → IST wall-clock time (no offset given)
//   "2026-10-11T18:30:00Z"/"+05:30" → absolute, offset honoured
//   "30/09/2026", "30/09/2026 23:59", "09/30/2026 11:30 PM" → locale rendering
//
// Naive values are read as India time, the business timezone. Reading them in
// the server's own zone would move a coupon's end by hours depending on where
// the host runs, so the timezone is fixed rather than inherited.
//
// Returns epoch ms, or null when the value is empty or unparseable. Callers
// must treat null as "no expiry we can prove" and never invent one.

const IST_OFFSET_MIN = 330; // UTC+05:30, no DST

// Build an epoch from wall-clock IST parts. Returns null if the parts do not
// round-trip (e.g. Feb 31), because Date would silently roll them over.
function istEpoch(y, mo, d, h, mi, s, ms) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s, ms) - IST_OFFSET_MIN * 60000;
  // Round-trip check on the IST calendar day.
  const back = new Date(utc + IST_OFFSET_MIN * 60000);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1) return null;
  return utc;
}

function parseCouponExpiry(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    return istEpoch(+dateOnly[1], +dateOnly[2], +dateOnly[3], 23, 59, 59, 999);
  }

  const locale = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(s);
  if (locale) {
    const first = +locale[1];
    const second = +locale[2];
    let day = first;
    let month = second;
    if (first <= 12 && second > 12) { day = second; month = first; }
    const hasTime = locale[4] !== undefined;
    let hour = hasTime ? +locale[4] : 23;
    const minute = hasTime ? +locale[5] : 59;
    const sec = hasTime ? (locale[6] !== undefined ? +locale[6] : 0) : 59;
    const ampm = (locale[7] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return istEpoch(+locale[3], month, day, hour, minute, sec, hasTime ? 0 : 999);
  }

  // ISO-shaped. A value with an explicit offset or "Z" is absolute; a naive
  // "T"/space time is IST wall-clock, not the server's local zone.
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(s);
  if (iso) {
    const ms = iso[7] ? +iso[7].padEnd(3, '0') : 0;
    return istEpoch(+iso[1], +iso[2], +iso[3], +iso[4], +iso[5], +(iso[6] || 0), ms);
  }

  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

module.exports = { parseCouponExpiry, IST_OFFSET_MIN };

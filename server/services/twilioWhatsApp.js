// ============================================
// SaveHatke — Twilio WhatsApp Notification Service
// ============================================
// Server-side only. Credentials are read from environment variables and are
// NEVER logged, returned in API responses, or exposed to the frontend.

let twilio = null;
try {
  twilio = require('twilio');
} catch (e) {
  // twilio package not installed — service reports as unconfigured
}

let client = null;

function getConfig() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_WHATSAPP_FROM || '',
    adminTo: process.env.ADMIN_WHATSAPP_NUMBER || '',
    contentSid: process.env.TWILIO_CONTENT_SID || '',
  };
}

function isConfigured() {
  const c = getConfig();
  return !!(twilio && c.accountSid && c.authToken && c.from && c.adminTo && c.contentSid);
}

function getClient() {
  const c = getConfig();
  if (!twilio || !c.accountSid || !c.authToken) return null;
  if (!client) client = twilio(c.accountSid, c.authToken);
  return client;
}

/**
 * Send the "new coupon submission" WhatsApp alert to the admin using the
 * approved Twilio content template (TWILIO_CONTENT_SID) with variables:
 *   {{1}} couponId  {{2}} store/brand  {{3}} coupon value  {{4}} selling price
 *   {{5}} seller id/email  {{6}} admin review URL
 *
 * Returns { success, sid?, error? } — never throws, never exposes credentials.
 */
async function sendCouponSubmissionAlert(coupon, reviewUrl) {
  if (!isConfigured()) {
    return { success: false, error: 'Twilio WhatsApp is not configured on the server.' };
  }

  const c = getConfig();
  const safe = (v, max = 200) => String(v == null ? '' : v).slice(0, max);

  try {
    const message = await getClient().messages.create({
      from: c.from,
      to: c.adminTo,
      contentSid: c.contentSid,
      contentVariables: JSON.stringify({
        1: safe(coupon.id, 64),
        2: safe(coupon.brand, 60),
        3: safe('₹' + (coupon.originalValue || '0'), 20),
        4: safe('₹' + (coupon.sellingPrice || '20'), 20),
        5: safe(coupon.sellerEmail || coupon.sellerUserId || 'unknown', 80),
        6: safe(reviewUrl, 300),
      }),
    });

    return { success: true, sid: message.sid };
  } catch (err) {
    // Log a sanitized message only — Twilio errors can contain account hints
    console.warn('Twilio WhatsApp send failed:', (err && err.message) ? String(err.message).slice(0, 200) : err);
    return { success: false, error: 'WhatsApp notification could not be sent.' };
  }
}

module.exports = { isConfigured, sendCouponSubmissionAlert };

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
  };
}

function isConfigured() {
  const c = getConfig();
  return !!(twilio && c.accountSid && c.authToken && c.from && c.adminTo);
}

function getClient() {
  const c = getConfig();
  if (!twilio || !c.accountSid || !c.authToken) return null;
  if (!client) client = twilio(c.accountSid, c.authToken);
  return client;
}

/**
 * Build the formatted WhatsApp message body for coupon submissions.
 *
 * @param {Array}  couponsList  — Array of coupon objects
 * @param {Object} sellerInfo   — { name, email }
 * @param {string} reviewUrl    — Admin panel review URL
 * @returns {string} The formatted WhatsApp message body
 */
function buildMessageBody(couponsList, sellerInfo, reviewUrl) {
  const count = couponsList.length;
  const sellerName = sellerInfo.name || sellerInfo.email || 'Unknown';
  const sellerEmail = sellerInfo.email || 'Unknown';
  const submittedAt = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  let body = '';
  body += `🔔 *New Coupon Submission${count > 1 ? 's' : ''} — SaveHatke*\n\n`;
  body += `A seller has submitted *${count} coupon${count > 1 ? 's' : ''}* for review.\n\n`;
  body += `👤 *Seller:* ${sellerName}\n`;
  body += `📧 *Seller Email:* ${sellerEmail}\n`;
  body += `🕐 *Submitted:* ${submittedAt}\n\n`;
  body += `━━━━━━━━━━━━━━\n`;

  couponsList.forEach((coupon, i) => {
    body += `\n`;
    body += `*${i + 1}. ${coupon.brand || coupon.title || 'Untitled'}*\n`;
    body += `🎟️ Coupon ID: #${coupon.id}\n`;
    body += `🏷️ Category: ${coupon.category || 'N/A'}\n`;
    body += `💰 Selling Price: ₹${coupon.sellingPrice || '20'}\n`;
    body += `💵 Original Value: ₹${coupon.originalValue || '0'}\n`;
    body += `📅 Expiry: ${coupon.expiryDate || 'Not specified'}\n`;
  });

  body += `\n━━━━━━━━━━━━━━\n\n`;
  body += `📋 *Status:* Pending Review\n\n`;
  body += `👉 *Review All in Admin Panel:*\n${reviewUrl}\n\n`;
  body += `— *SaveHatke Admin Alerts*`;

  return body;
}

/**
 * Send the "new coupon submission" WhatsApp alert to the admin.
 *
 * Accepts an array of coupons so all coupons from a single submission batch
 * are sent in ONE message with the rich formatted body.
 *
 * @param {Array}  couponsList  — Array of coupon objects (id, brand, category, sellingPrice, originalValue, expiryDate, …)
 * @param {Object} sellerInfo   — { name, email }
 * @param {string} reviewUrl    — Admin panel review URL
 * @returns {{ success: boolean, sid?: string, error?: string }} — never throws, never exposes credentials.
 */
async function sendCouponSubmissionAlert(couponsList, sellerInfo, reviewUrl) {
  if (!isConfigured()) {
    return { success: false, error: 'Twilio WhatsApp is not configured on the server.' };
  }

  if (!Array.isArray(couponsList) || couponsList.length === 0) {
    return { success: false, error: 'No coupons to notify about.' };
  }

  const c = getConfig();

  try {
    const body = buildMessageBody(couponsList, sellerInfo, reviewUrl);

    const message = await getClient().messages.create({
      from: c.from,
      to: c.adminTo,
      body: body,
    });

    return { success: true, sid: message.sid };
  } catch (err) {
    // Log a sanitized message only — Twilio errors can contain account hints
    console.warn('Twilio WhatsApp send failed:', (err && err.message) ? String(err.message).slice(0, 200) : err);
    return { success: false, error: 'WhatsApp notification could not be sent.' };
  }
}

module.exports = { isConfigured, sendCouponSubmissionAlert };

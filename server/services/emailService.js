// ============================================
// SaveHatke — Email Service (Nodemailer)
// ============================================
// Handles real transactional emails including OTP verification.
// Configurable via environment variables (SMTP, Gmail, SendGrid, Resend, etc.)

const nodemailer = require('nodemailer');
const crypto = require('crypto');

let transporter = null;

/**
 * Creates or retrieves the Nodemailer transporter based on .env config.
 */
function getTransporter() {
  const user = (process.env.SMTP_USER || process.env.EMAIL_USER || '').trim();
  const rawPass = (process.env.SMTP_PASS || process.env.EMAIL_PASS || '').trim();
  const host = (process.env.SMTP_HOST || '').trim();
  const port = parseInt(process.env.SMTP_PORT, 10) || 465;
  const service = (process.env.EMAIL_SERVICE || '').trim();

  if (!user || !rawPass) {
    return null;
  }

  // Strip spaces commonly copied from Google App Password UI (e.g. "abcd efgh ijkl mnop")
  const pass = service.toLowerCase() === 'gmail' || host.includes('gmail')
    ? rawPass.replace(/\s+/g, '')
    : rawPass;

  if (service.toLowerCase() === 'gmail') {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
  }

  if (host) {
    const isSecure = process.env.SMTP_SECURE === 'true' || port === 465;
    return nodemailer.createTransport({
      host,
      port,
      secure: isSecure,
      auth: { user, pass },
      tls: {
        rejectUnauthorized: false,
      },
    });
  }

  return null;
}

/**
 * Check if email service is configured
 */
function isEmailConfigured() {
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
  const host = process.env.SMTP_HOST || process.env.EMAIL_SERVICE;
  return Boolean(user && pass && host);
}

/**
 * Escape user-supplied text before injecting it into an HTML email template.
 * Prevents broken markup and accidental HTML injection from the user_name.
 */
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build a dedicated transporter for the no-reply account that sends
 * welcome emails. If the user has configured NOREPLY_SMTP_* env vars
 * (separate Gmail / SendGrid / Resend / SMTP account dedicated to
 * outbound notifications) we use those; otherwise we fall back to
 * the main SMTP transporter with a noreply@… "from" address — most
 * providers (Gmail via "Send mail as", SendGrid, SES, etc.) allow
 * this when the address is a verified alias on the same account.
 */
function getNoreplyTransporter() {
  const host = (process.env.NOREPLY_SMTP_HOST || '').trim();
  const port = parseInt(process.env.NOREPLY_SMTP_PORT, 10) || 465;
  const user = (process.env.NOREPLY_SMTP_USER || '').trim();
  const pass = (process.env.NOREPLY_SMTP_PASS || '').trim();
  const service = (process.env.NOREPLY_EMAIL_SERVICE || '').trim();

  if (user && pass && (host || service)) {
    const passClean = (service.toLowerCase() === 'gmail' || host.includes('gmail'))
      ? pass.replace(/\s+/g, '')
      : pass;
    if (service.toLowerCase() === 'gmail') {
      return nodemailer.createTransport({ service: 'gmail', auth: { user, pass: passClean } });
    }
    const isSecure = process.env.NOREPLY_SMTP_SECURE === 'true' || port === 465;
    return nodemailer.createTransport({
      host, port, secure: isSecure, auth: { user, pass: passClean },
      tls: { rejectUnauthorized: false },
    });
  }

  // Fall back to the main SMTP transporter
  return getTransporter();
}

/**
 * Send a Welcome Email to a newly registered user.
 * Sent only for first-time sign-ups (the auth code guards on isNewSignup
 * before calling this). Uses the no-reply account by default so replies
 * are routed to the support inbox via Reply-To.
 *
 * @param {string} to - Recipient email address
 * @param {string} userName - Display name to greet the user with
 * @returns {Promise<{success: boolean, messageId?: string, isSimulated?: boolean, error?: string}>}
 */
async function sendWelcomeEmail(to, userName) {
  const cleanEmail = String(to || '').toLowerCase().trim();
  const safeName = escapeHtml(userName && String(userName).trim() ? userName.trim() : 'there');

  // No-reply "from" — separate config if the user has set it up,
  // otherwise fall back to the main SMTP_USER.
  const noreplyEmail = (process.env.NOREPLY_EMAIL
    || (process.env.NOREPLY_SMTP_USER && `${process.env.NOREPLY_SMTP_USER}`)
    || process.env.SMTP_USER
    || process.env.EMAIL_USER
    || 'noreply@savehatke.com').trim();
  const noreplyName = (process.env.NOREPLY_NAME
    || process.env.EMAIL_FROM_NAME
    || 'SaveHatke').trim();
  // Replies go to support (not the no-reply inbox)
  const replyTo = process.env.SUPPORT_EMAIL || 'support@savehatke.com';

  const t = getNoreplyTransporter();
  if (!t) {
    console.warn(`⚠️ [EmailService] SMTP not configured. Welcome email for ${cleanEmail} was NOT sent.`);
    console.warn(`ℹ️ To send real emails, add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS to your .env file.`);
    return {
      success: false,
      isSimulated: true,
      error: 'SMTP credentials not configured on server. Please add SMTP details to .env.',
    };
  }

  const subject = 'Welcome to SaveHatke! 🎉';
  const year = new Date().getFullYear();
  const currentYear = year === 2026 ? year : year;

  const textBody =
`# Welcome to SaveHatke! 🎉

Hi **${safeName}**,

Welcome to **SaveHatke** — India's coupon marketplace! 🛍️💰

We're excited to have you with us.

With SaveHatke, you can:

* 🏷️ **Buy premium coupons** at discounted prices
* 💰 **Sell coupons** you don't need
* 🔐 Find **verified coupons** from real users
* 💸 Save more on your favourite brands and services

Your account has been successfully created. You can now explore SaveHatke and start saving.

**Happy Saving! 💙**

If you need any help, our support team is always here for you.

Regards,
**Team SaveHatke**
India's Coupon Marketplace`;

  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to SaveHatke</title>
  </head>
  <body style="margin:0;padding:0;background-color:#060d1f;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2ecff;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#060d1f;padding:40px 15px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:580px;background:#0c1835;border:1px solid rgba(79,195,247,0.2);border-radius:18px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.6);" cellspacing="0" cellpadding="0" border="0">
            <!-- Header / Hero -->
            <tr>
              <td style="padding:36px 36px 18px;text-align:center;background:radial-gradient(ellipse at top, rgba(0,230,118,0.10) 0%, transparent 70%);">
                <div style="display:inline-block;padding:8px 16px;background:rgba(0,230,118,0.12);border:1px solid rgba(0,230,118,0.3);border-radius:10px;margin-bottom:16px;">
                  <span style="font-size:1.05rem;font-weight:900;color:#00e676;letter-spacing:0.5px;">💰 SaveHatke</span>
                </div>
                <div style="font-size:2.4rem;line-height:1;margin-bottom:8px;">🎉</div>
                <h1 style="margin:0;font-size:1.6rem;font-weight:800;color:#ffffff;line-height:1.3;">Welcome to SaveHatke!</h1>
              </td>
            </tr>

            <!-- Greeting -->
            <tr>
              <td style="padding:8px 36px 0;">
                <p style="margin:0 0 14px;font-size:1rem;color:#e2ecff;line-height:1.6;">Hi <strong style="color:#00e676;">${safeName}</strong>,</p>
                <p style="margin:0 0 18px;font-size:0.95rem;color:#a8c0dc;line-height:1.7;">Welcome to <strong style="color:#e2ecff;">SaveHatke</strong> — India's coupon marketplace! 🛍️💰</p>
                <p style="margin:0 0 18px;font-size:0.95rem;color:#a8c0dc;line-height:1.7;">We're excited to have you with us.</p>
              </td>
            </tr>

            <!-- What you can do -->
            <tr>
              <td style="padding:0 36px;">
                <p style="margin:0 0 12px;font-size:0.78rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#4fc3f7;">With SaveHatke, you can:</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:rgba(79,195,247,0.04);border:1px solid rgba(79,195,247,0.12);border-radius:12px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px;font-size:0.95rem;color:#e2ecff;line-height:1.5;">🏷️ <strong>Buy premium coupons</strong> at discounted prices</p>
                      <p style="margin:0 0 8px;font-size:0.95rem;color:#e2ecff;line-height:1.5;">💰 <strong>Sell coupons</strong> you don't need</p>
                      <p style="margin:0 0 8px;font-size:0.95rem;color:#e2ecff;line-height:1.5;">🔐 Find <strong>verified coupons</strong> from real users</p>
                      <p style="margin:0;font-size:0.95rem;color:#e2ecff;line-height:1.5;">💸 Save more on your favourite brands and services</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Account ready -->
            <tr>
              <td style="padding:22px 36px 0;">
                <p style="margin:0;font-size:0.95rem;color:#a8c0dc;line-height:1.7;">Your account has been successfully created. You can now explore SaveHatke and start saving.</p>
              </td>
            </tr>

            <!-- CTA Buttons -->
            <tr>
              <td style="padding:26px 36px 8px;" align="center">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:0 6px;">
                      <a href="https://savehatke.com/marketplace.html" style="display:inline-block;background:linear-gradient(135deg,#00e676,#00c853);color:#060d1f !important;text-decoration:none;font-weight:700;font-size:0.92rem;padding:12px 22px;border-radius:10px;">Browse Coupons →</a>
                    </td>
                    <td style="padding:0 6px;">
                      <a href="https://savehatke.com/sell.html" style="display:inline-block;background:transparent;color:#00e676 !important;text-decoration:none;font-weight:700;font-size:0.92rem;padding:11px 22px;border-radius:10px;border:1.5px solid rgba(0,230,118,0.45);">Sell a Coupon →</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Sign-off -->
            <tr>
              <td style="padding:24px 36px 0;">
                <p style="margin:0 0 6px;font-size:1rem;font-weight:700;color:#00e676;">Happy Saving! 💙</p>
                <p style="margin:0 0 18px;font-size:0.88rem;color:#a8c0dc;line-height:1.6;">If you need any help, our support team is always here for you.</p>
                <p style="margin:0;font-size:0.88rem;color:#8ba2c4;line-height:1.5;">Regards,<br><strong style="color:#e2ecff;">Team SaveHatke</strong><br><span style="color:#6b88aa;">India's Coupon Marketplace</span></p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:28px 36px 22px;background:rgba(6,13,31,0.6);border-top:1px solid rgba(79,195,247,0.1);text-align:center;">
                <p style="margin:0 0 4px;font-size:0.78rem;color:#5a789a;">© ${currentYear} SaveHatke — India's Smartest Price Tracker &amp; Coupon Marketplace.</p>
                <p style="margin:0;font-size:0.72rem;color:#4a6890;">This is a one-time welcome message sent to ${safeName}. Replies are not monitored — please reach support@savehatke.com for help.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;

  try {
    const info = await t.sendMail({
      from: `"${noreplyName}" <${noreplyEmail}>`,
      to: cleanEmail,
      replyTo,
      subject,
      text: textBody,
      html: htmlContent,
      headers: {
        'X-Entity-Ref-ID': `welcome-${Date.now()}`,
        'Auto-Submitted': 'auto-generated',
      },
    });

    console.log(`✅ [EmailService] Welcome email sent to ${cleanEmail} from ${noreplyEmail} (Message ID: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`❌ [EmailService] Failed to send welcome email to ${cleanEmail}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send 6-Digit OTP Email with SaveHatke HTML Branding
 * @param {string} to - Recipient email address
 * @param {string} otp - 6-digit OTP code
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendOTPEmail(to, otp) {
  const cleanEmail = to.toLowerCase().trim();
  const fromEmail = process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER || 'noreply@savehatke.com';
  const fromName = process.env.EMAIL_FROM_NAME || 'SaveHatke';

  const t = getTransporter();

  if (!t || !isEmailConfigured()) {
    console.warn(`⚠️ [EmailService] SMTP not configured. OTP for ${cleanEmail} is: ${otp}`);
    console.warn(`ℹ️ To send real emails, add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS to your .env file.`);
    return {
      success: false,
      isSimulated: true,
      error: 'SMTP credentials not configured on server. Please add SMTP details to .env.',
    };
  }

  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your SaveHatke Verification Code</title>
  </head>
  <body style="margin:0;padding:0;background-color:#060d1f;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2ecff;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#060d1f;padding:40px 15px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" max-width="520" style="max-width:520px;background:#0c1835;border:1px solid rgba(79,195,247,0.2);border-radius:18px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.6);" cellspacing="0" cellpadding="0" border="0">
            <!-- Header -->
            <tr>
              <td style="padding:32px 36px 20px;text-align:center;background:linear-gradient(180deg, rgba(0,230,118,0.08) 0%, transparent 100%);">
                <div style="display:inline-block;padding:8px 16px;background:rgba(0,230,118,0.12);border:1px solid rgba(0,230,118,0.3);border-radius:10px;margin-bottom:14px;">
                  <span style="font-size:1.1rem;font-weight:900;color:#00e676;letter-spacing:0.5px;">💰 SaveHatke</span>
                </div>
                <h1 style="margin:0;font-size:1.6rem;font-weight:800;color:#ffffff;line-height:1.3;">Verification Code</h1>
                <p style="margin:8px 0 0;font-size:0.9rem;color:#a8c0dc;">Use the code below to log in or verify your SaveHatke account.</p>
              </td>
            </tr>

            <!-- OTP Box -->
            <tr>
              <td style="padding:20px 36px;" align="center">
                <div style="background:rgba(0,230,118,0.07);border:2px dashed #00e676;border-radius:14px;padding:22px 28px;display:inline-block;margin:10px auto;">
                  <div style="font-family:'Courier New',Courier,monospace;font-size:2.4rem;font-weight:800;letter-spacing:10px;color:#00e676;text-align:center;padding-left:10px;">
                    ${otp}
                  </div>
                </div>
                <p style="margin:14px 0 0;font-size:0.82rem;color:#6b88aa;">
                  ⏱️ This code will expire in <strong style="color:#4fc3f7;">5 minutes</strong>.
                </p>
              </td>
            </tr>

            <!-- Security Notice -->
            <tr>
              <td style="padding:10px 36px 28px;">
                <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(79,195,247,0.1);border-radius:10px;padding:14px 18px;">
                  <p style="margin:0;font-size:0.8rem;color:#8ba2c4;line-height:1.5;">
                    🔒 <strong>Security Tip:</strong> Never share this code with anyone. SaveHatke support will never ask for your OTP. If you did not request this, you can safely ignore this email.
                  </p>
                </div>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:20px 36px;background:rgba(6,13,31,0.6);border-top:1px solid rgba(79,195,247,0.1);text-align:center;">
                <p style="margin:0;font-size:0.75rem;color:#5a789a;">
                  © 2026 SaveHatke — India's Smartest Price Tracker & Coupon Marketplace.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;

  try {
    const info = await t.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: cleanEmail,
      subject: `${otp} is your SaveHatke verification code`,
      text: `Your SaveHatke verification code is: ${otp}. It expires in 5 minutes. Do not share this code with anyone.`,
      html: htmlContent,
    });

    console.log(`✅ [EmailService] OTP email sent successfully to ${cleanEmail} (Message ID: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`❌ [EmailService] Failed to send OTP email to ${cleanEmail}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Support-email transporter — a dedicated mailbox for support conversations
 * (SUPPORT_EMAIL + SUPPORT_EMAIL_PASSWORD in .env). Falls back to the main
 * SMTP transporter when the dedicated support credentials are not set, so
 * acknowledgment emails still go out.
 */
function getSupportTransporter() {
  const user = (process.env.SUPPORT_EMAIL || '').trim();
  const rawPass = (process.env.SUPPORT_EMAIL_PASSWORD || '').trim();
  if (!user || !rawPass) {
    return getTransporter(); // fallback: main SMTP account
  }

  // Strip spaces commonly copied from Google App Password UI
  const pass = rawPass.replace(/\s+/g, '');
  const host = (process.env.SUPPORT_SMTP_HOST || 'smtp.gmail.com').trim();
  const port = parseInt(process.env.SUPPORT_SMTP_PORT, 10) || 465;

  return nodemailer.createTransport({
    host,
    port,
    secure: process.env.SUPPORT_SMTP_SECURE === 'true' || port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
}

/**
 * Check whether any transporter can send support emails — the dedicated
 * support mailbox or the main SMTP account.
 */
function isSupportEmailConfigured() {
  const supportConfigured = Boolean(
    (process.env.SUPPORT_EMAIL || '').trim() && (process.env.SUPPORT_EMAIL_PASSWORD || '').trim()
  );
  return supportConfigured || isEmailConfigured();
}

/**
 * Send the "Your support request has been received" acknowledgment email
 * when a user submits the support form.
 *
 * @param {object} params
 * @param {string} params.to - User's email address
 * @param {string} params.userName - User's display name
 * @param {string} params.caseId - Support case / ticket ID
 * @param {string} params.subject - Ticket subject
 * @param {string} params.createdAt - ISO creation timestamp
 * @param {string} params.message - The user's submitted message
 * @returns {Promise<{success: boolean, messageId?: string, isSimulated?: boolean, error?: string}>}
 */
async function sendSupportAckEmail({ to, userName, caseId, subject, createdAt, message }) {
  const cleanEmail = String(to || '').toLowerCase().trim();
  const safeName = escapeHtml(userName && String(userName).trim() ? userName.trim() : 'there');
  const safeCaseId = escapeHtml(caseId);
  const safeSubject = escapeHtml(subject);
  const safeMessage = escapeHtml(message);

  const createdDate = createdAt
    ? new Date(createdAt).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
      })
    : '—';

  const supportFrom = (process.env.SUPPORT_EMAIL || '').trim();
  const supportPass = (process.env.SUPPORT_EMAIL_PASSWORD || '').trim();
  const hasDedicatedSupport = Boolean(supportFrom && supportPass);
  // CRITICAL: when we fall back to the main SMTP account, the from address MUST
  // match the authenticated user. Otherwise Gmail / strict SMTP servers reject
  // the send as a forgery attempt. Only use SUPPORT_EMAIL as the from when we
  // also have a password for it (i.e. we're authenticated as that user).
  const fromEmail = hasDedicatedSupport
    ? supportFrom
    : (process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER || 'noreply@savehatke.com');
  const fromName = (process.env.SUPPORT_FROM_NAME || 'SaveHatke Support').trim();
  const siteUrl = (process.env.SITE_URL || 'https://savehatke.com').replace(/\/+$/, '');
  const viewUrl = `${siteUrl}/support.html`;
  const year = new Date().getFullYear();

  const t = getSupportTransporter();
  if (!t || !isSupportEmailConfigured()) {
    console.warn(`⚠️ [EmailService] Support email not configured. Acknowledgment for case ${safeCaseId} was NOT sent.`);
    console.warn(`ℹ️ Add SUPPORT_EMAIL + SUPPORT_EMAIL_PASSWORD (or SMTP_USER/SMTP_PASS) to your .env file.`);
    return {
      success: false,
      isSimulated: true,
      error: 'Support email credentials not configured on server. Please add support email details to .env.',
    };
  }

  const subject_ = `SaveHatke Support — Request received (Case #${safeCaseId})`;

  const textBody =
`# SaveHatke Support

## Your support request has been received

Hello ${userName ? String(userName).trim() : 'there'},

We've received your support request and created a case for it.

**Case ID:** #${caseId}

**Subject:** ${subject}

**Created:** ${createdDate}

**Status:** Open

### Your Message

${message}

Our support team will review your request and get back to you as soon as possible.

Please keep your **Case ID #${caseId}** for future reference when contacting SaveHatke Support about this request.

View Support Request: ${viewUrl}

If you did not submit this request, please contact us immediately.

Regards,

**SaveHatke Support Team**

© ${year} SaveHatke. All rights reserved.`;

  const htmlContent = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light">
    <title>Support Request Received — SaveHatke</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=DM+Serif+Display:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html { scroll-behavior: smooth; }
      body {
        font-family: 'Outfit', sans-serif;
        background: #f4f5f7;
        color: #0f1e3a;
        -webkit-font-smoothing: antialiased;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 48px 16px 64px;
        line-height: 1.65;
      }

      .email-wrapper {
        position: relative;
        width: 100%;
        max-width: 620px;
      }

      /* Top brand bar */
      .email-header {
        text-align: center;
        margin-bottom: 28px;
      }
      .brand-link {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        text-decoration: none;
        color: #0f1e3a;
        font-size: 1.3rem;
        font-weight: 800;
      }
      .brand-icon {
        width: 38px;
        height: 38px;
        border-radius: 10px;
        background: linear-gradient(135deg, #00e676, #4fc3f7);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.1rem;
      }
      .bhl { color: #00c853; }

      /* Main email card — fully white */
      .email-card {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 20px;
        overflow: hidden;
        box-shadow: 0 8px 28px rgba(15, 30, 58, 0.08);
      }

      .email-body { padding: 36px 40px; }

      .email-title {
        font-family: 'DM Serif Display', serif;
        font-size: 1.65rem;
        font-weight: 400;
        line-height: 1.25;
        color: #0f1e3a;
        margin-bottom: 6px;
      }
      .email-subtitle {
        font-size: 1.1rem;
        font-weight: 700;
        line-height: 1.45;
        color: #0f1e3a;
        margin-bottom: 28px;
        padding-bottom: 22px;
        border-bottom: 1px solid #e5e7eb;
      }

      .line {
        font-size: 0.95rem;
        color: #374151;
        line-height: 1.75;
        margin-bottom: 18px;
      }
      .line strong { color: #0f1e3a; font-weight: 700; }
      .mono { font-family: 'JetBrains Mono', monospace; }

      .case-list {
        list-style: none;
        padding: 14px 20px;
        margin: 0 0 24px;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
      }
      .case-list li {
        font-size: 0.95rem;
        color: #374151;
        line-height: 1.7;
        padding: 4px 0;
      }
      .case-list li strong { color: #000000; font-weight: 800; }

      .section-h {
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #6b7280;
        margin: 24px 0 10px;
      }
      .msg-box {
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-left: 3px solid #00c853;
        border-radius: 0 12px 12px 0;
        padding: 18px 20px;
        font-size: 0.92rem;
        color: #374151;
        line-height: 1.75;
        margin: 0 0 24px;
        word-break: break-word;
        white-space: pre-wrap;
      }

      /* CTA Button — website green */
      .cta-wrap {
        text-align: center;
        margin: 28px 0 24px;
      }
      .cta-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 0 40px;
        height: 52px;
        border-radius: 12px;
        background: linear-gradient(135deg, #00e676, #00c853);
        color: #0f1e3a;
        font-family: 'Outfit', sans-serif;
        font-size: 1rem;
        font-weight: 800;
        letter-spacing: 0.01em;
        text-decoration: none;
        box-shadow: 0 10px 24px rgba(0, 200, 83, 0.35);
      }

      .warn-line {
        font-size: 0.86rem;
        color: #92400e;
        line-height: 1.65;
        margin: 0 0 24px;
        padding: 14px 18px;
        background: #fffbeb;
        border: 1px solid #fde68a;
        border-radius: 10px;
      }
      .warn-line strong { color: #78350f; font-weight: 700; }

      .signoff {
        font-size: 0.92rem;
        color: #374151;
        line-height: 1.75;
        margin-top: 24px;
        padding-top: 22px;
        border-top: 1px solid #e5e7eb;
      }
      .signoff strong { color: #0f1e3a; font-weight: 700; }

      .email-footer {
        background: #f9fafb;
        border-top: 1px solid #e5e7eb;
        padding: 22px 40px;
        text-align: center;
      }
      .footer-copy {
        font-size: 0.78rem;
        color: #6b7280;
      }

      @media (max-width: 600px) {
        body { padding: 28px 12px 48px; }
        .email-body { padding: 28px 24px; }
        .email-footer { padding: 20px 24px; }
      }
    </style>
  </head>
  <body>

  <!-- Preheader (hidden inbox preview line) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">We've received your support request — Case #${safeCaseId} is now open.</div>

  <div class="email-wrapper">

    <!-- Brand Header -->
    <div class="email-header">
      <a href="${siteUrl}/index.html" class="brand-link">
        <div class="brand-icon">💰</div>
        <span>Save<span class="bhl">Hatke</span></span>
      </a>
    </div>

    <!-- Email Card -->
    <div class="email-card">

      <div class="email-body">

        <h1 class="email-title">SaveHatke Support</h1>
        <h2 class="email-subtitle">Your support request has been received</h2>

        <p class="line">Hello <strong>${safeName}</strong>,</p>

        <p class="line">We've received your support request and created a case for it.</p>

        <ul class="case-list">
          <li><strong>Case ID:</strong> <span class="mono">#${safeCaseId}</span></li>
          <li><strong>Subject:</strong> ${safeSubject}</li>
          <li><strong>Created:</strong> <span class="mono">${escapeHtml(createdDate)} IST</span></li>
          <li><strong>Status:</strong> Open</li>
        </ul>

        <h3 class="section-h">Your Message</h3>
        <div class="msg-box">${safeMessage}</div>

        <p class="line">Our support team will review your request and get back to you as soon as possible.</p>

        <p class="line">Please keep your <strong>Case ID #${safeCaseId}</strong> for future reference when contacting SaveHatke Support about this request.</p>

        <div class="cta-wrap">
          <a href="${viewUrl}" class="cta-btn">View Support Request</a>
        </div>

        <p class="warn-line">If you did not submit this request, please contact us immediately.</p>

        <div class="signoff">
          Regards,<br>
          <strong>SaveHatke Support Team</strong>
        </div>

      </div>

      <!-- Footer -->
      <div class="email-footer">
        <div class="footer-copy">© ${year} SaveHatke. All rights reserved.</div>
      </div>

    </div>

  </div>

  </body>
  </html>
  `;

  // ── Deliverability headers (no body change) ────────────────────────
  // Gmail (Feb 2024), Yahoo (Feb 2024) and Outlook (May 2025) all require
  // List-Unsubscribe for bulk senders. Even for low-volume transactional
  // mail, adding the header avoids the new "missing unsubscribe" penalty
  // that pushes otherwise-clean mail to Spam.
  const fqdn = (() => {
    try { return new URL(siteUrl).hostname || 'savehatke.com'; }
    catch { return 'savehatke.com'; }
  })();
  const emailHash = crypto.createHash('sha256').update(cleanEmail).digest('hex').slice(0, 16);
  const unsubscribeMailto = `unsubscribe+${emailHash}@${fqdn}`;
  const unsubscribeUrl = `${siteUrl}/unsubscribe?c=${emailHash}&case=${encodeURIComponent(safeCaseId)}`;

  const headers = {
    'X-Entity-Ref-ID': `support-ack-${safeCaseId}`,
    // RFC 3834 — tells spam filters this is an automated transactional
    // notification (not marketing/bulk), which helps inbox placement.
    'Auto-Submitted': 'auto-generated',
    'X-Mailer': 'SaveHatke Support',
    'X-Priority': '3',
    'Importance': 'Normal',
    // RFC 8058 one-click unsubscribe — required by Gmail/Yahoo/Outlook.
    'List-Unsubscribe': `<mailto:${unsubscribeMailto}>, <${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to: cleanEmail,
    replyTo: supportFrom || undefined,
    subject: subject_,
    text: textBody,
    html: htmlContent,
    envelope: { from: fromEmail, to: cleanEmail },
    messageId: `<support-ack-${safeCaseId}-${Date.now()}@${fqdn}>`,
    headers,
  };

  // Optional DKIM signing — only activates when the operator has set the
  // DKIM_DOMAIN + DKIM_SELECTOR + DKIM_PRIVATE_KEY env vars (e.g. once the
  // support mailbox is moved to a real transactional service that allows
  // custom DKIM for savehatke.com). With Gmail's free SMTP the message
  // is still signed by gmail.com — this just lets a future migration
  // re-sign with savehatke.com without code changes.
  if (
    process.env.DKIM_DOMAIN &&
    process.env.DKIM_SELECTOR &&
    process.env.DKIM_PRIVATE_KEY
  ) {
    mailOptions.dkim = {
      domainName: process.env.DKIM_DOMAIN.trim(),
      keySelector: process.env.DKIM_SELECTOR.trim(),
      privateKey: process.env.DKIM_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }

  try {
    const info = await t.sendMail(mailOptions);

    console.log(`✅ [EmailService] Support acknowledgment sent to ${cleanEmail} for case #${safeCaseId} (Message ID: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`❌ [EmailService] Failed to send support acknowledgment to ${cleanEmail}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send the "Your support case has been resolved ✅" email when an admin
 * clicks Mark Resolved in the admin support-cases page.
 *
 * @param {object} params
 * @param {string} params.to - User's email address
 * @param {string} params.userName - User's display name
 * @param {string} params.caseId - Support case / ticket ID
 * @param {string} params.subject - Ticket subject
 * @param {string} params.resolvedAt - ISO resolution timestamp
 * @param {string} params.userMessage - The user's original submitted message
 * @param {string} params.resolution - Admin-typed resolution message
 * @returns {Promise<{success: boolean, messageId?: string, isSimulated?: boolean, error?: string}>}
 */
async function sendSupportResolvedEmail({ to, userName, caseId, subject, resolvedAt, userMessage, resolution }) {
  const cleanEmail = String(to || '').toLowerCase().trim();
  const safeName = escapeHtml(userName && String(userName).trim() ? userName.trim() : 'there');
  const safeCaseId = escapeHtml(caseId);
  const safeSubject = escapeHtml(subject);
  const safeUserMessage = escapeHtml(userMessage);
  const safeResolution = escapeHtml(resolution && String(resolution).trim() ? resolution.trim() : 'Your case has been marked as resolved by the SaveHatke Support team.');

  const resolvedDate = resolvedAt
    ? new Date(resolvedAt).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
      })
    : '—';

  const supportFrom = (process.env.SUPPORT_EMAIL || '').trim();
  const supportPass = (process.env.SUPPORT_EMAIL_PASSWORD || '').trim();
  const hasDedicatedSupport = Boolean(supportFrom && supportPass);
  // CRITICAL: when we fall back to the main SMTP account, the from address MUST
  // match the authenticated user. Otherwise Gmail / strict SMTP servers reject
  // the send as a forgery attempt. Only use SUPPORT_EMAIL as the from when we
  // also have a password for it (i.e. we're authenticated as that user).
  const fromEmail = hasDedicatedSupport
    ? supportFrom
    : (process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER || 'noreply@savehatke.com');
  const fromName = (process.env.SUPPORT_FROM_NAME || 'SaveHatke Support').trim();
  const siteUrl = (process.env.SITE_URL || 'https://savehatke.com').replace(/\/+$/, '');
  const viewUrl = `${siteUrl}/support.html`;
  const year = new Date().getFullYear();

  const t = getSupportTransporter();
  if (!t || !isSupportEmailConfigured()) {
    console.warn(`⚠️ [EmailService] Support email not configured. Resolution notice for case ${safeCaseId} was NOT sent.`);
    console.warn(`ℹ️ Add SUPPORT_EMAIL + SUPPORT_EMAIL_PASSWORD (or SMTP_USER/SMTP_PASS) to your .env file.`);
    return {
      success: false,
      isSimulated: true,
      error: 'Support email credentials not configured on server. Please add support email details to .env.',
    };
  }

  const subject_ = `SaveHatke Support — Your case #${safeCaseId} has been resolved ✅`;

  const textBody =
`SaveHatke Support

Your support case has been resolved ✅

Hello ${userName ? String(userName).trim() : 'there'},

We're writing to let you know that your support request has been resolved.

Case ID: #${caseId}
Subject: ${subject}
Resolved: ${resolvedDate}
Status: Resolved

Your Message

${userMessage}

Resolution

${resolution && String(resolution).trim() ? resolution : 'Your case has been marked as resolved by the SaveHatke Support team.'}

We hope your issue has been resolved successfully. If you're still experiencing the same problem or need further assistance, you can reopen this case or contact our support team again.

View Case Details: ${viewUrl}

Thank you for contacting SaveHatke Support.

Regards,
SaveHatke Support Team

© ${year} SaveHatke. All rights reserved.`;

  const htmlContent = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light">
    <title>Support Case Resolved — SaveHatke</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=DM+Serif+Display:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html { scroll-behavior: smooth; }
      body {
        font-family: 'Outfit', sans-serif;
        background: #f4f5f7;
        color: #0f1e3a;
        -webkit-font-smoothing: antialiased;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 48px 16px 64px;
        line-height: 1.65;
      }

      .email-wrapper {
        position: relative;
        width: 100%;
        max-width: 620px;
      }

      /* Top brand bar */
      .email-header {
        text-align: center;
        margin-bottom: 28px;
      }
      .brand-link {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        text-decoration: none;
        color: #0f1e3a;
        font-size: 1.3rem;
        font-weight: 800;
      }
      .brand-icon {
        width: 38px;
        height: 38px;
        border-radius: 10px;
        background: linear-gradient(135deg, #00e676, #4fc3f7);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.1rem;
      }
      .bhl { color: #00c853; }

      /* Main email card — fully white */
      .email-card {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 20px;
        overflow: hidden;
        box-shadow: 0 8px 28px rgba(15, 30, 58, 0.08);
      }

      .email-body { padding: 36px 40px; }

      .email-title {
        font-family: 'DM Serif Display', serif;
        font-size: 1.65rem;
        font-weight: 400;
        line-height: 1.25;
        color: #0f1e3a;
        margin-bottom: 6px;
      }
      .email-subtitle {
        font-size: 1.1rem;
        font-weight: 700;
        line-height: 1.45;
        color: #0f1e3a;
        margin-bottom: 28px;
        padding-bottom: 22px;
        border-bottom: 1px solid #e5e7eb;
      }

      .line {
        font-size: 0.95rem;
        color: #374151;
        line-height: 1.75;
        margin-bottom: 18px;
      }
      .line strong { color: #0f1e3a; font-weight: 700; }
      .mono { font-family: 'JetBrains Mono', monospace; }

      .case-list {
        list-style: none;
        padding: 14px 20px;
        margin: 0 0 24px;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
      }
      .case-list li {
        font-size: 0.95rem;
        color: #374151;
        line-height: 1.7;
        padding: 4px 0;
      }
      .case-list li strong { color: #000000; font-weight: 800; }

      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: #dcfce7;
        color: #166534;
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 3px 10px;
        border-radius: 9999px;
        border: 1px solid #bbf7d0;
        margin-left: 4px;
        vertical-align: middle;
      }

      .section-h {
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #6b7280;
        margin: 24px 0 10px;
      }
      .msg-box, .resolution-box {
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 0 12px 12px 0;
        padding: 18px 20px;
        font-size: 0.92rem;
        color: #374151;
        line-height: 1.75;
        margin: 0 0 24px;
        word-break: break-word;
        white-space: pre-wrap;
      }
      .msg-box { border-left: 3px solid #00c853; }
      .resolution-box { border-left: 3px solid #0ea5e9; }

      /* CTA Button — website green */
      .cta-wrap {
        text-align: center;
        margin: 28px 0 24px;
      }
      .cta-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 0 40px;
        height: 52px;
        border-radius: 12px;
        background: linear-gradient(135deg, #00e676, #00c853);
        color: #0f1e3a;
        font-family: 'Outfit', sans-serif;
        font-size: 1rem;
        font-weight: 800;
        letter-spacing: 0.01em;
        text-decoration: none;
        box-shadow: 0 10px 24px rgba(0, 200, 83, 0.35);
      }

      .signoff {
        font-size: 0.92rem;
        color: #374151;
        line-height: 1.75;
        margin-top: 24px;
        padding-top: 22px;
        border-top: 1px solid #e5e7eb;
      }
      .signoff strong { color: #0f1e3a; font-weight: 700; }

      .email-footer {
        background: #f9fafb;
        border-top: 1px solid #e5e7eb;
        padding: 22px 40px;
        text-align: center;
      }
      .footer-copy {
        font-size: 0.78rem;
        color: #6b7280;
      }

      @media (max-width: 600px) {
        body { padding: 28px 12px 48px; }
        .email-body { padding: 28px 24px; }
        .email-footer { padding: 20px 24px; }
      }
    </style>
  </head>
  <body>

  <!-- Preheader (hidden inbox preview line) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your SaveHatke support case #${safeCaseId} has been resolved.</div>

  <div class="email-wrapper">

    <!-- Brand Header -->
    <div class="email-header">
      <a href="${siteUrl}/index.html" class="brand-link">
        <div class="brand-icon">💰</div>
        <span>Save<span class="bhl">Hatke</span></span>
      </a>
    </div>

    <!-- Email Card -->
    <div class="email-card">

      <div class="email-body">

        <h1 class="email-title">SaveHatke Support</h1>
        <h2 class="email-subtitle">Your support case has been resolved ✅</h2>

        <p class="line">Hello <strong>${safeName}</strong>,</p>

        <p class="line">We're writing to let you know that your support request has been resolved.</p>

        <ul class="case-list">
          <li><strong>Case ID:</strong> <span class="mono">#${safeCaseId}</span></li>
          <li><strong>Subject:</strong> ${safeSubject}</li>
          <li><strong>Resolved:</strong> <span class="mono">${escapeHtml(resolvedDate)} IST</span></li>
          <li><strong>Status:</strong> <span class="status-pill">✅ Resolved</span></li>
        </ul>

        <h3 class="section-h">Your Message</h3>
        <div class="msg-box">${safeUserMessage}</div>

        <h3 class="section-h">Resolution</h3>
        <div class="resolution-box">${safeResolution}</div>

        <p class="line">We hope your issue has been resolved successfully. If you're still experiencing the same problem or need further assistance, you can reopen this case or contact our support team again.</p>

        <div class="cta-wrap">
          <a href="${viewUrl}" class="cta-btn">View Case Details</a>
        </div>

        <p class="line">Thank you for contacting SaveHatke Support.</p>

        <div class="signoff">
          Regards,<br>
          <strong>SaveHatke Support Team</strong>
        </div>

      </div>

      <!-- Footer -->
      <div class="email-footer">
        <div class="footer-copy">© ${year} SaveHatke. All rights reserved.</div>
      </div>

    </div>

  </div>

  </body>
  </html>
  `;

  // ── Deliverability headers (same as sendSupportAckEmail) ────────────
  const fqdn = (() => {
    try { return new URL(siteUrl).hostname || 'savehatke.com'; }
    catch { return 'savehatke.com'; }
  })();
  const emailHash = crypto.createHash('sha256').update(cleanEmail).digest('hex').slice(0, 16);
  const unsubscribeMailto = `unsubscribe+${emailHash}@${fqdn}`;
  const unsubscribeUrl = `${siteUrl}/unsubscribe?c=${emailHash}&case=${encodeURIComponent(safeCaseId)}`;

  const headers = {
    'X-Entity-Ref-ID': `support-resolved-${safeCaseId}`,
    'Auto-Submitted': 'auto-generated',
    'X-Mailer': 'SaveHatke Support',
    'X-Priority': '3',
    'Importance': 'Normal',
    'List-Unsubscribe': `<mailto:${unsubscribeMailto}>, <${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to: cleanEmail,
    replyTo: supportFrom || undefined,
    subject: subject_,
    text: textBody,
    html: htmlContent,
    envelope: { from: fromEmail, to: cleanEmail },
    messageId: `<support-resolved-${safeCaseId}-${Date.now()}@${fqdn}>`,
    headers,
  };

  if (
    process.env.DKIM_DOMAIN &&
    process.env.DKIM_SELECTOR &&
    process.env.DKIM_PRIVATE_KEY
  ) {
    mailOptions.dkim = {
      domainName: process.env.DKIM_DOMAIN.trim(),
      keySelector: process.env.DKIM_SELECTOR.trim(),
      privateKey: process.env.DKIM_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }

  try {
    const info = await t.sendMail(mailOptions);
    console.log(`✅ [EmailService] Support resolution notice sent to ${cleanEmail} for case #${safeCaseId} (Message ID: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`❌ [EmailService] Failed to send support resolution notice to ${cleanEmail}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send the "New sign-in detected on your SaveHatke account" security alert
 * after a successful user login. NOT sent for admin logins (admins have
 * their own audit pipeline in the vault).
 *
 * @param {object} params
 * @param {string} params.to - User's email address
 * @param {string} params.userName - User's display name
 * @param {string} params.userEmail - User's email (echoed for verification)
 * @param {string} params.signInTime - ISO login timestamp
 * @param {string} params.ip - Client IP address
 * @param {string} params.device - Parsed device name (e.g. "iPhone 15 Pro")
 * @param {string} params.browser - Parsed browser name (e.g. "Chrome 127")
 * @param {string} params.os - Parsed OS name (e.g. "Windows 11")
 * @param {string} [params.city] - Geo-IP city (optional)
 * @param {string} [params.country] - Geo-IP country (optional)
 * @param {string} [params.loginMethod] - "Email" | "Google" | "OTP"
 * @returns {Promise<{success: boolean, messageId?: string, isSimulated?: boolean, error?: string}>}
 */
async function sendSignInAlertEmail({
  to, userName, userEmail, signInTime,
  ip, device, browser, os,
  city, country, loginMethod,
}) {
  const cleanEmail = String(to || '').toLowerCase().trim();
  if (!cleanEmail) {
    return { success: false, error: 'No recipient address provided.' };
  }
  const safeName = escapeHtml(userName && String(userName).trim() ? userName.trim() : 'there');
  const safeEmail = escapeHtml(userEmail || cleanEmail);

  const signInDate = signInTime
    ? new Date(signInTime).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
      })
    : new Date().toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
      });

  const safeIp = escapeHtml(ip || 'Unknown');
  const safeDevice = escapeHtml(device || 'Unknown device');
  const safeBrowser = escapeHtml(browser || 'Unknown browser');
  const safeOs = escapeHtml(os || 'Unknown OS');
  const safeCity = escapeHtml(city || '');
  const safeCountry = escapeHtml(country || '');
  const locationLine = [safeCity, safeCountry].filter(Boolean).join(', ');
  const safeMethod = escapeHtml(loginMethod || 'Email');

  // From-address selection — same rules as the support emails
  const supportFrom = (process.env.SUPPORT_EMAIL || '').trim();
  const supportPass = (process.env.SUPPORT_EMAIL_PASSWORD || '').trim();
  const hasDedicatedSupport = Boolean(supportFrom && supportPass);
  // For security alerts we want the same "support" mailbox to be the
  // verified sender so a tampered From: cannot impersonate SaveHatke.
  // Falls back to the main SMTP account when no dedicated support creds.
  const fromEmail = hasDedicatedSupport
    ? supportFrom
    : (process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER || 'noreply@savehatke.com');
  const fromName = (process.env.SECURITY_FROM_NAME || 'SaveHatke Security').trim();
  const siteUrl = (process.env.SITE_URL || 'https://savehatke.com').replace(/\/+$/, '');
  const secureUrl = `${siteUrl}/dashboard.html#security`;
  const year = new Date().getFullYear();

  const t = getSupportTransporter();
  if (!t || !isSupportEmailConfigured()) {
    console.warn(`⚠️ [EmailService] Support email not configured. Sign-in alert for ${cleanEmail} was NOT sent.`);
    return {
      success: false,
      isSimulated: true,
      error: 'Support email credentials not configured on server. Please add support email details to .env.',
    };
  }

  const subject_ = `SaveHatke Security — New sign-in detected on your account`;

  const textBody =
`SaveHatke Security

New sign-in detected on your SaveHatke account

Hello ${userName && String(userName).trim() ? userName.trim() : 'there'} (${userEmail || cleanEmail}),

We detected a new sign-in to your SaveHatke account. If this was you, you can safely ignore this email.

Sign-in details:
  Time: ${signInDate} IST
  IP Address: ${ip || 'Unknown'}
  Device: ${safeDevice}
  Browser: ${safeBrowser}
  Operating System: ${safeOs}
  ${locationLine ? `Location: ${locationLine}` : ''}
  Method: ${safeMethod}

If you don't recognize this activity, please secure your account immediately:
${secureUrl}

Thank you,
SaveHatke Security Team

© ${year} SaveHatke. All rights reserved.`;

  const htmlContent = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light">
    <title>New Sign-in Detected — SaveHatke Security</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=DM+Serif+Display:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html { scroll-behavior: smooth; }
      body {
        font-family: 'Outfit', sans-serif;
        background: #f4f5f7;
        color: #0f1e3a;
        -webkit-font-smoothing: antialiased;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 48px 16px 64px;
        line-height: 1.65;
      }

      .email-wrapper {
        position: relative;
        width: 100%;
        max-width: 620px;
      }

      .email-header {
        text-align: center;
        margin-bottom: 28px;
      }
      .brand-link {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        text-decoration: none;
        color: #0f1e3a;
        font-size: 1.3rem;
        font-weight: 800;
      }
      .brand-icon {
        width: 38px;
        height: 38px;
        border-radius: 10px;
        background: linear-gradient(135deg, #00e676, #4fc3f7);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.1rem;
      }
      .bhl { color: #00c853; }

      .email-card {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 20px;
        overflow: hidden;
        box-shadow: 0 8px 28px rgba(15, 30, 58, 0.08);
      }

      .email-body { padding: 36px 40px; }

      .email-title {
        font-family: 'DM Serif Display', serif;
        font-size: 1.65rem;
        font-weight: 400;
        line-height: 1.25;
        color: #0f1e3a;
        margin-bottom: 6px;
      }
      /* Per spec: the h2 ("New sign-in detected...") is BOLD BLACK */
      .email-subtitle {
        font-size: 1.1rem;
        font-weight: 800;
        line-height: 1.45;
        color: #000000;
        margin-bottom: 28px;
        padding-bottom: 22px;
        border-bottom: 1px solid #e5e7eb;
      }

      .line {
        font-size: 0.95rem;
        color: #374151;
        line-height: 1.75;
        margin-bottom: 18px;
      }
      /* Per spec: {{user_name}} is "less bold black" — weight 700, dark navy */
      .line .greeting-name {
        color: #0f1e3a;
        font-weight: 700;
      }
      /* Per spec: ({{user_email}}) is in website green */
      .line .greeting-email {
        color: #00c853;
        font-weight: 600;
      }
      .mono { font-family: 'JetBrains Mono', monospace; }

      .case-list {
        list-style: none;
        padding: 14px 20px;
        margin: 0 0 24px;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
      }
      .case-list li {
        font-size: 0.95rem;
        color: #374151;
        line-height: 1.7;
        padding: 4px 0;
      }
      .case-list li strong { color: #000000; font-weight: 800; }

      .warn-line {
        font-size: 0.86rem;
        color: #92400e;
        line-height: 1.65;
        margin: 0 0 24px;
        padding: 14px 18px;
        background: #fffbeb;
        border: 1px solid #fde68a;
        border-radius: 10px;
      }
      .warn-line strong { color: #78350f; font-weight: 700; }

      /* CTA Button — website green */
      .cta-wrap {
        text-align: center;
        margin: 28px 0 24px;
      }
      .cta-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 0 40px;
        height: 52px;
        border-radius: 12px;
        background: linear-gradient(135deg, #00e676, #00c853);
        color: #0f1e3a;
        font-family: 'Outfit', sans-serif;
        font-size: 1rem;
        font-weight: 800;
        letter-spacing: 0.01em;
        text-decoration: none;
        box-shadow: 0 10px 24px rgba(0, 200, 83, 0.35);
      }

      .signoff {
        font-size: 0.92rem;
        color: #374151;
        line-height: 1.75;
        margin-top: 24px;
        padding-top: 22px;
        border-top: 1px solid #e5e7eb;
      }
      .signoff strong { color: #0f1e3a; font-weight: 700; }

      .email-footer {
        background: #f9fafb;
        border-top: 1px solid #e5e7eb;
        padding: 22px 40px;
        text-align: center;
      }
      .footer-copy {
        font-size: 0.78rem;
        color: #6b7280;
      }

      @media (max-width: 600px) {
        body { padding: 28px 12px 48px; }
        .email-body { padding: 28px 24px; }
        .email-footer { padding: 20px 24px; }
      }
    </style>
  </head>
  <body>

  <!-- Preheader (hidden inbox preview line) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">New sign-in detected on your SaveHatke account at ${signInDate}.</div>

  <div class="email-wrapper">

    <!-- Brand Header -->
    <div class="email-header">
      <a href="${siteUrl}/index.html" class="brand-link">
        <div class="brand-icon">🛡️</div>
        <span>Save<span class="bhl">Hatke</span></span>
      </a>
    </div>

    <!-- Email Card -->
    <div class="email-card">

      <div class="email-body">

        <h1 class="email-title">SaveHatke Security</h1>
        <h2 class="email-subtitle">New sign-in detected on your SaveHatke account</h2>

        <p class="line">
          Hello <span class="greeting-name">${safeName}</span>
          <span class="greeting-email">(${safeEmail})</span>,
        </p>

        <p class="line">We detected a new sign-in to your SaveHatke account. If this was you, you can safely ignore this email.</p>

        <ul class="case-list">
          <li><strong>Time:</strong> <span class="mono">${escapeHtml(signInDate)} IST</span></li>
          <li><strong>IP Address:</strong> <span class="mono">${safeIp}</span></li>
          ${locationLine ? `<li><strong>Location:</strong> ${escapeHtml(locationLine)}</li>` : ''}
          <li><strong>Device:</strong> ${safeDevice}</li>
          <li><strong>Browser:</strong> ${safeBrowser}</li>
          <li><strong>Operating System:</strong> ${safeOs}</li>
          <li><strong>Sign-in Method:</strong> ${safeMethod}</li>
        </ul>

        <p class="warn-line"><strong>Didn't sign in?</strong> If you don't recognize this activity, please secure your account immediately — change your password and end all active sessions from the security page.</p>

        <div class="cta-wrap">
          <a href="${secureUrl}" class="cta-btn">🔒 Secure My Account</a>
        </div>

        <p class="line">Thank you,<br><strong>SaveHatke Security Team</strong></p>

      </div>

      <!-- Footer -->
      <div class="email-footer">
        <div class="footer-copy">© ${year} SaveHatke. All rights reserved.</div>
      </div>

    </div>

  </div>

  </body>
  </html>
  `;

  // ── Deliverability headers ─────────────────────────────────────────
  const fqdn = (() => {
    try { return new URL(siteUrl).hostname || 'savehatke.com'; }
    catch { return 'savehatke.com'; }
  })();
  const emailHash = crypto.createHash('sha256').update(cleanEmail).digest('hex').slice(0, 16);
  const unsubscribeMailto = `unsubscribe+${emailHash}@${fqdn}`;
  const unsubscribeUrl = `${siteUrl}/unsubscribe?c=${emailHash}&type=security`;

  const headers = {
    'X-Entity-Ref-ID': `signin-alert-${emailHash}-${Date.now()}`,
    'Auto-Submitted': 'auto-generated',
    'X-Mailer': 'SaveHatke Security',
    'X-Priority': '1', // Security alerts are high-priority
    'Importance': 'High',
    'List-Unsubscribe': `<mailto:${unsubscribeMailto}>, <${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to: cleanEmail,
    replyTo: supportFrom || undefined,
    subject: subject_,
    text: textBody,
    html: htmlContent,
    envelope: { from: fromEmail, to: cleanEmail },
    messageId: `<signin-alert-${emailHash}-${Date.now()}@${fqdn}>`,
    headers,
  };

  if (
    process.env.DKIM_DOMAIN &&
    process.env.DKIM_SELECTOR &&
    process.env.DKIM_PRIVATE_KEY
  ) {
    mailOptions.dkim = {
      domainName: process.env.DKIM_DOMAIN.trim(),
      keySelector: process.env.DKIM_SELECTOR.trim(),
      privateKey: process.env.DKIM_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }

  try {
    const info = await t.sendMail(mailOptions);
    console.log(`✅ [EmailService] Sign-in alert sent to ${cleanEmail} (IP: ${ip || 'n/a'}, device: ${safeDevice}) (Message ID: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`❌ [EmailService] Failed to send sign-in alert to ${cleanEmail}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  sendOTPEmail,
  sendWelcomeEmail,
  sendSupportAckEmail,
  sendSupportResolvedEmail,
  sendSignInAlertEmail,
  isEmailConfigured,
  isSupportEmailConfigured,
};

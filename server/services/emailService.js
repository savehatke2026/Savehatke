// ============================================
// SaveHatke — Email Service (Nodemailer)
// ============================================
// Handles real transactional emails including OTP verification.
// Configurable via environment variables (SMTP, Gmail, SendGrid, Resend, etc.)

const nodemailer = require('nodemailer');

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
`SaveHatke Support

Your support request has been received

Hello ${userName ? String(userName).trim() : 'there'},

We've received your support request and created a case for it.

Case ID: #${caseId}
Subject: ${subject}
Created: ${createdDate}
Status: Open

Your Message:

${message}

Our support team will review your request and get back to you as soon as possible.

Please keep your Case ID #${caseId} for future reference when contacting SaveHatke Support about this request.

View Support Request: ${viewUrl}

If you did not submit this request, please contact us immediately.

Regards,
SaveHatke Support Team

© ${year} SaveHatke. All rights reserved.`;

  const htmlContent = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="dark">
    <title>Support Request Received — SaveHatke</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=DM+Serif+Display:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html { scroll-behavior: smooth; }
      body {
        font-family: 'Outfit', sans-serif;
        background: #060d1f;
        color: #e2ecff;
        -webkit-font-smoothing: antialiased;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
        padding: 48px 16px 64px;
      }

      /* Background mesh */
      .bg-mesh {
        position: fixed;
        inset: 0;
        background:
          radial-gradient(ellipse 70% 55% at 15% 20%, rgba(0,230,118,.06) 0%, transparent 65%),
          radial-gradient(ellipse 60% 70% at 85% 80%, rgba(79,195,247,.05) 0%, transparent 65%);
        pointer-events: none;
        z-index: 0;
      }
      .bg-grid {
        position: fixed;
        inset: 0;
        background-image:
          linear-gradient(rgba(79,195,247,.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(79,195,247,.03) 1px, transparent 1px);
        background-size: 52px 52px;
        pointer-events: none;
        z-index: 0;
      }

      /* Wrapper */
      .email-wrapper {
        position: relative;
        z-index: 1;
        width: 100%;
        max-width: 620px;
      }

      /* Top brand bar */
      .email-header {
        text-align: center;
        margin-bottom: 32px;
      }
      .brand-link {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        text-decoration: none;
        color: #e2ecff;
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
        flex-shrink: 0;
      }
      .bhl { color: #00e676; }

      /* Main email card */
      .email-card {
        background: rgba(15, 30, 58, 0.92);
        border: 1px solid rgba(79, 195, 247, 0.15);
        border-radius: 20px;
        overflow: hidden;
        box-shadow: 0 32px 80px rgba(0, 0, 0, 0.5);
      }

      /* Email card top banner */
      .email-banner {
        background: linear-gradient(135deg, rgba(0,230,118,.12) 0%, rgba(79,195,247,.08) 100%);
        border-bottom: 1px solid rgba(0, 230, 118, 0.18);
        padding: 36px 40px 32px;
        text-align: center;
      }
      .banner-icon {
        width: 64px;
        height: 64px;
        border-radius: 18px;
        background: linear-gradient(135deg, #00e676, #00c853);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.9rem;
        margin: 0 auto 20px;
        box-shadow: 0 12px 32px rgba(0, 230, 118, 0.3);
      }
      .banner-title {
        font-family: 'DM Serif Display', serif;
        font-size: clamp(1.55rem, 3vw, 2rem);
        line-height: 1.2;
        margin-bottom: 8px;
        color: #e2ecff;
      }
      .banner-sub {
        font-size: 0.92rem;
        color: #a8c0dc;
        line-height: 1.6;
      }
      .gtext {
        background: linear-gradient(135deg, #00e676, #4fc3f7);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      /* Email body */
      .email-body {
        padding: 36px 40px;
      }

      /* Greeting */
      .greeting {
        font-size: 1rem;
        color: #a8c0dc;
        line-height: 1.7;
        margin-bottom: 28px;
      }
      .greeting strong {
        color: #e2ecff;
        font-weight: 700;
      }

      /* Case details card */
      .case-card {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(79, 195, 247, 0.12);
        border-radius: 14px;
        overflow: hidden;
        margin-bottom: 28px;
      }
      .case-card-hdr {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 14px 20px;
        background: rgba(0, 230, 118, 0.06);
        border-bottom: 1px solid rgba(0, 230, 118, 0.12);
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #00e676;
      }
      .case-fields {
        padding: 6px 0;
      }
      .case-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 13px 20px;
        border-bottom: 1px solid rgba(79, 195, 247, 0.06);
        gap: 16px;
      }
      .case-row:last-child {
        border-bottom: none;
      }
      .case-label {
        font-size: 0.8rem;
        color: #6b88aa;
        font-weight: 600;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .case-value {
        font-size: 0.88rem;
        color: #e2ecff;
        font-weight: 600;
        text-align: right;
      }
      .case-value.mono {
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.85rem;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: rgba(0, 230, 118, 0.1);
        border: 1px solid rgba(0, 230, 118, 0.28);
        color: #00e676;
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 4px 12px;
        border-radius: 9999px;
      }
      .status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #00e676;
        animation: pulse 2s ease infinite;
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      /* Message block */
      .msg-label {
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #6b88aa;
        margin-bottom: 12px;
      }
      .msg-box {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(79, 195, 247, 0.1);
        border-left: 3px solid rgba(0, 230, 118, 0.5);
        border-radius: 0 12px 12px 0;
        padding: 18px 20px;
        font-size: 0.9rem;
        color: #a8c0dc;
        line-height: 1.75;
        margin-bottom: 28px;
        word-break: break-word;
        white-space: pre-wrap;
      }

      /* Info notice */
      .info-notice {
        background: rgba(79, 195, 247, 0.05);
        border: 1px solid rgba(79, 195, 247, 0.15);
        border-radius: 12px;
        padding: 18px 20px;
        font-size: 0.88rem;
        color: #a8c0dc;
        line-height: 1.7;
        margin-bottom: 28px;
      }
      .info-notice strong {
        color: #4fc3f7;
      }

      /* Case ID highlight */
      .case-id-callout {
        background: rgba(0, 230, 118, 0.06);
        border: 1px solid rgba(0, 230, 118, 0.2);
        border-radius: 12px;
        padding: 16px 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 28px;
        flex-wrap: wrap;
      }
      .case-id-text {
        font-size: 0.83rem;
        color: #a8c0dc;
      }
      .case-id-text strong {
        color: #e2ecff;
      }
      .case-id-badge {
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.9rem;
        font-weight: 700;
        color: #00e676;
        background: rgba(0, 230, 118, 0.1);
        border: 1px solid rgba(0, 230, 118, 0.25);
        padding: 6px 14px;
        border-radius: 8px;
        white-space: nowrap;
      }

      /* CTA Button */
      .cta-wrap {
        text-align: center;
        margin-bottom: 28px;
      }
      .cta-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 0 36px;
        height: 50px;
        border-radius: 12px;
        background: linear-gradient(135deg, #00e676, #00c853);
        color: #060d1f;
        font-family: 'Outfit', sans-serif;
        font-size: 0.95rem;
        font-weight: 700;
        text-decoration: none;
        border: none;
        cursor: pointer;
        transition: all 0.22s;
        box-shadow: 0 8px 24px rgba(0, 230, 118, 0.3);
      }
      .cta-btn:hover {
        opacity: 0.88;
        transform: translateY(-2px);
        box-shadow: 0 12px 32px rgba(0, 230, 118, 0.45);
      }

      /* Divider */
      .divider {
        height: 1px;
        background: rgba(79, 195, 247, 0.08);
        margin: 0 0 28px;
      }

      /* Warning notice */
      .warn-notice {
        background: rgba(255, 183, 77, 0.05);
        border: 1px solid rgba(255, 183, 77, 0.15);
        border-radius: 10px;
        padding: 14px 18px;
        font-size: 0.82rem;
        color: #a8c0dc;
        line-height: 1.65;
        margin-bottom: 28px;
      }
      .warn-notice strong {
        color: #ffb74d;
      }

      /* Sign-off */
      .signoff {
        font-size: 0.9rem;
        color: #a8c0dc;
        line-height: 1.75;
      }
      .signoff strong {
        color: #e2ecff;
        font-weight: 700;
      }

      /* Email footer */
      .email-footer {
        background: rgba(9, 16, 34, 0.8);
        border-top: 1px solid rgba(79, 195, 247, 0.08);
        padding: 24px 40px;
        text-align: center;
      }
      .footer-links {
        display: flex;
        justify-content: center;
        gap: 24px;
        flex-wrap: wrap;
        margin-bottom: 14px;
      }
      .footer-links a {
        font-size: 0.78rem;
        color: #6b88aa;
        text-decoration: none;
        transition: color 0.2s;
      }
      .footer-links a:hover {
        color: #00e676;
      }
      .footer-copy {
        font-size: 0.76rem;
        color: rgba(107, 136, 170, 0.7);
      }

      /* Bottom brand note */
      .bottom-note {
        text-align: center;
        margin-top: 24px;
        font-size: 0.75rem;
        color: rgba(107, 136, 170, 0.6);
      }

      @media (max-width: 600px) {
        body { padding: 28px 12px 48px; }
        .email-banner { padding: 28px 24px 24px; }
        .email-body { padding: 28px 24px; }
        .email-footer { padding: 20px 24px; }
        .case-row { flex-direction: column; align-items: flex-start; gap: 4px; }
        .case-value { text-align: left; }
        .case-id-callout { flex-direction: column; align-items: flex-start; }
      }
    </style>
  </head>
  <body>

  <!-- Preheader (hidden inbox preview line) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your support request has been received — Case #${safeCaseId} is now open.</div>

  <div class="bg-mesh"></div>
  <div class="bg-grid"></div>

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

      <!-- Banner -->
      <div class="email-banner">
        <div class="banner-icon">🎧</div>
        <h1 class="banner-title">Support Request <span class="gtext">Received</span></h1>
        <p class="banner-sub">We've got your message and are on it.</p>
      </div>

      <!-- Body -->
      <div class="email-body">

        <!-- Greeting -->
        <p class="greeting">
          Hello <strong>${safeName}</strong>,<br><br>
          We've received your support request and a case has been created for it. Our support team will review your request and get back to you as soon as possible.
        </p>

        <!-- Case Details -->
        <div class="case-card">
          <div class="case-card-hdr">
            📋 &nbsp;Case Details
          </div>
          <div class="case-fields">
            <div class="case-row">
              <span class="case-label">Case ID</span>
              <span class="case-value mono">#${safeCaseId}</span>
            </div>
            <div class="case-row">
              <span class="case-label">Subject</span>
              <span class="case-value">${safeSubject}</span>
            </div>
            <div class="case-row">
              <span class="case-label">Created</span>
              <span class="case-value mono">${escapeHtml(createdDate)} IST</span>
            </div>
            <div class="case-row">
              <span class="case-label">Status</span>
              <span class="case-value">
                <span class="status-pill">
                  <span class="status-dot"></span>
                  Open
                </span>
              </span>
            </div>
          </div>
        </div>

        <!-- User Message -->
        <div class="msg-label">Your Message</div>
        <div class="msg-box">${safeMessage}</div>

        <!-- Info -->
        <div class="info-notice">
          Our support team will review your request and get back to you as soon as possible. Response times are typically <strong>within 2–4 hours</strong> on business days.
        </div>

        <!-- Case ID Callout -->
        <div class="case-id-callout">
          <div class="case-id-text">
            Keep your <strong>Case ID</strong> handy for future reference when contacting SaveHatke Support about this request.
          </div>
          <div class="case-id-badge">#${safeCaseId}</div>
        </div>

        <!-- CTA -->
        <div class="cta-wrap">
          <a href="${viewUrl}" class="cta-btn">
            🔍 View Support Request
          </a>
        </div>

        <div class="divider"></div>

        <!-- Warning -->
        <div class="warn-notice">
          ⚠️ <strong>Didn't submit this request?</strong> If you did not submit this support request, please contact us immediately at <strong><a href="mailto:support@savehatke.com" style="color:#ffb74d;text-decoration:none;">support@savehatke.com</a></strong> so we can secure your account.
        </div>

        <!-- Sign-off -->
        <div class="signoff">
          Regards,<br>
          <strong>SaveHatke Support Team</strong>
        </div>

      </div>

      <!-- Footer -->
      <div class="email-footer">
        <div class="footer-links">
          <a href="${siteUrl}/support.html">Help Center</a>
          <a href="${siteUrl}/privacy.html">Privacy Policy</a>
          <a href="${siteUrl}/terms.html">Terms &amp; Conditions</a>
          <a href="${siteUrl}/marketplace.html">Marketplace</a>
        </div>
        <div class="footer-copy">© ${year} SaveHatke. All rights reserved. &nbsp;·&nbsp; Made with ❤️ in India</div>
      </div>

    </div>

    <div class="bottom-note">
      This is an automated email from SaveHatke Support. Please do not reply directly to this email.
    </div>

  </div>

  </body>
  </html>
  `;

  try {
    const info = await t.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: cleanEmail,
      replyTo: supportFrom || undefined,
      subject: subject_,
      text: textBody,
      html: htmlContent,
      headers: {
        'X-Entity-Ref-ID': `support-ack-${safeCaseId}`,
        // RFC 3834 — tells spam filters this is an automated transactional
        // notification (not marketing/bulk), which helps inbox placement.
        'Auto-Submitted': 'auto-generated',
      },
    });

    console.log(`✅ [EmailService] Support acknowledgment sent to ${cleanEmail} for case #${safeCaseId} (Message ID: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`❌ [EmailService] Failed to send support acknowledgment to ${cleanEmail}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  sendOTPEmail,
  sendWelcomeEmail,
  sendSupportAckEmail,
  isEmailConfigured,
  isSupportEmailConfigured,
};

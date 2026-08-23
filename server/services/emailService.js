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
 * Send a Welcome Email to a newly registered user.
 * Same dark SaveHatke branding as the OTP email, but celebratory.
 *
 * @param {string} to - Recipient email address
 * @param {string} userName - Display name to greet the user with
 * @returns {Promise<{success: boolean, messageId?: string, isSimulated?: boolean, error?: string}>}
 */
async function sendWelcomeEmail(to, userName) {
  const cleanEmail = String(to || '').toLowerCase().trim();
  const safeName = escapeHtml(userName && String(userName).trim() ? userName.trim() : 'there');
  const fromEmail = process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER || 'noreply@savehatke.com';
  const fromName = process.env.EMAIL_FROM_NAME || 'SaveHatke';

  const t = getTransporter();
  if (!t || !isEmailConfigured()) {
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
`Welcome to SaveHatke! 🎉

Hi ${safeName},

Welcome to SaveHatke — a simple and convenient platform to buy and sell unused coupons. 🛍️💰

We're excited to have you with us.

With SaveHatke, you can:

🏷️ Buy coupons at better prices
💰 Sell coupons you don't need
🔎 Discover available deals and discounts
🔐 Trade through a simple and secure platform

Your account has been successfully created. You can now explore available coupons, find great savings, or list coupons you no longer need.

Happy Saving! 💙

If you need any help, our support team is always here for you.

Regards,
Team SaveHatke`;

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
          <table role="presentation" width="100%" style="max-width:560px;background:#0c1835;border:1px solid rgba(79,195,247,0.2);border-radius:18px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.6);" cellspacing="0" cellpadding="0" border="0">
            <!-- Header / Hero -->
            <tr>
              <td style="padding:36px 36px 24px;text-align:center;background:radial-gradient(ellipse at top, rgba(0,230,118,0.10) 0%, transparent 70%);">
                <div style="display:inline-block;padding:8px 16px;background:rgba(0,230,118,0.12);border:1px solid rgba(0,230,118,0.3);border-radius:10px;margin-bottom:16px;">
                  <span style="font-size:1.1rem;font-weight:900;color:#00e676;letter-spacing:0.5px;">💰 SaveHatke</span>
                </div>
                <div style="font-size:2.6rem;line-height:1;margin-bottom:10px;">🎉</div>
                <h1 style="margin:0;font-size:1.7rem;font-weight:800;color:#ffffff;line-height:1.3;">Welcome to SaveHatke!</h1>
                <p style="margin:10px 0 0;font-size:0.95rem;color:#a8c0dc;">India's coupon marketplace — built around a simple idea.</p>
              </td>
            </tr>

            <!-- Greeting -->
            <tr>
              <td style="padding:8px 36px 0;">
                <p style="margin:0 0 14px;font-size:1rem;color:#e2ecff;line-height:1.6;">Hi <strong style="color:#00e676;">${safeName}</strong>,</p>
                <p style="margin:0 0 18px;font-size:0.95rem;color:#a8c0dc;line-height:1.7;">Welcome to SaveHatke — a simple and convenient platform to buy and sell unused coupons. 🛍️💰</p>
                <p style="margin:0 0 22px;font-size:0.95rem;color:#a8c0dc;line-height:1.7;">We're excited to have you with us.</p>
              </td>
            </tr>

            <!-- What you can do -->
            <tr>
              <td style="padding:0 36px;">
                <p style="margin:0 0 12px;font-size:0.78rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#4fc3f7;">With SaveHatke, you can:</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:rgba(79,195,247,0.04);border:1px solid rgba(79,195,247,0.12);border-radius:12px;">
                  <tr>
                    <td style="padding:18px 20px;">
                      <p style="margin:0 0 10px;font-size:0.95rem;color:#e2ecff;line-height:1.5;">🏷️ <strong>Buy coupons</strong> at better prices</p>
                      <p style="margin:0 0 10px;font-size:0.95rem;color:#e2ecff;line-height:1.5;">💰 <strong>Sell coupons</strong> you don't need</p>
                      <p style="margin:0 0 10px;font-size:0.95rem;color:#e2ecff;line-height:1.5;">🔎 <strong>Discover</strong> available deals and discounts</p>
                      <p style="margin:0;font-size:0.95rem;color:#e2ecff;line-height:1.5;">🔐 <strong>Trade</strong> through a simple and secure platform</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Account ready -->
            <tr>
              <td style="padding:22px 36px 0;">
                <p style="margin:0;font-size:0.95rem;color:#a8c0dc;line-height:1.7;">Your account has been successfully created. You can now explore available coupons, find great savings, or list coupons you no longer need.</p>
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
                <p style="margin:0;font-size:0.88rem;color:#8ba2c4;line-height:1.5;">Regards,<br><strong style="color:#e2ecff;">Team SaveHatke</strong></p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:28px 36px 22px;background:rgba(6,13,31,0.6);border-top:1px solid rgba(79,195,247,0.1);text-align:center;">
                <p style="margin:0 0 4px;font-size:0.78rem;color:#5a789a;">© ${currentYear} SaveHatke — India's Smartest Price Tracker &amp; Coupon Marketplace.</p>
                <p style="margin:0;font-size:0.72rem;color:#4a6890;">You're receiving this because you just created a SaveHatke account.</p>
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
      replyTo: process.env.SUPPORT_EMAIL || 'support@savehatke.com',
      subject,
      text: textBody,
      html: htmlContent,
      headers: {
        'X-Entity-Ref-ID': `welcome-${Date.now()}`,
      },
    });

    console.log(`✅ [EmailService] Welcome email sent to ${cleanEmail} (Message ID: ${info.messageId})`);
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
  const fromEmail = supportFrom
    || process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER
    || 'noreply@savehatke.com';
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
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SaveHatke Support — Your support request has been received</title>
  </head>
  <body style="margin:0;padding:0;background-color:#060d1f;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2ecff;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#060d1f;padding:40px 15px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:560px;background:#0c1835;border:1px solid rgba(79,195,247,0.2);border-radius:18px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.6);" cellspacing="0" cellpadding="0" border="0">
            <!-- Header -->
            <tr>
              <td style="padding:32px 36px 20px;text-align:center;background:radial-gradient(ellipse at top, rgba(0,230,118,0.10) 0%, transparent 70%);">
                <div style="display:inline-block;padding:8px 16px;background:rgba(0,230,118,0.12);border:1px solid rgba(0,230,118,0.3);border-radius:10px;margin-bottom:14px;">
                  <span style="font-size:1.1rem;font-weight:900;color:#00e676;letter-spacing:0.5px;">💰 SaveHatke</span>
                </div>
                <div style="font-size:2rem;line-height:1;margin-bottom:8px;">🛟</div>
                <h1 style="margin:0;font-size:1.5rem;font-weight:800;color:#ffffff;line-height:1.3;">SaveHatke Support</h1>
                <p style="margin:8px 0 0;font-size:0.95rem;color:#a8c0dc;">Your support request has been received</p>
              </td>
            </tr>

            <!-- Greeting -->
            <tr>
              <td style="padding:20px 36px 0;">
                <p style="margin:0 0 14px;font-size:1rem;color:#e2ecff;line-height:1.6;">Hello <strong style="color:#00e676;">${safeName}</strong>,</p>
                <p style="margin:0 0 18px;font-size:0.95rem;color:#a8c0dc;line-height:1.7;">We've received your support request and created a case for it.</p>
              </td>
            </tr>

            <!-- Case details -->
            <tr>
              <td style="padding:0 36px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:rgba(79,195,247,0.04);border:1px solid rgba(79,195,247,0.12);border-radius:12px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 10px;font-size:0.88rem;color:#a8c0dc;line-height:1.6;"><strong style="color:#8ba2c4;">Case ID:</strong> &nbsp;<span style="font-family:'Courier New',Courier,monospace;color:#4fc3f7;font-weight:700;">#${safeCaseId}</span></p>
                      <p style="margin:0 0 10px;font-size:0.88rem;color:#a8c0dc;line-height:1.6;"><strong style="color:#8ba2c4;">Subject:</strong> &nbsp;${safeSubject}</p>
                      <p style="margin:0 0 10px;font-size:0.88rem;color:#a8c0dc;line-height:1.6;"><strong style="color:#8ba2c4;">Created:</strong> &nbsp;${escapeHtml(createdDate)}</p>
                      <p style="margin:0;font-size:0.88rem;color:#a8c0dc;line-height:1.6;"><strong style="color:#8ba2c4;">Status:</strong> &nbsp;<span style="display:inline-block;padding:2px 10px;border-radius:6px;background:rgba(0,230,118,0.12);color:#00e676;font-weight:700;font-size:0.76rem;letter-spacing:0.05em;text-transform:uppercase;">Open</span></p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Your Message -->
            <tr>
              <td style="padding:22px 36px 0;">
                <p style="margin:0 0 10px;font-size:0.78rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#4fc3f7;">Your Message</p>
                <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(79,195,247,0.1);border-radius:12px;padding:16px 18px;">
                  <p style="margin:0;font-size:0.9rem;color:#e2ecff;line-height:1.7;white-space:pre-wrap;">${safeMessage}</p>
                </div>
              </td>
            </tr>

            <!-- Body copy -->
            <tr>
              <td style="padding:20px 36px 0;">
                <p style="margin:0 0 12px;font-size:0.95rem;color:#a8c0dc;line-height:1.7;">Our support team will review your request and get back to you as soon as possible.</p>
                <p style="margin:0 0 20px;font-size:0.95rem;color:#a8c0dc;line-height:1.7;">Please keep your <strong style="color:#4fc3f7;">Case ID <span style="font-family:'Courier New',Courier,monospace;">#${safeCaseId}</span></strong> for future reference when contacting SaveHatke Support about this request.</p>
              </td>
            </tr>

            <!-- CTA -->
            <tr>
              <td style="padding:0 36px 8px;" align="center">
                <a href="${viewUrl}" style="display:inline-block;background:linear-gradient(135deg,#00e676,#00c853);color:#060d1f !important;text-decoration:none;font-weight:700;font-size:0.92rem;padding:12px 26px;border-radius:10px;">View Support Request →</a>
              </td>
            </tr>

            <!-- Security note -->
            <tr>
              <td style="padding:14px 36px 0;">
                <div style="background:rgba(255,183,77,0.05);border:1px solid rgba(255,183,77,0.2);border-radius:10px;padding:12px 16px;">
                  <p style="margin:0;font-size:0.8rem;color:#ffb74d;line-height:1.5;">⚠️ If you did not submit this request, please contact us immediately.</p>
                </div>
              </td>
            </tr>

            <!-- Sign-off -->
            <tr>
              <td style="padding:22px 36px 0;">
                <p style="margin:0;font-size:0.88rem;color:#8ba2c4;line-height:1.5;">Regards,<br><strong style="color:#e2ecff;">SaveHatke Support Team</strong></p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:26px 36px 22px;background:rgba(6,13,31,0.6);border-top:1px solid rgba(79,195,247,0.1);text-align:center;">
                <p style="margin:0 0 4px;font-size:0.78rem;color:#5a789a;">© ${year} SaveHatke. All rights reserved.</p>
                <p style="margin:0;font-size:0.72rem;color:#4a6890;">You're receiving this because you submitted a support request on SaveHatke.</p>
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
      replyTo: supportFrom || undefined,
      subject: subject_,
      text: textBody,
      html: htmlContent,
      headers: {
        'X-Entity-Ref-ID': `support-ack-${safeCaseId}`,
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

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

module.exports = {
  sendOTPEmail,
  sendWelcomeEmail,
  isEmailConfigured,
};

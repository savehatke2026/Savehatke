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
  isEmailConfigured,
};

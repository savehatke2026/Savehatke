// ============================================
// SaveHatke — Email Testing Template Registry
// ============================================
// Single source of truth for the Admin → Email Testing tool.
//
// Every entry reuses a PRODUCTION email renderer from services/emailService.js
// through its `renderOnly` path. That means a test/preview email is always the
// exact same template a real user (or admin) would receive — only the data is
// safe dummy data and the recipient is the admin's saved test address. When a
// production template's design changes, the test and preview here change with
// it automatically. There are NO duplicate, testing-only templates.
//
// SAFETY:
//   • `renderOnly` never sends mail and never reads or writes any
//     user / order / payment / coupon / refund record — it only builds the
//     { subject, text, html } for the template.
//   • The admin-notification templates (coupon submission, payout request)
//     normally email ADMIN_ALERT_EMAILS. Here they are only RENDERED; the
//     finished HTML is dispatched by the route to the single saved test
//     address, so no real recipient is ever contacted.
//   • A visible [TEST] subject prefix and an in-body TEST banner are added at
//     this layer only — the production templates are never modified.

const emailService = require('./emailService');

const NOW_ISO = () => new Date().toISOString();

// ── Template catalog ────────────────────────────────────────────────────────
// `render(to)` calls the real production sender in renderOnly mode with safe
// dummy data. It resolves to { success, isPreview, subject, text, html } (or a
// { success:false, error } when SMTP is not configured on the server).
const TEMPLATES = [
  {
    id: 'payment_success',
    sender: 'payment',
    name: 'Payment Successful',
    description: 'Test the buyer payment-confirmation (receipt) email.',
    category: 'Payment',
    render: (to) => emailService.sendPaymentSuccessEmail({
      to,
      buyerName: 'SaveHatke Test User',
      amount: 499,
      orderCode: 'SH-TEST-1001',
      couponBrand: 'Test Brand',
      couponTitle: 'Test Coupon',
      couponCode: 'TESTCODE10',
      transactionId: 'TESTUTR1234567890',
      paidAt: NOW_ISO(),
      currency: 'INR',
    }, { renderOnly: true }),
  },
  {
    id: 'welcome',
    sender: 'noreply',
    name: 'Welcome Email',
    description: 'Test the new user welcome email.',
    category: 'Account',
    render: (to) => emailService.sendWelcomeEmail(to, 'SaveHatke Test User', { renderOnly: true }),
  },
  {
    id: 'otp',
    sender: 'security',
    name: 'OTP Verification Code',
    description: 'Test the login / verification one-time-code email.',
    category: 'Security',
    render: (to) => emailService.sendOTPEmail(to, '123456', { renderOnly: true }),
  },
  {
    id: 'signin_alert',
    sender: 'security',
    name: 'New Device Detected',
    description: 'Test the new-device / sign-in security notification email.',
    category: 'Security',
    render: (to) => emailService.sendSignInAlertEmail({
      to,
      userName: 'SaveHatke Test User',
      userEmail: to,
      signInTime: NOW_ISO(),
      ip: '203.0.113.10',
      device: 'Apple iPhone',
      browser: 'Chrome 128',
      os: 'iOS 18',
      city: 'Kolkata',
      state: 'West Bengal',
      country: 'India',
      loginMethod: 'Email',
      accountType: 'user',
    }, { renderOnly: true }),
  },
  {
    id: 'two_factor_enabled',
    sender: 'security',
    name: 'Two-Factor Enabled',
    description: 'Test the "two-factor authentication enabled" security email.',
    category: 'Security',
    render: (to) => emailService.sendTwoFactorSecurityEmail({
      to,
      userName: 'SaveHatke Test User',
      change: 'enabled',
      ip: '203.0.113.10',
      device: 'Apple iPhone',
      when: NOW_ISO(),
    }, { renderOnly: true }),
  },
  {
    id: 'two_factor_recovery_used',
    sender: 'security',
    name: 'Recovery Code Used',
    description: 'Test the "a recovery code was used" security alert email.',
    category: 'Security',
    render: (to) => emailService.sendTwoFactorSecurityEmail({
      to,
      userName: 'SaveHatke Test User',
      change: 'recovery_used',
      ip: '203.0.113.10',
      device: 'Apple iPhone',
      when: NOW_ISO(),
      recoveryCodesRemaining: 2,
    }, { renderOnly: true }),
  },
  {
    id: 'support_ack',
    sender: 'support',
    name: 'Support Request Received',
    description: 'Test the support ticket acknowledgment email.',
    category: 'Account',
    render: (to) => emailService.sendSupportAckEmail({
      to,
      userName: 'SaveHatke Test User',
      caseId: 'TEST-CASE-001',
      subject: 'Test support request',
      createdAt: NOW_ISO(),
      message: 'This is a sample support message used by the SaveHatke Email Testing tool.',
    }, { renderOnly: true }),
  },
  {
    id: 'support_resolved',
    sender: 'support',
    name: 'Support Case Resolved',
    description: 'Test the support ticket resolved email.',
    category: 'Account',
    render: (to) => emailService.sendSupportResolvedEmail({
      to,
      userName: 'SaveHatke Test User',
      caseId: 'TEST-CASE-001',
      subject: 'Test support request',
      resolvedAt: NOW_ISO(),
      userMessage: 'This is the original sample support message.',
      resolution: 'This is a sample resolution note from the SaveHatke Email Testing tool.',
    }, { renderOnly: true }),
  },
  {
    id: 'sos_alert',
    sender: 'security',
    name: 'SOS Backup Access Alert',
    description: 'Test the SOS backup-access security alert email.',
    category: 'Security',
    render: (to) => emailService.sendSosAccessAlertEmail({
      to,
      recipientName: 'SaveHatke Test User',
      selectedAdminName: 'SaveHatke Test Admin',
      reason: 'Sample SOS access (Email Testing tool)',
      ip: '203.0.113.10',
      location: {
        city: 'Kolkata', region: 'West Bengal', country: 'India',
        timezone: 'Asia/Kolkata', isp: 'Test ISP',
      },
      browser: 'Chrome 128',
      os: 'Windows 11',
      device: 'Desktop',
      captchaStatus: 'Passed',
      securityStatus: 'Passed',
      accessStatus: 'Granted',
      auditRef: 'TEST-AUDIT-001',
    }, { renderOnly: true }),
  },
  {
    id: 'monthly_report',
    sender: 'main',
    name: 'Monthly Report',
    description: 'Test the monthly marketplace report email.',
    category: 'Admin',
    render: (to) => emailService.sendMonthlyReportEmail({
      to,
      monthLabel: 'September 2026',
      periodLabel: 'Sep 1-30, 2026',
      revenue: 100,
      couponsBought: 1,
      couponsSold: 1,
      isResend: false,
    }, { renderOnly: true }),
  },
  {
    id: 'coupon_submission',
    sender: 'noreply',
    name: 'Coupon Submission (Admin)',
    description: 'Test the "new coupon submission" admin notification email.',
    category: 'Coupon',
    render: (to) => emailService.sendCouponSubmissionAdminEmail({
      sellerName: 'SaveHatke Test User',
      sellerEmail: to,
      count: 1,
      submittedAt: NOW_ISO(),
    }, { renderOnly: true }),
  },
  {
    id: 'payout_request',
    sender: 'noreply',
    name: 'Payout Request (Admin)',
    description: 'Test the "new payout request" admin notification email.',
    category: 'Admin',
    render: (to) => emailService.sendPayoutRequestAdminEmail({
      userName: 'SaveHatke Test User',
      userEmail: to,
      amount: 100,
      paymentMethod: 'UPI: test@upi',
      requestedAt: NOW_ISO(),
    }, { renderOnly: true }),
  },
];

// Filter categories exposed in the UI (fixed set requested by the product).
const CATEGORIES = ['All', 'Payment', 'Coupon', 'Refund', 'Account', 'Security', 'Admin'];

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

function listTemplates() {
  return TEMPLATES.map(({ id, name, description, category }) => ({ id, name, description, category }));
}

function isValidTemplate(id) {
  return BY_ID.has(String(id || ''));
}

function getTemplate(id) {
  return BY_ID.get(String(id || '')) || null;
}

// ── Test-only presentation helpers (never applied to production mail) ─────────
function withTestSubject(subject) {
  const s = String(subject || 'SaveHatke');
  return s.startsWith('[TEST]') ? s : `[TEST] ${s}`;
}

const TEST_BANNER_HTML = `
<div style="margin:0;padding:12px 16px;background:#fff3cd;color:#664d03;border-bottom:2px solid #ffe69c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;line-height:1.5;text-align:center;">
  &#129514; <strong>TEST EMAIL</strong> &mdash; This message was sent from the SaveHatke Admin &rarr; Email Testing section. It is a test only and does not affect any real user, order, coupon, payment, refund, or account.
</div>`;

function injectTestBanner(html) {
  const raw = String(html || '');
  if (/<body[^>]*>/i.test(raw)) {
    return raw.replace(/(<body[^>]*>)/i, `$1${TEST_BANNER_HTML}`);
  }
  return TEST_BANNER_HTML + raw;
}

function withTestText(text) {
  const t = String(text || '');
  return `=== TEST EMAIL — SaveHatke Admin Email Testing ===\nThis is a test email and does not affect any real user, order, coupon, payment, refund, or account.\n\n${t}`;
}

/**
 * Force the preview to a specific colour scheme, independent of the admin's own
 * OS/browser theme. The production emails gate their dark styles behind
 * `@media (prefers-color-scheme: dark)`; here we rewrite that query so the
 * preview iframe shows exactly what was asked for:
 *   • 'dark'  → make the dark rules always apply (`@media all`)
 *   • 'light' → make them never apply (an impossible condition)
 *   • anything else → leave the email exactly as a real client would get it.
 */
function applyPreviewMode(html, mode) {
  const media = emailService.EMAIL_DARK_MEDIA || '@media (prefers-color-scheme: dark)';
  const raw = String(html || '');
  if (mode === 'dark') return raw.split(media).join('@media all');
  if (mode === 'light') return raw.split(media).join(media + ' and (min-width:2000000px)');
  return raw;
}

/**
 * Render a template with safe dummy data, ready to preview or send. Applies the
 * [TEST] subject prefix and the in-body TEST banner. `mode` ('light'|'dark')
 * only affects the PREVIEW; a real/test send passes no mode so the email keeps
 * its automatic prefers-color-scheme behaviour. Returns:
 *   { ok:true, name, category, subject, html, text }
 *   { ok:false, error }   (unknown template, render failure, or SMTP not set up)
 *
 * @param {string} id        allowlisted template id
 * @param {string} testEmail recipient shown inside the rendered email
 * @param {string} [mode]    'light' | 'dark' — preview-only colour scheme force
 */
async function renderTemplate(id, testEmail, mode) {
  const tpl = getTemplate(id);
  if (!tpl) return { ok: false, error: 'Unknown email template.' };

  let r;
  try {
    r = await tpl.render(testEmail);
  } catch (e) {
    return { ok: false, error: `This template could not be rendered: ${e.message}` };
  }

  if (!r || r.isPreview !== true || !r.html) {
    return {
      ok: false,
      error: (r && r.error)
        || 'This email template could not be rendered. Please check the email configuration and try again.',
    };
  }

  return {
    ok: true,
    name: tpl.name,
    category: tpl.category,
    sender: tpl.sender || 'main',
    subject: withTestSubject(r.subject),
    html: applyPreviewMode(injectTestBanner(r.html), mode),
    text: withTestText(r.text),
  };
}

module.exports = {
  CATEGORIES,
  listTemplates,
  isValidTemplate,
  getTemplate,
  renderTemplate,
};

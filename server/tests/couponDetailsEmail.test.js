// Coupon Details (Purchase) email: greeting, bold labels, no Valid Until,
// themed View Coupon button, centred thank-you, Best sign-off, disclaimer.
const assert = require('assert');
const emailService = require('../services/emailService');

(async () => {
  const r = await emailService.sendCouponDetailsEmail({
    to: 'buyer@example.com',
    userName: 'Parly Das',
    brandName: 'Amazon',
    couponDescription: 'Flat ₹500 off on orders above ₹2,000',
    couponValue: 500,
    expiryDate: '2026-12-31',
    orderId: 'SH-PUR-20260926-A7K92P',
  }, { renderOnly: true });
  const html = r.html;
  const text = r.text;

  const check = (name, fn) => { fn(); console.log('PASS  ' + name); };

  check('greeting: Hello, with only the username bold', () => {
    assert.match(html, /<p>Hello, <strong>Parly Das<\/strong><\/p>/);
  });
  check('labels bold, values normal weight', () => {
    assert.match(html, /<strong>Brand:<\/strong> Amazon/);
    assert.match(html, /<strong>Description:<\/strong> Flat/);
    assert.match(html, /<strong>Coupon Value:<\/strong> <span class="green">₹500/);
    assert.match(html, /<strong>Order ID:<\/strong> SH-PUR-20260926-A7K92P/);
  });
  check('Valid Until removed from HTML and text', () => {
    assert.ok(!html.includes('Valid Until'));
    assert.ok(!text.includes('Valid Until'));
  });
  check('light button: black fill, white label, 8px radius', () => {
    assert.match(html, /<a class="button"[^>]*border-radius:8px;background-color:#000000;color:#FFFFFF/);
  });
  check('dark button: white fill, black label', () => {
    assert.match(html, /a\.button, \.button \{ background-color: #FFFFFF !important;[^}]*color: #000000 !important/);
  });
  check('thank-you centred, not bold, SaveHatke normal weight', () => {
    assert.match(html, /<p class="thanks" style="text-align:center;font-weight:400;">Thank you for choosing <span style="font-weight:400;">SaveHatke<\/span>\.<\/p>/);
  });
  check('sign-off is only "Best," (no Regards, or SaveHatke Team)', () => {
    assert.match(html, /<p class="signoff"[^>]*>Best,<\/p>/);
    assert.ok(!html.includes('Regards,'));
    assert.ok(!html.includes('SaveHatke Team'));
    assert.ok(!text.includes('Regards,'));
    assert.ok(!text.includes('SaveHatke Team'));
  });
  check('disclaimer exact text, 12px, centred, last content', () => {
    const msg = 'You’re receiving this email because a coupon was purchased through your SaveHatke account.';
    assert.ok(html.includes(msg));
    assert.match(html, /class="disclaimer" style="margin:28px 0 0;text-align:center;font-size:12px;/);
    assert.ok(html.indexOf(msg) > html.indexOf('>Best,<'));
  });
  check('dark-mode media query intact (preview toggle depends on it)', () => {
    assert.ok(html.includes('@media (prefers-color-scheme: dark)'));
  });
  check('View Coupon link destination preserved', () => {
    assert.match(html, /href="[^"]*\/dashboard\.html#my-coupons"/);
  });

  console.log('\nCoupon details email checks passed.');
})().catch((err) => {
  console.error('FAIL', err.message);
  process.exit(1);
});

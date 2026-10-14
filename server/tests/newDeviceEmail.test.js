// New Device Detected (sign-in alert) email: greeting, blue account/links,
// underlined Support, Best sign-off, brand footer, settings link, disclaimer.
const assert = require('assert');
const emailService = require('../services/emailService');

(async () => {
  const r = await emailService.sendSignInAlertEmail({
    to: 'buyer@example.com',
    userName: 'Parly Das',
    userEmail: 'buyer@example.com',
    signInTime: '2026-10-14T15:30:00Z',
    ip: '203.0.113.7',
    device: 'Desktop',
    browser: 'Chrome 129',
    os: 'Windows 10',
    city: 'Kolkata', state: 'West Bengal', country: 'India',
    loginMethod: 'Password',
    accountType: 'user',
  }, { renderOnly: true });
  const html = r.html;
  const text = r.text;

  const check = (name, fn) => { fn(); console.log('PASS  ' + name); };

  check('greeting: Hello, with only the username bold', () => {
    assert.match(html, /<p>Hello, <strong>Parly Das<\/strong><\/p>/);
  });
  check('account email blue #0066CC', () => {
    assert.match(html, /<span class="acct-blue" style="color:#0066CC;">buyer@example\.com<\/span>/);
  });
  check('both security links blue, functional, same destinations', () => {
    assert.match(html, /<a class="sec-link" href="[^"]*\/dashboard\.html#security" style="color:#0066CC;/);
    assert.match(html, /<a class="sec-link" href="[^"]*\/dashboard\.html#account" style="color:#0066CC;/);
    assert.match(html, />Review your recent activity<\/a>/);
    assert.match(html, />access your account security settings now\.<\/a>/);
  });
  check('SaveHatke Support underlined only, not the whole sentence', () => {
    assert.match(html, /<a class="support-link" href="[^"]*" style="color:#222222;text-decoration:underline;">SaveHatke Support<\/a> as soon as possible\./);
  });
  check('sign-off is Best, with no Regards or Team', () => {
    assert.match(html, /<p class="signoff"[^>]*>Best,<\/p>/);
    assert.ok(!html.includes('Regards,'));
    assert.ok(!html.includes('SaveHatke Team'));
    assert.ok(!text.includes('Regards,'));
    assert.ok(!text.includes('SaveHatke Team'));
  });
  check('centred SaveHatke footer with Save and Hatke colours', () => {
    assert.match(html, /<p class="sh-footer-brand"[^>]*text-align:center[^>]*>/);
    assert.match(html, /<span class="fb-save" style="color:#111111;">Save<\/span><span class="green" style="color:#00E272;">Hatke<\/span>/);
    assert.ok(!html.includes('Team</'));
  });
  check('settings link underlined, blue, to existing /notifications route', () => {
    assert.match(html, /<a href="[^"]*\/dashboard\.html#notifications" style="color:#0066CC;text-decoration:underline;">Manage your notification settings<\/a>/);
  });
  check('disclaimer exact text, last content, 12px, not bold or underlined', () => {
    const msg = 'You are receiving this email because a new sign-in was detected on your SaveHatke account.';
    assert.ok(html.includes(msg));
    assert.match(html, /class="disclaimer" style="margin:28px 0 0;text-align:center;font-size:12px;/);
    assert.ok(html.indexOf(msg) > html.indexOf('Manage your notification settings'));
  });
  check('sign-in details still dynamic (device, browser, IP, location)', () => {
    assert.match(html, /<strong>Device:<\/strong> Desktop/);
    assert.match(html, /<strong>Browser:<\/strong> Chrome 129/);
    assert.match(html, /<strong>IP:<\/strong> 203\.0\.113\.7/);
    assert.match(html, /<strong>Location:<\/strong> Kolkata, West Bengal, India/);
  });
  check('dark-mode media query intact (preview toggle depends on it)', () => {
    assert.ok(html.includes('@media (prefers-color-scheme: dark)'));
  });

  console.log('\nNew device email checks passed.');
})().catch((err) => {
  console.error('FAIL', err.message);
  process.exit(1);
});

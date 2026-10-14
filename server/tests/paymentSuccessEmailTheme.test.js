// Payment Successful email — design contract.
// Renders the SHARED production renderer (the same path the Admin Email Testing
// preview and test-send use) and asserts the requested design:
//   • "Hello, <bold name>" greeting (comma right after Hello, name in <strong>)
//   • Light theme: View Order = black button, white label
//   • Dark theme:  View Order = white button, black label
// Run: node server/tests/paymentSuccessEmailTheme.test.js

const assert = require('assert');
const templates = require('../services/emailTestingTemplates');

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`PASS  ${name}`))
    .catch((e) => { failures++; console.log(`FAIL  ${name}\n      ${e.message}`); });
}

(async () => {
  const light = await templates.renderTemplate('payment_success', 'probe@example.com', 'light');
  assert.ok(light.ok, 'payment_success renders via the shared renderer');
  const html = light.html;

  await check('greeting is "Hello, <bold name>" with comma after Hello', () => {
    assert.match(html, /Hello, <strong[^>]*>Parly Das<\/strong>/);
  });

  await check('light: View Order button cell is black with white label', () => {
    assert.match(html, /class="sh-btn sh-view-btn-cell"[^>]*background:#000000/);
    assert.match(html, /<a class="sh-view-btn"[^>]*background-color:#000000[^>]*color:#FFFFFF[^>]*>View Order<\/a>/);
  });

  await check('dark: shared dark block turns View Order cell white with black label', () => {
    assert.match(html, /\.sh-view-btn-cell,\s*td\.sh-view-btn-cell \{ background:#FFFFFF !important/);
    assert.match(html, /a\.sh-view-btn,\s*td\.sh-view-btn-cell a\.sh-view-btn \{ color:#000000 !important/);
  });

  await check('dark: client-specific (data-ogsc) fallback is white bg + black label', () => {
    assert.match(html, /\[data-ogsc\] \.sh-view-btn-cell \{ background-color:#FFFFFF/);
    assert.match(html, /\[data-ogsc\] a\.sh-view-btn \{ color:#000000/);
  });

  await check('username is bold and in normal text colour (not green)', () => {
    assert.match(html, /Hello, <strong[^>]*color:#111827[^>]*>Parly Das<\/strong>/);
    assert.ok(!/<strong[^>]*color:#00E272[^>]*>Parly Das/.test(html));
  });

  await check('Payment Method row is completely removed', () => {
    assert.ok(!html.includes('Payment Method'));
    assert.ok(!html.includes('>UPI<'));
  });

  await check('closing uses Best, and a centered thank-you + SaveHatke with no bold', () => {
    assert.ok(!html.includes('Regards,'));
    assert.match(html, /<p[^>]*text-align:center;">Thank you for choosing SaveHatke\.<\/p>/);
    assert.match(html, /<p[^>]*text-align:center;">Best,<br \/>SaveHatke<\/p>/);
    assert.ok(!/font-weight:700[^>]*>SaveHatke</.test(html.slice(html.indexOf('Best,') - 300, html.indexOf('Best,') + 200)));
  });

  await check('disclaimer is the exact last content, 12px, centered, gray', () => {
    const msg = 'You’re receiving this email because a payment associated with a purchase through your SaveHatke account has been successfully received and confirmed.';
    const idx = html.indexOf(msg);
    assert.ok(idx > html.indexOf('Best,'), 'disclaimer comes after sign-off');
    const tail = html.slice(idx);
    assert.match(tail, /^[^<]*<\/td>\s*<\/tr>\s*<\/table>\s*<\/td>\s*<\/tr>\s*<\/table>\s*<\/body>/);
    assert.match(html.slice(html.lastIndexOf('<td', idx), idx), /font-size:12px;[^"]*text-align:center/);
  });

  await check('no stale green CTA remains', () => {
    assert.ok(!html.includes('bgcolor="#00E272" style="background:#00E272;border-radius:8px;"'));
  });

  await check('Admin test-send copy keeps the TEST banner (test-only, production unchanged)', () => {
    assert.ok(html.includes('TEST EMAIL'));
  });

  await check('dark preview maps the dark media query so the dark design can be previewed', async () => {
    const dark = await templates.renderTemplate('payment_success', 'probe@example.com', 'dark');
    assert.ok(dark.ok && dark.html.includes('@media all'));
  });

  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll payment-success theme checks passed.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

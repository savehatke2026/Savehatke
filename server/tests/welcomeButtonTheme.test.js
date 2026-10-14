// Verifies the Welcome email "Go to SaveHatke" button colours in light and dark.
// Light: black fill, white label. Dark: white fill, black label.
const assert = require('assert');
const emailService = require('../services/emailService');

async function render() {
  const out = await emailService.sendWelcomeEmail('test@example.com', 'Test User', { renderOnly: true });
  return typeof out === 'string' ? out : (out.html || '');
}

(async () => {
  const html = await render();
  assert.ok(html.length > 0, 'welcome email rendered');

  // Light inline button: black background, white label.
  const inline = html.match(/<a\s+class="button-label"[^>]*style="([^"]*)"/);
  assert.ok(inline, 'button inline style found');
  assert.match(inline[1], /background-color:#000000/i, 'light fill is black');
  assert.match(inline[1], /color:#FFFFFF/i, 'light label is white');
  assert.doesNotMatch(inline[1], /#00E272/i, 'no green left on the button');

  // Dark block: white fill and black label, declared after the shared green rules.
  const dark = html.match(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\s*\}\s*\n\s*\/\* Client-specific/);
  assert.ok(dark, 'dark media block found');
  const darkCss = dark[1];
  const lastGreenFill = darkCss.lastIndexOf('background-color:#00E272 !important');
  const whiteFill = darkCss.indexOf('background:#FFFFFF !important');
  assert.ok(whiteFill > -1, 'dark button fill is white');
  assert.ok(whiteFill > lastGreenFill, 'dark white fill wins over shared green fill');
  assert.match(darkCss, /\.button[^{]*\{color:#000000 !important/, 'dark label is black');

  console.log('PASS  light button: black fill, white label');
  console.log('PASS  dark block: white fill, black label, after shared green rules');
  console.log('\nWelcome button theme checks passed.');
})().catch((err) => {
  console.error('FAIL', err.message);
  process.exit(1);
});

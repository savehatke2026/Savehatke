// Validation for admin brand-logo uploads. Runs without Google Drive: every
// case here must be rejected BEFORE any Drive call is made.
const assert = require('assert');
const brandAssets = require('../services/brandAssets');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(32)]);

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (e) {
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return;
  }
  throw new Error(`expected rejection ${code}`);
}

(async () => {
  let pass = 0;

  await expectCode(brandAssets.uploadBrandLogo({ buffer: Buffer.alloc(0) }), 'LOGO_EMPTY');
  pass++;

  await expectCode(brandAssets.uploadBrandLogo({ buffer: null }), 'LOGO_EMPTY');
  pass++;

  const tooBig = Buffer.alloc(brandAssets.LOGO_UPLOAD_MAX_BYTES + 1, 0x89);
  await expectCode(brandAssets.uploadBrandLogo({ buffer: tooBig }), 'LOGO_TOO_LARGE');
  pass++;

  // A script renamed to .png is rejected by magic bytes, not the file name.
  const fake = Buffer.from('<script>alert(1)</script>');
  await expectCode(brandAssets.uploadBrandLogo({ buffer: fake, originalName: 'evil.png' }), 'LOGO_BAD_TYPE');
  pass++;

  // An SVG (which can carry script) is not an accepted type.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await expectCode(brandAssets.uploadBrandLogo({ buffer: svg, originalName: 'logo.svg' }), 'LOGO_BAD_TYPE');
  pass++;

  // Valid bytes pass validation; the next failure must be the Drive step
  // (not configured in tests), proving the type check accepted them.
  for (const buf of [PNG, JPG, WEBP]) {
    try {
      await brandAssets.uploadBrandLogo({ buffer: buf, originalName: 'ok' });
    } catch (e) {
      assert.ok(
        ['DRIVE_NOT_CONFIGURED', 'DRIVE_UPLOAD_FAILED'].includes(e.code),
        `valid image should reach Drive, got ${e.code}`
      );
    }
    pass++;
  }

  console.log(`brandLogoUpload: ${pass} passed, 0 failed`);
  process.exit(0);
})().catch((e) => {
  console.error('brandLogoUpload FAILED:', e.message);
  process.exit(1);
});

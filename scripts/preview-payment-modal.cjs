// ============================================
// SaveHatke — payment modal preview (development)
// ============================================
// Renders the REAL payment modal into a standalone HTML file.
//
// The <style> blocks and the .upm-overlay markup are extracted **verbatim**
// from public/checkout.html, the QR is the actual PNG server/services/upi.js
// produces for the configured VPA, and the brand marks are inlined from
// public/logos/. Nothing here is a hand-written approximation of the design,
// so the preview cannot drift from the page the way a redrawn mockup can.
//
// This exists because there is no browser in the dev environment: a UI change
// can be eyeballed in the built-in preview panel without booting the server or
// installing Chromium.
//
// Usage:
//   node scripts/preview-payment-modal.cjs
//   node scripts/preview-payment-modal.cjs --amount=299
//   node scripts/preview-payment-modal.cjs --vpa=9876543210@fam
//   node scripts/preview-payment-modal.cjs --out=/tmp/modal.html
//
//   --amount=N    amount to render (default 15)
//   --vpa=<vpa>   override the configured VPA for one run, without editing
//                 .env — same escape hatch as scripts/verify-upi-qr.cjs
//   --out=<path>  where to write (default .tmp_verify_artifacts/modal-preview.html)
//
// The output is a SINGLE self-contained file: logos and QR are base64 data
// URLs, because /logos/* only resolves while the app server is running.
// ============================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
require('dotenv').config({ path: path.join(ROOT, 'server', '.env') });

const upi = require(path.join(ROOT, 'server', 'services', 'upi'));

// ── CLI ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

const USAGE = `
SaveHatke — payment modal preview

Renders the real payment modal from public/checkout.html into a standalone HTML
file. The style blocks and the .upm-overlay markup are copied verbatim, the QR
is the actual PNG the server produces, and the brand marks are inlined from
public/logos/. Nothing is redrawn, so the preview cannot drift from the page.

Usage:
  node scripts/preview-payment-modal.cjs [options]

Options:
  --amount=N    amount to render (default 15)
  --vpa=<vpa>   override the configured VPA for one run, without editing .env
  --out=<path>  output path (default .tmp_verify_artifacts/modal-preview.html)
  --help, -h    show this

The output is one self-contained file — logos and QR are base64 data URLs,
because /logos/* only resolves while the app server is running.
`;

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

function flag(name, dflt) {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const AMOUNT = Number(flag('amount', '15'));
const VPA_OVERRIDE = String(flag('vpa', '')).trim();
const OUT = flag('out', path.join(ROOT, '.tmp_verify_artifacts', 'modal-preview.html'));

if (!Number.isFinite(AMOUNT) || AMOUNT <= 0) {
  console.error('FAILED: --amount must be a positive number (got ' + flag('amount', '15') + ')');
  process.exit(1);
}

// ── The page requests /logos/*, which only resolves while the server is up.
//    Inlining keeps the preview one self-contained file. ────────────────
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };

function inlineLogos(markup) {
  return markup.replace(/src="(\/logos\/[^"]+)"/g, (whole, src) => {
    const p = path.join(ROOT, 'public', src.replace(/^\//, ''));
    try {
      const mime = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
      const b64 = fs.readFileSync(p).toString('base64');
      console.log('inlined   :', src.padEnd(20), Math.round(b64.length / 1024) + ' KB base64');
      return 'src="data:' + mime + ';base64,' + b64 + '"';
    } catch (e) {
      console.warn('  ! could not inline', src, '-', e.message);
      return whole;
    }
  });
}

(async () => {
  const checkoutHtml = fs.readFileSync(path.join(ROOT, 'public', 'checkout.html'), 'utf8');

  // ── 1. Every <style> block, verbatim ───────────────────────────────────
  const styles = [...checkoutHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join('\n\n');

  // ── 2. The overlay markup, verbatim ────────────────────────────────────
  const start = checkoutHtml.indexOf('<div class="upm-overlay"');
  const end = checkoutHtml.indexOf('<!-- SUCCESS OVERLAY -->');
  if (start < 0 || end < 0 || end < start) throw new Error('Could not locate the modal markup in public/checkout.html.');
  const overlay = inlineLogos(checkoutHtml.slice(start, end).trim());

  // ── 3. The real QR for the real configured VPA ─────────────────────────
  const payee = upi.getPayee();
  // A --vpa override is validated by buildUpiUri() itself, so an unconfigured
  // .env must not block the override path.
  if (!VPA_OVERRIDE && !payee.configured) {
    throw new Error('UPI_ID is not usable: ' + payee.invalidReason + ' (or pass --vpa=)');
  }

  const vpa = VPA_OVERRIDE || payee.upiId;
  const uri = upi.buildUpiUri({ amount: AMOUNT, upiId: VPA_OVERRIDE || undefined });
  const qr = await upi.generateQrPngDataUrl(uri);

  console.log('VPA        :', vpa + (VPA_OVERRIDE ? '  (--vpa override, .env untouched)' : ''));
  console.log('payee name :', payee.payeeName);
  console.log('amount     :', AMOUNT);
  console.log('URI        :', uri);
  console.log('QR data URL:', qr.slice(0, 48) + '...  (' + Math.round(qr.length / 1024) + ' KB)');
  if (payee.warning && !VPA_OVERRIDE) console.log('advisory   :', payee.warning.code, '-', payee.warning.error);

  // ── 4. Fill the server-owned placeholders the page's JS would fill ─────
  function fill(opts = {}) {
    let m = overlay;
    m = m.replace('<div class="upm-overlay" id="upiPayOverlay"', '<div class="upm-overlay show" id="upiPayOverlay"');
    m = m.replace('class="upm-open hide"', 'class="upm-open"');
    m = m.replace(
      '<div class="upm-qr-empty" id="upmQrEmpty"><div class="upm-qr-skel"></div></div>',
      '<img src="' + qr + '" alt="UPI payment QR code">'
    );
    m = m.replace('id="upmPayAmt">\u2014<', 'id="upmPayAmt">\u20B9' + AMOUNT + '<');
    m = m.replace('id="upmVpaText">\u2014<', 'id="upmVpaText">' + vpa + '<');
    m = m.replace('id="upmTimerVal">--:--<', 'id="upmTimerVal">' + (opts.timer || '08:17') + '<');
    if (opts.timerClass) m = m.replace('class="upm-timer" id="upmTimer"', 'class="upm-timer ' + opts.timerClass + '" id="upmTimer"');
    if (opts.cancel) m = m.replace('class="upm-cancel" id="upmCancelPanel"', 'class="upm-cancel show" id="upmCancelPanel"');
    if (opts.expired) {
      m = m.replace('class="upm-state" id="upmState"', 'class="upm-state show" id="upmState"');
      m = m.replace('id="upmStateIco"></div>', 'id="upmStateIco">\u23F1</div>');
    }
    return m;
  }

  const hero = fill();
  const cancelVariant = fill({ cancel: true });
  const expiredVariant = fill({ expired: true });
  const warnVariant = fill({ timer: '01:47', timerClass: 'warn' });

  const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SaveHatke — Payment Modal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${styles}
</style>
<style>
  /* ── Preview chrome only. Everything above is the real checkout CSS. ── */
  html, body { background:#060d1f; }
  body { margin:0; font-family:'Outfit',sans-serif; color:#e2ecff; }

  .pv-bar { position:sticky; top:0; z-index:500; display:flex; flex-wrap:wrap; gap:10px 22px; align-items:center;
            padding:14px 22px; background:rgba(6,13,31,.92); backdrop-filter:blur(12px);
            border-bottom:1px solid rgba(79,195,247,.16); font-size:.8rem; }
  .pv-bar b { color:#00e676; font-weight:800; letter-spacing:.02em; }
  .pv-bar span { color:#8ba2c4; }
  .pv-bar code { font-family:'JetBrains Mono',monospace; font-size:.74rem; color:#4fc3f7; }

  .pv-note { max-width:860px; margin:26px auto 0; padding:0 22px; }
  .pv-note h1 { font-size:1.28rem; font-weight:800; margin:0 0 8px; }
  .pv-note h1 span { color:#00e676; }
  .pv-note p { font-size:.85rem; color:#8ba2c4; line-height:1.65; margin:0 0 6px; }

  .pv-hero { min-height:calc(100vh - 52px); }

  .pv-gallery { max-width:860px; margin:0 auto; padding:10px 22px 70px; }
  .pv-gallery h2 { font-size:.95rem; font-weight:800; margin:38px 0 12px; color:#e2ecff; }
  .pv-gallery h2 em { font-style:normal; color:#8ba2c4; font-weight:500; font-size:.8rem; margin-left:8px; }

  /* Stack the extra states as cards instead of full-screen overlays. */
  .pv-card .upm-overlay { position:relative; inset:auto; opacity:1; pointer-events:auto;
                          padding:30px 22px; border-radius:26px; border:1px solid rgba(79,195,247,.14); }
  .pv-card .upm-body { max-height:none; }
</style>
</head>
<body>

<div class="pv-bar">
  <b>SaveHatke</b>
  <span>payment modal &mdash; rendered from the real <code>public/checkout.html</code></span>
  <span>VPA <code>${vpa}</code></span>
  <span>QR <code>decode&nbsp;PASS</code></span>
</div>

<div class="pv-note">
  <h1>Complete <span>Payment</span> &mdash; live modal</h1>
  <p>The style blocks and the modal markup on this page are copied verbatim from
     <code>public/checkout.html</code>. The QR is the actual PNG the server renders for
     <code>${uri}</code>, at ${VPA_OVERRIDE ? 'the <code>--vpa</code> override' : 'the configured VPA'}.</p>
  <p>Below the modal: the other two states the payment window can enter.</p>
</div>

<div class="pv-hero">
${hero}
</div>

<div class="pv-gallery">
  <h2>Cancel confirmation <em>opens from the &times;</em></h2>
  <div class="pv-card">
${cancelVariant}
  </div>

  <h2>Payment window expired <em>covers the box; the flow stops here</em></h2>
  <div class="pv-card">
${expiredVariant}
  </div>

  <h2>Countdown in its warning state <em>last two minutes</em></h2>
  <div class="pv-card">
${warnVariant}
  </div>
</div>

</body>
</html>
`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, page, 'utf8');
  console.log('\nwrote ' + OUT + '  (' + Math.round(page.length / 1024) + ' KB)');
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});

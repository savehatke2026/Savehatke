// Preview harness for the Payment Successful window.
//
// Renders the REAL markup and the REAL .pay-ok-* stylesheet out of
// public/checkout.html into standalone pages, so the card's size, spacing and
// fit can be inspected at phone / tablet / desktop widths without running the
// app or making a payment. Nothing here restyles the card; the stylesheet block
// and the overlay markup are copied verbatim.
//
// Writes three kinds of page into <outdir>:
//   <mode>-card.html      one device, at its own viewport size
//   <mode>-sheet.html     phone + tablet + desktop, each a real iframe
//   compare-<w>x<h>.html  before vs after, side by side
//
// <mode> is 'after' (the shipped sizing) or 'before' (the previous sizing,
// reconstructed by the BEFORE map below). The map is asserted, so this script
// fails loudly instead of silently producing a wrong "before" if the .pay-ok-*
// rules ever change shape.
//
// Usage:
//   node scripts/preview-pay-ok-window.cjs                       # current sizing
//   node scripts/preview-pay-ok-window.cjs <outdir>             # explicit output dir
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'public', 'checkout.html'), 'utf8');
const outDir = process.argv[2] || path.join(REPO, '.build', 'pay-ok-preview');

// ── stylesheet block: the .pay-ok-* section ────────────────────────────────
// The section opens with a block comment, which may span several lines, so the
// slice has to start after the comment CLOSES — not merely after its first line.
const styleStart = html.indexOf('/* PAYMENT SUCCESSFUL card');
const styleEnd = html.indexOf('.success-box {');
const commentEnd = styleStart === -1 ? -1 : html.indexOf('*/', styleStart);
if (styleStart === -1 || styleEnd === -1 || commentEnd === -1) {
  throw new Error('could not locate the .pay-ok-* stylesheet block');
}
let afterCss = html.slice(html.indexOf('\n', commentEnd) + 1, html.indexOf('\n', styleEnd));

// Previous sizing -> current sizing. Used only to rebuild the "before" render.
const BEFORE = {
  'width:min(540px, calc(100vw - 40px), calc((100dvh - 40px) * 0.74))': 'width:min(754px, calc(100vw - 48px))',
  'max-height:calc(100dvh - 32px); overflow:auto; overscroll-behavior:contain; ': '',
  'padding:10cqw 7.6cqw 4.6cqw;': 'padding:14.5cqw 8.3cqw 6.1cqw;',
  'width:50cqw; height:30.5cqw; margin:0 auto 1.4cqw;': 'width:61cqw; height:37cqw; margin:0 auto 2.7cqw;',
  'font-size:max(24px,7.5cqw)': 'font-size:8.15cqw',
  'margin:1.6cqw -2.6cqw 3.4cqw; font-size:max(13.5px,4.1cqw)': 'margin:2.8cqw -3cqw 5.5cqw; font-size:4.35cqw',
  'min-height:11.6cqw; padding:.6cqw 0;': 'min-height:14.6cqw; padding:0;',
  'font-size:max(13px,3.6cqw)': 'font-size:4.1cqw',
  'font-size:max(12.5px,3.5cqw)': 'font-size:3.9cqw',
  'font-size:max(17px,4.7cqw)': 'font-size:5.3cqw',
  'margin:4.2cqw 0 4.6cqw; font-size:max(12.5px,3.2cqw)': 'margin:7cqw 0 8cqw; font-size:3.45cqw',
  'font-size:max(12px,3.3cqw)': 'font-size:3.7cqw',
  'width:4.2cqw; height:5cqw;': 'width:4.9cqw; height:5.9cqw;',
  'border-radius:clamp(18px,3vw,28px)': 'border-radius:clamp(20px,3.8vw,36px)',
  'white-space:nowrap; letter-spacing:-.06cqw; overflow:hidden': 'white-space:nowrap; letter-spacing:-.08cqw; overflow:hidden',
  'width:calc(100vw - 28px)': 'width:calc(100vw - 32px)',
};

function beforeCss() {
  let css = afterCss;
  for (const [now, old] of Object.entries(BEFORE)) {
    if (!css.includes(now)) {
      throw new Error('preview map is stale: no match for "' + now + '". Update BEFORE in this script.');
    }
    css = css.replace(now, old);
  }
  // The short-viewport rule did not exist in the previous sizing.
  css = css.replace(/\n[^\n]*@media \(max-height:640px\)[^\n]*\n/, '\n');
  return css;
}

// ── markup: the overlay exactly as shipped, shown with real values ────────
const mStart = html.indexOf('<div class="pay-ok-overlay"');
const mEnd = html.indexOf('<!-- SUCCESS OVERLAY');
if (mStart === -1 || mEnd === -1) throw new Error('could not locate the payOkOverlay markup');
let markup = html.slice(mStart, mEnd).trimEnd();
markup = markup.replace('class="pay-ok-overlay"', 'class="pay-ok-overlay show"');
markup = markup
  .replace('<dd class="pay-ok-amount" id="payOkAmount">—</dd>', '<dd class="pay-ok-amount" id="payOkAmount">&#8377;299</dd>')
  .replace('<dd id="payOkTxn">—</dd>', '<dd id="payOkTxn">TXN-20261016-A1B2C3D4</dd>')
  .replace('<dd id="payOkOrder">—</dd>', '<dd id="payOkOrder">SH-PUR-20261016-X7K2M9</dd>')
  .replace('<dd id="payOkDate">—</dd>', '<dd id="payOkDate">16 Oct 2026, 1:14 PM</dd>');

const FRAME_CSS = `
 body { margin:0; padding:14px; background:#0b1220; font-family:Arial,sans-serif; color:#cbd5e1; }
 h1 { font-size:14px; margin:0 0 12px; color:#e2e8f0; font-weight:600; }
 .row { display:flex; flex-direction:column; gap:18px; align-items:flex-start; }
 figure { margin:0; }
 figcaption { font-size:12px; margin-bottom:5px; color:#94a3b8; display:flex; align-items:center; gap:6px; }
 .dot { width:9px; height:9px; border-radius:50%; display:inline-block; }
 .frame { border:1px solid #334155; border-radius:8px; overflow:hidden; background:#050e1b; }
`;
// A real iframe per device: media queries and container queries inside resolve
// against that device's own viewport. scale() is for viewing only.
const frame = (label, tint, file, w, h, s) => `
  <figure>
    <figcaption>${tint ? `<span class="dot" style="background:${tint}"></span>` : ''}${label}</figcaption>
    <div class="frame" style="width:${Math.round(w * s)}px;height:${Math.round(h * s)}px">
      <iframe src="${file}" width="${w}" height="${h}"
              style="transform:scale(${s});transform-origin:0 0;border:0"></iframe>
    </div>
  </figure>`;

const write = (name, css, body, title) => fs.writeFileSync(
  path.join(outDir, name),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body { margin:0; background:#050e1b; font-family:'Century Gothic','Trebuchet MS',Arial,sans-serif; }
${css}
${name.includes('card') ? '' : FRAME_CSS}
</style></head><body>
${body}
</body></html>`
);

fs.mkdirSync(outDir, { recursive: true });

// 1. Single-device page, opened directly in a browser at that device size.
write('after-card.html', afterCss, markup, 'Payment Successful window (after)');
write('before-card.html', beforeCss(), markup, 'Payment Successful window (before)');

// 2. Contact sheet of the shipped sizing at phone / tablet / desktop.
const DEVICES = [
  ['Phone 390x844', 390, 844, 1.0],
  ['Tablet 768x1024', 768, 1024, 0.62],
  ['Desktop 1280x800', 1280, 800, 0.38],
];
write('after-sheet.html', afterCss,
  '<h1>Payment Successful window, shipped sizing (real CSS, real markup)</h1><div class="row">'
  + DEVICES.map(([n, w, h, s]) => frame(n, '', 'after-card.html', w, h, s)).join('') + '</div>',
  'Payment Successful window - shipped sizing');

// 3. Before vs after at the same device size.
const CMP = ['Tablet 768x1024', 768, 1024, 0.6];
const [, cw, ch, cs] = CMP;   // skip the label; then width, height, view scale
write('compare.html', afterCss,
  '<h1>Payment Successful window before vs after at ' + CMP[0] + ' (real CSS, real markup)</h1><div class="row">'
  + frame('BEFORE - 754px card', '#f87171', 'before-card.html', cw, ch, cs)
  + frame('AFTER - compacted card', '#4ade80', 'after-card.html', cw, ch, cs) + '</div>',
  'Payment Successful window - before vs after');

console.log('wrote after-card.html, before-card.html, after-sheet.html, compare.html in ' + outDir);
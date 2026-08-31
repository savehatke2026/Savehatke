// ============================================
// SaveHatke — Monthly report PDF
// ============================================
// Builds the one-page monthly report as a real PDF, with no new dependency:
// the file is assembled by hand from the seven objects a text-only page needs
// and the two built-in Type1 fonts (Helvetica / Helvetica-Bold), which every
// reader ships. That keeps the report attachable from a serverless function
// where a headless-Chrome or wkhtmltopdf style renderer cannot run.
//
// One deliberate limitation: the built-in fonts use WinAnsiEncoding, which has
// no ₹ (U+20B9). Amounts are therefore written as "Rs. 1,234" in the PDF while
// the admin panel keeps using ₹.

const PAGE = { w: 595.28, h: 841.89 };          // A4 in points
const MARGIN = 56;

const BRAND = { green: [0, 0.902, 0.463], ink: [0.09, 0.13, 0.22], mute: [0.42, 0.53, 0.67] };

/** Escape the three characters that terminate or shift a PDF string literal. */
function esc(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * Drop anything outside WinAnsi's printable range so a stray emoji or ₹ cannot
 * corrupt the stream. ₹ is spelled out instead of dropped.
 */
function winAnsi(text) {
  return String(text == null ? '' : text)
    .replace(/\u20B9\s?/g, 'Rs. ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}

class Content {
  constructor() { this.ops = []; }
  color(rgb) { this.ops.push(`${rgb[0]} ${rgb[1]} ${rgb[2]} rg`); return this; }
  text(x, y, size, bold, str) {
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${esc(winAnsi(str))}) Tj ET`);
    return this;
  }
  rect(x, y, w, h, rgb) {
    this.ops.push(`${rgb[0]} ${rgb[1]} ${rgb[2]} rg ${x} ${y} ${w} ${h} re f`);
    return this;
  }
  line(x1, y1, x2, y2, rgb, width = 0.8) {
    this.ops.push(`${rgb[0]} ${rgb[1]} ${rgb[2]} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S`);
    return this;
  }
  toString() { return this.ops.join('\n'); }
}

/**
 * @param {object} r
 * @param {string} r.monthLabel     e.g. "August 2026"
 * @param {string} r.periodLabel    e.g. "Aug 1-31, 2026"
 * @param {number} r.revenue        rupees
 * @param {number} r.couponsBought
 * @param {number} r.couponsSold
 * @param {string} r.generatedAt    ISO string
 * @param {Array<{email:string,status:string}>} [r.recipients]
 * @returns {Buffer} the PDF bytes
 */
function buildMonthlyReportPdf(r) {
  const money = (n) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN');
  const c = new Content();
  let y = PAGE.h - MARGIN;

  // Header band
  c.rect(0, PAGE.h - 96, PAGE.w, 96, [0.024, 0.051, 0.122]);
  c.rect(0, PAGE.h - 100, PAGE.w, 4, BRAND.green);
  c.color([1, 1, 1]).text(MARGIN, PAGE.h - 52, 22, true, 'SaveHatke');
  c.color(BRAND.mute).text(MARGIN, PAGE.h - 72, 10.5, false, 'Coupon marketplace - monthly report');
  c.color([1, 1, 1]).text(PAGE.w - MARGIN - 150, PAGE.h - 52, 13, true, r.monthLabel || '');
  c.color(BRAND.mute).text(PAGE.w - MARGIN - 150, PAGE.h - 70, 9.5, false, r.periodLabel || '');

  y = PAGE.h - 150;
  c.color(BRAND.ink).text(MARGIN, y, 16, true, 'Monthly Reports');
  y -= 18;
  c.color(BRAND.mute).text(MARGIN, y, 10, false, 'Monthly coupon marketplace revenue and report delivery status.');

  // Three figures, each in its own bordered row so the page stays readable in
  // print without relying on a table.
  y -= 34;
  const rows = [
    ['Revenue this month', money(r.revenue), 'Sum of selling prices for coupons sold in this period'],
    ['Coupons bought this month', String(r.couponsBought || 0), 'Completed buyer purchases in this period'],
    ['Coupons sold this month', String(r.couponsSold || 0), 'Seller-listed coupons sold in this period'],
  ];
  for (const [label, value, note] of rows) {
    c.line(MARGIN, y + 22, PAGE.w - MARGIN, y + 22, [0.85, 0.89, 0.94]);
    c.color(BRAND.ink).text(MARGIN, y, 11, false, label);
    c.color(BRAND.ink).text(PAGE.w - MARGIN - 130, y, 15, true, value);
    c.color(BRAND.mute).text(MARGIN, y - 15, 8.5, false, note);
    y -= 46;
  }
  c.line(MARGIN, y + 22, PAGE.w - MARGIN, y + 22, [0.85, 0.89, 0.94]);

  // Delivery record
  y -= 12;
  c.color(BRAND.ink).text(MARGIN, y, 12, true, 'Report delivery');
  y -= 20;
  const recipients = Array.isArray(r.recipients) ? r.recipients : [];
  if (!recipients.length) {
    c.color(BRAND.mute).text(MARGIN, y, 10, false, 'No admin recipients are configured.');
    y -= 16;
  } else {
    recipients.forEach((rec, i) => {
      c.color(BRAND.mute).text(MARGIN, y, 10, false, `Admin ${i + 1}: ${rec.email || '-'}`);
      c.color(BRAND.ink).text(PAGE.w - MARGIN - 130, y, 10, false, String(rec.status || 'pending'));
      y -= 16;
    });
  }

  // Footer
  const when = r.generatedAt ? new Date(r.generatedAt) : new Date();
  const stamp = when.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  c.line(MARGIN, MARGIN + 34, PAGE.w - MARGIN, MARGIN + 34, [0.85, 0.89, 0.94]);
  c.color(BRAND.mute).text(MARGIN, MARGIN + 18, 8.5, false, `Generated ${stamp} IST - SaveHatke admin panel`);
  c.color(BRAND.mute).text(PAGE.w - MARGIN - 120, MARGIN + 18, 8.5, false, 'Figures cover this period only');

  return assemble(c.toString());
}

/** Wrap one content stream into a minimal, correctly cross-referenced PDF file. */
function assemble(stream) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] `
      + '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

module.exports = { buildMonthlyReportPdf };

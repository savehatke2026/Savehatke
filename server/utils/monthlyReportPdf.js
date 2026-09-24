'use strict';
// ============================================================================
// SaveHatke — Monthly Revenue Report PDF (Phase 2)
// ============================================================================
// Renders REAL monthly data onto the APPROVED master template by GLYPH-LEVEL
// REDACTION + REDRAW (no mask rectangles): every dynamic value's glyph run is
// deleted from the page content stream (background/graphics/charts untouched)
// and the real value is redrawn at the same position, in the SAME colour the
// template used (sampled live), with an embedded ₹-capable font (DejaVuSans —
// closest embeddable, since the subset template font cannot be reused).
//
// The template is NEVER modified: each report loads a fresh copy. Values come
// only from finance.buildMonthlyReportData (current SaveHatke model). Fees and
// buyer-side-fee-model fields that the production system does NOT record are
// rendered as ₹0 / 0.00% — never the August reference numbers.

const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, decodePDFRawStream, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { redactByPosition } = require('./pdfRedact');

const TDIR = path.join(__dirname, '..', 'templates');
const TEMPLATE = path.join(TDIR, 'monthly-revenue-report-template.pdf');
const LAYOUT = path.join(TDIR, 'report-layout.json');
const FONT_REG = path.join(TDIR, 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(TDIR, 'fonts', 'DejaVuSans-Bold.ttf');

let _layout = null;
function layout() { if (!_layout) _layout = JSON.parse(fs.readFileSync(LAYOUT, 'utf8')); return _layout; }

// ── Formatters (match the template's styles) ──
const I = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');            // ₹70,42,168
const N = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');                   // 14,286
const D = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); // ₹488.93
const P = (n) => (Number(n) || 0).toFixed(2) + '%';                                    // 79.70%

// ── Month / reference helpers ──
const MON_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function ymOf(key) { const [y, m] = String(key || '').split('-').map(Number); return { y, m }; }
function spaced(s) { return String(s).split('').join(' '); } // letter-spacing like the template headers

function decodePageContent(doc, page) {
  const c = page.node.Contents();
  if (!c) return '';
  const dec = (st) => Buffer.from(decodePDFRawStream(st).decode()).toString('latin1');
  if (c.constructor && c.constructor.name === 'PDFArray') return c.asArray().map((r) => dec(doc.context.lookup(r))).join('\n');
  return dec(c);
}
function setPageContent(doc, page, latin1Str) {
  const ref = doc.context.register(doc.context.flateStream(Buffer.from(latin1Str, 'latin1')));
  page.node.set(PDFName.of('Contents'), ref);
}

// Build the per-page { templateString : replacementString } map from real data.
function buildReplacementMap(r) {
  const s = r.summary, rev = r.revenue, sal = r.sales, pur = r.purchases, sel = r.sellers,
    sp = r.sellerPayouts, ar = r.adminRevenue, ap = r.adminPayouts, rf = r.refunds,
    cmp = r.comparison, rt = r.ratios, rec = r.reconciliation, me = r.monthEnd;
  const cur = ymOf(r.period.key);
  const prev = ymOf(r.previousPeriod.key);
  const a1 = rev.distribution.admin1.amount, a2 = rev.distribution.admin2.amount, plat = rev.distribution.platform.amount;
  const totalAdmin = ar.totalAdminRevenue;

  // Values shared across many pages
  const m = {};
  const add = (page, obj) => { m[page] = Object.assign(m[page] || {}, obj); };

  // Core figures reused on several pages
  const core = {
    '₹70,42,168': I(rev.grossSales),
    '₹5,08,145': I(rev.netDistributableRevenue),
    '14,286': N(s.couponsSold),
    '₹56,12,450': I(rev.sellerRevenue),
    '56,12,450': N(rev.sellerRevenue),
    '₹7,01,557': I(rev.platformServiceFeeRevenue),
    '7,01,557': N(rev.platformServiceFeeRevenue),
    '63,14,007': N(rev.settledSales),
    '₹4,06,516': I(totalAdmin),
    '₹1,01,629': I(plat),
    '1,01,629': N(plat),
    '2,03,258': N(a1),
    '5,08,145': N(rev.netDistributableRevenue),
    '70,42,168': N(rev.grossSales),
  };

  // PAGE 1 — headline (title handled separately in generate for size)
  add(1, {
    '₹70,42,168': I(rev.grossSales), '₹5,08,145': I(rev.netDistributableRevenue),
    '14,286': N(s.couponsSold), '₹0': I(rec.revenue.variance),
    '▲ 11.39% MoM': (cmp.grossGrowthPct >= 0 ? '▲ ' : '▼ ') + P(Math.abs(cmp.grossGrowthPct)) + ' MoM',
    '▲ 14.77% MoM': (cmp.netGrowthPct >= 0 ? '▲ ' : '▼ ') + P(Math.abs(cmp.netGrowthPct)) + ' MoM',
  });

  // PAGE 2 — Executive snapshot
  add(2, Object.assign({}, core, {
    '₹63,21,940': I(cmp.previous.grossSales),
    '₹70,42,168': I(rev.grossSales),
    '₹5,08,145': I(rev.netDistributableRevenue),
    '₹4,42,760': I(cmp.previous.netRevenue),
    '14,742': N(s.couponsBought), '11,842': N(s.completedTransactions),
    '₹56,12,450': I(rev.sellerRevenue), '₹48,96,220': I(sel.liability.paid),
    '₹4,06,516': I(totalAdmin), '₹2,84,500': I(ap.paid.amount),
    '₹1,43,508': I(rf.refundAmount), '₹1,42,124': I(rev.gatewayFees),
    '₹488.93': D(s.avgCouponSaleValue),
    '12,908': N(cmp.previous.couponsSold),
  }));

  // PAGE 3 — Revenue Overview (waterfall + distribution)
  add(3, {
    '70,42,168': N(rev.grossSales),
    '(2,52,164)': '(' + N(rev.pendingValue) + ')',
    '(3,32,489)': '(' + N(rev.cancelledValue) + ')',
    '(1,43,508)': '(' + N(rev.refundedValue) + ')',
    '63,14,007': N(rev.settledSales),
    '(56,12,450)': '(' + N(rev.sellerRevenue) + ')',
    '7,01,557': N(rev.platformServiceFeeRevenue),
    '(1,42,124)': '(' + N(rev.gatewayFees) + ')',
    '(51,288)': '(' + N(rev.otherCharges) + ')',
    '5,08,145': N(rev.netDistributableRevenue),
    '2,03,258': N(a1), '1,01,629': N(plat),
    '₹4,06,516': I(totalAdmin), '₹1,01,629': I(plat),
    '₹7,01,557': I(rev.platformServiceFeeRevenue), '₹5,08,145': I(rev.netDistributableRevenue),
    '₹1,42,124': I(rev.gatewayFees), '₹51,288': I(rev.otherCharges),
  });

  // PAGE 4 — Sales + Buying performance
  add(4, {
    '14,286': N(sal.totalSold), '12,914': N(sal.completed), '512': N(sal.pending),
    '611': N(sal.cancelled), '249': N(sal.refunded),
    '₹70,42,168': I(sal.totalSalesValue), '₹63,14,007': I(sal.completedSalesValue),
    '₹488.93': D(sal.avgSaleValue), '₹8,499': I(sal.highestSale), '11,842': N(s.completedTransactions),
    '90.40%': P(sal.completionRate),
    '14,742': N(pur.totalBought), '528': N(pur.pending), '1,051': N(pur.cancelled),
    '₹72,68,940': I(pur.totalPurchaseValue), '₹533.19': D(pur.avgPurchaseValue),
    '87.60%': P(pur.completionRate), '1.69%': P(pur.refundRateByCount), '2.04%': P(pur.refundRateByValue),
  });

  // PAGE 5 — Seller revenue + top 10 sellers
  add(5, {
    '₹63,14,007': I(sel.totalSalesValue), '₹56,12,450': I(sel.totalSellerRevenue),
    '₹434.60': D(sel.avgRevenuePerSale), '88.89%': P(sel.revenueShare),
    '₹48,96,220': I(sel.liability.paid), '₹4,12,880': I(sel.liability.processing),
    '₹3,03,350': I(sel.liability.pending), '₹7,16,230': I(sel.liability.closing),
  });

  // PAGE 6 — Seller payouts + top coupons
  add(6, {
    '1,486': N(sp.totalRequests), '1,268': N(sp.paid.count), '104': N(sp.processing.count),
    '78': N(sp.pending.count), '24': N(sp.rejected.count), '12': N(sp.failed.count),
    '₹48,96,220': I(sp.paid.amount), '48,96,220': N(sp.paid.amount),
    '4,12,880': N(sp.processing.amount), '3,03,350': N(sp.pending.amount),
    '64,180': N(sp.rejected.amount), '38,940': N(sp.failed.amount),
    '57,15,570': N(sp.paid.amount + sp.processing.amount + sp.pending.amount + sp.rejected.amount + sp.failed.amount),
    '₹3,861.37': D(sp.avgCompletedPayout),
  });

  // PAGE 8 — Admin revenue + admin payouts
  add(8, {
    '₹5,08,145': I(ar.netDistributableRevenue), '₹4,06,516': I(totalAdmin), '₹1,01,629': I(plat),
    '2,03,258': N(a1), '1,01,629': N(plat), '5,08,145': N(rev.netDistributableRevenue),
    '18': N(ap.totalRequests), '12': N(ap.paid.count), '2': N(ap.processing.count),
    '3': N(ap.pending.count), '1': N(ap.rejected.count), '0': N(ap.failed.count),
    '2,84,500': N(ap.paid.amount), '42,000': N(ap.processing.amount), '23,500': N(ap.pending.amount),
    '22,000': N(ap.rejected.amount), '3,72,000': N(ap.paid.amount + ap.processing.amount + ap.pending.amount + ap.rejected.amount),
    '₹2,84,500': I(ap.paid.amount), '₹23,500': I(ap.pending.amount),
    '₹56,516': I(Math.max(0, totalAdmin - ap.paid.amount - ap.processing.amount - ap.pending.amount)),
  });

  // PAGE 9 — Refunds & cancellations + fees (fees NOT recorded -> ₹0)
  add(9, {
    '318': N(rf.requests), '₹1,43,508': I(rf.refundAmount), '611': N(rf.cancelledCount),
    '₹3,32,489': I(rf.cancelledValue),
    '249': N(rf.completed), '41': N(rf.pending), '28': N(rf.rejected),
    '1,43,508': N(rf.refundAmount), '23,914': N(0), '16,082': N(0), '1,83,504': N(rf.refundAmount),
    '2.04%': P(rf.refundRate), '1.69%': P(rf.refundRate), '4.72%': P(rf.cancellationRate),
    '4.28%': P(rf.cancellationRate), '6.76%': P(rf.combinedReversalRate),
    // Fee section — production records none:
    '64,57,515': N(0), '₹64,57,515': I(0), '1,42,124': N(0), '18,470': N(0),
    '21,336': N(0), '11,482': N(0), '51,288': N(0), '1,93,412': N(0), '₹1,93,412': I(0),
    '₹61,20,595': I(0),
  });

  // PAGE 11 — ratios + reconciliation
  add(11, {
    '90.40%': P(rt.salesCompletionRate), '87.60%': P(pur.completionRate),
    '88.89%': P(rt.sellerRevenueShare), '12.50%': P(0), '11.11%': P(0),
    '8.05%': P(rt.netRevenueMargin), '7.22%': P(rt.netRevenueMargin),
    '27.57%': P(0), '2.04%': P(rf.refundRate), '4.72%': P(rf.cancellationRate),
    '87.24%': P(rt.sellerPayoutRatio), '69.98%': P(rt.adminPayoutRatio),
    '₹42.91': D(rt.netRevenuePerTransaction), '₹434.60': D(sel.avgRevenuePerSale),
    '70,42,168': N(rev.grossSales), '(2,52,164)': '(' + N(rev.pendingValue) + ')',
    '(3,32,489)': '(' + N(rev.cancelledValue) + ')', '(1,43,508)': '(' + N(rev.refundedValue) + ')',
    '63,14,007': N(rev.settledSales), '(56,12,450)': '(' + N(rev.sellerRevenue) + ')',
    '7,01,557': N(rev.platformServiceFeeRevenue), '(1,42,124)': '(' + N(rev.gatewayFees) + ')',
    '(51,288)': '(' + N(rev.otherCharges) + ')', '5,08,145': N(rev.netDistributableRevenue),
    '(2,03,258)': '(' + N(a1) + ')', '(1,01,629)': '(' + N(plat) + ')',
    '56,12,450': N(rev.sellerRevenue), '(48,96,220)': '(' + N(sel.liability.paid) + ')',
    '(4,12,880)': '(' + N(sel.liability.processing) + ')', '(3,03,350)': '(' + N(sel.liability.pending) + ')',
    '4,06,516': N(totalAdmin), '(2,84,500)': '(' + N(ap.paid.amount) + ')',
  });

  // PAGE 12 — month-end summary
  add(12, {
    '70,42,168': N(me.grossSales), '63,14,007': N(me.settledSales), '56,12,450': N(me.sellerRevenue),
    '7,01,557': N(me.platformServiceFee), '(1,93,412)': '(' + N(0) + ')', '5,08,145': N(me.netDistributableRevenue),
    '4,06,516': N(me.adminRevenue), '1,01,629': N(me.platformRevenue),
    '4,12,880': N(me.carried.sellerPayoutsProcessing), '3,03,350': N(me.carried.sellerPayoutsPending),
    '65,500': N(me.carried.adminPayoutsProcessing + me.carried.adminPayoutsPending),
    '56,516': N(Math.max(0, me.adminRevenue - ap.paid.amount - ap.processing.amount - ap.pending.amount)),
    '23,914': N(0), '8,62,160': N(me.carried.totalSettlementLiability),
    '12,914': N(me.settledSales ? sal.completed : 0),
    '₹70,42,168': I(me.grossSales), '₹63,14,007': I(me.settledSales), '₹56,12,450': I(me.sellerRevenue),
    '₹7,01,557': I(me.platformServiceFee), '₹5,08,145': I(me.netDistributableRevenue),
  });

  // ── DETAIL TABLES (per-row) ──────────────────────────────────────────────
  // The template ships example rows; we blank any cell we have no real value
  // for (so NO August example data ever survives) and fill the rest from real
  // data. `blankIf` maps a template cell string → real value or '' (cleared).
  const settled = rev.settledSales || 0;
  const share = (v) => (settled > 0 ? P((v / settled) * 100) : '0.00%');

  // PAGE 5 — Top 10 sellers  [seller, sold, salesValue, sellerRevenue, paid, pending]
  const P5 = [
    ['DealNest Retail', '512', '2,54,790', '2,26,480', '2,02,480', '24,000'],
    ['CouponKart Store', '448', '2,20,860', '1,96,320', '1,78,320', '18,000'],
    ['SaveMore Deals Hub', '401', '1,96,605', '1,74,760', '1,56,760', '18,000'],
    ['VoucherVault India', '366', '1,78,808', '1,58,940', '1,38,940', '20,000'],
    ['GrabItNow Store', '332', '1,59,953', '1,42,180', '1,27,180', '15,000'],
    ['PriceDrop Bazaar', '298', '1,43,573', '1,27,620', '1,10,620', '17,000'],
    ['ClipNSave Traders', '271', '1,29,251', '1,14,890', '1,02,890', '12,000'],
    ['OfferOrbit Retail', '246', '1,16,393', '1,03,460', '90,460', '13,000'],
    ['DiscountDen Store', '224', '1,04,828', '93,180', '82,180', '11,000'],
    ['ThriftLoop Deals', '203', '94,860', '84,320', '73,320', '11,000'],
  ];
  const p5 = {};
  P5.forEach((row, i) => {
    const d = sel.top10[i];
    p5[row[0]] = d ? String(d.label || '') : '';
    p5[row[1]] = d ? N(d.count) : '';
    p5[row[2]] = d ? N(d.salesValue) : '';
    p5[row[3]] = d ? N(d.sellerRevenue) : '';
    p5[row[4]] = ''; // per-seller paid split not tracked
    p5[row[5]] = '';
  });
  add(5, p5);

  // PAGE 6 — Top selling coupons [coupon, brand, category, sold, salesValue, sellerRevenue]
  const P6 = [
    ['TRAVELMAX ₹2000 Off', 'MakeMyTrip', 'Travel', '312', '3,15,900', '2,80,800'],
    ['GADGETZONE ₹1500 Off', 'Croma', 'Electronics', '268', '2,11,050', '1,87,600'],
    ['FLAT30 Fashion Fest', 'Myntra', 'Shopping', '684', '2,07,765', '1,84,680'],
    ['BINGE12 Annual Pass', 'Netflix', 'Entertainment', '214', '1,92,600', '1,71,200'],
    ['SUPERSAVE Grocery', 'BigBasket', 'Shopping', '596', '1,67,625', '1,49,000'],
    ['HOMEDEAL ₹1000 Off', 'Amazon', 'Shopping', '336', '1,51,200', '1,34,400'],
    ['GLOWUP Beauty Bundle', 'Nykaa', 'Beauty', '462', '1,29,938', '1,15,500'],
    ['FOODIE50 Weekend', 'Swiggy', 'Food & Dining', '548', '1,23,300', '1,09,600'],
    ['DINEOUT Gold ₹750', 'Zomato', 'Food & Dining', '398', '1,11,938', '99,500'],
    ['QUICKCAB ₹300 Off', 'Uber', 'Travel', '424', '71,550', '63,600'],
  ];
  const p6 = {};
  P6.forEach((row, i) => {
    const d = r.topCoupons[i];
    p6[row[0]] = d ? String(d.label || '') : '';
    p6[row[1]] = d ? String(d.brand || '') : '';
    p6[row[2]] = d ? String(d.category || '') : '';
    p6[row[3]] = d ? N(d.count) : '';
    p6[row[4]] = d ? N(d.salesValue) : '';
    p6[row[5]] = d ? N(d.sellerRevenue) : '';
  });
  add(6, p6);

  // PAGE 7 — Brands [brand, sold, salesValue, sellerRevenue, share]
  const P7B = [
    ['Amazon', '1,482', '7,42,140', '6,59,680', '11.75%'],
    ['Myntra', '1,246', '6,18,435', '5,49,720', '9.79%'],
    ['MakeMyTrip', '684', '5,86,238', '5,21,100', '9.28%'],
    ['Flipkart', '1,118', '5,24,745', '4,66,440', '8.31%'],
    ['Swiggy', '1,342', '4,38,413', '3,89,700', '6.94%'],
    ['BigBasket', '968', '3,55,050', '3,15,600', '5.62%'],
    ['Croma', '512', '3,29,738', '2,93,100', '5.22%'],
    ['Nykaa', '826', '2,86,313', '2,54,500', '4.53%'],
    ['Zomato', '894', '2,51,438', '2,23,500', '3.98%'],
    ['Netflix', '386', '2,38,275', '2,11,800', '3.77%'],
  ];
  const p7 = {};
  P7B.forEach((row, i) => {
    const d = r.brands[i];
    p7[row[0]] = d ? String(d.label || '') : '';
    p7[row[1]] = d ? N(d.count) : '';
    p7[row[2]] = d ? N(d.salesValue) : '';
    p7[row[3]] = d ? N(d.sellerRevenue) : '';
    p7[row[4]] = d ? share(d.salesValue) : '';
  });
  // PAGE 7 — Categories [category, bought, sold, salesValue, sellerRevenue, share]
  const P7C = [
    ['Shopping', '5,586', '4,872', '19,86,462', '17,65,744', '31.46%'],
    ['Travel', '1,672', '1,468', '14,52,938', '12,91,500', '23.01%'],
    ['Food & Dining', '2,948', '2,584', '8,74,935', '7,77,720', '13.86%'],
    ['Electronics', '1,308', '1,146', '8,26,875', '7,35,000', '13.10%'],
    ['Entertainment', '1,042', '926', '5,26,163', '4,67,700', '8.33%'],
    ['Beauty', '1,386', '1,214', '4,58,663', '4,07,700', '7.26%'],
  ];
  P7C.forEach((row, i) => {
    const d = r.categories[i];
    p7[row[0]] = d ? String(d.label || '') : '';
    p7[row[1]] = ''; // per-category buyer count not tracked
    p7[row[2]] = d ? N(d.count) : '';
    p7[row[3]] = d ? N(d.salesValue) : '';
    p7[row[4]] = d ? N(d.sellerRevenue) : '';
    p7[row[5]] = d ? share(d.salesValue) : '';
  });
  add(7, p7);

  // PAGE 10 — Weekly [sold, bought, transactions, gross, sellerRev, net]
  const P10W = [
    ['3,262', '3,368', '2,704', '16,08,420', '12,84,116', '1,16,254'],
    ['3,451', '3,562', '2,861', '17,01,336', '13,58,204', '1,22,948'],
    ['3,824', '3,947', '3,169', '18,84,952', '15,02,388', '1,36,012'],
    ['2,569', '2,647', '2,131', '12,66,410', '10,05,742', '91,062'],
    ['1,180', '1,218', '977', '5,81,050', '4,62,000', '41,869'],
  ];
  const p10 = {};
  P10W.forEach((row, i) => {
    const w = r.weekly[i];
    p10[row[0]] = w ? N(w.couponsSold) : '';
    p10[row[1]] = w ? N(w.couponsBought) : '';
    p10[row[2]] = w ? N(w.transactions) : '';
    p10[row[3]] = w ? N(w.grossSales) : '';
    p10[row[4]] = w ? N(w.sellerRevenue) : '';
    p10[row[5]] = w ? N(w.netRevenue) : '';
  });
  // PAGE 10 — MoM current column (previous-month breakdown limited to what we compute)
  Object.assign(p10, {
    '₹70,42,168': I(rev.grossSales), '₹63,21,940': I(cmp.previous.grossSales),
    '₹5,08,145': I(rev.netDistributableRevenue), '₹4,42,760': I(cmp.previous.netRevenue),
    '14,286': N(s.couponsSold), '12,908': N(cmp.previous.couponsSold),
    '₹56,12,450': I(rev.sellerRevenue), '₹50,48,712': I(cmp.previous.sellerRevenue),
  });
  add(10, p10);

  return m;
}

// Global boundary-safe token replacements: catch the LARGE, unique-meaning
// August figures wherever they appear (composite callouts, total rows, prose),
// not only in standalone cells. Boundaries prevent matching inside a longer
// number (so "12" never corrupts "12,914"). Only unambiguous figures go here;
// ambiguous small counts stay in the per-page/table dicts.
function buildGlobalTokens(r) {
  const rev = r.revenue, s = r.summary, sel = r.sellers, ap = r.adminPayouts, cmp = r.comparison, rf = r.refunds;
  const a1 = rev.distribution.admin1.amount, plat = rev.distribution.platform.amount;
  const top = sel.top10 || [];
  const topSold = top.reduce((a, t) => a + (t.count || 0), 0);
  const topSales = top.reduce((a, t) => a + (t.salesValue || 0), 0);
  const topRev = top.reduce((a, t) => a + (t.sellerRevenue || 0), 0);
  const map = {
    '70,42,168': N(rev.grossSales), '63,21,940': N(cmp.previous.grossSales),
    '5,08,145': N(rev.netDistributableRevenue), '4,42,760': N(cmp.previous.netRevenue),
    '56,12,450': N(rev.sellerRevenue), '50,48,712': N(cmp.previous.sellerRevenue),
    '7,01,557': N(rev.platformServiceFeeRevenue), '63,14,007': N(rev.settledSales),
    '72,68,940': N(r.purchases.totalPurchaseValue),
    '48,96,220': N(sel.liability.paid), '4,12,880': N(sel.liability.processing),
    '3,03,350': N(sel.liability.pending), '7,16,230': N(sel.liability.closing),
    '1,42,124': N(0), '51,288': N(0), '1,93,412': N(0), '64,57,515': N(0), '61,20,595': N(0),
    '18,470': N(0), '21,336': N(0), '11,482': N(0),
    '1,43,508': N(rf.refundAmount), '3,32,489': N(rf.cancelledValue),
    '2,03,258': N(a1), '1,01,629': N(plat), '4,06,516': N(r.adminRevenue.totalAdminRevenue),
    '2,84,500': N(ap.paid.amount), '3,72,000': N(ap.paid.amount + ap.processing.amount + ap.pending.amount + ap.rejected.amount),
    '8,499': N(r.sales.highestSale),
    '14,286': N(s.couponsSold), '14,742': N(s.couponsBought), '11,842': N(s.completedTransactions),
    '12,908': N(cmp.previous.couponsSold),
    '15,99,921': N(topSales), '14,22,150': N(topRev), '3,301': N(topSold),
    // Top-5 brand callout sales values (page 7) — real brands[] or 0 when none.
    '7,42,140': N((r.brands[0] || {}).salesValue || 0),
    '6,18,435': N((r.brands[1] || {}).salesValue || 0),
    '5,86,238': N((r.brands[2] || {}).salesValue || 0),
    '5,24,745': N((r.brands[3] || {}).salesValue || 0),
    '4,38,413': N((r.brands[4] || {}).salesValue || 0),
    '488.93': (Number(s.avgCouponSaleValue) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    '434.60': (Number(sel.avgRevenuePerSale) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    '42.91': (Number(r.ratios.netRevenuePerTransaction) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  };
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Object.entries(map)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([tok, val]) => ({ re: new RegExp('(?<!\\d)' + esc(tok) + '(?!\\d)', 'g'), val: String(val) }));
}

function applyGlobal(str, tokens) {
  let out = str;
  for (const { re, val } of tokens) out = out.replace(re, val);
  return out === str ? null : out;
}

/**
 * @param {object} r report data (finance.buildMonthlyReportData)
 * @returns {Promise<{buffer:Buffer, applied:{ok:number,miss:string[]}}>}
 */
async function generateMonthlyReportPdf(r) {
  const doc = await PDFDocument.load(fs.readFileSync(TEMPLATE));
  doc.registerFontkit(fontkit.default || fontkit);
  const reg = await doc.embedFont(fs.readFileSync(FONT_REG), { subset: true });
  const bold = await doc.embedFont(fs.readFileSync(FONT_BOLD), { subset: true });
  const pages = doc.getPages();
  const L = layout();
  const applied = { ok: 0, redacted: 0, miss: [] };

  const cur = ymOf(r.period.key);
  const newMonthLabel = r.period.label;                 // "September 2026"
  const newRefTail = `${cur.y}/${String(cur.m).padStart(2, '0')}`;

  // Month/period/reference token replacements applied to WHOLE matching items
  // (handles the letter-spaced running header + footers on every page).
  function headerRepl(str) {
    let out = str;
    // full month name (plain + letter-spaced), any month → current
    for (let i = 0; i < 12; i++) {
      out = out.split('August 2026').join(newMonthLabel);
      out = out.split(spaced('AUGUST 2026')).join(spaced(`${MON_FULL[cur.m - 1].toUpperCase()} ${cur.y}`));
    }
    out = out.split('SH/FIN/2026/08').join(`SH/FIN/${newRefTail}`);
    out = out.split(spaced('SH/FIN/2026/08')).join(spaced(`SH/FIN/${newRefTail}`));
    out = out.split('2026/08').join(newRefTail);
    return out === str ? null : out;
  }

  const map = buildReplacementMap(r);
  const tokens = buildGlobalTokens(r);

  for (let p = 1; p <= pages.length; p++) {
    const page = pages[p - 1];
    const dict = map[p] || {};
    const items = L.filter((it) => it.page === p);

    // Collect targets: exact financial cells, then header/ref + global figures.
    const targets = [];
    for (const it of items) {
      let repl = null;
      if (Object.prototype.hasOwnProperty.call(dict, it.str)) {
        repl = dict[it.str];
      } else {
        let t = it.str;
        const h = headerRepl(t); if (h != null) t = h;
        const g = applyGlobal(t, tokens); if (g != null) t = g;
        if (t !== it.str) repl = t;
      }
      if (repl == null) continue;
      targets.push({ it, repl });
    }
    if (!targets.length) continue;

    const posTargets = targets.map((t) => ({ x: t.it.x, y: t.it.y, w: t.it.w, ytol: 2.6, xtol: 2.6 }));
    const content = decodePageContent(doc, page);
    const { edited, matches } = redactByPosition(content, posTargets);
    setPageContent(doc, page, edited);

    targets.forEach((t, i) => {
      const mm = matches[i];
      if (mm) applied.redacted += 1;
      const size = t.it.size;
      const font = size >= 12.4 ? bold : reg;
      const color = mm && mm.color ? rgb(mm.color.r, mm.color.g, mm.color.b) : rgb(0.09, 0.13, 0.22);
      const str = String(t.repl);
      const w = font.widthOfTextAtSize(str, size);
      // Right-align numeric cells whose original was right-aligned is unknown;
      // keep left origin (matches most of the template's left-set values).
      page.drawText(str, { x: t.it.x, y: t.it.y, size, font, color });
      applied.ok += 1;
    });
  }

  return { buffer: Buffer.from(await doc.save()), applied };
}

module.exports = { generateMonthlyReportPdf, buildReplacementMap, inr: I, num: N };

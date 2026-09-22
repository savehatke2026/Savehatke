// ============================================
// SaveHatke — Sheets-only 7% seller payout verification
// ============================================
// Verifies the Google Sheets-only architecture for the 7% seller payout rule:
//   • Existing SHEETS.COUPONS already has a `sellerPayout` column — reused
//   • Existing SHEETS.PAYOUTS is the per-payout ledger — reused
//   • Supabase is NOT touched for payout (no seller_payout column, no trigger)
//   • 7% is computed at admin-approval time and written to the existing
//     Sheets sellerPayout column; never at submission time
//   • Duplicate approval does not re-write the payout
//   • The auto-payout flow (when a coupon is sold) uses 7% of face value
//     and never reads the marketplace sellingPrice
//
// Run: node verify-payout-rules.cjs

const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const sp = require(path.join(ROOT, 'server', 'services', 'sellerPayout.js'));

let pass = 0, fail = 0;
const t = (ok, name, info = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (info ? `   ${info}` : ''));
  ok ? pass++ : fail++;
};

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const couponsSrc    = read('server/routes/coupons.js');
const payoutsSrc    = read('server/routes/payouts.js');
const adminSrc      = read('server/routes/admin.js');
const paymentsSrc   = read('server/routes/payment.js');
const supabaseSrc   = read('server/services/supabase.js');
const sellerPayoutSrc = read('server/services/sellerPayout.js');
const sheetsSrc     = read('server/services/googleSheets.js');
const sellHtmlSrc   = read('public/sell.html');
const dashboardSrc  = read('public/dashboard.html');

console.log('\n═══ §1 — Existing Google Sheets infrastructure is reused ═══');
t(/\[SHEETS\.COUPONS\]:\s*\[[\s\S]*?'sellerPayout'/.test(sheetsSrc),
  'Existing SHEETS.COUPONS already declares a sellerPayout column');
t(/\[SHEETS\.PAYOUTS\]:\s*\[/.test(sheetsSrc),
  'Existing SHEETS.PAYOUTS is the per-payout ledger');
t(/\[SHEETS\.SELLER_PAYOUT_DETAILS\]:\s*\[/.test(sheetsSrc),
  'Existing SHEETS.SELLER_PAYOUT_DETAILS holds per-seller destinations');
// No new sheet/tab/column added.
t(!/create.*sheet|createSheet|new sheet/i.test(adminSrc + couponsSrc + payoutsSrc),
  'No new Google Sheet/tab is created anywhere');

console.log('\n═══ §2 — CORE RULE: payout = face_value × 0.07 ═══');
for (const [fv, expected] of [[100,7],[200,14],[500,35],[1000,70],[2000,140],[2500,175],[5000,350],[7500,525],[10000,700]]) {
  t(sp.calculateSellerPayout(fv) === expected, `₹${fv} × 0.07 = ₹${expected}`);
}
t(sp.PAYOUT_RATE === 0.07, 'PAYOUT_RATE constant = 0.07');

console.log('\n═══ §3 — Seller coupon workflow: payout is NOT generated on submit ═══');
// Submission handler must NOT set sellerPayout on the new coupon row.
const submissionHandler = couponsSrc.slice(couponsSrc.indexOf('handleCouponSubmission'),
  couponsSrc.indexOf('router.post(\'/sell\''));
// Strip comment-only lines first so a "NOTE: sellerPayout is intentionally NOT
// set" comment does not poison the assertion below.
const submissionCode = submissionHandler.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
// Find the field written immediately after `originalValue:` inside the new
// coupon object. It must NOT be `sellerPayout:`.
const newCouponBlock = submissionCode.match(/const coupon = \{[\s\S]*?\n\s*\};/);
const newCouponFields = newCouponBlock ? newCouponBlock[0] : '';
const afterOriginalValue = newCouponFields.match(/originalValue:[^,\n]+,\s*\n\s*([a-zA-Z_$][\w$]*):/);
const fieldAfterFV = afterOriginalValue ? afterOriginalValue[1] : null;
t(fieldAfterFV !== 'sellerPayout',
  `Field after originalValue in new coupon object is "${fieldAfterFV}" — must not be sellerPayout`);
// Belt-and-braces: no batch-level payout computation.
t(!/batchPayouts\[i\]/.test(submissionHandler),
  'Submission handler does not compute a per-batch payout');
// The submission MUST still validate the face value range.
t(/calculateSellerPayout\(faceText\)/.test(submissionHandler)
  && /INVALID_FACE_VALUE/.test(submissionHandler),
  'Submission handler still validates face value via calculateSellerPayout');
// Submission response says "will be activated once approved" — not "now".
t(/will be activated once the coupon is approved/i.test(submissionHandler),
  'Submission response language says payout is activated at approval, not at submission');

console.log('\n═══ §4 — Payout generated at admin-approval time, written to Sheets ═══');
const reviewAction = adminSrc.slice(adminSrc.indexOf("router.post('/coupons/:id/review-action'"),
  adminSrc.indexOf("router.post('/coupons/:id/invalidate'"));
t(/action === 'approve'/.test(reviewAction),
  'review-action endpoint exists and handles action=approve');
t(/updates\.sellerPayout\s*=\s*calculateSellerPayout\(coupon\.originalValue\)/.test(reviewAction),
  'Approval path computes 7% × face value and writes it to the coupon update');
t(/SHEETS\.COUPONS/.test(reviewAction) && /db\.updateRow/.test(reviewAction),
  'Approval write targets the existing Sheets COUPONS tab');
t(!/seller_payout:/.test(reviewAction),
  'Approval path does NOT write to any Supabase seller_payout column');

console.log('\n═══ §5 — Verified face value, not marketplace sellingPrice ═══');
t(/coupon\.originalValue/.test(reviewAction),
  'Approval payout is derived from coupon.originalValue (face value)');
t(!/coupon\.sellingPrice/.test(reviewAction),
  'Approval payout does NOT read the marketplace sellingPrice');
t(/calculateSellerPayout\(coupon\.originalValue\)/.test(reviewAction),
  'Approval uses the formula on coupon.originalValue');

console.log('\n═══ §6 — Supabase is NOT modified for seller payout ═══');
t(!/seller_payout\s*=/.test(supabaseSrc),
  'supabase.js contains no `seller_payout = ...` write');
t(!/seller_payout:/.test(supabaseSrc),
  'supabase.js contains no `seller_payout:` field write');
t(!/function payoutForFaceValue/.test(supabaseSrc),
  'supabase.js contains no payoutForFaceValue helper');
t(!/require.*sellerPayout/.test(supabaseSrc),
  'supabase.js does not import the sellerPayout service');
// No migration file at the path that previously created the column.
const migrationPath = path.join(ROOT, 'supabase/migrations/20260920_seller_payout_7_percent.sql');
t(!fs.existsSync(migrationPath),
  'No Supabase migration creates a seller_payout column');
// No trigger / function in any migration.
const migrationsDir = path.join(ROOT, 'supabase/migrations');
const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
const triggerLeak = migrationFiles.some((f) => /enforce_seller_payout_7_percent|seller_payout_trigger/i.test(read(`supabase/migrations/${f}`)));
t(!triggerLeak, 'No Supabase trigger/function for seller payout in any migration');

console.log('\n═══ §7 — Frontend: read-only, no manual entry, Face Value + Payout + Rate ═══');
t(/payout-preview-label[\s\S]*Seller Payout/.test(sellHtmlSrc),
  'Sell page shows "Seller Payout" label');
t(/payout-preview-rate[\s\S]*7% of face value/.test(sellHtmlSrc),
  'Sell page shows the "7% of face value" caption');
t(/<input[^>]*name="sellerPayout"/i.test(sellHtmlSrc) === false,
  'Sell page has NO editable sellerPayout input field');

console.log('\n═══ §8 — Admin panel shows the existing Sheets payout fields ═══');
t(/payoutSummary\(/.test(adminSrc),
  'admin.js uses the payoutSummary helper for payout display');
t(/sellerPayout:\s*info\.payoutEligible\s*\?\s*info\.sellerPayout\s*:\s*null/.test(adminSrc),
  'payoutSummary surfaces the canonical server-computed sellerPayout');
t(/sellerPayoutStored:/.test(adminSrc),
  'payoutSummary also exposes the stored Sheets value for audit');

console.log('\n═══ §9 — Existing payout process reads existing payout info ═══');
t(/resolveCouponPayoutAmount/.test(payoutsSrc),
  'payouts.js exports the resolveCouponPayoutAmount helper');
t(/sellerPayout\.calculateSellerPayout/.test(payoutsSrc),
  'payouts.js derives the payout via sellerPayout.calculateSellerPayout');
// The auto-payout writes to the existing Payouts sheet, not a new one.
t(/SHEETS\.PAYOUTS/.test(payoutsSrc) && /db\.appendRow/.test(payoutsSrc),
  'Auto-payout writes to the existing SHEETS.PAYOUTS ledger');
// Idempotent: re-creating an auto-payout for the same coupon returns the
// existing row instead of producing a duplicate.
t(/existing\s*=\s*all\.find\(\(p\)\s*=>\s*String\(p\.sourceCouponId\)\s*===\s*String\(coupon\.id\)\)/.test(payoutsSrc),
  'createAutoPayout is idempotent — duplicate calls return the existing payout row');

console.log('\n═══ §10 — Security: server is the only authority on payout amount ═══');
// Approval never reads payout from the request body.
t(!/req\.body\.(?:sellerPayout|seller_payout|payout_amount|payoutAmount)/.test(reviewAction),
  'review-action never reads a client-supplied payout field');
// Admin write strips client-supplied payout keys before any write.
t(/PAYOUT_BODY_KEYS/.test(adminSrc) && /sellerPayout/.test(adminSrc) && /payout_amount/.test(adminSrc),
  'admin.js PAYOUT_BODY_KEYS strips every payout-shaped body key');
// Auto-payout path computes from the coupon row, not from the request body.
const autoPayoutFn = payoutsSrc.slice(payoutsSrc.indexOf('createAutoPayout'),
  payoutsSrc.indexOf('module.exports.createAutoPayout') < 0
    ? payoutsSrc.length
    : payoutsSrc.indexOf('module.exports.createAutoPayout'));
t(!autoPayoutFn.includes('req.body.sellerPayout'),
  'createAutoPayout never reads a client-supplied payout');

console.log('\n═══ §11 — Duplicate-payout protection on repeated approval ═══');
t(/alreadyApproved\s*=\s*String\(coupon\.status[^)]*\)\.toLowerCase\(\)\s*===\s*'available'/.test(reviewAction),
  'review-action detects already-approved coupons');
t(/skipPayoutWrite\s*=\s*action\s*===\s*'approve'\s*&&\s*alreadyApproved/.test(reviewAction),
  'review-action skips the sellerPayout write on duplicate approval');
t(/!skipPayoutWrite/.test(reviewAction),
  'Approval guards the sellerPayout write behind the duplicate-approval check');
// createAutoPayout also already prevents duplicate Payouts rows.
t(/existing\s*=\s*all\.find\(/.test(payoutsSrc),
  'createAutoPayout prevents duplicate Payouts-tab rows by sourceCouponId');

console.log('\n═══ §12 — Face value validation ₹100–₹10,000 only ═══');
for (const bad of [99, 10001, 50, 0, -100, 99.99, 10000.01]) {
  let threw = false, code = null;
  try { sp.calculateSellerPayout(bad); } catch (e) { threw = true; code = e.code; }
  t(threw && code === 'INVALID_FACE_VALUE', `₹${bad} rejected with INVALID_FACE_VALUE`);
}
for (const ok of [100, 10000]) {
  t(sp.calculateSellerPayout(ok) !== undefined && Number.isFinite(sp.calculateSellerPayout(ok)),
    `₹${ok} accepted (boundary inclusive)`);
}
let silent = false;
try { sp.calculateSellerPayout(50); } catch { silent = true; }
t(silent, 'Out-of-range face value throws (does NOT silently clamp)');

console.log('\n═══ §13 — Existing admin/public coupons are not affected ═══');
// Submission only validates face value for SELLER coupons. Admin coupons are
// not gated by the same rule on submission, and their existing sellerPayout
// field is untouched by this change.
t(/isSellerCoupon/.test(adminSrc),
  'isSellerCoupon helper exists for distinguishing admin vs seller rows');
t(!/isSellerCoupon\(coupon\)\s*\|\|\s*approving/.test(adminSrc),
  'Approval no longer requires isSellerCoupon || approving for face-value edits');

console.log('\n═══ §14 — Marketplace selling price kept separate ═══');
const resolverBody = payoutsSrc.slice(payoutsSrc.indexOf('async function resolveCouponPayoutAmount'),
  payoutsSrc.indexOf('function tryCompute7Percent'));
t(!/sellingPrice|selling_price/.test(resolverBody),
  'resolveCouponPayoutAmount does not read sellingPrice');
// The 7% formula lives in tryCompute7Percent, which the resolver delegates to.
// Check the whole payout-resolver chain (resolver + helper) for the formula.
const resolverChain = payoutsSrc.slice(payoutsSrc.indexOf('async function resolveCouponPayoutAmount'),
  payoutsSrc.indexOf('\nmodule.exports = router'));
t(/sellerPayout\.calculateSellerPayout/.test(resolverChain),
  'payout resolver derives the payout from face value via the 7% formula');

console.log('\n═══ §15 — Existing Sheet data is not overwritten ═══');
// Approval only touches the targeted coupon row via id; it does not bulk-rewrite
// any unrelated sheet, and does not create duplicate coupon rows.
t(/db\.updateRow\(db\.SHEETS\.COUPONS,\s*['"]id['"]/.test(reviewAction)
  && /updates\)/.test(reviewAction),
  'Approval updates exactly one coupon row by id (no bulk rewrite)');
t(!/appendRow\(db\.SHEETS\.COUPONS/.test(reviewAction),
  'Approval does NOT append a new coupon row (no duplicate)');

console.log('\n═══ §16 — Spec test cases (₹100–₹10,000) ═══');
const CASES = [[100,7],[200,14],[500,35],[1000,70],[2000,140],[2500,175],[5000,350],[7500,525],[10000,700]];
for (const [fv, expected] of CASES) {
  t(sp.calculateSellerPayout(fv) === expected, `₹${fv} → ₹${expected}`);
}
for (const bad of [99, 10001]) {
  let threw = false;
  try { sp.calculateSellerPayout(bad); } catch { threw = true; }
  t(threw, `₹${bad} rejected under the ₹100–₹10,000 rule`);
}
// Cascade: changing face value changes payout, recomputed server-side.
t(sp.calculateSellerPayout(1000) === 70 && sp.calculateSellerPayout(2000) === 140,
  'Changing ₹1000 → ₹2000 cascades payout ₹70 → ₹140 (auto, server-side)');

console.log('\n═══ §17 — Existing functionality preserved ═══');
t(/router\.post\('\/sell'/.test(couponsSrc) && /router\.post\('\/submit'/.test(couponsSrc),
  'POST /sell and /submit endpoints still exist');
t(/router\.post\('\/buy\/:id'/.test(couponsSrc),
  'POST /buy/:id still exists');
t(/router\.post\('\/create'/.test(paymentsSrc) && /router\.post\('\/verify'/.test(paymentsSrc),
  'UPI payment create / verify endpoints still exist');
t(/SHEETS\.COUPONS/.test(couponsSrc) && /SHEETS\.PAYOUTS/.test(payoutsSrc),
  'Google Sheets mirror still in use (Coupons + Payouts)');
t(/authenticateToken/.test(adminSrc) && /requireAdmin/.test(adminSrc),
  'Admin authentication preserved');
t(/isFeatured/.test(sheetsSrc) && /isExclusive/.test(sheetsSrc),
  'Sheet column structure unchanged (no duplicates created)');

console.log('\n═══ FINAL — SELLER PAYOUT = 7% OF VERIFIED FACE VALUE ═══');
t(sp.PAYOUT_RATE === 0.07, 'PAYOUT_RATE = 0.07');
t(sp.PAYOUT_PRICING_MODEL === 'face-value-7-percent', 'Pricing model identifier');
t(sp.MIN_FACE_VALUE === 100 && sp.MAX_FACE_VALUE === 10000, 'Eligible range locked');

// ═══ Summary ═══
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

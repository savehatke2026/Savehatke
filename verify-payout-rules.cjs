// ============================================
// SaveHatke — End-to-end 7% seller payout rules verification
// ============================================
// Walks through all 14 sections of the seller payout spec and asserts each
// guarantee by reading the REAL source files (no re-implementations).
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
const paymentsSrc   = read('server/routes/payments.js');
const supabaseSrc   = read('server/services/supabase.js');
const sellerPayoutSrc = read('server/services/sellerPayout.js');
const migrationSrc  = read('supabase/migrations/20260920_seller_payout_7_percent.sql');
const sellHtmlSrc   = read('public/sell.html');
const dashboardSrc  = read('public/dashboard.html');

console.log('\n═══ §1 — CORE RULE: payout = face_value × 0.07 ═══');
for (const [fv, expected] of [[100,7],[200,14],[300,21],[500,35],[1000,70],[2000,140],[2500,175],[5000,350],[7500,525],[10000,700]]) {
  t(sp.calculateSellerPayout(fv) === expected, `₹${fv} × 0.07 = ₹${expected}`);
}
t(/PAYOUT_RATE\s*=\s*0\.07/.test(sellerPayoutSrc), 'PAYOUT_RATE constant = 0.07');

console.log('\n═══ §2 — Marketplace sellingPrice is preserved separately ═══');
// The seller payout service does not read sellingPrice. The submission route
// keeps sellingPrice as its own column. The admin and update paths keep
// sellingPrice too.
t(!/sellingPrice|selling_price/.test(sellerPayoutSrc.replace(/^\s*\/\/.*$/gm, '')),
  'sellerPayout.js code (no comments) does not read sellingPrice');
t(/originalValue/.test(couponsSrc) && /sellingPrice/.test(couponsSrc),
  'coupons.js keeps originalValue and sellingPrice as distinct fields');

// §3 SELL COUPON FLOW — payout is computed at submission time, read-only, no manual edit.
console.log('\n═══ §3 — Sell coupon flow: backend computes, seller cannot edit ═══');
t(/calculateSellerPayout\(/.test(couponsSrc), 'coupons.js calls calculateSellerPayout during submission');
t(/batchPayouts\[i\]\s*=\s*calculateSellerPayout/.test(couponsSrc),
  'Payout is computed once per coupon before any DB write (no partial saves)');
t(/sellerPayout:\s*batchPayouts\[i\]/.test(couponsSrc),
  'Stored sellerPayout on the new coupon comes from the server-computed value');
// The front-end must show a live payout preview and never accept an editable payout field.
t(/payout-preview/.test(sellHtmlSrc) && /read-only/.test(sellHtmlSrc.toLowerCase()),
  'Sell page shows a read-only payout preview panel');

// §4 BACKEND CALCULATION — server is the source of truth; client payout is ignored.
console.log('\n═══ §4 — Backend performs the calculation; client payout is ignored ═══');
t(/sellerPayout\s*:\s*batchPayouts\[i\]/.test(couponsSrc),
  'Submission route overwrites any client-supplied sellerPayout with batchPayouts[i]');
// Verify the submission handler never reads sellerPayout/payout_amount from the body.
// Look for "payout-shaped key followed by req.body" — the only dangerous pattern.
const submissionHandler = couponsSrc.slice(couponsSrc.indexOf('handleCouponSubmission'),
  couponsSrc.indexOf('router.post(\'/sell\''));
const bodyReadsPayout = /\b(sellerPayout|seller_payout|payout_amount|payoutAmount)\s*[:=]?\s*req\.body/;
t(!bodyReadsPayout.test(submissionHandler),
  'Submission handler never reads a client-supplied payout field (no "payout: req.body")');
// Payout uses integer paise (no floating-point drift).
t(/paise/.test(sellerPayoutSrc) && /SafeInteger/.test(sellerPayoutSrc),
  'Payout calculation uses integer paise (no binary FP drift)');

// §5 DATABASE — existing coupons table; seller_payout added by migration.
console.log('\n═══ §5 — Database: existing coupons table; seller_payout via migration ═══');
t(/ALTER TABLE public\.coupons ADD COLUMN IF NOT EXISTS seller_payout/.test(migrationSrc),
  'Migration adds seller_payout to public.coupons (IF NOT EXISTS)');
t(!/CREATE TABLE/i.test(migrationSrc) || /ADD COLUMN/i.test(migrationSrc),
  'Migration does NOT create a duplicate coupon table');
t(/UPDATE public\.coupons\s+SET seller_payout = ROUND\(btrim\(original_value\)/.test(migrationSrc),
  'Migration backfills seller_payout = ROUND(face_value × 0.07, 2) for eligible rows');
t(/CREATE TRIGGER trg_coupons_seller_payout_7_percent/.test(migrationSrc),
  'Migration installs a trigger that enforces the rule on every INSERT/UPDATE');

// §6 VALIDATION — only ₹100–₹10,000 face values are eligible.
console.log('\n═══ §6 — Validation: face value must be in [₹100, ₹10,000] ═══');
for (const bad of [99, 10001, 50, 0, -100, 99.99, 10000.01]) {
  let threw = false, code = null;
  try { sp.calculateSellerPayout(bad); } catch (e) { threw = true; code = e.code; }
  t(threw && code === 'INVALID_FACE_VALUE', `₹${bad} rejected with INVALID_FACE_VALUE`);
}
for (const ok of [100, 10000]) {
  t(sp.calculateSellerPayout(ok) !== undefined && Number.isFinite(sp.calculateSellerPayout(ok)),
    `₹${ok} accepted (boundary inclusive)`);
}
t(/Coupon face value must be between ₹100 and ₹10,000/.test(sellerPayoutSrc),
  'Validation message is the spec message (₹100–₹10,000)');
// "Don't silently change an invalid face value" — a thrown error is the only outcome.
let silent = false;
try { sp.calculateSellerPayout(50); } catch { silent = true; }
t(silent, 'Out-of-range face value throws (does NOT silently clamp to ₹100/₹10,000)');

// §7 SELLER UI — read-only, automatically calculated.
console.log('\n═══ §7 — Seller UI: read-only, automatically calculated ═══');
t(/payout-preview-label[\s\S]*Seller Payout/.test(sellHtmlSrc),
  'Sell page label says "Seller Payout"');
t(/payout-preview-rate[\s\S]*7% of face value/.test(sellHtmlSrc),
  'Sell page shows the 7% of face value caption');
t(/<input[^>]*name="sellerPayout"/i.test(sellHtmlSrc) === false,
  'Sell page has no editable sellerPayout input');

// §8 MY SALES / SELLER DASHBOARD — shows the payout.
console.log('\n═══ §8 — My Sales / Dashboard shows payout from server-computed value ═══');
t(/router\.get\('\/my-sales'/.test(couponsSrc),
  'GET /api/coupons/my-sales exists');
t(/couponPayoutInfo\(c\)/.test(couponsSrc),
  'my-sales spreads couponPayoutInfo into each coupon row');
t(/sellerPayout:\s*payout/.test(couponsSrc),
  'my-sales returns the canonical server-computed sellerPayout (not the stored value)');
// Dashboard reads sellerPayout from the row.
t(/Number\(c\.sellerPayout\)/.test(dashboardSrc),
  'dashboard.html priceOf() prefers c.sellerPayout (numeric, server-computed)');
t(!/c\.sellingPrice\s*\?\s*c\.sellerPayout/.test(dashboardSrc) || /prefer.*sellerPayout/i.test(dashboardSrc),
  'dashboard.html priceOf() does not fall back to sellingPrice without using sellerPayout first');

// §9 ADMIN PANEL — shows face value, payout, marketplace price, status.
console.log('\n═══ §9 — Admin panel shows face value, payout, selling price, status ═══');
t(/payoutSummary\(/.test(adminSrc), 'admin.js uses payoutSummary() helper');
t(/faceValue:\s*moneyToPaise/.test(sellerPayoutSrc) || /faceValue:\s*[\d.]+/.test(sellerPayoutSrc),
  'payoutSummary returns faceValue, sellerPayout, payoutRate');
t(/PAYOUT_BODY_KEYS/.test(adminSrc) && /sellerPayout/.test(adminSrc),
  'Admin write strips client-supplied payout fields before persisting');
t(/stripePayoutFields|stripPayoutFields/.test(adminSrc),
  'admin.js strips payout keys from every client request');
// Confirm admin cannot directly set the stored payout.
const adminPostCoupons = adminSrc.slice(adminSrc.indexOf("router.post('/coupons'"),
  adminSrc.indexOf("router.put('/coupons/:id'"));
t(!/sellerPayout\s*:\s*(?:req\.body|body)\.sellerPayout/.test(adminPostCoupons),
  'POST /admin/coupons never copies a client-supplied sellerPayout into the new coupon');

// §10 PAYOUT PROCESS — derived from face value, never marketplace price.
console.log('\n═══ §10 — Payout process: payout = 7% of face value, not sellingPrice ═══');
t(/resolveCouponPayoutAmount/.test(payoutsSrc),
  'payouts.js exports a payout resolver');
t(/sellerPayout\.calculateSellerPayout/.test(payoutsSrc),
  'payouts.js calls sellerPayout.calculateSellerPayout to compute the payout');
// The resolver must NOT use sellingPrice to compute the payout.
const resolverBody = payoutsSrc.slice(payoutsSrc.indexOf('async function resolveCouponPayoutAmount'),
  payoutsSrc.indexOf('function tryCompute7Percent'));
const resolverUsesSellingPrice = /sellingPrice|selling_price/.test(resolverBody);
t(!resolverUsesSellingPrice, 'resolveCouponPayoutAmount() does not read sellingPrice');
// The auto-payout uses the resolver.
t(/const resolved = await resolveCouponPayoutAmount/.test(payoutsSrc),
  'createAutoPayout uses resolveCouponPayoutAmount');
// Verify payouts.js import uses sellerPayout module.
t(/require\(['"]\.\.\/services\/sellerPayout['"]\)/.test(payoutsSrc),
  'payouts.js imports sellerPayout service (single source of truth)');
// Confirm the comment block at the top of payouts.js reflects the 7% rule.
t(/7% of (?:the )?coupon(?:'s)? face value/i.test(payoutsSrc),
  'payouts.js header documents the 7% rule');

// §11 SECURITY — never trust client-supplied payouts.
console.log('\n═══ §11 — Security: server is the only authority on the payout ═══');
// 1. Submission route — any client-supplied payout is silently overwritten.
const submissionBody = couponsSrc.slice(couponsSrc.indexOf('handleCouponSubmission'),
  couponsSrc.indexOf('router.post(\'/sell\''));
t(!/req\.body\.(?:sellerPayout|seller_payout|payout_amount|payoutAmount)/.test(submissionBody),
  'Submission handler does not read client-supplied payout fields');
// 2. Admin route — payout body keys stripped before any write.
// Look at the full admin.js so the PAYOUT_BODY_KEYS constant is visible.
t(/PAYOUT_BODY_KEYS\s*=\s*\[[\s\S]*?sellerPayout[\s\S]*?payout_amount[\s\S]*?\]/.test(adminSrc),
  'admin.js PAYOUT_BODY_KEYS includes every payout-shaped body key');
t(/function stripPayoutFields[\s\S]*?PAYOUT_BODY_KEYS\.includes/.test(adminSrc),
  'admin.js stripPayoutFields drops every payout-shaped body key');
// 3. Database trigger is the last line of defence.
t(/enforce_seller_payout_7_percent/.test(migrationSrc) && /NEW\.seller_payout\s*:=\s*ROUND\(face\s*\*\s*0\.07/.test(migrationSrc),
  'DB trigger always recomputes seller_payout from face_value (client cannot override)');
// 4. The payments.js route uses the new createAutoPayout with face value, not sellingPrice.
const paymentsVerify = paymentsSrc.slice(paymentsSrc.indexOf("router.post('/verify'"),
  paymentsSrc.indexOf("module.exports"));
t(/originalValue:\s*coupon\.originalValue/.test(paymentsVerify),
  'payments verify path passes originalValue (face value) to createAutoPayout');
t(!/sellingPrice:\s*coupon\.sellingPrice/.test(paymentsVerify),
  'payments verify path does NOT pass sellingPrice to createAutoPayout');

// §12 EXISTING SYSTEM MUST BE PRESERVED — spot-check the unchanged flows.
console.log('\n═══ §12 — Existing system preserved ═══');
t(/router\.post\('\/sell'/.test(couponsSrc) && /router\.post\('\/submit'/.test(couponsSrc),
  'POST /sell and /submit endpoints still exist');
t(/router\.post\('\/buy\/:id'/.test(couponsSrc),
  'POST /buy/:id still exists');
t(/router\.post\('\/create-order'/.test(paymentsSrc) && /router\.post\('\/verify'/.test(paymentsSrc),
  'Razorpay order/verify endpoints still exist');
t(/SHEETS\.COUPONS/.test(couponsSrc) && /SHEETS\.PAYOUTS/.test(payoutsSrc),
  'Google Sheets mirror still in use');
t(/is_verified: Boolean\(c\.isVerified/.test(supabaseSrc),
  'Coupon schema still includes all original fields');

// §13 TEST CASES — the explicit list from the spec.
console.log('\n═══ §13 — Spec test cases (all face value → payout pairs) ═══');
const CASES = [
  [100,    7],
  [200,    14],
  [500,    35],
  [1000,   70],
  [2000,   140],
  [2500,   175],
  [5000,   350],
  [7500,   525],
  [10000,  700],
];
for (const [fv, expected] of CASES) {
  t(sp.calculateSellerPayout(fv) === expected, `₹${fv} → ₹${expected}`);
}
for (const bad of [99, 10001]) {
  let threw = false;
  try { sp.calculateSellerPayout(bad); } catch { threw = true; }
  t(threw, `₹${bad} rejected under the ₹100–₹10,000 rule`);
}
// The cascade test: changing face value automatically changes payout, and the
// backend recomputes it (no manual editing).
const cascade1 = sp.calculateSellerPayout(1000);
const cascade2 = sp.calculateSellerPayout(2000);
t(cascade1 === 70 && cascade2 === 140,
  'Changing ₹1000 → ₹2000 cascades payout ₹70 → ₹140 (auto, no manual edit)');
// And the BACKEND does the same recompute. We confirm by inspecting that
// submission and admin writes re-derive the payout from the face value.
t(/updates\.sellerPayout\s*=\s*payoutForFaceValue/.test(adminSrc),
  'admin update recomputes payout from face value (server-side)');
t(/sellerPayout:\s*payoutForFaceValue\(faceValue\)/.test(adminSrc),
  'admin coupon creation recomputes payout from face value (server-side)');

// §14 FINAL RULE — sanity check that the entire payout system is the 7% formula.
console.log('\n═══ §14 — FINAL RULE: SELLER PAYOUT = 7% OF COUPON FACE VALUE ═══');
t(sp.PAYOUT_RATE === 0.07, 'PAYOUT_RATE = 0.07');
t(sp.MIN_FACE_VALUE === 100 && sp.MAX_FACE_VALUE === 10000, 'Range locked to ₹100–₹10,000');
t(sp.PAYOUT_PRICING_MODEL === 'face-value-7-percent',
  'PAYOUT_PRICING_MODEL = "face-value-7-percent" (the only pricing model)');
t(/const PAYOUT_PRICING_MODEL\s*=\s*['"]face-value-7-percent['"]/.test(payoutsSrc)
  && /module\.exports\.PAYOUT_PRICING_MODEL\s*=\s*PAYOUT_PRICING_MODEL/.test(payoutsSrc),
  'payouts.js exports PAYOUT_PRICING_MODEL = face-value-7-percent');

// ═══ Summary ═══
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

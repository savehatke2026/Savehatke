// Regression checks for User Dashboard data integrity.
// Run: node server/tests/dashboardDataIntegrity.test.js
// These checks intentionally inspect the real route and page source without
// contacting Sheets, Supabase, Gmail, payment providers, or customer accounts.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const coupons = fs.readFileSync(path.join(root, 'server/routes/coupons.js'), 'utf8');
const payouts = fs.readFileSync(path.join(root, 'server/routes/payouts.js'), 'utf8');
const reviewsRoute = fs.readFileSync(path.join(root, 'server/routes/reviews.js'), 'utf8');
const testimonialsRoute = fs.readFileSync(path.join(root, 'server/routes/testimonials.js'), 'utf8');
const googleSheets = fs.readFileSync(path.join(root, 'server/services/googleSheets.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'public/js/admin.js'), 'utf8');
const vault = fs.readFileSync(path.join(root, 'public/vault.html'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'public/dashboard.html'), 'utf8');
const support = fs.readFileSync(path.join(root, 'public/support.html'), 'utf8');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, 'start marker exists: ' + startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, 'end marker exists: ' + endMarker);
  return source.slice(start, end);
}

function check(name, fn) {
  fn();
  console.log('PASS ' + name);
}

function assertCssBalanced(css) {
  let state = 0; // 0 = normal, 1 = comment, 2 = single-quoted string, 3 = double-quoted string
  let depth = 0;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    const next = css[i + 1];
    if (state === 0) {
      if (ch === '/' && next === '*') { state = 1; i += 1; continue; }
      if (ch.charCodeAt(0) === 39) { state = 2; continue; }
      if (ch.charCodeAt(0) === 34) { state = 3; continue; }
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        assert.ok(depth >= 0, 'CSS contains a closing brace without an opening brace.');
      }
    } else if (state === 1) {
      if (ch === '*' && next === '/') { state = 0; i += 1; }
    } else if (state === 2) {
      if (ch.charCodeAt(0) === 92) i += 1;
      else if (ch.charCodeAt(0) === 39) state = 0;
    } else if (state === 3) {
      if (ch.charCodeAt(0) === 92) i += 1;
      else if (ch.charCodeAt(0) === 34) state = 0;
    }
  }
  assert.equal(state, 0, 'CSS comment or string is not closed.');
  assert.equal(depth, 0, 'CSS contains an unclosed rule or media-query brace.');
}

check('My Purchases uses the matching paid order amount when available', () => {
  const route = between(
    coupons,
    "router.get('/my-purchases'",
    "router.get('/sell-eligibility'"
  );
  assert.match(route, /pricePaid:\s*purchase\s*\?\s*Number\(ord\.amount\)\s*:\s*c\.sellingPrice/);
  assert.match(route, /paymentStore\.moneyEquals\(payment\.amount, order\.amount\)/);
});

check('Dashboard seller earnings preserve two decimal places', () => {
  assert.match(dashboard, /return Math\.round\(serverPayout \* 100\) \/ 100;/);
});

check('Overview stats do not show false zeroes before a successful load', () => {
  assert.match(dashboard, /setText\('statPurchased', STATE\.purchasesLoaded \? totalPurchased : '—'\);/);
  assert.match(dashboard, /setText\('statSold', STATE\.salesLoaded \? soldCount : '—'\);/);
});

check('Purchase request failure cannot be converted into a successful empty list', () => {
  const loader = between(dashboard, 'async function loadMyPurchases()', 'async function loadMyReviews()');
  assert.doesNotMatch(loader, /catch\s*\([^)]*\)\s*\{[\s\S]*?return\s+\[\s*\]/);
  assert.match(dashboard, /STATE\.purchasesLoadError\s*=\s*err\.message/);
  assert.match(dashboard, /if \(STATE\.purchasesLoadError\) \{\s*if \(!STATE\.purchasesLoaded\) container\.innerHTML = dashboardLoadErrorMarkup\('your purchases'\)/);
  assert.match(dashboard, /return STATE\.purchases;/);
});

check('Sales request failure cannot be converted into a successful empty list', () => {
  const loader = between(dashboard, 'async function loadMySales()', 'async function loadMyPurchases()');
  assert.doesNotMatch(loader, /catch\s*\([^)]*\)\s*\{[\s\S]*?return\s+\[\s*\]/);
  assert.match(dashboard, /STATE\.salesLoadError\s*=\s*err\.message/);
  assert.match(dashboard, /if \(STATE\.salesLoadError\) \{\s*if \(!STATE\.salesLoaded\) container\.innerHTML = dashboardLoadErrorMarkup\('your listings'\)/);
  assert.match(dashboard, /return STATE\.sales;/);
});

check('Reviews, support, payouts and refunds errors preserve old data', () => {
  assert.match(dashboard, /STATE\.reviewsLoadError\s*=\s*err\.message/);
  assert.match(dashboard, /STATE\.ticketsLoadError\s*=\s*err\.message/);
  assert.match(dashboard, /STATE\.payoutsLoadError\s*=\s*err\.message/);
  assert.match(dashboard, /STATE\.refundsLoadError\s*=\s*err\.message/);
  assert.match(dashboard, /return STATE\.tickets;/);
  assert.match(dashboard, /return STATE\.reviews;/);
  assert.match(dashboard, /return \{ payouts: STATE\.payouts, summary: STATE\.payoutsSummary \};/);
  assert.match(dashboard, /return \{ refunds: STATE\.refunds, summary: STATE\.refundsSummary \};/);
});
check('Dependent views show retry UI on first-load failures', () => {
  for (const section of ['support cases','payouts','transactions','activity','your reviews','refunds']) {
    assert.ok(dashboard.includes(`dashboardLoadErrorMarkup('${section}')`), section);
  }
});
check('Dashboard page-level views are hidden in the initial HTML', () => {
  const views = [...dashboard.matchAll(/<div id="(view-[^"]+)" class="db-view([^"]*)"([^>]*)>/g)];
  assert.equal(views.length, 10, 'all ten dashboard views must be present');
  const initialActive = views.filter((m) => /\bactive\b/.test(m[2]));
  assert.deepEqual(initialActive.map((m) => m[1]), ['view-dashboard']);
  for (const view of views.filter((m) => m[1] !== 'view-dashboard')) {
    assert.match(view[3], /\bhidden\b/, view[1] + ' must start hidden');
  }
});

check('Dashboard navigation keeps views mutually exclusive', () => {
  assert.match(dashboard, /#pageWrapper \.db-view:not\(\.active\)[\s\S]{0,100}display:\s*none\s*!important/);
  assert.match(dashboard, /v\.hidden = true/);
  assert.match(dashboard, /view\.hidden = false/);
  assert.match(dashboard, /view\.classList\.add\('active'\)/);
});

check('Dashboard stylesheet is balanced and visibility rules are not trapped in mobile CSS', () => {
  const firstStyle = dashboard.match(/<style>([\s\S]*?)<\/style>/i);
  assert.ok(firstStyle, 'main dashboard stylesheet exists');
  const css = firstStyle[1];
  assertCssBalanced(css);
  assert.ok(
    css.includes('.sec-posture{flex-wrap:wrap;gap:12px}\n    }\n    .sec-status{'),
    'the 520px media query must close before the following security styles and view-visibility rules'
  );
  assert.ok(css.indexOf('.db-view{display:none}') > css.indexOf('.sec-status{'), 'view visibility rules remain after the closed media section');
});

check('Wallet balance uses the server-calculated available amount', () => {
  const stats = between(dashboard, 'function renderStats()', '// ─── My-Coupons reskin');
  assert.match(stats, /STATE\.payoutsSummary\s*&&\s*STATE\.payoutsSummary\.available/);
  assert.match(stats, /setText\('statBalance', STATE\.payoutsLoaded \? inr\(availableBalance\) : '—'\);/);
  assert.doesNotMatch(stats, /const availableBalance = totalEarnings/);
});

check('Recent Activity uses seller payout instead of coupon selling price', () => {
  const activity = between(dashboard, 'function renderActivity()', '// ─── Help & Support');
  assert.match(activity, /const sellerPayout = c\.sellerPayout/);
  assert.match(activity, /Number\.isFinite\(sellerPayout\)/);
  assert.doesNotMatch(activity, /amount: c\.sellingPrice/);
});

check('Refunds and Transactions share a single authoritative snapshot', () => {
  assert.match(dashboard, /function renderRefundsSnapshot\(refunds, summary/);
  assert.match(dashboard, /STATE\.refunds = Array\.isArray\(refunds\) \? refunds : \[\]/);
  assert.match(dashboard, /STATE\.refundsSummary = summary/);
  assert.match(dashboard, /_allRefunds = records/);
  assert.match(dashboard, /function fetchRefundsSnapshot\(\)/);
  assert.match(dashboard, /Date\.now\(\) - STATE\.refundsLoadedAt < 20000/);
});

check('Transactions display available sources when one ledger source fails', () => {
  const renderer = between(dashboard, 'function renderTransactions()', 'function renderPayouts()');
  assert.match(renderer, /const loadedSources = sources\.filter\(\(source\) => source\.loaded\)/);
  assert.match(renderer, /Available records are still shown/);
  assert.doesNotMatch(renderer, /if \(initialSourceError\)\s*\{/);
  const builder = between(dashboard, 'function buildTransactions()', '// Strip currency/formatting');
  assert.match(builder, /if \(STATE\.purchasesLoaded\) \(STATE\.purchases \|\| \[\]\)\.forEach/);
  assert.match(builder, /if \(STATE\.refundsLoaded\) \(STATE\.refunds \|\| \[\]\)\.forEach/);
  assert.match(builder, /if \(STATE\.payoutsLoaded\) \(STATE\.payouts \|\| \[\]\)\.forEach/);
});

check('Transaction totals are tied to the matching data source', () => {
  const stats = between(dashboard, 'function renderTxStats()', 'function renderTransactions()');
  assert.match(stats, /STATE\.purchasesLoaded \? inr\(totalSpend\) : '—'/);
  assert.match(stats, /STATE\.payoutsLoaded \? inr\(totalPayout\) : '—'/);
  assert.match(stats, /STATE\.refundsLoaded \? inr\(totalRefund\) : '—'/);
});

check('Transactions fetches its data sources when the page opens', () => {
  assert.match(dashboard, /function refreshTransactionsData\(\{ silent = true \} = \{\}\)/);
  assert.match(dashboard, /refreshTransactionsData\(\{ silent: true \}\)/);
  assert.match(dashboard, /onclick="refreshTransactionsData\(\{silent:false\}\)"/);
  assert.match(dashboard, /shareDashboardSource\('purchases'/);
  assert.match(dashboard, /shareDashboardSource\('payouts'/);
});

check('Transactions preserve visible rows when an individual source fails', () => {
  const renderer = between(dashboard, 'function renderTransactions()', 'function renderPayouts()');
  assert.match(renderer, /const failedSources = sources\.filter\(\(source\) => source\.error\)/);
  assert.match(renderer, /Available records are still shown/);
});

check('Submitted buyer reviews appear in the admin Homepage Testimonials queue', () => {
  assert.match(reviewsRoute, /router\.get\('\/admin-submissions', authenticateToken, requireAdmin/);
  assert.match(reviewsRoute, /buyerName: String\(req\.user\.name/);
  assert.match(googleSheets, /'buyerName'/);
  assert.match(adminJs, /api\('\/reviews\/admin-submissions', \{ useAdmin: true \}\)/);
  assert.match(vault, /id="buyerReviewSubmissions"/);
  assert.match(vault, /loadHomepageTestimonialsWorkspace\(\)/);
});

check('Buyer review promotion creates an unpublished testimonial draft only once', () => {
  assert.match(testimonialsRoute, /router\.post\('\/from-review\/:reviewId', authenticateToken, requireAdmin/);
  assert.match(testimonialsRoute, /sourceReviewId/);
  assert.match(testimonialsRoute, /isVisible: 'false'/);
  assert.match(testimonialsRoute, /This buyer review has already been added/);
  assert.match(testimonialsRoute, /sortOrder, sourceReviewId, \.\.\.card/);
});

check('Admin review queue does not return customer email addresses', () => {
  const queue = reviewsRoute.slice(reviewsRoute.indexOf("router.get('/admin-submissions'"), reviewsRoute.indexOf("router.get('/my'"));
  assert.doesNotMatch(queue, /buyerEmail:\s*row\.buyerEmail/);
  assert.match(vault, /Submitted Buyer Reviews/);
});

check('Payment method box reflects saved state and exposes Edit', () => {
  assert.match(dashboard, /id="paymentMethodStatusBox"/);
  assert.match(dashboard, /id="paymentMethodStatusTitle"/);
  assert.match(dashboard, /Payment Method Added/);
  assert.match(dashboard, /'Edit', 'btn-ghost', \(\) => openPayoutDetailsModal\(\)/);
  assert.match(dashboard, /editing \? 'Edit Payment Method' : 'Add Payment Method'/);
  assert.match(dashboard, /editing \? 'Save Changes' : 'Save'/);
  assert.match(dashboard, /payoutDetailsPromise/);
});

check('Support form width is reduced and remains responsive', () => {
  assert.match(support, /\.support-grid\s*\{[\s\S]{0,250}max-width:560px;/);
  assert.match(support, /width:100%;/);
});

check('Payout history remains available if balance calculation fails', () => {
  const route = between(payouts, "router.get('/payouts/my'", "router.get('/payouts/coupon-status'");
  assert.match(route, /try\s*\{\s*balance = await calculateSellerPayoutBalance/);
  assert.match(route, /catch \(balanceErr\)/);
  assert.match(route, /available: balance \? balance\.available : null/);
  assert.match(route, /res\.json\(\{ payouts: mine\.map\(sanitizeForSeller\), summary \}\)/);
  assert.doesNotMatch(route, /balance = await calculateSellerPayoutBalance[\s\S]*?\n\s*\} catch \(err\)/);
});

check('Purchase IDs join to the owning PAID order without a payment-row user-ID false negative', () => {
  const route = between(coupons, "router.get('/my-purchases'", "router.get('/sell-eligibility'");
  assert.match(route, /if \(rowUserId && userId && rowUserId === userId\) return true/);
  assert.match(route, /!payment\.couponId\) continue/);
  assert.doesNotMatch(route, /!payment\.couponId \|\| !belongsToCurrentUser\(row\)/);
  assert.match(route, /orderCode: ord\.order_code \|\| \(purchase && purchase\.order\.orderCode\)/);
  assert.match(route, /transactionId: ord\.transaction_id \|\|\s*\(purchase && purchase\.order\.transactionId\)/);
});

check('Dashboard and Support pages have no site footer', () => {
  assert.doesNotMatch(dashboard, /<footer class="footer"/);
  assert.doesNotMatch(support, /<footer class="footer"/);
  assert.doesNotMatch(dashboard, /js\/site-footer\.js/);
  assert.doesNotMatch(support, /js\/site-footer\.js/);
});

check('Support form width stays responsive and is reduced to 560px', () => {
  assert.match(support, /\.support-grid\s*\{[\s\S]{0,250}max-width:560px;/);
  assert.match(support, /width:100%;/);
});

console.log('\nDashboard data integrity regression checks passed.');

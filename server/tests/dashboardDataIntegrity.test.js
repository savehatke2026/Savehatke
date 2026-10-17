// Regression checks for User Dashboard data integrity.
// Run: node server/tests/dashboardDataIntegrity.test.js
// These checks intentionally inspect the real route and page source without
// contacting Sheets, Supabase, Gmail, payment providers, or customer accounts.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const coupons = fs.readFileSync(path.join(root, 'server/routes/coupons.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'public/dashboard.html'), 'utf8');

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

console.log('\nDashboard data integrity regression checks passed.');

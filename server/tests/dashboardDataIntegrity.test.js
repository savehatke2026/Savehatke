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

console.log('\nDashboard data integrity regression checks passed.');

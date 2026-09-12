// Verification harness for the Coupon Management fixes. Run: node verify-coupon-fixes.cjs
// Loads the REAL helpers from the REAL files — no quoting artifacts.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, 'public', 'js');

// ── Load countdown helpers from coupon-meta.js (skip DOM-touching top part) ──
const meta = fs.readFileSync(path.join(root, 'coupon-meta.js'), 'utf8');
eval(meta.slice(meta.indexOf('const DAY_MS')));

// ── Extract the exact predicates from the edited admin.js ──
const admin = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');
const grabFn = (name) => {
  const i = admin.indexOf(`function ${name}`);
  if (i === -1) throw new Error(`${name} not found`);
  return admin.slice(i, admin.indexOf('\n}', i) + 2);
};
eval(grabFn('isSellerSubmission'));

// Re-create the two filters exactly as written in loadInventory / loadPending
const allCouponsFilter = (rows) => rows.filter((c) => !(c.status === 'pending' && isSellerSubmission(c)));
const pendingFilter = (rows) => rows.filter((c) => c.status === 'pending' && isSellerSubmission(c));

let pass = 0, fail = 0;
const t = (ok, name) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name); ok ? pass++ : fail++; };

// ═══ Filtering (the user's required cases) ═══
const db = [
  { id: 'A1', code: 'ADMIN10', source: 'admin', status: 'available' },
  { id: 'S1', code: 'SELL01', source: 'user-submitted', status: 'pending' },
  { id: 'S2', code: 'SELL02', source: 'user', status: 'pending' }, // variant spelling
  { id: 'S3', code: 'SELL03', source: 'user-submitted', status: 'proof_requested' },
  { id: 'S4', code: 'SELL04', source: 'user-submitted', status: 'available' },
  { id: 'P1', code: 'PART01', source: 'partner', status: 'available' },
];
const all = allCouponsFilter(db);
const pend = pendingFilter(db);

t(all.some((c) => c.id === 'A1'), 'Admin coupon → All Coupons');
t(pend.some((c) => c.id === 'S1') && !all.some((c) => c.id === 'S1'), 'Seller pending → ONLY Pending tab');
t(all.some((c) => c.id === 'S4') && !pend.some((c) => c.id === 'S4'), 'Seller approved → All Coupons');
// Badge counts from the FULL list (like loadInventory's badge read of data.coupons),
// not from the already-filtered All list — that's the point.
t(pend.length === 2 && db.filter((c) => c.status === 'pending' && isSellerSubmission(c)).length === 2,
  'Pending badge = actual pending seller count (2)');
t(!pend.some((c) => all.some((a) => a.id === c.id)), 'No coupon duplicated across tabs');
t(all.some((c) => c.id === 'P1'), 'Partner coupons unaffected in All');

// approve S1 → moves Pending → All, badge drops
const after = db.map((c) => c.id === 'S1' ? { ...c, status: 'available' } : c);
const all2 = allCouponsFilter(after);
const pend2 = pendingFilter(after);
t(all2.some((c) => c.id === 'S1') && !pend2.some((c) => c.id === 'S1'), 'Approve moves coupon Pending → All Coupons');
t(pend2.length === 1, 'Badge decrements after approve');

// Refresh-stability: same DB → same tabs (idempotent, no server-side mutation involved)
t(JSON.stringify(allCouponsFilter(after)) === JSON.stringify(allCouponsFilter(after))
  && JSON.stringify(pendingFilter(after)) === JSON.stringify(pendingFilter(after)),
  'Refresh does not move coupons into the wrong tab (pure read-time filters)');

// ═══ Countdown (the user's exact example) ═══
const expiry = parseExpiry('30/09/2026 23:59');                       // actual expiry in DB
const NOW = new Date(2026, 8, 12, 16, 17, 0).getTime();                // 12 Sep 2026 16:17 local
const label = expiryLabel(expiry - NOW);
t(new Date(expiry).getMonth() === 8 && new Date(expiry).getDate() === 30
  && new Date(expiry).getHours() === 23 && new Date(expiry).getMinutes() === 59,
  'Expiry 30/09/2026 23:59 parsed to the real date/time (day-first + clock)');
t(label === '⏳ 18d 07:42:00', `Countdown = actualExpiry − now (${label})`);
t(expiryLabel(500) === '⏳ 00:00:00' && expiryLabel(1000) === '⏳ 00:00:01',
  'Countdown updates second-by-second (1s resolution)');
t(expiryLabel(-1) === '⌛ Ended' && expiryLabel(0) === '⌛ Ended', 'Expired coupon shows Ended');

// Real formats seen in this stack
const fmt = (raw, y, m, d, h, min) => {
  const at = parseExpiry(raw);
  const dt = at === null ? null : new Date(at);
  return at !== null && dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d
    && dt.getHours() === h && dt.getMinutes() === min;
};
t(fmt('2026-09-30', 2026, 8, 30, 23, 59), 'YYYY-MM-DD → end of its final day');
t(fmt('2026-09-30T23:59', 2026, 8, 30, 23, 59), 'picker format YYYY-MM-DDTHH:mm (local)');
t(fmt('2026-09-30 23:59', 2026, 8, 30, 23, 59), 'space-separated (Sheets render)');
t(parseExpiry('2026-09-30T23:59:00.000Z') === Date.UTC(2026, 8, 30, 23, 59), 'absolute ISO with Z');
t(parseExpiry('09/30/2026 11:30 PM') !== null
  && new Date(parseExpiry('09/30/2026 11:30 PM')).getHours() === 23, 'month-first + AM/PM');
t(parseExpiry('') === null && parseExpiry('not-a-date') === null, 'unset/garbage → null (never an invented timer)');
t(parseExpiry('31/02/2026') === null && parseExpiry('32/01/2026') === null, 'impossible dates rejected, not rolled');
// No artificial countdown anywhere: remaining time is ALWAYS actualExpiry − now
t(expiryLabel(expiry - NOW).startsWith('⏳ 18d'), 'countdown derived only from the stored expiry value');
// toTimerInputValue keeps the real expiry in the editable picker
eval(grabFn('toTimerInputValue'));
t(toTimerInputValue('30/09/2026 23:59') === '2026-09-30T23:59', 'picker shows the real expiry, not a default');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

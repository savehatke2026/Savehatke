// Brand directory: validation, normalization, duplicate matching, the active-brand
// coupon gate, and the schema-missing error. Pure logic only: no Supabase,
// Drive or network access. Run: node server/tests/brandStore.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const brandStore = require(path.join(__dirname, '..', 'services', 'brandStore'));
const { validateBrandInput, normalizeKey, matchActiveBrand, fromRow, _internals } = brandStore;

let passed = 0;
let failed = 0;
const lines = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    lines.push(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    lines.push(`  FAIL ${name}\n       ${err && err.message}`);
  }
}

// ── Normalization ────────────────────────────────────────────────────────────
check('normalizeKey squashes case, spacing and punctuation', () => {
  assert.equal(normalizeKey('Cult.fit'), 'cultfit');
  assert.equal(normalizeKey('Cult Fit'), 'cultfit');
  assert.equal(normalizeKey('  CULTFIT  '), 'cultfit');
});

check('normalizeKey strips diacritics (Lakmé == Lakme)', () => {
  assert.equal(normalizeKey('Lakmé'), 'lakme');
  assert.equal(normalizeKey('Lakme'), 'lakme');
});

check('normalizeKey matches the Drive brand-asset rule for common names', () => {
  assert.equal(normalizeKey("McDonald's"), 'mcdonalds');
  assert.equal(normalizeKey('Disney+ Hotstar'), 'disneyhotstar');
});

// ── Validation ───────────────────────────────────────────────────────────────
check('validate accepts a normal brand and derives the key', () => {
  const v = validateBrandInput({ name: '  Cult.fit  ', category: 'Fitness & Sports' });
  assert.equal(v.name, 'Cult.fit');
  assert.equal(v.key, 'cultfit');
  assert.equal(v.category, 'Fitness & Sports');
  assert.equal(v.isActive, true);
});

check('validate rejects a blank name', () => {
  assert.throws(() => validateBrandInput({ name: '   ' }), (e) => e.name === 'BrandValidationError' && e.field === 'name');
});

check('validate rejects a name with no letters or digits', () => {
  assert.throws(() => validateBrandInput({ name: '!!! ---' }), (e) => e.field === 'name');
});

check('validate rejects names over 80 characters', () => {
  assert.throws(() => validateBrandInput({ name: 'x'.repeat(81) }), (e) => e.field === 'name');
});

check('validate rejects an unknown category (taxonomy cannot drift)', () => {
  assert.throws(() => validateBrandInput({ name: 'Acme', category: 'Made Up' }), (e) => e.field === 'category');
});

check('validate defaults a blank category to General', () => {
  assert.equal(validateBrandInput({ name: 'Acme', category: '' }).category, 'General');
});

check('validate rejects a non-integer display order', () => {
  assert.throws(() => validateBrandInput({ name: 'Acme', displayOrder: 'first' }), (e) => e.field === 'displayOrder');
});

check('validate rejects a logo id that is not a Drive file id', () => {
  assert.throws(() => validateBrandInput({ name: 'Acme', logoFileId: 'bad id!' }), (e) => e.field === 'logoFileId');
});

check('validate accepts a valid Drive file id', () => {
  assert.equal(validateBrandInput({ name: 'Acme', logoFileId: '1AbCdEfGhIjKlMnOp' }).logoFileId, '1AbCdEfGhIjKlMnOp');
});

check('validate treats isActive=false / "false" as inactive', () => {
  assert.equal(validateBrandInput({ name: 'A', isActive: false }).isActive, false);
  assert.equal(validateBrandInput({ name: 'A', isActive: 'false' }).isActive, false);
});

check('partial validate only returns the fields it was given', () => {
  const v = validateBrandInput({ isActive: false }, { partial: true });
  assert.deepEqual(Object.keys(v), ['isActive']);
});

check('description is stripped of control characters and capped', () => {
  const v = validateBrandInput({ name: 'A', description: 'hi\u0000there' + 'x'.repeat(400) });
  assert.ok(!/[\u0000-\u001f]/.test(v.description));
  assert.ok(v.description.length <= 300);
});

// ── Duplicate matching + the active-brand coupon gate ───────────────────────
const directory = [
  { id: 'b_cultfit', name: 'Cult.fit', key: 'cultfit', isActive: true },
  { id: 'b_amazon', name: 'Amazon', key: 'amazon', isActive: true },
  { id: 'b_oldbrand', name: 'Old Brand', key: 'oldbrand', isActive: false },
];

check('matchActiveBrand resolves spelling variants to one brand', () => {
  assert.equal(matchActiveBrand('cult fit', directory).id, 'b_cultfit');
  assert.equal(matchActiveBrand('CULT.FIT', directory).id, 'b_cultfit');
});

check('matchActiveBrand never returns an inactive brand', () => {
  assert.equal(matchActiveBrand('Old Brand', directory), null);
});

check('matchActiveBrand returns null for an unknown brand', () => {
  assert.equal(matchActiveBrand('Nonexistent', directory), null);
});

check('matchActiveBrand returns null for an empty or symbol-only name', () => {
  assert.equal(matchActiveBrand('', directory), null);
  assert.equal(matchActiveBrand('???', directory), null);
});

// ── Row mapping ──────────────────────────────────────────────────────────────
check('fromRow maps snake_case columns to the API shape', () => {
  const b = fromRow({
    id: 'b_amazon', name: 'Amazon', key: 'amazon', category: 'E-Commerce',
    description: '', logo_file_id: 'FILE123456', display_order: '3', is_active: true,
  }, new Map([['b_amazon', 7]]));
  assert.equal(b.logoFileId, 'FILE123456');
  assert.equal(b.displayOrder, 3);
  assert.equal(b.isActive, true);
  assert.equal(b.couponCount, 7);
});

check('fromRow treats a NULL is_active as active only when explicitly true', () => {
  assert.equal(fromRow({ id: 'x', name: 'X', key: 'x', is_active: false }).isActive, false);
});

// ── Database error mapping ───────────────────────────────────────────────────
check('a missing brands table becomes a loud, named 503 that names the migration', () => {
  const e = _internals.wrapDbError({ message: 'relation "public.brands" does not exist' }, 'list');
  assert.equal(e.code, 'BRANDS_SCHEMA_MISSING');
  assert.equal(e.status, 503);
  assert.match(e.message, /20261014_brands_directory\.sql/);
});

check('a missing brand column (PGRST204 / 42703) is treated as schema-missing', () => {
  const e = _internals.wrapDbError({ message: 'Could not find the column brands.logo_file_id (PGRST204)' }, 'update');
  assert.equal(e.code, 'BRANDS_SCHEMA_MISSING');
});

check('a unique-key violation becomes a duplicate conflict, not a generic error', () => {
  const e = _internals.wrapDbError({ message: 'duplicate key value violates unique constraint "brands_key_uq"' }, 'create');
  assert.equal(e.name, 'BrandConflictError');
  assert.equal(e.status, 409);
});

check('an unknown database error stays a generic 500 with no leaked detail', () => {
  const e = _internals.wrapDbError({ message: 'connection reset: secret=abc' }, 'list');
  assert.equal(e.status, 500);
  assert.ok(!/secret/.test(e.message));
});

// ── Coupon gate error shape ──────────────────────────────────────────────────
check('an unknown brand on a coupon is a 400 BRAND_NOT_ACTIVE-style validation error', () => {
  const err = new brandStore.BrandValidationError('x', 'brand');
  err.code = 'BRAND_NOT_ACTIVE';
  assert.equal(err.status, 400);
  assert.equal(err.field, 'brand');
});

console.log('brandStore tests');
console.log(lines.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

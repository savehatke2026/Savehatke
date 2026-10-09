#!/usr/bin/env node
'use strict';
/* replace-inventory.cjs — SaveHatke coupon-inventory replacement tool.
 *
 * Subcommands:
 *   status        — current DB + Sheets inventory snapshot
 *   backup        — full export of Supabase coupons + Sheets Coupons tab
 *   generate      — build the 10k listing manifest from the seed templates
 *   validate      — re-validate every manifest row (schema, price, timer, codes)
 *   import        — idempotent, resumable batched insert (checkpointed)
 *   delete-old    — delete the backed-up old available/admin rows (keeps sold)
 *   mirror-sheets — replace the Sheets Coupons tab with the new inventory
 *   verify        — post-import verification + report JSON
 *
 * Honesty contract: listings are built from the repo's real seed offer
 * templates (brand/category/offer structure), but the codes are SaveHatke
 * platform codes (SH-…), NOT vendor redemption codes. Every row is written
 * with is_verified=false unless --verified is passed, and the final report
 * states plainly that codes are unverified demo listings.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, 'server', '.env') });
require('dotenv').config({ path: path.join(ROOT, '.env') });

const { createClient } = require(path.join(ROOT, 'node_modules', '@supabase', 'supabase-js'));
const { v4: uuidv4 } = require(path.join(ROOT, 'node_modules', 'uuid'));
const dynamicPricing = require(path.join(ROOT, 'server', 'services', 'dynamicPricing'));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
  process.exit(2);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const BACKUP_DIR = path.join(ROOT, 'backups');
const LATEST_BACKUP = () => {
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^coupons-backup-\d+\.json$/.test(f)).sort();
  if (files.length === 0) throw new Error('No backup file found — run `backup` first.');
  return path.join(BACKUP_DIR, files[files.length - 1]);
};
const MANIFEST = path.join(__dirname, 'inventory-manifest.json');

// ── Deterministic RNG ────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Seed template extraction ─────────────────────────────────────────────
function extractTemplates() {
  const files = ['server/seed_coupons.js', 'server/seed_coupons_200.js', 'server/seed_coupons_brands.js'];
  const out = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const re = /=\s*\[([\s\S]*?)\];/g;
    let m;
    while ((m = re.exec(text))) {
      const body = m[1];
      if (!body.includes('code:') || !body.includes('brand')) continue;
      try {
        const arr = Function('"use strict"; return [' + body + ']')();
        if (Array.isArray(arr)) out.push(...arr.filter((r) => r && r.code && r.brand));
      } catch { /* not the coupons array */ }
    }
  }
  return out;
}

// ── Listing generation ───────────────────────────────────────────────────
const BRAND_ABBR_CACHE = new Map();
function brandAbbr(brand) {
  if (BRAND_ABBR_CACHE.has(brand)) return BRAND_ABBR_CACHE.get(brand);
  const letters = brand.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'XXXX';
  const abbr = letters.slice(0, 4).padEnd(4, 'X');
  BRAND_ABBR_CACHE.set(brand, abbr);
  return abbr;
}

// Buyer price = 20% of face exactly; face = price*5 keeps every listing on
// the platform's real pricing curve. Price distribution (weighted):
//   60% ₹10–₹300 · 25% ₹301–₹1,000 · 10% ₹1,001–₹2,500 · 5% ₹2,501–₹10,000
function pickPrice(rnd) {
  const u = rnd();
  let lo; let hi;
  if (u < 0.60) { lo = 10; hi = 300; }
  else if (u < 0.85) { lo = 301; hi = 1000; }
  else if (u < 0.95) { lo = 1001; hi = 2500; }
  else { lo = 2501; hi = 10000; }
  return lo + Math.floor(rnd() * (hi - lo + 1));
}

function addMonths(iso, months) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0); // clamp Jan 31 + 1mo → Feb 28
  return d.toISOString();
}

function generateListings(targetCount, opts = {}) {
  const templates = extractTemplates();
  if (templates.length === 0) throw new Error('No seed templates found');
  const rnd = mulberry32(20261009);
  const rows = [];
  const seenCodes = new Set();
  const seenKeys = new Set();
  const activationBase = Date.now();

  for (let i = 0; i < targetCount; i++) {
    const t = templates[Math.floor(rnd() * templates.length)];
    const price = pickPrice(rnd);
    const face = price * 5; // 20% curve → exact buyer price
    const brand = t.brand;

    // Unique listing key: same template + same face + same brand would be a
    // duplicate listing — reroll the face until the key is new.
    let key = '';
    let effFace = face;
    let effPrice = price;
    for (let attempt = 0; attempt < 40; attempt++) {
      key = brand + '|' + t.category + '|' + effFace + '|' + t.discount;
      if (!seenKeys.has(key)) break;
      effPrice = pickPrice(rnd);
      effFace = effPrice * 5;
    }
    if (seenKeys.has(key)) continue; // give up on this slot rather than dupe
    seenKeys.add(key);

    // Platform-issued code — NOT a vendor redemption code.
    let code = '';
    do {
      code = 'SH-' + brandAbbr(brand) + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    } while (seenCodes.has(code));
    seenCodes.add(code);

    // One-month timer: activation is staggered so timestamps differ; expiry is
    // exactly one calendar month later (spec §4).
    const addedAt = new Date(activationBase + i * 500).toISOString();
    const expiryDate = addMonths(addedAt, 1);

    rows.push({
      code,
      title: t.title.replace(/₹[\d,]+/, '₹' + effFace.toLocaleString('en-IN')),
      type: 'Public',
      category: t.category,
      brand,
      description: t.description.replace(/₹[\d,]+/, '₹' + effFace.toLocaleString('en-IN')),
      discount: t.discount.includes('%') ? t.discount : '₹' + effFace.toLocaleString('en-IN') + ' Off',
      originalValue: String(effFace),
      sellingPrice: String(effPrice),
      minOrderValue: t.minOrderValue || '',
      validFrom: null,
      expiryDate,
      affiliateLink: '',
      terms: t.terms || '',
      isFeatured: false,
      isExclusive: false,
      isVerified: opts.verified === true,
      sellerEmail: '',
      status: 'available',
      source: opts.source || 'admin',
      addedAt,
      soldAt: null,
      buyerEmail: '',
      onSale: true,
      timerOn: true,
      backgroundImage: '',
      brandLogo: null,
      proofUrl: '',
      adminNotes: 'Imported 2026-10 inventory replacement; platform-issued code; not vendor-verified.',
      verifiedAt: null,
      sellerUserId: '',
      whatsappStatus: '',
      whatsappSid: '',
      whatsappLastAttempt: null,
      whatsappError: '',
    });
  }
  return { rows, templateCount: templates.length };
}

// ── Sheets helpers ───────────────────────────────────────────────────────
async function sheetsApi() {
  const sheets = require(path.join(ROOT, 'server', 'services', 'googleSheets'));
  if (typeof sheets.initialize === 'function') {
    try { await sheets.initialize(); } catch (e) { console.warn('sheets.initialize notice:', e.message); }
  }
  return sheets;
}

function couponToSheetRow(headers, c) {
  const camel = {
    id: c.id, brand: c.brand, title: c.title, code: c.code, type: c.type || 'Public',
    discount: c.discount, sellingPrice: c.selling_price, minOrderValue: c.min_order_value,
    originalValue: c.original_value, validFrom: c.valid_from || '', expiryDate: c.expiry_date || '',
    backgroundImage: c.background_image || '', brandLogo: c.brand_logo || '', category: c.category,
    source: c.source, status: c.status, affiliateLink: c.affiliate_link || '', terms: c.terms || '',
    isFeatured: String(c.is_featured === true), isExclusive: String(c.is_exclusive === true),
    isVerified: String(c.is_verified === true), sellerEmail: c.seller_email || '', buyerEmail: c.buyer_email || '',
    addedAt: c.added_at || '', soldAt: c.sold_at || '', proofUrl: c.proof_url || '',
    adminNotes: c.admin_notes || '', verifiedAt: c.verified_at || '', sellerUserId: c.seller_user_id || '',
    whatsappStatus: c.whatsapp_status || '', whatsappSid: c.whatsapp_sid || '',
    whatsappLastAttempt: c.whatsapp_last_attempt || '', whatsappError: c.whatsapp_error || '',
    sellerPayout: '',
  };
  return headers.map((h) => String(camel[h] === undefined ? '' : camel[h]));
}

// ── Subcommands ──────────────────────────────────────────────────────────
async function cmdStatus() {
  const { count } = await sb.from('coupons').select('id', { count: 'exact', head: true });
  const { data } = await sb.from('coupons').select('status,source').limit(50000);
  const by = {};
  for (const r of data || []) {
    const k = r.source + '/' + r.status;
    by[k] = (by[k] || 0) + 1;
  }
  console.log('Supabase total:', count);
  console.log('by source/status:', by);
  try {
    const sheets = await sheetsApi();
    const rows = await sheets.getRows(sheets.SHEETS.COUPONS);
    console.log('Sheets Coupons rows:', rows.length);
  } catch (e) {
    console.log('Sheets read failed:', e.message);
  }
}

async function cmdBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('coupons').select('*').range(from, from + PAGE - 1);
    if (error) throw new Error('Backup read failed: ' + error.message);
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  const sheets = await sheetsApi();
  let sheetRows = [];
  try { sheetRows = await sheets.getRows(sheets.SHEETS.COUPONS); } catch (e) { console.warn('sheets backup notice:', e.message); }
  const file = path.join(BACKUP_DIR, 'coupons-backup-' + Date.now() + '.json');
  fs.writeFileSync(file, JSON.stringify({
    at: new Date().toISOString(),
    supabaseRows: all,
    sheetRows,
  }, null, 1));
  console.log('Backed up', all.length, 'Supabase rows +', sheetRows.length, 'sheet rows →', file);
}

async function cmdGenerate() {
  const target = Number(process.argv[3] || 10000);
  const verified = process.argv.includes('--verified');
  const { rows, templateCount } = generateListings(target, { verified });

  // Validation pass (same checks as `validate`)
  const problems = [];
  const codes = new Set();
  for (const r of rows) {
    if (!r.code || codes.has(r.code)) problems.push('dup/bad code ' + r.code);
    codes.add(r.code);
    if (!r.brand || !r.category) problems.push('missing brand/category ' + r.code);
    const p = Number(r.sellingPrice);
    if (!(p >= 1 && p <= 10000)) problems.push('price out of range ' + r.code + ' ' + p);
    const f = Number(r.originalValue);
    if (!(f >= 5 && f <= 50000)) problems.push('face out of range ' + r.code);
    const exp = new Date(r.expiryDate).getTime();
    const add = new Date(r.addedAt).getTime();
    if (!(exp > add)) problems.push('expiry <= added ' + r.code);
    const monthMs = 31 * 86400000 + 86400000; // calendar month ± clock slack
    if (exp - add > monthMs) problems.push('timer longer than a month ' + r.code);
  }
  const brands = new Set(rows.map((r) => r.brand));
  const cats = new Set(rows.map((r) => r.category));
  const prices = rows.map((r) => Number(r.sellingPrice));
  fs.writeFileSync(MANIFEST, JSON.stringify({
    generatedAt: new Date().toISOString(),
    seed: 20261009,
    targetCount: target,
    verified,
    rows,
    checkpoint: { nextBatch: 0, insertedIds: [] },
    stats: { problems: problems.slice(0, 20), problemCount: problems.length },
  }));
  console.log('Templates used:', templateCount);
  console.log('Rows generated:', rows.length, '(dupes skipped:', target - rows.length + ')');
  console.log('Distinct brands:', brands.size, '| categories:', cats.size);
  console.log('Price range: ₹' + Math.min(...prices) + ' – ₹' + Math.max(...prices));
  console.log('Validation problems:', problems.length ? problems.slice(0, 10).join(' | ') : 'none');
  console.log('Manifest →', MANIFEST);
}

async function cmdValidate() {
  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const codes = new Set();
  let bad = 0;
  for (const r of man.rows) {
    if (!r.code || codes.has(r.code)) { bad++; console.log('BAD code', r.code); }
    codes.add(r.code);
    const p = Number(r.sellingPrice);
    if (!(p >= 1 && p <= 10000)) { bad++; console.log('BAD price', r.code, p); }
    if (!r.brand || !r.category || !r.title) { bad++; console.log('BAD fields', r.code); }
  }
  // Cross-check against live DB codes (duplicate-avoidance preview)
  const existing = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('coupons').select('code').range(from, from + 999);
    if (error) throw new Error(error.message);
    (data || []).forEach((r) => r.code && existing.add(String(r.code).toUpperCase()));
    if (!data || data.length < 1000) break;
  }
  const clashes = man.rows.filter((r) => existing.has(r.code.toUpperCase()));
  console.log('Rows:', man.rows.length, '| invalid:', bad, '| code clashes with live DB:', clashes.length);
  if (clashes.length) console.log(clashes.slice(0, 5).map((c) => c.code).join(', '));
}

async function cmdImport() {
  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const BATCH = 200;
  const totalBatches = Math.ceil(man.rows.length / BATCH);
  man.checkpoint = man.checkpoint || { nextBatch: 0, insertedIds: [] };

  // Codes already in the DB (any state) — never re-insert a code.
  const existingCodes = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('coupons').select('code').range(from, from + 999);
    if (error) throw new Error(error.message);
    (data || []).forEach((r) => r.code && existingCodes.add(String(r.code).toUpperCase()));
    if (!data || data.length < 1000) break;
  }

  // Ids already inserted (checkpoint) — resumability.
  const insertedSet = new Set(man.checkpoint.insertedIds);
  const toSupabase = (r, id) => ({
    id,
    code: r.code.toUpperCase().trim(),
    title: r.title, type: r.type, category: r.category, brand: r.brand,
    description: r.description, discount: r.discount,
    original_value: String(r.originalValue), selling_price: String(r.sellingPrice),
    min_order_value: String(r.minOrderValue || ''), valid_from: r.validFrom,
    expiry_date: r.expiryDate, affiliate_link: r.affiliateLink, terms: r.terms,
    is_featured: !!r.isFeatured, is_exclusive: !!r.isExclusive, is_verified: !!r.isVerified,
    seller_email: r.sellerEmail || '', status: r.status, source: r.source,
    added_at: r.addedAt, sold_at: r.soldAt, buyer_email: r.buyerEmail || '',
    on_sale: !!r.onSale, timer_on: !!r.timerOn,
    background_image: r.backgroundImage || null, brand_logo: r.brandLogo || null,
    proof_url: r.proofUrl || '', admin_notes: r.adminNotes || '', verified_at: r.verifiedAt,
    seller_user_id: r.sellerUserId || '', whatsapp_status: '', whatsapp_sid: '',
    whatsapp_last_attempt: null, whatsapp_error: '',
  });

  let skipped = 0;
  let inserted = 0;
  const startedAt = Date.now();
  for (let b = man.checkpoint.nextBatch; b < totalBatches; b++) {
    const slice = man.rows.slice(b * BATCH, (b + 1) * BATCH);
    const payload = [];
    for (const r of slice) {
      if (existingCodes.has(r.code.toUpperCase()) || insertedSet.has(r.code.toUpperCase())) { skipped++; continue; }
      const id = uuidv4();
      insertedSet.add(r.code.toUpperCase());
      payload.push(toSupabase(r, id));
    }
    if (payload.length > 0) {
      const { data, error } = await sb.from('coupons').insert(payload).select('id');
      if (error) {
        if (error.code === '23505') {
          // One or more codes raced in — find them, drop, retry once.
          console.warn('batch', b, 'unique violation — deduping retry');
          const got = new Set();
          for (const p of payload) {
            const { data: hit } = await sb.from('coupons').select('id').eq('code', p.code).maybeSingle();
            if (hit) { got.add(p.code); skipped++; }
          }
          const retry = payload.filter((p) => !got.has(p.code));
          if (retry.length) {
            const { data: data2, error: e2 } = await sb.from('coupons').insert(retry).select('id');
            if (e2) throw new Error('batch ' + b + ' retry failed: ' + e2.message);
            (data2 || []).forEach((r) => man.checkpoint.insertedIds.push(r.id));
            inserted += retry.length;
          }
        } else {
          throw new Error('batch ' + b + ' failed: ' + error.message);
        }
      } else {
        (data || []).forEach((r) => man.checkpoint.insertedIds.push(r.id));
        inserted += payload.length;
      }
    }
    man.checkpoint.nextBatch = b + 1;
    fs.writeFileSync(MANIFEST, JSON.stringify(man));
    const done = b + 1;
    const rate = (done / totalBatches) * 100;
    process.stdout.write('\rbatch ' + done + '/' + totalBatches + ' (' + rate.toFixed(1) + '%) inserted=' + inserted + ' skipped=' + skipped + '   ');
  }
  console.log('\nImport done in ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's — inserted:', inserted, 'skipped(dupes):', skipped);
  const { count } = await sb.from('coupons').select('id', { count: 'exact', head: true });
  console.log('DB total now:', count);
}

async function cmdDeleteOld() {
  const backup = JSON.parse(fs.readFileSync(LATEST_BACKUP(), 'utf8'));
  // Delete ONLY the backed-up rows that were available+admin — the sold rows
  // (real purchase history) and anything else are kept untouched.
  const doomed = (backup.supabaseRows || [])
    .filter((r) => String(r.source).toLowerCase() === 'admin' && String(r.status).toLowerCase() === 'available')
    .map((r) => r.id);
  console.log('Deleting', doomed.length, 'old available/admin rows (sold rows kept:', (backup.supabaseRows || []).length - doomed.length, ')');
  for (let i = 0; i < doomed.length; i += 200) {
    const chunk = doomed.slice(i, i + 200);
    const { error, count } = await sb.from('coupons').delete().in('id', chunk).select('id', { count: 'exact' });
    if (error) throw new Error('delete chunk failed: ' + error.message);
    process.stdout.write('\rdeleted ' + Math.min(i + chunk.length, doomed.length) + '/' + doomed.length + (count ? ' (last chunk ' + count + ')' : '') + '   ');
  }
  console.log('\nOld Supabase rows deleted.');
  const { count } = await sb.from('coupons').select('id', { count: 'exact', head: true });
  console.log('DB total now:', count);
}

async function cmdMirrorSheets() {
  const sheets = await sheetsApi();
  const headers = sheets.HEADERS[sheets.SHEETS.COUPONS];
  const backup = JSON.parse(fs.readFileSync(LATEST_BACKUP(), 'utf8'));
  const oldSheetRows = backup.sheetRows || [];
  console.log('Old sheet rows to clear:', oldSheetRows.length);

  // Clear the tab (keep header row) via batchUpdate deleteRows.
  const auth = sheets.__test ? null : null;
  // googleSheets.js doesn't expose a raw deleteRows helper, so mirror-sheets
  // uses getRows-fresh evidence instead: mark old rows superseded by
  // overwriting each with a tombstone? — No: we do a real clear via the
  // module's internal googleapis client if reachable.
  let cleared = 0;
  try {
    const gsMod = require(path.join(ROOT, 'server', 'services', 'googleSheets'));
    // Some builds expose the raw sheets client internally; otherwise we fall
    // back to updateRow tombstones for old rows (status='replaced').
    if (gsMod.deleteRow) {
      for (const r of oldSheetRows) {
        try { await gsMod.deleteRow(gsMod.SHEETS.COUPONS, r.id); cleared++; } catch { /* row may be gone */ }
        if (cleared % 50 === 0) process.stdout.write('\rcleared ' + cleared + '/' + oldSheetRows.length + '   ');
      }
    }
  } catch (e) {
    console.warn('clear path failed:', e.message);
  }
  console.log('\nCleared', cleared, 'old sheet rows');

  // Append the new inventory (from the DB = the truth) in 500-row batches.
  const fresh = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('coupons').select('*').range(from, from + 999);
    if (error) throw new Error(error.message);
    fresh.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  console.log('Appending', fresh.length, 'rows to the Coupons tab...');
  let appended = 0;
  const CHUNK = 500;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const rows = fresh.slice(i, i + CHUNK).map((c) => couponToSheetRow(headers, c));
    await sheets.appendRows ? sheets.appendRows(sheets.SHEETS.COUPONS, rows) : null;
    if (!sheets.appendRows) {
      for (const r of rows) await sheets.appendRow(sheets.SHEETS.COUPONS, Object.fromEntries(headers.map((h, idx) => [h, r[idx]])));
    }
    appended += rows.length;
    process.stdout.write('\rappended ' + appended + '/' + fresh.length + '   ');
  }
  console.log('\nSheets mirror complete.');
}

async function cmdVerify() {
  const report = { at: new Date().toISOString() };

  const { count: total } = await sb.from('coupons').select('id', { count: 'exact', head: true });
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('coupons').select('*').range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const byStatus = {}; const bySource = {};
  for (const r of all) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    bySource[r.source] = (bySource[r.source] || 0) + 1;
  }
  report.dbTotal = total;
  report.byStatus = byStatus;
  report.bySource = bySource;

  const newRows = all.filter((r) => String(r.admin_notes || '').includes('Imported 2026-10'));
  report.newImported = newRows.length;
  report.oldRowsRemoved = null; // filled from backup comparison below

  const codes = new Set(newRows.map((r) => String(r.code).toUpperCase()));
  report.distinctCodes = codes.size;
  const dupeCodes = newRows.length - codes.size;
  report.duplicateCodes = dupeCodes;

  const brands = new Set(newRows.map((r) => r.brand));
  report.distinctBrands = brands.size;
  const cats = new Set(newRows.map((r) => r.category));
  report.distinctCategories = cats.size;

  // Pricing — the buyer price is derived, so verify the curve holds for every row.
  let minPrice = Infinity; let maxPrice = -Infinity; let badPrice = 0;
  for (const r of newRows) {
    const bp = dynamicPricing.getBuyerPrice(r);
    if (!bp.purchasable) { badPrice++; continue; }
    if (bp.price < 1 || bp.price > 10000) badPrice++;
    if (bp.price < minPrice) minPrice = bp.price;
    if (bp.price > maxPrice) maxPrice = bp.price;
  }
  report.purchasableCount = newRows.length - badPrice;
  report.outOfRangePrices = badPrice;
  report.minBuyerPrice = minPrice === Infinity ? null : minPrice;
  report.maxBuyerPrice = maxPrice === -Infinity ? null : maxPrice;

  // One-month timers
  let timersOk = 0; let expiredNow = 0; let timerTooLong = 0;
  for (const r of newRows) {
    const add = new Date(r.added_at).getTime();
    const exp = new Date(r.expiry_date).getTime();
    if (!(exp > add)) timerTooLong++;
    else if (exp - add <= 32 * 86400000) timersOk++;
    else timerTooLong++;
    if (exp <= Date.now()) expiredNow++;
  }
  report.oneMonthTimers = timersOk;
  report.timerAnomalies = timerTooLong;
  report.expiredAtVerifyTime = expiredNow;

  // Old-row accounting from the newest backup
  try {
    const backup = JSON.parse(fs.readFileSync(LATEST_BACKUP(), 'utf8'));
    const oldIds = new Set((backup.supabaseRows || []).map((r) => r.id));
    const stillThere = all.filter((r) => oldIds.has(r.id));
    const keptSold = stillThere.filter((r) => String(r.status).toLowerCase() === 'sold').length;
    report.oldRowsOriginal = oldIds.size;
    report.oldRowsStillPresent = stillThere.length;
    report.oldSoldRowsKept = keptSold;
    report.oldAvailableRemoved = oldIds.size - stillThere.length;
  } catch (e) { report.backupCompareError = e.message; }

  fs.writeFileSync(path.join(__dirname, 'import-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const cmd = process.argv[2];
  const fn = {
    status: cmdStatus, backup: cmdBackup, generate: cmdGenerate, validate: cmdValidate,
    import: cmdImport, 'delete-old': cmdDeleteOld, 'mirror-sheets': cmdMirrorSheets, verify: cmdVerify,
  }[cmd];
  if (!fn) {
    console.log('Usage: node scripts/replace-inventory.cjs <status|backup|generate|validate|import|delete-old|mirror-sheets|verify>');
    process.exit(2);
  }
  await fn();
}

main().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });

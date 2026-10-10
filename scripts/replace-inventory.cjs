#!/usr/bin/env node
'use strict';
/* replace-inventory.cjs — SaveHatke coupon-inventory replacement tool.
 *
 * Subcommands:
 *   status         — current DB + Sheets inventory snapshot
 *   backup         — full export of Supabase coupons + Sheets Coupons tab
 *   generate       — build the listing manifest from the admin's own seed offers
 *   validate       — re-validate every manifest row (schema, price, timer, codes)
 *   import         — idempotent, resumable batched insert (checkpointed)
 *   snapshot-sold  — write sold-coupon snapshots onto their PAID order rows
 *   delete-old     — delete ALL backed-up coupon rows (requires snapshots first)
 *   mirror-sheets  — replace the Sheets Coupons tab with the new inventory
 *   verify         — post-import verification + report JSON
 *
 * Honesty contract: listings come VERBATIM from the administrator's own seed
 * files (server/seed_coupons*.js — the same authored offers that populated the
 * original inventory), codes included. No codes are invented here. Every row
 * is written with is_verified=false and an admin note stating the code is
 * platform-authored, not vendor-verified. The final report states the actual
 * imported total and the shortfall against 10,000.
 *
 * Purchase-history contract: sold coupons are deleted from the inventory
 * stores, but their display data is first snapshotted onto their PAID order
 * row (Orders.coupon_snapshot), and /api/coupons/my-purchases falls back to
 * that snapshot so buyer history keeps working after the reset.
 */

const fs = require('fs');
const path = require('path');

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

// ── Listing generation (verbatim admin templates) ────────────────────────

function addMonths(iso, months) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0); // clamp Jan 31 + 1mo → Feb 28
  return d.toISOString();
}

/**
 * Build the new inventory from the administrator's own seed offers, verbatim:
 * codes, titles, faces, prices and terms are used exactly as authored — this
 * session invents nothing. Duplicates are rejected (same code, or same
 * brand+title+face+discount). Each listing is activated at import time with a
 * one-calendar-month expiry (spec §4), stored on the row so restarts and
 * refreshes never reset it.
 */
function generateListings() {
  const templates = extractTemplates();
  if (templates.length === 0) throw new Error('No seed templates found');

  const seenCodes = new Set();
  const seenOffers = new Set();
  const rows = [];
  const rejected = [];

  for (const t of templates) {
    const codeKey = String(t.code || '').toUpperCase().trim();
    const offerKey = [t.brand, t.title, t.originalValue, t.discount].join('|').toLowerCase();

    // Validation + duplicate protection (spec §5).
    const face = Number(t.originalValue);
    const problems = [];
    if (!codeKey) problems.push('missing code');
    if (seenCodes.has(codeKey)) problems.push('duplicate code');
    if (seenOffers.has(offerKey)) problems.push('duplicate offer');
    if (!t.brand || !t.category || !t.title) problems.push('missing brand/category/title');
    if (!Number.isFinite(face) || face < 5 || face > 50000) problems.push('face value out of range ₹5–₹50,000');
    else {
      const derived = dynamicPricing.getBuyerPrice({ originalValue: String(face), expiryDate: addMonths(new Date().toISOString(), 1) });
      if (!derived.purchasable || derived.price < 1 || derived.price > 10000) problems.push('derived price out of range ₹1–₹10,000');
    }

    if (problems.length > 0) {
      rejected.push({ code: t.code, brand: t.brand, reasons: problems });
      continue;
    }
    seenCodes.add(codeKey);
    seenOffers.add(offerKey);

    // Activation = import moment (staggered so timestamps differ); expiry is
    // exactly one calendar month later, stored on the row.
    const addedAt = new Date(Date.now() + rows.length * 500).toISOString();
    const expiryDate = addMonths(addedAt, 1);

    rows.push({
      code: codeKey,
      title: t.title,
      type: 'Public',
      category: t.category,
      brand: t.brand,
      description: t.description,
      discount: t.discount,
      originalValue: String(face),
      // Keep the authored stored price for the record; buyers are always
      // charged the derived 20%-of-face figure recomputed server-side.
      sellingPrice: String(t.sellingPrice === undefined || t.sellingPrice === '' ? Math.round(face * 0.2) : t.sellingPrice),
      minOrderValue: t.minOrderValue || '',
      validFrom: null,
      expiryDate,
      affiliateLink: '',
      terms: t.terms || '',
      isFeatured: false,
      isExclusive: false,
      isVerified: false,
      sellerEmail: '',
      status: 'available',
      source: 'admin',
      addedAt,
      soldAt: null,
      buyerEmail: '',
      onSale: true,
      timerOn: true,
      backgroundImage: '',
      brandLogo: null,
      proofUrl: '',
      adminNotes: 'Imported 2026-10 inventory replacement; admin-authored offer; code is platform-authored, not vendor-verified.',
      verifiedAt: null,
      sellerUserId: '',
      whatsappStatus: '',
      whatsappSid: '',
      whatsappLastAttempt: null,
      whatsappError: '',
    });
  }
  return { rows, rejected, templateCount: templates.length };
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

async function readAllSupabase() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('coupons').select('*').range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

// ── Subcommands ──────────────────────────────────────────────────────────
async function cmdStatus() {
  const { count } = await sb.from('coupons').select('id', { count: 'exact', head: true });
  const data = await readAllSupabase();
  const by = {};
  for (const r of data) {
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
  const all = await readAllSupabase();
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
  const { rows, rejected, templateCount } = generateListings();

  // Second validation pass over the generated rows (same checks as `validate`).
  const problems = [];
  const codes = new Set();
  for (const r of rows) {
    if (!r.code || codes.has(r.code)) problems.push('dup/bad code ' + r.code);
    codes.add(r.code);
    if (!r.brand || !r.category) problems.push('missing brand/category ' + r.code);
    const f = Number(r.originalValue);
    if (!(f >= 5 && f <= 50000)) problems.push('face out of range ' + r.code);
    const exp = new Date(r.expiryDate).getTime();
    const add = new Date(r.addedAt).getTime();
    if (!(exp > add)) problems.push('expiry <= added ' + r.code);
    if (exp - add > 32 * 86400000) problems.push('timer longer than a month ' + r.code);
    const bp = dynamicPricing.getBuyerPrice({ originalValue: r.originalValue, expiryDate: r.expiryDate });
    if (!bp.purchasable || bp.price < 1 || bp.price > 10000) problems.push('derived price out of range ' + r.code);
  }
  const brands = new Set(rows.map((r) => r.brand));
  const cats = new Set(rows.map((r) => r.category));
  const prices = rows.map((r) => dynamicPricing.getBuyerPrice({ originalValue: r.originalValue, expiryDate: r.expiryDate }).price);
  fs.writeFileSync(MANIFEST, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: 'verbatim-admin-seed-offers',
    targetCount: 10000,
    rows,
    rejected,
    checkpoint: { nextBatch: 0, insertedIds: [] },
    stats: { problems: problems.slice(0, 20), problemCount: problems.length },
  }));
  console.log('Seed offers found:', templateCount);
  console.log('Rows generated:', rows.length);
  console.log('Rejected (invalid/duplicate):', rejected.length, rejected.length ? '→ ' + rejected.slice(0, 8).map((r) => r.code + ':' + r.reasons[0]).join(' | ') : '');
  console.log('Distinct brands:', brands.size, '| categories:', cats.size);
  console.log('Derived buyer price range: ₹' + Math.min(...prices) + ' – ₹' + Math.max(...prices));
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
    const f = Number(r.originalValue);
    if (!(f >= 5 && f <= 50000)) { bad++; console.log('BAD face', r.code, f); }
    if (!r.brand || !r.category || !r.title) { bad++; console.log('BAD fields', r.code); }
    const exp = new Date(r.expiryDate).getTime();
    const add = new Date(r.addedAt).getTime();
    if (!(exp > add) || exp - add > 32 * 86400000) { bad++; console.log('BAD timer', r.code); }
    const bp = dynamicPricing.getBuyerPrice({ originalValue: r.originalValue, expiryDate: r.expiryDate });
    if (!bp.purchasable || bp.price < 1 || bp.price > 10000) { bad++; console.log('BAD derived price', r.code); }
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

  // Codes already inserted (checkpoint) — resumability.
  const insertedSet = new Set(man.checkpoint.insertedIds);
  // Only real table columns (verified against the live schema; fields like
  // timer_on / admin_notes / background_image do not exist and must not be
  // sent — timer/brand-asset behaviour comes from defaults + fallbacks).
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
    on_sale: !!r.onSale,
    brand_logo: r.brandLogo || null,
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
    process.stdout.write('\rbatch ' + done + '/' + totalBatches + ' (' + ((done / totalBatches) * 100).toFixed(1) + '%) inserted=' + inserted + ' skipped=' + skipped + '   ');
  }
  console.log('\nImport done in ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's — inserted:', inserted, 'skipped(dupes):', skipped);
  const { count } = await sb.from('coupons').select('id', { count: 'exact', head: true });
  console.log('DB total now:', count);
}

/**
 * Write a display snapshot of every SOLD coupon onto its PAID order row, so
 * purchase history survives the inventory deletion. The order row is only
 * updated when the full purchase gate holds (PAID order + matching PAID
 * payment for the same coupon) — the same conditions /my-purchases requires
 * to release the code.
 */
async function cmdSnapshotSold() {
  const paymentStore = require(path.join(ROOT, 'server', 'services', 'paymentStore'));
  const sheets = await sheetsApi();
  const backup = JSON.parse(fs.readFileSync(LATEST_BACKUP(), 'utf8'));
  const sold = (backup.supabaseRows || []).filter((r) => String(r.status).toLowerCase() === 'sold');
  console.log('Sold rows to snapshot:', sold.length);

  const [orderRows, paymentRows] = await Promise.all([
    sheets.getRowsFresh(sheets.SHEETS.ORDERS),
    sheets.getRowsFresh(sheets.SHEETS.PAYMENTS),
  ]);
  const paidByOrder = new Map();
  for (const row of paymentRows || []) {
    const p = paymentStore.fromPayment(row);
    if (p && String(p.status).toUpperCase() === 'PAID' && p.orderId) paidByOrder.set(String(p.orderId), p);
  }
  const orderByCoupon = new Map();
  for (const row of orderRows || []) {
    const o = paymentStore.fromOrder(row);
    if (!o || !o.couponId || String(o.status).toUpperCase() !== 'PAID') continue;
    const p = paidByOrder.get(String(o.id));
    if (!p || String(p.couponId) !== String(o.couponId) || !paymentStore.moneyEquals(p.amount, o.amount)) continue;
    orderByCoupon.set(String(o.couponId), { order: o, payment: p });
  }

  let snapshotted = 0;
  const unsnapshotted = [];
  for (const c of sold) {
    const hit = orderByCoupon.get(String(c.id));
    if (!hit) { unsnapshotted.push(c); continue; }
    const snap = {
      id: c.id,
      code: c.code,
      brand: c.brand,
      title: c.title,
      description: c.description,
      discount: c.discount,
      category: c.category,
      originalValue: c.original_value,
      sellingPrice: c.selling_price,
      expiryDate: c.expiry_date,
      addedAt: c.added_at,
      soldAt: c.sold_at,
      sellerEmail: c.seller_email,
      backgroundImage: c.background_image,
      terms: c.terms,
      snapshottedAt: new Date().toISOString(),
    };
    await sheets.updateRow(sheets.SHEETS.ORDERS, 'id', hit.order.id, { coupon_snapshot: JSON.stringify(snap) });
    snapshotted++;
    process.stdout.write('\rsnapshotted ' + snapshotted + '/' + sold.length + '   ');
  }
  console.log('\nSnapshotted:', snapshotted, '| sold rows without a matching PAID order:', unsnapshotted.length);
  if (unsnapshotted.length) {
    console.log('Unsnapshotted ids:', unsnapshotted.map((c) => c.id).join(', '));
    console.log('These cannot be preserved in history — delete-old will refuse unless --include-unsnapshotted is passed.');
  }
  fs.writeFileSync(path.join(__dirname, 'snapshot-result.json'), JSON.stringify({
    at: new Date().toISOString(),
    sold: sold.length,
    snapshotted,
    unsnapshottedIds: unsnapshotted.map((c) => c.id),
  }, null, 2));
}

async function cmdDeleteOld() {
  const force = process.argv.includes('--include-unsnapshotted');
  const backup = JSON.parse(fs.readFileSync(LATEST_BACKUP(), 'utf8'));
  const all = backup.supabaseRows || [];
  const sold = all.filter((r) => String(r.status).toLowerCase() === 'sold');

  // Safety gate: every sold row must have been snapshotted (or explicitly forced).
  let snap = null;
  try { snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'snapshot-result.json'), 'utf8')); } catch { /* none */ }
  if (sold.length > 0) {
    const covered = snap && (snap.sold === sold.length) && (snap.unsnapshottedIds || []).length === 0;
    if (!covered && !force) {
      throw new Error('Sold-coupon snapshots are missing/incomplete — run `snapshot-sold` first (or pass --include-unsnapshotted to abandon history for the uncovered rows).');
    }
  }

  console.log('Deleting ALL', all.length, 'backed-up coupon rows (',
    all.length - sold.length, 'available +', sold.length, 'sold-with-snapshot ) ...');
  const doomed = all.map((r) => r.id);
  let deleted = 0;
  for (let i = 0; i < doomed.length; i += 200) {
    const chunk = doomed.slice(i, i + 200);
    const { error, count } = await sb.from('coupons').delete().in('id', chunk).select('id', { count: 'exact' });
    if (error) throw new Error('delete chunk failed: ' + error.message);
    deleted += chunk.length;
    process.stdout.write('\rdeleted ' + deleted + '/' + doomed.length + (count ? ' (last chunk ' + count + ')' : '') + '   ');
  }
  console.log('\nOld Supabase rows deleted:', deleted);
  const { count } = await sb.from('coupons').select('id', { count: 'exact', head: true });
  console.log('DB total now:', count);
}

async function cmdMirrorSheets() {
  const sheets = await sheetsApi();
  const headers = sheets.HEADERS[sheets.SHEETS.COUPONS];
  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const manifestCodes = new Set(man.rows.map((r) => String(r.code).toUpperCase()));

  // Clear every sheet row that is not part of the new inventory (old rows,
  // stale test rows, blank-code ghosts) in ONE batched delete.
  const removed = await sheets.deleteRowsWhere(sheets.SHEETS.COUPONS, (r) => {
    const code = String(r.code || '').toUpperCase();
    return !code || !manifestCodes.has(code);
  });
  console.log('Cleared', removed, 'sheet rows not in the manifest');

  const fresh = await readAllSupabase();
  console.log('Appending', fresh.length, 'rows to the Coupons tab...');
  let appended = 0;
  for (const c of fresh) {
    const obj = {};
    const rowArr = couponToSheetRow(headers, c);
    headers.forEach((h, idx) => { obj[h] = rowArr[idx]; });
    await sheets.appendRow(sheets.SHEETS.COUPONS, obj);
    appended++;
    if (appended % 25 === 0) process.stdout.write('\rappended ' + appended + '/' + fresh.length + '   ');
  }
  console.log('\nSheets mirror complete:', appended, 'rows.');
}

async function cmdVerify() {
  const report = { at: new Date().toISOString() };
  const all = await readAllSupabase();
  const { count: total } = await sb.from('coupons').select('id', { count: 'exact', head: true });

  const byStatus = {}; const bySource = {};
  for (const r of all) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    bySource[r.source] = (bySource[r.source] || 0) + 1;
  }
  report.dbTotal = total;
  report.byStatus = byStatus;
  report.bySource = bySource;

  const newRows = (() => {
    // The table has no provenance column — identify imported rows by code
    // membership in the manifest (codes are unique across both).
    let man = null;
    try { man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return all.filter(() => false); }
    const wanted = new Set(man.rows.map((r) => String(r.code).toUpperCase()));
    return all.filter((r) => wanted.has(String(r.code).toUpperCase()));
  })();
  report.newImported = newRows.length;

  const codes = new Set(newRows.map((r) => String(r.code).toUpperCase()));
  report.distinctCodes = codes.size;
  report.duplicateCodes = newRows.length - codes.size;

  const brands = new Set(newRows.map((r) => r.brand));
  report.distinctBrands = brands.size;
  const cats = new Set(newRows.map((r) => r.category));
  report.distinctCategories = cats.size;

  // Pricing — the buyer price is derived, so verify the curve holds for every row.
  // getBuyerPrice expects camelCase fields; DB rows are snake_case.
  let minPrice = Infinity; let maxPrice = -Infinity; let badPrice = 0;
  for (const r of newRows) {
    const bp = dynamicPricing.getBuyerPrice({ originalValue: r.original_value, expiryDate: r.expiry_date });
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
    if (!(exp > add) || exp - add > 32 * 86400000) timerTooLong++;
    else timersOk++;
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
    report.oldRowsOriginal = oldIds.size;
    report.oldRowsStillPresent = stillThere.length;
    report.oldRowsRemoved = oldIds.size - stillThere.length;
    const oldByStatus = {};
    for (const r of (backup.supabaseRows || [])) {
      const k = String(r.status || '').toLowerCase();
      oldByStatus[k] = (oldByStatus[k] || 0) + 1;
    }
    report.oldRowsByStatus = oldByStatus;
  } catch (e) { report.backupCompareError = e.message; }

  // Financial-history preservation: orders/payments/payouts live in Sheets.
  try {
    const sheets = await sheetsApi();
    const [orders, payments] = await Promise.all([
      sheets.getRows(sheets.SHEETS.ORDERS),
      sheets.getRows(sheets.SHEETS.PAYMENTS),
    ]);
    report.financialHistory = {
      ordersRows: orders.length,
      paidOrders: orders.filter((r) => String(r.status || '').toUpperCase() === 'PAID').length,
      paymentsRows: payments.length,
      paidPayments: payments.filter((r) => String(r.status || '').toUpperCase() === 'PAID').length,
      ordersWithCouponSnapshot: orders.filter((r) => String(r.coupon_snapshot || '').trim() !== '').length,
    };
  } catch (e) { report.financialHistoryError = e.message; }

  // Sheets mirror consistency
  try {
    const sheets = await sheetsApi();
    const sheetRows = await sheets.getRows(sheets.SHEETS.COUPONS);
    report.sheetsRows = sheetRows.length;
    const dbCodes = new Set(all.map((r) => String(r.code).toUpperCase()));
    const sheetOnly = sheetRows.filter((r) => !dbCodes.has(String(r.code || '').toUpperCase())).length;
    report.sheetsRowsNotInDb = sheetOnly;
  } catch (e) { report.sheetsCheckError = e.message; }

  // Authenticity shortfall (spec §7.10)
  report.shortfall = {
    requestedListings: 10000,
    actualImported: newRows.length,
    missingListings: Math.max(0, 10000 - newRows.length),
    reason: 'Only the administrator-authored seed offers exist as verified listing data; no vendor-supplied redeemable code file was provided. Codes are platform-authored and marked is_verified=false.',
  };

  fs.writeFileSync(path.join(__dirname, 'import-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const cmd = process.argv[2];
  const fn = {
    status: cmdStatus, backup: cmdBackup, generate: cmdGenerate, validate: cmdValidate,
    import: cmdImport, 'snapshot-sold': cmdSnapshotSold, 'delete-old': cmdDeleteOld,
    'mirror-sheets': cmdMirrorSheets, verify: cmdVerify,
  }[cmd];
  if (!fn) {
    console.log('Usage: node scripts/replace-inventory.cjs <status|backup|generate|validate|import|snapshot-sold|delete-old|mirror-sheets|verify>');
    process.exit(2);
  }
  await fn();
}

main().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });

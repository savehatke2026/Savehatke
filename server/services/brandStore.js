// ============================================
// SaveHatke - Brand directory store (Supabase `brands` table)
// ============================================
// Single authoritative source of truth for brands. Public website lists,
// marketplace filters, sell/coupon forms, dashboards and the Admin Panel all
// read through this module (directly or via /api/brands). The brand image is a
// stable Google Drive file id (logo_file_id); the browser only ever receives
// the /api/brand-assets/file/:id reference built by services/brandAssets.js.
//
// Apply supabase/migrations/20261014_brands_directory.sql before use. A missing
// table/column surfaces as a loud, named error - never a silent empty list.
// ============================================

const supabaseService = require('./supabase');

const TABLE = 'brands';
const MIGRATION_HINT = 'supabase/migrations/20261014_brands_directory.sql';

const NAME_MAX = 80;
const DESCRIPTION_MAX = 300;
const FILE_ID_RE = /^[a-zA-Z0-9_-]{10,80}$/;
const DEFAULT_CATEGORY = 'General';

// Website categories (mirrors public/js/marketplace.js). Unknown categories are
// rejected server-side so the brand taxonomy cannot drift from the site.
const CATEGORIES = [
  'General', 'Electronics', 'Fashion', 'Beauty', 'Food', 'Travel', 'E-Commerce',
  'Hotels & Stays', 'Gaming & Entertainment', 'Fitness & Sports', 'Education',
  'Health & Pharmacy', 'Finance & Payments',
];

class BrandValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'BrandValidationError';
    this.status = 400;
    this.field = field || null;
  }
}

class BrandConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrandConflictError';
    this.status = 409;
  }
}

/** Normalized match key - identical rule to normalizeBrand() in brandAssets.js. */
function normalizeKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Collapse runs of whitespace; trims. Display form is kept human-readable. */
function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

/** Stable id derived from the key, so re-creating the same brand is idempotent. */
function idForKey(key) {
  return 'b_' + key;
}

function sanitizeText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Validate and normalize a brand payload coming from an admin request or a
 * seed script. Throws BrandValidationError with a field name on any problem.
 * `partial` allows updates that only touch some fields.
 */
function validateBrandInput(input, { partial = false } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};

  if (!partial || src.name !== undefined) {
    const name = cleanName(src.name);
    if (!name) throw new BrandValidationError('Brand name is required.', 'name');
    if (name.length > NAME_MAX) throw new BrandValidationError(`Brand name must be ${NAME_MAX} characters or fewer.`, 'name');
    const key = normalizeKey(name);
    if (!key) throw new BrandValidationError('Brand name must contain at least one letter or digit.', 'name');
    out.name = name;
    out.key = key;
  }

  if (!partial || src.category !== undefined) {
    const category = cleanName(src.category) || DEFAULT_CATEGORY;
    if (!CATEGORIES.includes(category)) {
      throw new BrandValidationError('Unknown brand category.', 'category');
    }
    out.category = category;
  }

  if (!partial || src.description !== undefined) {
    out.description = sanitizeText(src.description, DESCRIPTION_MAX);
  }

  if (!partial || src.displayOrder !== undefined) {
    const n = Number(src.displayOrder === undefined || src.displayOrder === '' ? 0 : src.displayOrder);
    if (!Number.isFinite(n) || !Number.isInteger(n) || Math.abs(n) > 100000) {
      throw new BrandValidationError('Display order must be a whole number.', 'displayOrder');
    }
    out.displayOrder = n;
  }

  if (!partial || src.isActive !== undefined) {
    out.isActive = !(src.isActive === false || src.isActive === 'false' || src.isActive === 0);
  }

  if (!partial || src.logoFileId !== undefined) {
    const fileId = String(src.logoFileId || '').trim();
    if (fileId && !FILE_ID_RE.test(fileId)) {
      throw new BrandValidationError('Logo file id is not a valid Google Drive id.', 'logoFileId');
    }
    out.logoFileId = fileId || null;
  }

  return out;
}

function fromRow(row, couponCounts) {
  if (!row) return null;
  const count = couponCounts ? (couponCounts.get(row.id) || 0) : undefined;
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    category: row.category || DEFAULT_CATEGORY,
    description: row.description || '',
    logoFileId: row.logo_file_id || null,
    displayOrder: Number(row.display_order) || 0,
    isActive: row.is_active !== false,
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    ...(count !== undefined ? { couponCount: count } : {}),
  };
}

/** Maps Postgres/PostgREST schema failures to a loud, actionable error. */
function wrapDbError(err, action) {
  const msg = String((err && err.message) || err || '');
  if (/relation .*brands.* does not exist|PGRST205|42P01/i.test(msg) ||
      /42703|PGRST204|could not find the column/i.test(msg)) {
    const e = new Error(`Brands table/columns missing - apply ${MIGRATION_HINT} in the Supabase SQL editor. (${action})`);
    e.code = 'BRANDS_SCHEMA_MISSING';
    e.status = 503;
    return e;
  }
  if (/duplicate key|23505|brands_key_uq/i.test(msg)) {
    return new BrandConflictError('A brand with this name already exists.');
  }
  const e = new Error(`Brand ${action} failed.`);
  e.cause = err;
  e.status = 500;
  return e;
}

function client() {
  const c = supabaseService.getClient();
  if (!c) {
    const e = new Error('Brand directory is unavailable: database is not configured.');
    e.code = 'BRANDS_UNAVAILABLE';
    e.status = 503;
    throw e;
  }
  return c;
}

/** coupon_id counts per brand_id, for admin list badges. */
async function countCouponsByBrand() {
  const { data, error } = await client()
    .from('coupons')
    .select('brand_id')
    .not('brand_id', 'is', null);
  if (error) throw wrapDbError(error, 'coupon count');
  const map = new Map();
  for (const r of data || []) map.set(r.brand_id, (map.get(r.brand_id) || 0) + 1);
  return map;
}

/**
 * List brands. opts: { activeOnly, search, category, status ('active'|'inactive') , withCounts }
 */
async function listBrands(opts = {}) {
  let q = client().from(TABLE).select('*');
  if (opts.activeOnly) q = q.eq('is_active', true);
  if (opts.status === 'active') q = q.eq('is_active', true);
  if (opts.status === 'inactive') q = q.eq('is_active', false);
  if (opts.category) q = q.eq('category', String(opts.category));
  q = q.order('display_order', { ascending: true }).order('name', { ascending: true });

  const { data, error } = await q;
  if (error) throw wrapDbError(error, 'list');

  let counts = null;
  if (opts.withCounts) counts = await countCouponsByBrand();

  let rows = (data || []).map((r) => fromRow(r, counts));
  if (opts.search) {
    const needle = normalizeKey(opts.search);
    const raw = String(opts.search).trim().toLowerCase();
    rows = rows.filter((b) => b.key.includes(needle) || b.name.toLowerCase().includes(raw));
  }
  return rows;
}

async function getBrandById(id) {
  const { data, error } = await client().from(TABLE).select('*').eq('id', String(id)).maybeSingle();
  if (error) throw wrapDbError(error, 'lookup');
  return fromRow(data);
}

/** Find an existing brand by any spelling of its name (duplicate detection). */
async function findBrandByName(name) {
  const key = normalizeKey(name);
  if (!key) return null;
  const { data, error } = await client().from(TABLE).select('*').eq('key', key).maybeSingle();
  if (error) throw wrapDbError(error, 'lookup');
  return fromRow(data);
}

/** Create a brand. Duplicate names/keys are rejected, never silently merged. */
async function createBrand(input) {
  const v = validateBrandInput(input);
  const existing = await findBrandByName(v.name);
  if (existing) throw new BrandConflictError(`"${existing.name}" already exists as a brand.`);

  const now = new Date().toISOString();
  const row = {
    id: idForKey(v.key),
    name: v.name,
    key: v.key,
    category: v.category,
    description: v.description || '',
    logo_file_id: v.logoFileId || null,
    display_order: v.displayOrder || 0,
    is_active: v.isActive !== false,
    created_at: now,
    updated_at: now,
  };
  const { data, error } = await client().from(TABLE).insert(row).select('*').single();
  if (error) throw wrapDbError(error, 'create');
  return fromRow(data);
}

/**
 * Update a brand's editable fields. The stable id never changes, so coupons
 * keep their brand_id link when the name or logo is edited.
 */
async function updateBrand(id, input) {
  const current = await getBrandById(id);
  if (!current) {
    const e = new Error('Brand not found.');
    e.status = 404;
    throw e;
  }
  const v = validateBrandInput(input, { partial: true });
  if (v.key && v.key !== current.key) {
    const clash = await findBrandByName(v.name);
    if (clash && clash.id !== current.id) {
      throw new BrandConflictError(`"${clash.name}" already exists as a brand.`);
    }
  }

  const patch = { updated_at: new Date().toISOString() };
  if (v.name !== undefined) { patch.name = v.name; patch.key = v.key; }
  if (v.category !== undefined) patch.category = v.category;
  if (v.description !== undefined) patch.description = v.description;
  if (v.displayOrder !== undefined) patch.display_order = v.displayOrder;
  if (v.isActive !== undefined) patch.is_active = v.isActive;
  if (v.logoFileId !== undefined) patch.logo_file_id = v.logoFileId;

  const { data, error } = await client().from(TABLE).update(patch).eq('id', current.id).select('*').single();
  if (error) throw wrapDbError(error, 'update');
  return fromRow(data);
}

/** Soft activate/deactivate. Brands are never hard-deleted here. */
async function setBrandActive(id, isActive) {
  return updateBrand(id, { isActive: Boolean(isActive) });
}

/**
 * Pure matcher: pick the brand whose normalized key equals the typed name's key.
 * "Cult.fit", "cult fit" and "CULTFIT" all resolve to the same brand. Returns
 * null when nothing matches. Only active brands should be passed in.
 */
function matchActiveBrand(typedName, brands) {
  const key = normalizeKey(typedName);
  if (!key) return null;
  return (brands || []).find((b) => b.isActive !== false && b.key === key) || null;
}

/**
 * Coupon write gate. Resolves a typed brand to an ACTIVE directory brand and
 * returns { brandId, brand } where brand.name is the canonical display name.
 * Throws BrandValidationError (code BRAND_NOT_ACTIVE) for unknown or inactive
 * brands, so new coupons can only reference brands admins have activated.
 * Existing coupons are never re-validated - historical records are untouched.
 */
async function resolveActiveBrand(typedName) {
  const key = normalizeKey(typedName);
  if (!key) throw new BrandValidationError('Brand is required.', 'brand');
  const row = await findBrandByName(typedName);
  if (!row || !row.isActive) {
    const err = new BrandValidationError(
      'That brand is not available. Choose an active brand from the list.',
      'brand'
    );
    err.code = 'BRAND_NOT_ACTIVE';
    throw err;
  }
  return { brandId: row.id, brand: row };
}

module.exports = {
  TABLE,
  MIGRATION_HINT,
  CATEGORIES,
  BrandValidationError,
  BrandConflictError,
  normalizeKey,
  cleanName,
  idForKey,
  validateBrandInput,
  fromRow,
  listBrands,
  getBrandById,
  findBrandByName,
  createBrand,
  updateBrand,
  setBrandActive,
  matchActiveBrand,
  resolveActiveBrand,
  countCouponsByBrand,
  _internals: { wrapDbError, FILE_ID_RE },
};

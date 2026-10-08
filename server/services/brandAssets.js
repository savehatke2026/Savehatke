// ============================================
// SaveHatke — Brand Asset Resolver (Google Drive)
// ============================================
// Brand logos and coupon card backgrounds live in the connected SaveHatke
// Google Drive, in two folders:
//
//     SaveHatke Assets/
//     ├── Brand Logos/          e.g. amazon.png, flipkart.png, cultfit.png
//     └── Coupon Backgrounds/   e.g. amazon.jpg, flipkart.jpg, cultfit.jpg
//
// The file stem (minus extension), normalized the same way the frontend
// squashes brand names (lowercase, diacritics stripped, all non-alphanumerics
// dropped), IS the brand key: "Cult.fit", "Cult Fit" and "cultfit" all resolve
// to cultfit.png / cultfit.jpg. Admins keep typing plain brand names — nothing
// about coupon creation or the database changes.
//
// This service REUSES the existing Drive integration (services/googleDrive.js —
// OAuth refresh token from Supabase security_credentials, env fallback, or the
// Workspace service account). No new credentials, no new auth flow. All Drive
// access stays server-side; the browser only ever sees a reference to OUR
// public image endpoint (/api/brand-assets/file/:fileId).
//
// Performance contract — coupons number in the thousands, brands do not:
//   • Folder IDs are resolved once per hour (exact-name search, cached).
//   • Each asset folder is LISTED once per 10 minutes (two API calls per TTL
//     total, regardless of traffic) and the listing is matched in memory.
//   • Per-brand resolutions are cached for 5 minutes (hits AND misses) with
//     single-flight deduplication, so N coupons of one brand cost ONE lookup.
//   • A Drive outage trips a 60s breaker instead of retrying per request.
//
// Env variables (all optional — folder names are auto-discovered when absent):
//   GOOGLE_DRIVE_ASSETS_FOLDER_ID            "SaveHatke Assets" root folder
//   GOOGLE_DRIVE_BRAND_LOGOS_FOLDER_ID       "Brand Logos" folder
//   GOOGLE_DRIVE_COUPON_BACKGROUNDS_FOLDER_ID "Coupon Backgrounds" folder
// ============================================

const googleDrive = require('./googleDrive');

const ASSETS_ROOT_FOLDER_NAME = 'SaveHatke Assets';
const LOGOS_FOLDER_NAME = 'Brand Logos';
const BGS_FOLDER_NAME = 'Coupon Backgrounds';

// Cache lifetimes. Folder IDs essentially never change; listings refresh on a
// slower clock than brand resolutions so new uploads appear without a restart.
const FOLDER_TTL_MS = 60 * 60 * 1000;        // resolved folder IDs
const FOLDER_PARTIAL_TTL_MS = 5 * 60 * 1000; // when a folder wasn't found yet
const LISTING_TTL_MS = 10 * 60 * 1000;       // per-folder file listings
const LISTING_ERROR_TTL_MS = 60 * 1000;      // breaker after a failed listing
const BRAND_TTL_MS = 5 * 60 * 1000;          // per-brand resolution (hit or miss)
const BRAND_CACHE_MAX = 2000;                // LRU-ish cap on brand entries

// Preferred extension when two files normalize to the same brand stem.
const EXT_RANK = { png: 0, svg: 1, jpg: 2, jpeg: 2, webp: 3 };

function clean(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}

/**
 * Brand-name normalization — MUST stay identical to normBrandKey() in
 * public/js/coupon-meta.js: lowercase, diacritics stripped, every character
 * that is not a-z/0-9 dropped (spaces, dots, dashes, ampersands, apostrophes,
 * repeated spaces, capitalization all collapse). "Cult.fit" → "cultfit".
 */
function normalizeBrand(brand) {
  return String(brand || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function extRank(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? (EXT_RANK[m[1].toLowerCase()] ?? 9) : 9;
}

/** Public, cacheable image reference for a Drive file. */
function fileUrl(fileId) {
  return '/api/brand-assets/file/' + encodeURIComponent(fileId);
}

// ── Folder ID resolution ─────────────────────────────────────────────────────
// 1. GOOGLE_DRIVE_BRAND_LOGOS_FOLDER_ID / GOOGLE_DRIVE_COUPON_BACKGROUNDS_FOLDER_ID
// 2. exact-name child of GOOGLE_DRIVE_ASSETS_FOLDER_ID (or of the Drive-wide
//    "SaveHatke Assets" folder when that env var is absent)
// 3. exact-name Drive-wide search — zero-config fallback
let folderCache = { at: 0, ids: null, promise: null };

async function findFolderByName(drive, name, parentId) {
  const safe = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  let q = `name = '${safe}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await drive.files.list({
    q,
    fields: 'files(id, name)',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files || [])[0] || null;
}

async function _resolveFolderIds() {
  const ids = {
    logos: clean(process.env.GOOGLE_DRIVE_BRAND_LOGOS_FOLDER_ID) || null,
    backgrounds: clean(process.env.GOOGLE_DRIVE_COUPON_BACKGROUNDS_FOLDER_ID) || null,
  };
  let partial = !ids.logos || !ids.backgrounds;

  if (partial) {
    const drive = await googleDrive.getDriveClient();
    if (drive) {
      try {
        const rootId =
          clean(process.env.GOOGLE_DRIVE_ASSETS_FOLDER_ID) ||
          ((await findFolderByName(drive, ASSETS_ROOT_FOLDER_NAME, null)) || {}).id || null;
        if (!ids.logos) {
          ids.logos = ((await findFolderByName(drive, LOGOS_FOLDER_NAME, rootId)) || {}).id || null;
        }
        if (!ids.backgrounds) {
          ids.backgrounds = ((await findFolderByName(drive, BGS_FOLDER_NAME, rootId)) || {}).id || null;
        }
      } catch (e) {
        console.warn('[brandAssets] folder discovery failed:', e.message);
        partial = true;
      }
    }
  }

  partial = partial || !ids.logos || !ids.backgrounds;
  folderCache = { at: Date.now(), ids, promise: null };
  folderCache.ttl = partial ? FOLDER_PARTIAL_TTL_MS : FOLDER_TTL_MS;
  return ids;
}

async function getAssetFolderIds() {
  // Capture the current cache object: _resolveFolderIds() may complete
  // synchronously (both folder IDs come from env) and reassign `folderCache`
  // before this function returns — reading the module variable again would
  // hand back the fresh object's null `promise`.
  const cached = folderCache;
  if (
    cached.ids &&
    Date.now() - cached.at < (cached.ttl || FOLDER_TTL_MS)
  ) {
    return cached.ids;
  }
  if (!cached.promise) {
    const p = _resolveFolderIds().finally(() => {
      folderCache.promise = null; // clear on whichever object is current then
    });
    cached.promise = p;
    return p;
  }
  return cached.promise;
}

// ── Folder listings ──────────────────────────────────────────────────────────
// One files.list pagination per folder per TTL. Everything downstream (brand
// lookup, proxy authorization, MIME lookup) matches against this in-memory map.
const listingCache = new Map(); // folderId -> { at, ttl, byKey, fileIds, mimeById }

async function _listFolder(drive, folderId) {
  const byKey = new Map();
  const fileIds = new Set();
  const mimeById = new Map();
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 200,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files || []) {
      if (!f || !f.id) continue;
      fileIds.add(f.id);
      mimeById.set(f.id, f.mimeType || '');
      const stem = String(f.name || '').replace(/\.[^.]+$/, '');
      const key = normalizeBrand(stem);
      if (!key) continue;
      const prev = byKey.get(key);
      if (!prev || extRank(f.name) < extRank(prev.name)) byKey.set(key, f);
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return { byKey, fileIds, mimeById };
}

async function getFolderListing(folderId) {
  const hit = listingCache.get(folderId);
  if (hit && Date.now() - hit.at < hit.ttl) return hit;

  const drive = await googleDrive.getDriveClient();
  if (!drive) {
    const entry = { at: Date.now(), ttl: LISTING_ERROR_TTL_MS, byKey: new Map(), fileIds: new Set(), mimeById: new Map(), error: true };
    listingCache.set(folderId, entry);
    return entry;
  }

  try {
    const data = await _listFolder(drive, folderId);
    const entry = { at: Date.now(), ttl: LISTING_TTL_MS, ...data };
    listingCache.set(folderId, entry);
    return entry;
  } catch (e) {
    // Breaker: serve an empty listing for 60s so an outage doesn't turn every
    // page render into a Drive retry storm.
    console.warn('[brandAssets] listing failed for folder', folderId, '-', e.message);
    const entry = { at: Date.now(), ttl: LISTING_ERROR_TTL_MS, byKey: new Map(), fileIds: new Set(), mimeById: new Map(), error: true };
    listingCache.set(folderId, entry);
    return entry;
  }
}

// ── Brand resolution ─────────────────────────────────────────────────────────
const brandCache = new Map(); // normKey -> { at, logo, background }
const inflight = new Map();   // normKey -> Promise (single-flight per brand)

function packResult(original, key, entry) {
  return {
    brand: original,
    normalizedBrand: key,
    logo: (entry && entry.logo) || null,
    background: (entry && entry.background) || null,
  };
}

async function _resolveBrand(original, key) {
  let logoId = null;
  let bgId = null;
  try {
    const ids = await getAssetFolderIds();
    if (ids.logos) {
      logoId = ((await getFolderListing(ids.logos)).byKey.get(key))?.id || null;
    }
    if (ids.backgrounds) {
      bgId = ((await getFolderListing(ids.backgrounds)).byKey.get(key))?.id || null;
    }
  } catch (e) {
    console.warn('[brandAssets] resolve failed for', key, '-', e.message);
  }

  const entry = {
    at: Date.now(),
    logo: logoId ? fileUrl(logoId) : null,
    background: bgId ? fileUrl(bgId) : null,
  };
  brandCache.set(key, entry);

  // Simple size cap: drop the oldest quarter when the cache grows unbounded.
  if (brandCache.size > BRAND_CACHE_MAX) {
    const drop = Math.floor(BRAND_CACHE_MAX / 4);
    let i = 0;
    for (const k of brandCache.keys()) {
      if (i++ >= drop) break;
      brandCache.delete(k);
    }
  }
  return packResult(original, key, entry);
}

/**
 * Resolve one brand name ("Cult.fit") to its Drive asset references.
 * Never throws — a Drive problem resolves to nulls and the frontend falls
 * back to its existing default artwork. Cached per brand, single-flight.
 */
async function resolveBrandAssets(brand) {
  const original = String(brand || '').trim();
  const key = normalizeBrand(original);
  if (!key) {
    return { brand: original, normalizedBrand: '', logo: null, background: null };
  }
  const hit = brandCache.get(key);
  if (hit && Date.now() - hit.at < BRAND_TTL_MS) return packResult(original, key, hit);

  const going = inflight.get(key);
  if (going) return going;
  const p = _resolveBrand(original, key).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Batch resolve. Deduplicates on the normalized key. */
async function resolveBrands(brands) {
  const list = (Array.isArray(brands) ? brands : [brands]).map((b) => String(b || '').trim()).filter(Boolean);
  const unique = Array.from(new Set(list.map(normalizeBrand).filter(Boolean)));
  const results = await Promise.all(unique.map((key) => {
    const original = list.find((b) => normalizeBrand(b) === key) || key;
    return resolveBrandAssets(original);
  }));
  return results;
}

// ── Proxy helpers (used by the /file/:fileId endpoint) ───────────────────────
let lastForcedRefreshAt = 0;

/**
 * True when fileId lives in one of the two asset folders. This is what keeps
 * /api/brand-assets/file/:fileId a scoped brand-asset endpoint instead of an
 * open proxy into the private Drive. On a cache miss the listing is refreshed
 * at most once per 30s (covers files uploaded moments ago).
 */
async function isKnownAssetFile(fileId) {
  let ids;
  try {
    ids = await getAssetFolderIds();
  } catch (e) {
    return false;
  }
  for (const folderId of [ids.logos, ids.backgrounds]) {
    if (!folderId) continue;
    let listing = await getFolderListing(folderId);
    if (listing.fileIds.has(fileId)) return true;
    if (!listing.error && Date.now() - lastForcedRefreshAt > 30 * 1000) {
      lastForcedRefreshAt = Date.now();
      listingCache.delete(folderId);
      listing = await getFolderListing(folderId);
      if (listing.fileIds.has(fileId)) return true;
    }
  }
  return false;
}

/** MIME type for an asset file from the cached listing (no extra Drive call). */
function cachedMimeFor(fileId) {
  for (const listing of listingCache.values()) {
    const mime = listing.mimeById && listing.mimeById.get(fileId);
    if (mime) return mime;
  }
  return null;
}

module.exports = {
  normalizeBrand,
  resolveBrandAssets,
  resolveBrands,
  isKnownAssetFile,
  cachedMimeFor,
  fileUrl,
  // Exposed for diagnostics
  _getAssetFolderIds: getAssetFolderIds,
};

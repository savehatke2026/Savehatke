// ============================================
// SaveHatke — Brand directory API
// ============================================
//   GET  /api/brands                       public: active brands (display order)
//   GET  /api/admin/brands                 admin: all brands + coupon counts
//                                          (?search=&status=active|inactive&category=)
//   GET  /api/admin/brands/drive-logos     admin: logo files in the Drive "Brand Logos"
//                                          folder, optional ?search= filename filter
//   GET  /api/admin/brands/drive-logos/check?fileId=…
//                                          admin: verify a Drive file id/URL is an
//                                          accessible image before assigning it
//   POST /api/admin/brands                 admin: create
//   GET  /api/admin/brands/:id             admin: one brand
//   PUT  /api/admin/brands/:id             admin: update name/category/logo/order/desc
//   POST /api/admin/brands/:id/active      admin: { isActive } soft (de)activate
//
// Admin routes always run authenticateToken + requireAdmin server-side; the
// frontend hiding a button is never the access control. Public responses carry
// no Drive credentials — only the /api/brand-assets/file/:id image reference.
// ============================================

const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { adminMutationLimiter } = require('../utils/adminRateLimit');
const brandStore = require('../services/brandStore');
const brandAssets = require('../services/brandAssets');
const googleDrive = require('../services/googleDrive');

const router = express.Router();
const adminRouter = express.Router();

const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';

/** Public-safe shape: no internal key, no coupon counts, resolved logo URL. */
function publicBrand(b) {
  return {
    id: b.id,
    name: b.name,
    category: b.category,
    description: b.description,
    displayOrder: b.displayOrder,
    logo: b.logoFileId ? brandAssets.fileUrl(b.logoFileId) : null,
  };
}

function sendStoreError(res, err, fallback) {
  if (err && err.name === 'BrandValidationError') {
    return res.status(400).json({ error: err.message, code: 'BRAND_INVALID', field: err.field });
  }
  if (err && err.name === 'BrandConflictError') {
    return res.status(409).json({ error: err.message, code: 'BRAND_DUPLICATE' });
  }
  if (err && err.code === 'BRANDS_SCHEMA_MISSING') {
    return res.status(503).json({ error: err.message, code: 'BRANDS_SCHEMA_MISSING' });
  }
  if (err && err.status === 404) {
    return res.status(404).json({ error: err.message, code: 'BRAND_NOT_FOUND' });
  }
  console.error('[brands]', fallback, '-', err && err.message);
  return res.status(err && err.status === 503 ? 503 : 500).json({ error: fallback, code: 'BRAND_FAILED' });
}

// ── Public ───────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const rows = await brandStore.listBrands({ activeOnly: true, category: req.query.category });
    res.set('Cache-Control', PUBLIC_CACHE);
    return res.json({ brands: rows.map(publicBrand) });
  } catch (err) {
    return sendStoreError(res, err, 'Could not load brands.');
  }
});

// ── Admin (every route authenticated + admin-checked) ────────────────────────
adminRouter.use(authenticateToken, requireAdmin);

adminRouter.get('/', async (req, res) => {
  try {
    const status = ['active', 'inactive'].includes(req.query.status) ? req.query.status : undefined;
    const rows = await brandStore.listBrands({
      withCounts: true,
      status,
      category: req.query.category || undefined,
      search: String(req.query.search || '').slice(0, 80) || undefined,
    });
    return res.json({ brands: rows, categories: brandStore.CATEGORIES });
  } catch (err) {
    return sendStoreError(res, err, 'Could not load brands.');
  }
});

adminRouter.get('/drive-logos', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().toLowerCase().slice(0, 80);
    const files = await brandAssets.listLogoFiles();
    const filtered = search
      ? files.filter((f) => f.name.toLowerCase().includes(search))
      : files;
    return res.json({ files: filtered.slice(0, 500), total: filtered.length });
  } catch (err) {
    console.error('[brands] drive logo list failed:', err && err.message);
    return res.status(502).json({ error: 'Could not read the Google Drive brand logo folder.', code: 'DRIVE_UNAVAILABLE' });
  }
});

adminRouter.get('/drive-logos/check', async (req, res) => {
  const raw = String(req.query.fileId || '').trim();
  const fileId = brandAssets.extractDriveFileId(raw);
  if (!fileId) {
    return res.status(400).json({ error: 'Enter a Google Drive file ID or a valid Drive link.', code: 'BAD_FILE_REF' });
  }
  try {
    const result = await brandAssets.checkLogoFile(fileId);
    return res.json(result);
  } catch (err) {
    console.error('[brands] drive check failed:', err && err.message);
    return res.status(502).json({ error: 'Could not reach Google Drive to verify this file.', code: 'DRIVE_UNAVAILABLE' });
  }
});

adminRouter.post('/', adminMutationLimiter, async (req, res) => {
  try {
    const brand = await brandStore.createBrand(req.body || {});
    brandAssets.invalidateBrandCaches();
    return res.status(201).json({ brand });
  } catch (err) {
    return sendStoreError(res, err, 'Could not create the brand.');
  }
});

adminRouter.get('/:id', async (req, res) => {
  try {
    const brand = await brandStore.getBrandById(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found.', code: 'BRAND_NOT_FOUND' });
    return res.json({ brand });
  } catch (err) {
    return sendStoreError(res, err, 'Could not load the brand.');
  }
});

adminRouter.put('/:id', adminMutationLimiter, async (req, res) => {
  try {
    const brand = await brandStore.updateBrand(req.params.id, req.body || {});
    brandAssets.invalidateBrandCaches();
    return res.json({ brand });
  } catch (err) {
    return sendStoreError(res, err, 'Could not update the brand.');
  }
});

adminRouter.post('/:id/active', adminMutationLimiter, async (req, res) => {
  try {
    const brand = await brandStore.setBrandActive(req.params.id, req.body && req.body.isActive);
    brandAssets.invalidateBrandCaches();
    return res.json({ brand });
  } catch (err) {
    return sendStoreError(res, err, 'Could not change the brand status.');
  }
});

module.exports = router;
module.exports.adminRouter = adminRouter;

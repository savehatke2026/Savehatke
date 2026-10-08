// ============================================
// SaveHatke — Brand Asset API (Google Drive backed)
// ============================================
// Public endpoints backing the brand logos / coupon backgrounds that live in
// the "SaveHatke Assets" Drive folders. Resolution happens server-side via
// services/brandAssets.js (which reuses the existing googleDrive service) —
// no Drive credentials or file metadata beyond the image reference ever
// reach the browser.
//
//   GET /api/brand-assets?brands=a,b,c   batch resolve  → { assets: { key: {...} } }
//   GET /api/brand-assets/:brand         single resolve → { brand, normalizedBrand, logo, background }
//   GET /api/brand-assets/file/:fileId   stream one asset image (public; scoped
//                                        to the two asset folders — NOT an open
//                                        Drive proxy)
//
// `logo` / `background` are references to the /file/ endpoint above, or null
// when the brand has no such asset in Drive (the frontend then falls back to
// its existing default artwork).
// ============================================

const express = require('express');
const brandAssets = require('../services/brandAssets');
const googleDrive = require('../services/googleDrive');

const router = express.Router();

const FILE_ID_RE = /^[a-zA-Z0-9_-]{10,80}$/;
const MAX_BATCH = 100; // brands per request — far above the real brand count
const RESOLVER_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=600';

// ── GET /api/brand-assets?brands=Amazon,Flipkart,… ──────────────────────────
router.get('/', async (req, res) => {
  const brands = String(req.query.brands || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_BATCH);

  if (!brands.length) {
    return res.json({ assets: {} });
  }

  try {
    const results = await brandAssets.resolveBrands(brands);
    const assets = {};
    for (const r of results) {
      if (r && r.normalizedBrand) assets[r.normalizedBrand] = r;
    }
    res.set('Cache-Control', RESOLVER_CACHE_CONTROL);
    return res.json({ assets });
  } catch (e) {
    console.error('[brandAssets] batch resolve error:', e.message);
    return res.status(502).json({ assets: {}, error: 'Brand asset resolution failed.' });
  }
});

// ── GET /api/brand-assets/file/:fileId — stream one image ───────────────────
// Registered BEFORE /:brand so "file" is never treated as a brand name.
router.get('/file/:fileId', async (req, res) => {
  const fileId = String(req.params.fileId || '');
  if (!FILE_ID_RE.test(fileId)) {
    return res.status(400).json({ error: 'Invalid file id.' });
  }

  // Scope: only files present in the Brand Logos / Coupon Backgrounds folders
  // may leave the building through this endpoint.
  let known = false;
  try {
    known = await brandAssets.isKnownAssetFile(fileId);
  } catch (e) {
    known = false;
  }
  if (!known) {
    return res.status(404).json({ error: 'Asset not found.' });
  }

  // Content type comes from the cached folder listing (no extra Drive call).
  // Non-image entries are refused outright.
  let mime = brandAssets.cachedMimeFor(fileId);
  if (!mime) {
    try {
      const meta = await googleDrive.getFileMeta(fileId);
      mime = meta && meta.mimeType;
    } catch (e) { /* handled by the check below */ }
  }
  if (!mime || !/^image\//i.test(mime)) {
    return res.status(404).json({ error: 'Not an image asset.' });
  }

  // File IDs are immutable — a replaced logo is a new file with a new ID — so
  // the browser can cache aggressively and re-visit pages cost nothing.
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');

  const onAbort = () => {
    try { res.end(); } catch (_) {}
  };
  req.on('aborted', onAbort);
  req.on('close', onAbort);

  try {
    const stream = await googleDrive.downloadFile(fileId);
    stream.on('error', (e) => {
      console.error('[brandAssets] stream error:', e.message);
      if (!res.headersSent) res.status(502).end();
      else res.end();
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[brandAssets] download error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Failed to fetch asset from Drive.' });
  }
});

// ── GET /api/brand-assets/:brand — single resolve ───────────────────────────
// "Cult.fit" → { brand: "Cult.fit", normalizedBrand: "cultfit",
//                logo: "/api/brand-assets/file/…", background: "/api/brand-assets/file/…" }
router.get('/:brand', async (req, res) => {
  try {
    // Express has already percent-decoded the path segment.
    const result = await brandAssets.resolveBrandAssets(req.params.brand);
    res.set('Cache-Control', RESOLVER_CACHE_CONTROL);
    return res.json(result);
  } catch (e) {
    console.error('[brandAssets] resolve error:', e.message);
    return res.status(502).json({ error: 'Brand asset resolution failed.' });
  }
});

module.exports = router;

// ============================================
// SaveHatke — Central brand directory (client)
// ============================================
// Single client-side view of the Admin-managed brand list. Every page that shows
// a brand list, filter, selector or logo reads from here instead of a hardcoded
// array. Source of truth: GET /api/brands (active brands only), backed by the
// Supabase `brands` table. Admin edits take effect on the next page load (the
// server responds with a short public cache).
//
// Exposes on window:
//   SH_BRANDS                 → array of { id, name, category, description, displayOrder, logo }
//   loadBrandDirectory()      → Promise<array>   (fetch once, reuse)
//   brandDirectoryReady       → Promise that resolves once loaded (never rejects)
//   brandLogoFor(name)        → logo URL string or null
//   brandCategoryFor(name)    → category string or null
//   brandNameFor(name)        → canonical display name or the input
//
// Loaded as a classic script before pages that depend on it. Brand logos use
// the /api/brand-assets/file/:id reference, so no Drive credentials reach the
// browser. A failed load leaves SH_BRANDS empty; callers render their own empty
// state rather than crashing.
// ============================================
(function () {
  'use strict';

  var ENDPOINT = '/api/brands';
  var brands = [];
  var byKey = Object.create(null);
  var loading = null;

  function normKey(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  function index(list) {
    byKey = Object.create(null);
    list.forEach(function (b) {
      var k = normKey(b.name);
      if (k && !(k in byKey)) byKey[k] = b;
    });
  }

  function load() {
    if (loading) return loading;
    loading = fetch(ENDPOINT, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : { brands: [] }; })
      .then(function (data) {
        brands = Array.isArray(data && data.brands) ? data.brands : [];
        window.SH_BRANDS = brands;
        index(brands);
        return brands;
      })
      .catch(function () {
        brands = [];
        window.SH_BRANDS = brands;
        index(brands);
        return brands;
      });
    return loading;
  }

  function find(name) {
    return byKey[normKey(name)] || null;
  }

  window.SH_BRANDS = brands;
  window.loadBrandDirectory = load;
  window.brandDirectoryReady = load();
  window.brandLogoFor = function (name) {
    var b = find(name);
    return b && b.logo ? b.logo : null;
  };
  window.brandCategoryFor = function (name) {
    var b = find(name);
    return b ? b.category : null;
  };
  window.brandNameFor = function (name) {
    var b = find(name);
    return b ? b.name : String(name || '');
  };
})();

// ============================================
// SaveHatke — Admin Brands page (Brand Management)
// ============================================
// Drives the Brands section of vault.html (#sec-brands). All data goes through
// the authenticated admin API (/api/admin/brands/*). The browser never sees a
// Drive token; logos are chosen by Drive file id and previewed through the
// server's /api/brand-assets/file/:id reference.
//
// Relies on helpers defined in vault.html / app.js: openModal, closeModal,
// showToast. Loaded at the end of <body>, after those are available.
// ============================================
(function () {
  'use strict';

  var API = '/api/admin/brands';
  var state = { brands: [], categories: [], search: '', status: '', category: '', loading: false };
  var editingId = null;
  var pickedLogo = null; // { id, name, url } chosen in the picker
  var driveFiles = null; // cached Drive logo list for this page session

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, type) {
    if (typeof showToast === 'function') showToast(msg, type || 'info');
  }

  function api(path, opts) {
    opts = opts || {};
    var init = {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(API + path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var err = new Error((data && data.error) || ('Request failed (' + r.status + ')'));
          err.code = data && data.code;
          err.status = r.status;
          throw err;
        }
        return data;
      });
    });
  }

  // ── List ───────────────────────────────────────────────────────────────────
  function loadBrands() {
    state.loading = true;
    renderLoading();
    var qs = new URLSearchParams();
    if (state.search) qs.set('search', state.search);
    if (state.status) qs.set('status', state.status);
    if (state.category) qs.set('category', state.category);
    return api('?' + qs.toString()).then(function (data) {
      state.brands = data.brands || [];
      state.categories = data.categories || [];
      state.loading = false;
      renderFilters();
      renderList();
      renderStats();
    }).catch(function (err) {
      state.loading = false;
      renderError(err.message || 'Could not load brands.');
    });
  }

  function logoHtml(b) {
    if (b.logoFileId) {
      var url = '/api/brand-assets/file/' + encodeURIComponent(b.logoFileId);
      return '<img class="bd-logo" src="' + esc(url) + '" alt="' + esc(b.name) + ' logo" loading="lazy" ' +
        'onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'bd-logo-fallback\',textContent:\'' +
        esc((b.name || '?').charAt(0).toUpperCase()) + '\'}))">';
    }
    return '<span class="bd-logo-fallback">' + esc((b.name || '?').charAt(0).toUpperCase()) + '</span>';
  }

  function renderList() {
    var box = $('brandsList');
    if (!box) return;
    if (!state.brands.length) {
      box.innerHTML = '<div class="bd-empty">No brands match these filters.</div>';
      return;
    }
    box.innerHTML = state.brands.map(function (b) {
      var active = b.isActive !== false;
      return '<div class="bd-row' + (active ? '' : ' bd-row-inactive') + '">' +
        '<div class="bd-row-main">' + logoHtml(b) +
          '<div class="bd-row-text"><div class="bd-name">' + esc(b.name) + '</div>' +
          '<div class="bd-meta">' + esc(b.category) + ' · order ' + esc(b.displayOrder) + '</div></div>' +
        '</div>' +
        '<div class="bd-row-side">' +
          '<span class="bd-count">' + esc(b.couponCount || 0) + ' coupons</span>' +
          '<span class="bd-status ' + (active ? 'on' : 'off') + '">' + (active ? 'Active' : 'Inactive') + '</span>' +
          '<button class="btn btn-sm" data-act="edit" data-id="' + esc(b.id) + '">Edit</button>' +
          '<button class="btn btn-sm" data-act="toggle" data-id="' + esc(b.id) + '" data-active="' + (active ? '1' : '0') + '">' +
            (active ? 'Deactivate' : 'Activate') + '</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderLoading() {
    var box = $('brandsList');
    if (box) box.innerHTML = '<div class="bd-empty">Loading brands…</div>';
  }

  function renderError(msg) {
    var box = $('brandsList');
    if (box) box.innerHTML = '<div class="bd-empty bd-error">' + esc(msg) + '</div>';
  }

  function renderStats() {
    var total = state.brands.length;
    var active = state.brands.filter(function (b) { return b.isActive !== false; }).length;
    var set = function (id, v) { var el = $(id); if (el) el.textContent = String(v); };
    set('brandsStatTotal', total);
    set('brandsStatActive', active);
    set('brandsStatInactive', total - active);
  }

  function renderFilters() {
    var sel = $('brandsCategoryFilter');
    if (!sel) return;
    var current = state.category;
    sel.innerHTML = '<option value="">All categories</option>' +
      (state.categories || []).map(function (c) {
        return '<option value="' + esc(c) + '"' + (c === current ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('');
  }

  // ── Add / edit form ────────────────────────────────────────────────────────
  function fillCategorySelect() {
    var sel = $('brandFormCategory');
    if (!sel) return;
    sel.innerHTML = (state.categories || []).map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');
  }

  function setLogoPreview(url, label) {
    var box = $('brandLogoPreview');
    if (!box) return;
    box.innerHTML = url
      ? '<img src="' + esc(url) + '" alt="' + esc(label || 'Logo preview') + '" class="bd-logo-preview-img">'
      : '<span class="bd-logo-preview-empty">No logo selected</span>';
  }

  function openForm(brand) {
    editingId = brand ? brand.id : null;
    pickedLogo = null;
    $('brandFormTitle').textContent = brand ? 'Edit brand' : 'Add brand';
    $('brandFormName').value = brand ? brand.name : '';
    $('brandFormDescription').value = brand ? (brand.description || '') : '';
    $('brandFormOrder').value = brand ? brand.displayOrder : 0;
    $('brandFormActive').checked = brand ? brand.isActive !== false : true;
    $('brandFormError').textContent = '';
    fillCategorySelect();
    $('brandFormCategory').value = brand ? brand.category : 'General';
    if (brand && brand.logoFileId) {
      pickedLogo = { id: brand.logoFileId, name: brand.name, url: '/api/brand-assets/file/' + encodeURIComponent(brand.logoFileId) };
      setLogoPreview(pickedLogo.url, brand.name);
    } else {
      setLogoPreview(null);
    }
    $('brandFormFileId').value = '';
    openModal('brandFormModal');
  }

  function readForm() {
    return {
      name: $('brandFormName').value,
      category: $('brandFormCategory').value,
      description: $('brandFormDescription').value,
      displayOrder: $('brandFormOrder').value,
      isActive: $('brandFormActive').checked,
      logoFileId: pickedLogo ? pickedLogo.id : '',
    };
  }

  function saveForm() {
    var btn = $('brandFormSave');
    var body = readForm();
    $('brandFormError').textContent = '';
    if (!body.name || !body.name.trim()) {
      $('brandFormError').textContent = 'Brand name is required.';
      return;
    }
    btn.disabled = true;
    var req = editingId
      ? api('/' + encodeURIComponent(editingId), { method: 'PUT', body: body })
      : api('', { method: 'POST', body: body });
    req.then(function () {
      toast(editingId ? 'Brand updated.' : 'Brand created.', 'success');
      closeModal('brandFormModal');
      return loadBrands();
    }).catch(function (err) {
      $('brandFormError').textContent = err.message || 'Could not save the brand.';
    }).finally(function () { btn.disabled = false; });
  }

  function toggleBrand(id, currentlyActive) {
    api('/' + encodeURIComponent(id) + '/active', { method: 'POST', body: { isActive: !currentlyActive } })
      .then(function () {
        toast(currentlyActive ? 'Brand deactivated. It is hidden from new coupons.' : 'Brand activated.', 'success');
        return loadBrands();
      })
      .catch(function (err) { toast(err.message || 'Could not change status.', 'error'); });
  }

  // ── Drive logo picker ──────────────────────────────────────────────────────
  function openPicker() {
    $('brandPickerSearch').value = '';
    openModal('brandPickerModal');
    loadDriveFiles(false);
  }

  function loadDriveFiles(force) {
    var grid = $('brandPickerGrid');
    if (!grid) return;
    if (driveFiles && !force) return renderDriveFiles();
    grid.innerHTML = '<div class="bd-empty">Loading Google Drive logos…</div>';
    api('/drive-logos').then(function (data) {
      driveFiles = data.files || [];
      renderDriveFiles();
    }).catch(function (err) {
      driveFiles = null;
      grid.innerHTML = '<div class="bd-empty bd-error">' + esc(err.message || 'Could not read Google Drive.') + '</div>';
    });
  }

  function renderDriveFiles() {
    var grid = $('brandPickerGrid');
    var q = ($('brandPickerSearch').value || '').trim().toLowerCase();
    var files = (driveFiles || []).filter(function (f) { return !q || f.name.toLowerCase().indexOf(q) !== -1; });
    if (!files.length) {
      grid.innerHTML = '<div class="bd-empty">No logos found. Use the file ID option below.</div>';
      return;
    }
    grid.innerHTML = files.map(function (f) {
      return '<button type="button" class="bd-pick" data-file="' + esc(f.id) + '" data-name="' + esc(f.name) + '">' +
        '<img src="/api/brand-assets/file/' + encodeURIComponent(f.id) + '" alt="" loading="lazy" ' +
        'onerror="this.style.visibility=\'hidden\'">' +
        '<span>' + esc(f.name) + '</span></button>';
    }).join('');
  }

  function choosePickedFile(id, name) {
    pickedLogo = { id: id, name: name, url: '/api/brand-assets/file/' + encodeURIComponent(id) };
    setLogoPreview(pickedLogo.url, name);
    closeModal('brandPickerModal');
  }

  // Manual fallback: paste a Drive file ID or link. The server verifies the file
  // is an accessible image before it is accepted.
  function checkManualFileId() {
    var raw = ($('brandFormFileId').value || '').trim();
    var msg = $('brandFormError');
    msg.textContent = '';
    if (!raw) { msg.textContent = 'Paste a Drive file ID or link first.'; return; }
    api('/drive-logos/check?fileId=' + encodeURIComponent(raw)).then(function (res) {
      if (res.ok) {
        pickedLogo = { id: res.file.id, name: res.file.name, url: res.url };
        setLogoPreview(res.url, res.file.name);
        toast('Logo verified: ' + res.file.name, 'success');
      } else {
        var why = {
          not_found: 'That file was not found in Google Drive.',
          no_access: 'The server cannot access that file. Share it with the Drive account.',
          not_image: 'That file is not an image.',
          drive_unavailable: 'Google Drive is not reachable right now.',
        }[res.reason] || 'That file could not be used.';
        msg.textContent = why;
      }
    }).catch(function (err) { msg.textContent = err.message || 'Could not verify the file.'; });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function bind() {
    var list = $('brandsList');
    if (list) {
      list.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-act]');
        if (!btn) return;
        var id = btn.getAttribute('data-id');
        if (btn.getAttribute('data-act') === 'edit') {
          var found = state.brands.find(function (b) { return b.id === id; });
          if (found) openForm(found);
        } else if (btn.getAttribute('data-act') === 'toggle') {
          toggleBrand(id, btn.getAttribute('data-active') === '1');
        }
      });
    }
    var search = $('brandsSearch');
    if (search) {
      var t = null;
      search.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () { state.search = search.value.trim(); loadBrands(); }, 250);
      });
    }
    var sf = $('brandsStatusFilter');
    if (sf) sf.addEventListener('change', function () { state.status = sf.value; loadBrands(); });
    var cf = $('brandsCategoryFilter');
    if (cf) cf.addEventListener('change', function () { state.category = cf.value; loadBrands(); });

    var add = $('brandsAddBtn');
    if (add) add.addEventListener('click', function () { openForm(null); });
    var save = $('brandFormSave');
    if (save) save.addEventListener('click', saveForm);
    var pick = $('brandPickDriveBtn');
    if (pick) pick.addEventListener('click', openPicker);
    var clear = $('brandClearLogoBtn');
    if (clear) clear.addEventListener('click', function () { pickedLogo = null; setLogoPreview(null); });
    var manual = $('brandCheckFileIdBtn');
    if (manual) manual.addEventListener('click', checkManualFileId);
    var ps = $('brandPickerSearch');
    if (ps) ps.addEventListener('input', renderDriveFiles);
    var pg = $('brandPickerGrid');
    if (pg) pg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-file]');
      if (b) choosePickedFile(b.getAttribute('data-file'), b.getAttribute('data-name'));
    });
    var refresh = $('brandPickerRefresh');
    if (refresh) refresh.addEventListener('click', function () { loadDriveFiles(true); });
  }

  // Load the brands list when the Brands section is opened. loadBrands is also
  // called once on init so the stats are ready on first visit.
  function init() {
    if (!$('sec-brands')) return;
    bind();
    loadBrands();
  }

  window.brandsAdmin = { reload: loadBrands };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

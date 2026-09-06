// ============================================
// SaveHatke — Homepage Testimonial Routes
// ============================================
// The testimonial cards on the landing page. Admins own them outright: they are
// written, edited, hidden and ordered from the admin panel's Reviews section,
// and the homepage renders whatever this returns.
//
// Not to be confused with /api/reviews, which holds real buyer reviews of
// purchased coupons and is scoped to the buyer who wrote them.

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const db = require('../services/googleSheets');

const router = express.Router();

const MAX_NAME = 60;
const MAX_ROLE = 80;
const MAX_QUOTE = 400;

// Written once into an empty Testimonials tab so a fresh install shows the same
// three cards the homepage used to hard-code. Deleting them all is respected —
// the settings row records that seeding already happened.
const STARTER_TESTIMONIALS = [
  {
    name: 'Rahul Kumar',
    role: 'Software Engineer, Bangalore',
    quote: 'I had ₹500 worth of Nykaa coupons I was never going to use. Sold them all on SaveHatke and got cash instantly. Genius concept!',
    rating: 5,
  },
  {
    name: 'Priya Sharma',
    role: 'College Student, Delhi',
    quote: 'The price tracker saved me ₹4,000 on a laptop! It alerted me the moment the price dropped on Flipkart. Absolutely recommend.',
    rating: 5,
  },
  {
    name: 'Aditya Mehta',
    role: 'Freelancer, Mumbai',
    quote: "Bought a Puma coupon for ₹20 that gave ₹500 off. That's a 25x return! SaveHatke is my go-to before any online purchase now.",
    rating: 5,
  },
];

function nowIso() {
  return new Date().toISOString();
}

function toBool(v, dflt = true) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return dflt;
}

/** Initials for the avatar tile, derived from the name so it can never disagree. */
function initialsFor(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '★';
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

function sanitize(row) {
  const rating = Number(row.rating);
  return {
    id: row.id,
    name: row.name || '',
    role: row.role || '',
    quote: row.quote || '',
    rating: Number.isFinite(rating) && rating >= 1 && rating <= 5 ? Math.round(rating) : 5,
    initials: initialsFor(row.name),
    isVisible: toBool(row.isVisible),
    sortOrder: Number(row.sortOrder) || 0,
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
  };
}

/** Display order, with creation time as the tie-break so it is always stable. */
function byDisplayOrder(a, b) {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
}

/**
 * Reject anything that would render as an empty or broken card. Name and quote
 * are required; the role line and rating are optional.
 * @returns {{ok:true, value:object}|{ok:false, error:string}}
 */
function validate(body) {
  const name = String(body.name == null ? '' : body.name).trim();
  const role = String(body.role == null ? '' : body.role).trim();
  const quote = String(body.quote == null ? '' : body.quote).trim();

  if (!name) return { ok: false, error: 'A name is required.' };
  if (name.length > MAX_NAME) return { ok: false, error: `The name must be ${MAX_NAME} characters or fewer.` };
  if (role.length > MAX_ROLE) return { ok: false, error: `The role must be ${MAX_ROLE} characters or fewer.` };
  if (!quote) return { ok: false, error: 'A testimonial quote is required.' };
  if (quote.length > MAX_QUOTE) return { ok: false, error: `The quote must be ${MAX_QUOTE} characters or fewer.` };

  let rating = 5;
  if (body.rating !== undefined && body.rating !== '') {
    rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return { ok: false, error: 'The rating must be a whole number between 1 and 5.' };
    }
  }

  return {
    ok: true,
    value: { name, role, quote, rating, isVisible: toBool(body.isVisible) },
  };
}

/**
 * The heading copy above the cards, which lives with the other site settings.
 * `??` rather than `||`: a field the admin deliberately cleared must stay
 * cleared, and only a setting that was never recorded falls back.
 */
function sectionFrom(settings) {
  return {
    label: settings.testimonialsLabel ?? 'Testimonials',
    title: settings.testimonialsTitle ?? 'Loved by',
    titleHighlight: settings.testimonialsTitleHighlight ?? '10,000+ Smart Shoppers',
    subtitle: settings.testimonialsSubtitle ?? '',
    show: toBool(settings.showTestimonials),
  };
}

/**
 * Write the starter set the first time the tab is read, so a fresh deployment's
 * homepage is not suddenly missing its testimonials. Idempotent, and it only
 * ever runs while `testimonialsSeeded` is unset: once an admin has curated the
 * list, an empty list stays empty.
 */
async function seedIfNeeded(rows, settings) {
  if (rows.length || toBool(settings.testimonialsSeeded, false)) return rows;

  const created = [];
  try {
    for (let i = 0; i < STARTER_TESTIMONIALS.length; i += 1) {
      const row = {
        ...STARTER_TESTIMONIALS[i],
        id: uuidv4(),
        isVisible: 'true',
        sortOrder: String(i + 1),
        createdAt: nowIso(),
        updatedAt: '',
      };
      await db.appendRow(db.SHEETS.TESTIMONIALS, row);
      created.push(row);
    }
    await db.saveSettings({ testimonialsSeeded: true });
  } catch (err) {
    console.warn('[testimonials] seeding warning:', err.message);
  }
  return created;
}

async function loadAll({ seed = false } = {}) {
  const settings = await db.getSettings();
  let rows = await db.getRows(db.SHEETS.TESTIMONIALS);
  rows = (rows || []).filter((r) => r && r.id);
  if (seed) rows = await seedIfNeeded(rows, settings);
  return { settings, testimonials: rows.map(sanitize).sort(byDisplayOrder) };
}

/** The next free slot, so a new testimonial lands at the end of the list. */
function nextSortOrder(list) {
  return list.reduce((max, t) => Math.max(max, t.sortOrder), 0) + 1;
}

// ─── GET /api/testimonials — public: what the homepage renders ────────────
router.get('/', async (req, res) => {
  try {
    const { settings, testimonials } = await loadAll({ seed: true });
    res.json({
      section: sectionFrom(settings),
      testimonials: testimonials
        .filter((t) => t.isVisible)
        .map(({ isVisible, createdAt, updatedAt, sortOrder, ...card }) => card),
    });
  } catch (err) {
    console.error('[testimonials] public list failed:', err.message);
    // The homepage treats an error as "nothing to show" and hides the section,
    // which is preferable to a half-rendered strip of cards.
    res.json({ section: sectionFrom({}), testimonials: [] });
  }
});

// ─── GET /api/testimonials/all — admin: including hidden ones ─────────────
router.get('/all', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { settings, testimonials } = await loadAll({ seed: true });
    res.json({ section: sectionFrom(settings), testimonials });
  } catch (err) {
    console.error('[testimonials] admin list failed:', err.message);
    res.status(500).json({ error: 'Unable to load the testimonials.' });
  }
});

// ─── POST /api/testimonials — admin: add one ──────────────────────────────
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const valid = validate(req.body && typeof req.body === 'object' ? req.body : {});
    if (!valid.ok) return res.status(400).json({ error: valid.error });

    const { testimonials } = await loadAll();
    const row = {
      id: uuidv4(),
      name: valid.value.name,
      role: valid.value.role,
      quote: valid.value.quote,
      rating: String(valid.value.rating),
      isVisible: String(valid.value.isVisible),
      sortOrder: String(nextSortOrder(testimonials)),
      createdAt: nowIso(),
      updatedAt: '',
    };

    await db.appendRow(db.SHEETS.TESTIMONIALS, row);
    res.status(201).json({ message: 'Testimonial added.', testimonial: sanitize(row) });
  } catch (err) {
    console.error('[testimonials] create failed:', err.message);
    res.status(500).json({ error: 'Unable to add the testimonial.' });
  }
});

// ─── PUT /api/testimonials/:id — admin: edit one ──────────────────────────
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const existing = await db.findRow(db.SHEETS.TESTIMONIALS, 'id', id);
    if (!existing) return res.status(404).json({ error: 'That testimonial no longer exists.' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // A visibility-only flip posts nothing else, so fall back to what is stored
    // rather than validating absent fields as empty.
    const valid = validate({
      name: body.name !== undefined ? body.name : existing.name,
      role: body.role !== undefined ? body.role : existing.role,
      quote: body.quote !== undefined ? body.quote : existing.quote,
      rating: body.rating !== undefined ? body.rating : existing.rating,
      isVisible: body.isVisible !== undefined ? body.isVisible : existing.isVisible,
    });
    if (!valid.ok) return res.status(400).json({ error: valid.error });

    const updates = {
      name: valid.value.name,
      role: valid.value.role,
      quote: valid.value.quote,
      rating: String(valid.value.rating),
      isVisible: String(valid.value.isVisible),
      updatedAt: nowIso(),
    };
    await db.updateRow(db.SHEETS.TESTIMONIALS, 'id', id, updates);

    res.json({ message: 'Testimonial updated.', testimonial: sanitize({ ...existing, ...updates }) });
  } catch (err) {
    console.error('[testimonials] update failed:', err.message);
    res.status(500).json({ error: 'Unable to update the testimonial.' });
  }
});

// ─── DELETE /api/testimonials/:id — admin: remove one ─────────────────────
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const existing = await db.findRow(db.SHEETS.TESTIMONIALS, 'id', id);
    if (!existing) return res.status(404).json({ error: 'That testimonial no longer exists.' });

    await db.deleteRow(db.SHEETS.TESTIMONIALS, 'id', id);
    res.json({ message: 'Testimonial deleted.', deleted: id });
  } catch (err) {
    console.error('[testimonials] delete failed:', err.message);
    res.status(500).json({ error: 'Unable to delete the testimonial.' });
  }
});

// ─── POST /api/testimonials/:id/move — admin: reorder ─────────────────────
// Swaps the card with its neighbour and rewrites both slots, so the saved order
// stays a clean 1..n even if the sheet was edited by hand.
router.post('/:id/move', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const direction = String((req.body || {}).direction || '').toLowerCase();
    if (direction !== 'up' && direction !== 'down') {
      return res.status(400).json({ error: 'Direction must be "up" or "down".' });
    }

    const { testimonials } = await loadAll();
    const index = testimonials.findIndex((t) => t.id === id);
    if (index === -1) return res.status(404).json({ error: 'That testimonial no longer exists.' });

    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= testimonials.length) {
      return res.json({ message: 'Already at the end of the list.', moved: false });
    }

    const reordered = [...testimonials];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

    for (let i = 0; i < reordered.length; i += 1) {
      const slot = i + 1;
      if (reordered[i].sortOrder === slot) continue;
      await db.updateRow(db.SHEETS.TESTIMONIALS, 'id', reordered[i].id, {
        sortOrder: String(slot),
        updatedAt: nowIso(),
      });
      reordered[i].sortOrder = slot;
    }

    res.json({ message: 'Order updated.', moved: true, testimonials: reordered });
  } catch (err) {
    console.error('[testimonials] reorder failed:', err.message);
    res.status(500).json({ error: 'Unable to reorder the testimonials.' });
  }
});

module.exports = router;

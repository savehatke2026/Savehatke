// ============================================
// SaveHatke — Pricing configuration (admin-editable)
// ============================================
// Holds the values the admin can tune without a deploy:
//   • maximumDiscountTiers — used when a coupon has no face value but has a
//     maximum discount. Each tier covers max discount up to `maxRupees`.
//   • manualFinalPercentOff — default last-24h discount applied to a manual
//     normal price when the admin gives no explicit final price.
//
// Stored under the single `pricing_config` key in the existing Supabase
// `site_settings` table (the same jsonb key/value store maintenance mode uses),
// so there is no new table and no competing source of truth.
//
// The buyer-price path is synchronous and runs on every listing and purchase,
// so it reads a cached copy. The cache is refreshed from Supabase at startup
// and on every admin save; if Supabase is unreachable the built-in defaults
// are used, so pricing keeps working and never invents a value.

const DEFAULT_CONFIG = Object.freeze({
  // maxRupees is inclusive. The last tier is open-ended (Infinity) so every
  // maximum discount above ₹1,000 still has a price.
  maximumDiscountTiers: Object.freeze([
    Object.freeze({ maxRupees: 100, normal: 10, final: 5 }),
    Object.freeze({ maxRupees: 300, normal: 20, final: 10 }),
    Object.freeze({ maxRupees: 500, normal: 30, final: 15 }),
    Object.freeze({ maxRupees: 1000, normal: 50, final: 25 }),
    Object.freeze({ maxRupees: null, normal: 100, final: 50 }), // above ₹1,000
  ]),
  manualFinalPercentOff: 50,
});

const SETTING_KEY = 'pricing_config';
const CACHE_TTL_MS = 60 * 1000;

let cached = { value: DEFAULT_CONFIG, loadedAt: 0 };

function isNonNegNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** Validate and normalise a config object. Returns { ok, config, errors }. */
function normaliseConfig(input) {
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};

  const pct = Number(src.manualFinalPercentOff ?? DEFAULT_CONFIG.manualFinalPercentOff);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    errors.push('Default last-24-hours discount must be between 0 and 100%.');
  }

  const rawTiers = Array.isArray(src.maximumDiscountTiers) ? src.maximumDiscountTiers : DEFAULT_CONFIG.maximumDiscountTiers;
  const tiers = rawTiers.map((t, i) => ({
    maxRupees: t.maxRupees === null || t.maxRupees === undefined ? null : Number(t.maxRupees),
    normal: Number(t.normal),
    final: Number(t.final),
    index: i,
  }));
  if (tiers.length === 0) errors.push('At least one maximum-discount tier is required.');
  for (const t of tiers) {
    if (t.maxRupees !== null && (!isNonNegNumber(t.maxRupees) || t.maxRupees <= 0)) {
      errors.push(`Tier ${t.index + 1}: maximum discount must be a positive amount.`);
    }
    if (!isNonNegNumber(t.normal)) errors.push(`Tier ${t.index + 1}: normal price must be zero or more.`);
    if (!isNonNegNumber(t.final)) errors.push(`Tier ${t.index + 1}: last-24-hours price must be zero or more.`);
    if (isNonNegNumber(t.normal) && isNonNegNumber(t.final) && t.final > t.normal) {
      errors.push(`Tier ${t.index + 1}: last-24-hours price cannot exceed the normal price.`);
    }
  }
  // Tiers must rise strictly and the last one must be open-ended, so every
  // maximum discount maps to exactly one tier.
  const bounded = tiers.filter((t) => t.maxRupees !== null).sort((a, b) => a.maxRupees - b.maxRupees);
  for (let i = 1; i < bounded.length; i += 1) {
    if (bounded[i].maxRupees === bounded[i - 1].maxRupees) errors.push('Tier maximums must be unique.');
  }
  if (tiers.length && tiers[tiers.length - 1].maxRupees !== null) {
    errors.push('The last tier must be open-ended (no maximum) so every amount has a price.');
  }
  if (errors.length) return { ok: false, config: null, errors };

  // Keep the admin's order, sorted by maximum so lookup is a simple scan.
  const sorted = [...tiers].sort((a, b) => {
    if (a.maxRupees === null) return 1;
    if (b.maxRupees === null) return -1;
    return a.maxRupees - b.maxRupees;
  });
  return {
    ok: true,
    errors: [],
    config: {
      maximumDiscountTiers: sorted.map((t) => ({ maxRupees: t.maxRupees, normal: t.normal, final: t.final })),
      manualFinalPercentOff: pct,
    },
  };
}

/**
 * Pick the tier for a maximum discount given in paise. Returns normal/final
 * in paise. Boundaries are inclusive: ₹100 falls in the "up to ₹100" tier.
 */
function tierFor(config, maxPaise) {
  const tiers = (config && config.maximumDiscountTiers) || DEFAULT_CONFIG.maximumDiscountTiers;
  for (const t of tiers) {
    const limitPaise = t.maxRupees === null ? Infinity : Math.round(t.maxRupees * 100);
    if (maxPaise <= limitPaise) {
      return { normalPaise: Math.round(t.normal * 100), finalPaise: Math.round(t.final * 100) };
    }
  }
  const last = tiers[tiers.length - 1];
  return { normalPaise: Math.round(last.normal * 100), finalPaise: Math.round(last.final * 100) };
}

/** True when the config has at least one usable tier (validation helper). */
function tierForConfigured(config) {
  return Boolean(config && Array.isArray(config.maximumDiscountTiers) && config.maximumDiscountTiers.length > 0);
}

function getCachedConfig() {
  return cached.value;
}

/** Load from Supabase site_settings. Falls back to defaults on any problem. */
async function refreshConfig(getSiteSetting) {
  try {
    const row = await getSiteSetting(SETTING_KEY);
    const candidate = row && row.value ? row.value : null;
    const result = candidate ? normaliseConfig(candidate) : { ok: true, config: DEFAULT_CONFIG };
    cached = { value: result.ok ? result.config : DEFAULT_CONFIG, loadedAt: Date.now() };
  } catch (err) {
    console.warn('pricing config: using defaults —', err.message);
    cached = { value: DEFAULT_CONFIG, loadedAt: Date.now() };
  }
  return cached.value;
}

/** Save a validated config to Supabase, then refresh the cache. */
async function saveConfig(setSiteSetting, input, updatedBy) {
  const result = normaliseConfig(input);
  if (!result.ok) return { ok: false, errors: result.errors };
  await setSiteSetting(SETTING_KEY, result.config, updatedBy);
  cached = { value: result.config, loadedAt: Date.now() };
  return { ok: true, config: result.config };
}

module.exports = {
  DEFAULT_CONFIG,
  SETTING_KEY,
  CACHE_TTL_MS,
  normaliseConfig,
  tierFor,
  tierForConfigured,
  getCachedConfig,
  refreshConfig,
  saveConfig,
};

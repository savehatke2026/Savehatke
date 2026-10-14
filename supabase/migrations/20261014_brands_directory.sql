-- ============================================
-- SaveHatke — Supabase migration: centralized Brand directory
-- ============================================
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent: safe to re-run. Non-destructive: no coupon, purchase, payment or
-- transaction row is modified except for the nullable brand_id link.
--
-- 1) brands — the single authoritative brand list. Admins create, rename,
--    re-logo, reorder and (de)activate brands from the Admin Panel.
--    * id           stable identifier (text, slug-derived, never changes)
--    * name         display name (unique on normalized key, see brands_key_uq)
--    * key          normalized match key — lowercase, a-z0-9 only (same rule as
--                   normalizeBrand() in server/services/brandAssets.js)
--    * category     one of the existing website categories (free text, checked
--                   by the server against the category list)
--    * description  optional short blurb
--    * logo_file_id Google Drive file id of the logo (image reference only —
--                   no binary is stored). NULL → brand-name Drive lookup/placeholder.
--    * display_order  ascending sort for public lists
--    * is_active    soft-deactivation switch. Brands are never hard-deleted once
--                   linked to coupons; deactivate instead.
--
-- 2) coupons.brand_id — optional link to brands.id. The existing coupons.brand
--    text column is KEPT and remains the display fallback, so every existing
--    coupon keeps its brand name even if the link is NULL.
--
-- 3) Backfill — creates one brands row per distinct existing coupon brand
--    (matched on normalized key, so "Cult.fit" and "cult fit" become ONE row)
--    and links coupons to it. Rows whose brand is blank stay unlinked.
-- ============================================

CREATE TABLE IF NOT EXISTS brands (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  key           TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'General',
  description   TEXT NOT NULL DEFAULT '',
  logo_file_id  TEXT DEFAULT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brands_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT brands_key_not_blank CHECK (length(key) > 0)
);

-- Duplicate prevention: one brand per normalized key, regardless of case,
-- spacing, punctuation or diacritics applied by the server before insert.
CREATE UNIQUE INDEX IF NOT EXISTS brands_key_uq ON brands (key);
CREATE INDEX IF NOT EXISTS idx_brands_active_order ON brands (is_active, display_order, name);

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS brand_id TEXT DEFAULT NULL
  REFERENCES brands(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_coupons_brand_id ON coupons (brand_id);

-- Backfill. Deterministic id = 'b_' + key, so re-running is a no-op.
INSERT INTO brands (id, name, key, category)
SELECT DISTINCT ON (regexp_replace(lower(btrim(c.brand)), '[^a-z0-9]', '', 'g'))
       'b_' || regexp_replace(lower(btrim(c.brand)), '[^a-z0-9]', '', 'g'),
       btrim(c.brand),
       regexp_replace(lower(btrim(c.brand)), '[^a-z0-9]', '', 'g'),
       COALESCE(NULLIF(btrim(c.category), ''), 'General')
FROM coupons c
WHERE c.brand IS NOT NULL
  AND regexp_replace(lower(btrim(c.brand)), '[^a-z0-9]', '', 'g') <> ''
ON CONFLICT (key) DO NOTHING;

UPDATE coupons c
SET brand_id = 'b_' || regexp_replace(lower(btrim(c.brand)), '[^a-z0-9]', '', 'g')
WHERE c.brand_id IS NULL
  AND c.brand IS NOT NULL
  AND regexp_replace(lower(btrim(c.brand)), '[^a-z0-9]', '', 'g') <> '';

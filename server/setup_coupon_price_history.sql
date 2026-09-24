-- ============================================
-- SaveHatke — Coupon Price History Migration
-- ============================================
-- Creates a price history audit table for tracking admin coupon dynamic pricing changes.
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- This is idempotent and safe to re-run.
--
-- IMPORTANT: This does NOT modify the existing coupons table structure.
-- The coupons table remains the single source of truth for current coupon data.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. Create coupon_price_history table
-- ══════════════════════════════════════════════════════════════════════════
-- This table is ONLY for audit/history tracking.
-- It records when an admin coupon's price changes due to entering a new pricing band.
-- It is NOT used to calculate the current price (that's done dynamically from expiry_date).

CREATE TABLE IF NOT EXISTS coupon_price_history (
  id BIGSERIAL PRIMARY KEY,
  coupon_id TEXT NOT NULL,
  old_price DECIMAL(10, 2) NOT NULL,
  new_price DECIMAL(10, 2) NOT NULL,
  old_band TEXT NOT NULL,
  new_band TEXT NOT NULL,
  days_remaining INTEGER NOT NULL,
  change_reason TEXT NOT NULL DEFAULT 'dynamic_pricing_band_change',
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. Add foreign key constraint
-- ══════════════════════════════════════════════════════════════════════════
-- Links to the coupons table. ON DELETE CASCADE ensures history records are
-- removed if the coupon itself is deleted (keeps the DB clean).

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'fk_coupon_price_history_coupon_id'
  ) THEN
    ALTER TABLE coupon_price_history 
    ADD CONSTRAINT fk_coupon_price_history_coupon_id 
    FOREIGN KEY (coupon_id) 
    REFERENCES coupons(id) 
    ON DELETE CASCADE;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. Create indexes for efficient queries
-- ══════════════════════════════════════════════════════════════════════════
-- These indexes optimize the common queries:
-- - Fetching history for a specific coupon (admin panel)
-- - Ordering by timestamp (most recent first)
-- - Finding changes within a date range

CREATE INDEX IF NOT EXISTS idx_coupon_price_history_coupon_id 
  ON coupon_price_history (coupon_id);

CREATE INDEX IF NOT EXISTS idx_coupon_price_history_changed_at 
  ON coupon_price_history (changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_coupon_price_history_coupon_changed 
  ON coupon_price_history (coupon_id, changed_at DESC);

-- ══════════════════════════════════════════════════════════════════════════
-- 4. Add comment to table for documentation
-- ══════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE coupon_price_history IS 
'Audit trail for admin coupon dynamic pricing changes. Records when a coupon enters a new pricing band. NOT used for current price calculation.';

COMMENT ON COLUMN coupon_price_history.coupon_id IS 
'Foreign key to coupons.id. Only admin coupons (source=admin) have dynamic pricing.';

COMMENT ON COLUMN coupon_price_history.old_band IS 
'Previous pricing band (e.g., "45-36" means 45 to 36 days remaining).';

COMMENT ON COLUMN coupon_price_history.new_band IS 
'New pricing band that triggered the price change.';

COMMENT ON COLUMN coupon_price_history.days_remaining IS 
'Days until coupon expiry when this price change occurred.';

COMMENT ON COLUMN coupon_price_history.change_reason IS 
'Reason for price change. Default: dynamic_pricing_band_change';

-- ══════════════════════════════════════════════════════════════════════════
-- Migration complete
-- ══════════════════════════════════════════════════════════════════════════

-- Verify table exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'coupon_price_history') THEN
    RAISE NOTICE '✅ coupon_price_history table created successfully';
  ELSE
    RAISE EXCEPTION '❌ Failed to create coupon_price_history table';
  END IF;
END $$;

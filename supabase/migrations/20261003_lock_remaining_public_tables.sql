-- ============================================================================
-- SaveHatke — close the remaining browser-reachable tables and stop new ones
-- from being created open.
--
-- WHY THIS EXISTS
-- 20261002_server_only_sensitive_tables.sql locked an explicit list of tables.
-- Two gaps survived it:
--
--   1. `coupon_price_history` is created by server/setup_coupon_price_history.sql
--      with no ENABLE ROW LEVEL SECURITY and no REVOKE. A table created through
--      the Supabase SQL editor inherits the default privileges for the `anon`
--      and `authenticated` roles, so if that script was ever run, the public
--      anon key could read — and write — SaveHatke's pricing history. The table
--      is referenced by no server code; it is pure attack surface.
--
--   2. Every OTHER table created in `public` after this migration would inherit
--      the same default grants. Adding one new feature table was enough to
--      reopen the hole, and nothing in the repo would have caught it.
--
-- WHAT IT DOES
--   * Locks `coupon_price_history` (and any other public table that is not
--     already service-role-only) the same way the sensitive list is locked.
--   * Sweeps EVERY table in `public` rather than a hand-maintained list, so a
--     table this file has never heard of is still covered.
--   * Revokes the default privileges for anon/authenticated so future tables
--     are created closed.
--
-- RLS state and grants are catalog reads, so this is safe to run repeatedly.
-- It does not drop or modify data.
-- ============================================================================

DO $$
DECLARE
  v_table TEXT;
  v_relation REGCLASS;
  v_policy RECORD;
BEGIN
  -- Sweep every ordinary/partitioned table in the public schema. Everything in
  -- this application is server-accessed only: the browser talks to the Express
  -- API, never to Supabase directly (no Supabase URL or key ships to the
  -- frontend).
  FOR v_table IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  LOOP
    v_relation := to_regclass(format('public.%I', v_table));
    CONTINUE WHEN v_relation IS NULL;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_relation);

    -- Drop any policy that could let a browser role through. Nothing in this
    -- app relies on one: access is via the service-role client only.
    FOR v_policy IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = v_table
    LOOP
      EXECUTE format('DROP POLICY %I ON %s', v_policy.policyname, v_relation);
    END LOOP;

    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated', v_relation);
    EXECUTE format('GRANT ALL ON TABLE %s TO service_role', v_relation);
  END LOOP;
END;
$$;

-- Stop the next table from being created open. Without this, the sweep above
-- has to be re-run after every new feature; with it, a new table is private by
-- default and has to be granted explicitly (which is the direction we want).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;

-- Sequences back identity/serial columns; the same reasoning applies.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;

-- ── Verification (run manually after applying) ──────────────────────────────
-- Expect ZERO rows from both queries. Any row is a browser-reaching grant that
-- must be revoked.
--
--   SELECT tablename, rowsecurity
--   FROM pg_tables
--   WHERE schemaname = 'public' AND rowsecurity = false;
--
--   SELECT grantee, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_schema = 'public'
--     AND grantee IN ('anon', 'authenticated');

-- SaveHatke accesses these sensitive tables only through its server-side
-- service-role client. Remove browser-role grants and policies so a public
-- Supabase key cannot read sessions, identities, coupons, refunds, or stored
-- provider credentials directly. The app's Express APIs remain the user-facing
-- access path and perform their own authentication/authorization checks.
DO $$
DECLARE
  v_table TEXT;
  v_relation REGCLASS;
  v_policy RECORD;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'users',
    'coupons',
    'user_sessions',
    'admin_sessions',
    'sessions',
    'site_settings',
    'backup_codes',
    'refunds',
    'security_credentials',
    'payment_mailbox_credentials',
    'seller_payout_reservations'
  ] LOOP
    v_relation := to_regclass(format('public.%I', v_table));
    IF v_relation IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_relation);

    -- The browser has no direct Supabase data path in this application.
    -- Drop existing policies on these sensitive tables so previously deployed
    -- broad policies cannot outlive this server-only access model.
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

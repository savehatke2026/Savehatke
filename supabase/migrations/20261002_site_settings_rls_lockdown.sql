-- The original maintenance_mode migration created a permissive policy without
-- a role target. Close browser-role access on already-deployed databases.
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access" ON public.site_settings;
REVOKE ALL ON TABLE public.site_settings FROM anon, authenticated;
GRANT ALL ON TABLE public.site_settings TO service_role;
CREATE POLICY "Service role full access" ON public.site_settings
  TO service_role
  FOR ALL
  USING (true)
  WITH CHECK (true);

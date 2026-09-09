-- Maintenance whitelist seeding has been removed.
-- The previous implementation gave specific user emails a maintenance
-- bypass, but the new requirements explicitly forbid that. The only
-- maintenance bypass is the admin role, decided server-side from the
-- JWT, and there is no allow-list table or row to create.
--
-- This migration is kept as a no-op so anyone who runs the old
-- `supabase/migrations/maintenance_whitelist.sql` against a fresh
-- database gets a clean exit instead of a syntax error.
SELECT 1;

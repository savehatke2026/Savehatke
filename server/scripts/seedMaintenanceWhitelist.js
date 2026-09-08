// ============================================
// SaveHatke — Maintenance Whitelist Seed Script
// ============================================
// Stores the trusted-user allow-list in Supabase (site_settings key
// `maintenance_whitelist`). When maintenance mode is ON, only these
// addresses — plus the hardcoded admin accounts — can sign in.
//
// Run with: `node server/scripts/seedMaintenanceWhitelist.js`

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const supabase = require('../services/supabase');

const DEFAULT_WHITELIST = [
  'rupayandas2026@gmail.com',
  'rupayandas2025@gmail.com',
];

async function runSeed() {
  if (!supabase.isConfigured()) {
    console.error('❌ Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env first.');
    process.exit(1);
  }

  // Ensure the site_settings table exists (idempotent).
  try {
    await supabase.ensureSiteSettingsTable();
  } catch (e) {
    console.warn('⚠️  ensureSiteSettingsTable warning:', e.message);
  }

  // Read existing whitelist and merge with the default seed so we never
  // accidentally drop addresses the admin has typed in by hand.
  let existing = [];
  try {
    const current = await supabase.getMaintenanceWhitelist();
    existing = Array.from(current || []);
  } catch (e) {
    existing = [];
  }

  const merged = Array.from(new Set(
    [...existing, ...DEFAULT_WHITELIST]
      .map((e) => String(e).toLowerCase().trim())
      .filter((e) => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
  ));

  const added = merged.filter((e) => !existing.includes(e));

  try {
    const result = await supabase.setMaintenanceWhitelist(merged, 'seed-script');
    console.log(`✅ Maintenance whitelist saved (${result.emails.length} email(s)).`);
    if (added.length) {
      console.log('   Newly added:');
      added.forEach((e) => console.log('   • ' + e));
    } else {
      console.log('   (No new addresses — defaults were already present.)');
    }
    console.log('\nFull list:');
    result.emails.forEach((e) => console.log('   • ' + e));
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to save whitelist:', err.message);
    process.exit(1);
  }
}

runSeed();

// Seeds / replaces the sell whitelist in Supabase site_settings.
// Usage:
//   node server/scripts/seedSellWhitelist.js email1@example.com email2@example.com
//   node server/scripts/seedSellWhitelist.js            # prints current list
//   node server/scripts/seedSellWhitelist.js --clear     # empties the list
// Emails are normalised (trimmed, lowercased, deduped) by the service.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in the server .env.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const supabase = require('../services/supabase');

async function main() {
  if (!supabase.isConfigured()) {
    console.error('✖ Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in server/.env.');
    process.exit(1);
  }

  const args = process.argv.slice(2);

  if (args.includes('--clear')) {
    const result = await supabase.setSellWhitelist([], 'seed-script');
    console.log(`✔ Sell whitelist cleared.`);
    return;
  }

  if (args.length === 0) {
    const emails = await supabase.getSellWhitelist();
    console.log(`Sell whitelist (${emails.length} email${emails.length === 1 ? '' : 's'}):`);
    emails.forEach((e) => console.log(`  ${e}`));
    return;
  }

  const result = await supabase.setSellWhitelist(args, 'seed-script');
  console.log(`✔ Saved ${result.emails.length} whitelisted email${result.emails.length === 1 ? '' : 's'}:`);
  result.emails.forEach((e) => console.log(`  ${e}`));
}

main().catch((err) => {
  console.error('✖ Failed to update sell whitelist:', err.message);
  process.exit(1);
});

// ============================================
// SaveHatke — Verify the security_credentials table (post-rename)
// ============================================
// READ-ONLY. Confirms the rename/migration succeeded WITHOUT ever printing the
// refresh token. Prints:
//   * which table name is live (security_credentials vs legacy),
//   * the row count,
//   * the safe fields for each row,
//   * whether the new authorized_at / estimated_expires_at columns exist,
//   * whether encrypted_refresh_token is present (length only, never the value).
//
// Usage (from the project root):
//   node server/scripts/verify-security-credentials.js
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in the environment.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { createClient } = require('@supabase/supabase-js');

const SAFE = 'email, status, connected_at, authorized_at, estimated_expires_at, last_verified_at, last_used_at, last_error, updated_at';

(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set.');
    process.exit(1);
  }
  const c = createClient(url, key);

  const isMissingRelation = (e) =>
    e && (e.code === '42P01' || e.code === 'PGRST205' ||
      /does not exist|could not find the table|schema cache/i.test(e.message || ''));

  let live = null;
  for (const t of ['security_credentials', 'payment_mailbox_credentials']) {
    // A real (non-head) select surfaces a missing-relation error reliably;
    // a missing-COLUMN error still means the table itself exists.
    const { error } = await c.from(t).select('email').limit(1);
    if (!error || !isMissingRelation(error)) { live = t; break; }
  }
  if (!live) {
    console.error('❌ Neither security_credentials nor payment_mailbox_credentials is reachable.');
    process.exit(1);
  }

  console.log('\n=== security_credentials verification ===');
  console.log('Live table            :', live, live === 'security_credentials' ? '✅ (renamed)' : '⚠️ (rename SQL not applied yet)');

  // Safe columns + row count.
  const { data, error, count } = await c.from(live).select(SAFE, { count: 'exact' });
  const hasNewCols = !error;
  if (error && /authorized_at|estimated_expires_at|column/i.test(error.message)) {
    console.log('New columns           : ❌ authorized_at / estimated_expires_at NOT found — apply the rename SQL.');
    const base = await c.from(live).select('email, status, connected_at, updated_at', { count: 'exact' });
    console.log('Row count             :', base.count);
    (base.data || []).forEach((r) => console.log('  row:', JSON.stringify(r)));
  } else if (error) {
    console.error('Query error           :', error.message);
    process.exit(1);
  } else {
    console.log('New columns           : ✅ authorized_at + estimated_expires_at present');
    console.log('Row count             :', count);
    (data || []).forEach((r) => console.log('  row:', JSON.stringify(r)));
  }

  // Token presence (length only — NEVER the value).
  const { data: t, error: te } = await c.from(live).select('email, encrypted_refresh_token');
  if (!te) {
    (t || []).forEach((r) =>
      console.log(
        '  token[' + r.email + ']    :',
        r.encrypted_refresh_token ? 'present (encrypted, len=' + String(r.encrypted_refresh_token).length + ')' : 'MISSING'
      )
    );
  }

  console.log('\nDone. (No secret values were printed.)\n');
  process.exit(0);
})().catch((e) => {
  console.error('Unexpected error:', e.message);
  process.exit(1);
});

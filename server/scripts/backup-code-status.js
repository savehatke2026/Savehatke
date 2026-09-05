// ============================================
// SaveHatke — Backup-code status check
// ============================================
// Quick diagnostic: shows whether the server route is registered,
// whether MongoDB is reachable, and how many codes are stored.
//
// Run: node server/scripts/backup-code-status.js

const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const Y = '\x1b[33m', G = '\x1b[32m', R = '\x1b[31m', C = '\x1b[36m', X = '\x1b[0m';

function pad(s, n) { return String(s).padEnd(n); }

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

(async () => {
  console.log(`${Y}╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  SaveHatke — Backup-code diagnostic                         ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝${X}\n`);

  // 1) Try the public status endpoint (no auth required)
  console.log(`${C}[1/4]${X} Pinging /api/admin/backup-code/status on localhost:3000…`);
  const r = await get('http://localhost:3000/api/admin/backup-code/status');
  if (r.error) {
    console.log(`  ${R}✗ Server unreachable${X} — ${r.error}`);
    console.log(`  ${Y}Tip:${X} Start the server with \`cd server && node server.js\` first.`);
  } else if (r.status === undefined) {
    console.log(`  ${R}✗ Server didn't respond${X} (port likely closed).`);
    console.log(`  ${Y}Tip:${X} Start the server with \`cd server && node server.js\` first.`);
  } else if (r.status === 200) {
    console.log(`  ${G}✓ Server is up and the route is mounted.${X}`);
    try {
      const j = JSON.parse(r.data);
      // The endpoint is unauthenticated, so it publishes one bit and nothing
      // else: whether any code store can be reached. Counts and identities moved
      // to GET /admin/list behind admin auth.
      console.log(`     available  : ${j.available}`);
    } catch (e) {}
  } else {
    console.log(`  ${R}✗ HTTP ${r.status}${X} — server responded but the route is not mounted.`);
    console.log(`  Body: ${(r.data || '').slice(0, 200)}`);
  }
  console.log('');

  // 2) Read every code store directly
  const header = () => {
    console.log(`     ${pad('prefix', 8)}  ${pad('label', 30)}  ${pad('active', 6)}  ${pad('uses', 4)}  ${pad('cap', 4)}  ${pad('expires', 12)}  created`);
    console.log(`     ${'-'.repeat(96)}`);
  };
  const printRow = (r) => {
    const d = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
    console.log(
      `     ${pad(r.codePrefix, 8)}  ${pad((r.label || '').slice(0, 30), 30)}  ${pad(String(r.isActive !== false), 6)}  ${pad(String(r.usageCount || 0), 4)}  ${pad(r.maxUses == null ? '1*' : r.maxUses, 4)}  ${pad(r.expiresAt ? d(r.expiresAt) : 'never', 12)}  ${d(r.created_at)}`
    );
  };

  console.log(`${C}[2/4]${X} Reading Supabase (table backup_codes)…`);
  try {
    const supabase = require('../services/supabase');
    if (!supabase.isConfigured()) {
      console.log(`  ${Y}· SUPABASE_URL / SUPABASE_SERVICE_KEY not set — skipping.${X}`);
    } else {
      const rows = await supabase.listAllBackupCodes({ includeInactive: true });
      if (rows === null) {
        console.log(`  ${R}✗ backup_codes table is missing.${X}`);
        console.log(`  ${Y}Fix:${X} run supabase/migrations/backup_codes.sql in the Supabase SQL Editor.`);
      } else if (!rows.length) {
        console.log(`  ${G}✓ Connected.${X} No codes stored yet — register one first.`);
      } else {
        console.log(`  ${G}✓ Connected. Found ${rows.length} backup code(s):${X}\n`);
        header();
        rows.forEach(printRow);
      }
    }
  } catch (e) {
    console.log(`  ${R}✗ ${e.message.split('\n')[0]}${X}`);
  }
  console.log('');

  console.log(`${C}[3/4]${X} Reading MongoDB…`);
  try {
    const mongoose = require('mongoose');
    const BackupCode = require('../models/BackupCode');
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 6000, bufferCommands: false });
    const rows = await BackupCode.find({}).select('+codeHash codePrefix label isActive usageCount maxUses expiresAt createdBy created_at').lean();
    console.log(`  ${G}✓ MongoDB connected. Found ${rows.length} backup code(s):${X}\n`);
    if (rows.length === 0) {
      console.log(`     (none yet — register the code first)`);
    } else {
      header();
      rows.forEach(printRow);
    }
    await mongoose.disconnect();
  } catch (e) {
    console.log(`  ${R}✗ ${e.message.split('\n')[0]}${X}`);
  }
  console.log('');
  console.log(`  ${Y}*${X} cap "1*" means no explicit maxUses, which the SOS route treats as single use.`);
  console.log('');

  // 4) Quick sanity: is the route file present + has the expected endpoints?
  console.log(`${C}[4/4]${X} Verifying the SOS routes are in place…`);
  const fs = require('fs');
  const routeFile = path.join(__dirname, '..', 'routes', 'backupCode.js');
  const sosFile = path.join(__dirname, '..', 'routes', 'sos.js');
  if (fs.existsSync(routeFile) && fs.existsSync(sosFile)) {
    const src = fs.readFileSync(routeFile, 'utf8');
    const sos = fs.readFileSync(sosFile, 'utf8');
    const has = (haystack, s) => (haystack.includes(s) ? `${G}✓${X}` : `${R}✗${X}`);
    console.log(`     sos /check-code (the gate)  : ${has(sos, "router.post('/check-code'")}`);
    console.log(`     sos /start                  : ${has(sos, "router.post('/start'")}`);
    console.log(`     sos /select-admin           : ${has(sos, "router.post('/select-admin'")}`);
    console.log(`     sos /verify                 : ${has(sos, "router.post('/verify'")}`);
    console.log(`     multi-store code lookup     : ${has(sos, 'backupCodeStore.listActiveCandidates')}`);
    console.log(`     /status endpoint            : ${has(src, "router.get('/status'")}`);
    console.log(`     /admin/create endpoint      : ${has(src, "router.post('/admin/create'")}`);
    console.log(`     /admin/list endpoint        : ${has(src, "router.get('/admin/list'")}`);
  } else {
    console.log(`  ${R}✗ Route file missing (${routeFile} / ${sosFile})${X}`);
  }
  console.log('');
  console.log(`${Y}Done. Share this output if you need help debugging.${X}`);
})();

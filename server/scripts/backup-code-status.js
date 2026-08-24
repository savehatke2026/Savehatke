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
  console.log(`${C}[1/3]${X} Pinging /api/admin/backup-code/status on localhost:3000…`);
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
      console.log(`     mongoReady : ${j.mongoReady}`);
      console.log(`     codes      : ${j.codeCount} total, ${j.activeCount} active`);
      console.log(`     admins     : ${(j.admins || []).map((a) => a.email).join(', ')}`);
    } catch (e) {}
  } else {
    console.log(`  ${R}✗ HTTP ${r.status}${X} — server responded but the route is not mounted.`);
    console.log(`  Body: ${(r.data || '').slice(0, 200)}`);
  }
  console.log('');

  // 2) Check Mongo directly
  console.log(`${C}[2/3]${X} Connecting to MongoDB…`);
  try {
    const mongoose = require('mongoose');
    const BackupCode = require('../models/BackupCode');
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 6000, bufferCommands: false });
    const rows = await BackupCode.find({}).select('+codeHash codePrefix label isActive usageCount maxUses expiresAt createdBy created_at');
    console.log(`  ${G}✓ MongoDB connected. Found ${rows.length} backup code(s):${X}\n`);
    if (rows.length === 0) {
      console.log(`     (none yet — register the code first)`);
    } else {
      console.log(`     ${pad('prefix', 8)}  ${pad('label', 32)}  ${pad('active', 6)}  ${pad('uses', 4)}  ${pad('cap', 4)}  ${pad('expires', 12)}  created`);
      console.log(`     ${'-'.repeat(98)}`);
      rows.forEach((r) => {
        console.log(
          `     ${pad(r.codePrefix, 8)}  ${pad((r.label || '').slice(0, 32), 32)}  ${pad(String(r.isActive), 6)}  ${pad(String(r.usageCount), 4)}  ${pad(r.maxUses == null ? '∞' : r.maxUses, 4)}  ${pad(r.expiresAt ? r.expiresAt.toISOString().slice(0, 10) : 'never', 12)}  ${r.created_at ? r.created_at.toISOString().slice(0, 10) : ''}`
        );
      });
    }
    await mongoose.disconnect();
  } catch (e) {
    console.log(`  ${R}✗ ${e.message.split('\n')[0]}${X}`);
  }
  console.log('');

  // 3) Quick sanity: is the route file present + has the expected endpoints?
  console.log(`${C}[3/3]${X} Verifying server/routes/backupCode.js is in place…`);
  const fs = require('fs');
  const routeFile = path.join(__dirname, '..', 'routes', 'backupCode.js');
  if (fs.existsSync(routeFile)) {
    const src = fs.readFileSync(routeFile, 'utf8');
    const has = (s) => src.includes(s) ? `${G}✓${X}` : `${R}✗${X}`;
    console.log(`     /init endpoint          : ${has("router.post('/init'")}`);
    console.log(`     /complete endpoint      : ${has("router.post('/complete'")}`);
    console.log(`     /status endpoint        : ${has("router.get('/status'")}`);
    console.log(`     /admin/create endpoint  : ${has("router.post('/admin/create'")}`);
    console.log(`     /admin/list endpoint    : ${has("router.get('/admin/list'")}`);
    console.log(`     Mongo matchBackupCode   : ${has('BackupCode.find')}`);
    console.log(`     Dev-fallback warning    : ${has('NO BACKUP_CODES CONFIGURED')}`);
  } else {
    console.log(`  ${R}✗ Route file not found at ${routeFile}${X}`);
  }
  console.log('');
  console.log(`${Y}Done. Share this output if you need help debugging.${X}`);
})();

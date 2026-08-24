// ============================================
// SaveHatke — Register a Backup Code (cleartext → MongoDB)
// ============================================
// Run:
//   node server/scripts/register-backup-code.js --code "SH-BK-XXXX-XXXX-XXXX-XXXX" --label "Primary SOS code"
//
// Use this when the cleartext was generated elsewhere (e.g. by an admin
// in chat) and you want to persist the bcrypt hash + metadata to MongoDB.
// The script will NOT echo the cleartext — it only stores the hash.

const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const BackupCode = require('../models/BackupCode');

function getArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function parseDurationToDate(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const m = String(s).match(/^(\d+)([smhdw])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  const ms = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[u] * n;
  return new Date(Date.now() + ms);
}

const CODE = getArg('code', '');
const LABEL = getArg('label', 'Registered SOS code');
const EXPIRES = getArg('expires', '');
const MAX_USES = getArg('max-uses', '');
const ALLOWED = getArg('allowed', '');
const CREATED_BY = getArg('created-by', 'cli-register');

if (!CODE) {
  console.error('Usage:');
  console.error('  node server/scripts/register-backup-code.js --code "SH-BK-XXXX-XXXX-XXXX-XXXX" --label "Primary SOS code"');
  process.exit(1);
}
if (!/^SH-BK-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(CODE.trim())) {
  console.error(`Invalid code format. Expected SH-BK-XXXX-XXXX-XXXX-XXXX (uppercase hex). Got: "${CODE}"`);
  process.exit(1);
}

async function main() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/savehatke';
  console.log(`\n🍃 Connecting to MongoDB…`);
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000, bufferCommands: false });
  console.log(`   connected: ${mongoose.connection.host}/${mongoose.connection.name}\n`);

  const expiresAt = parseDurationToDate(EXPIRES);
  const maxUses = MAX_USES ? Number(MAX_USES) : null;
  if (MAX_USES && (!Number.isInteger(maxUses) || maxUses < 1)) {
    throw new Error(`Invalid --max-uses "${MAX_USES}"`);
  }
  const allowedAdminEmails = ALLOWED
    ? ALLOWED.split(',').map((s) => s.toLowerCase().trim()).filter(Boolean)
    : [];

  const hash = await bcrypt.hash(CODE.trim(), 10);
  const codePrefix = crypto.createHash('sha256').update(hash).digest('hex').slice(0, 6);

  const row = await BackupCode.create({
    id: require('uuid').v4(),
    codeHash: hash,
    codePrefix,
    label: LABEL,
    createdBy: CREATED_BY,
    notes: '',
    isActive: true,
    expiresAt,
    maxUses,
    allowedAdminEmails,
  });

  const G = '\x1b[32m', C = '\x1b[36m', X = '\x1b[0m';
  console.log(`${G}✅ Backup code registered in MongoDB.${X}\n`);
  console.log(`${C}ID:           ${X} ${row.id}`);
  console.log(`${C}Prefix:       ${X} ${row.codePrefix}  (visible in audit logs)`);
  console.log(`${C}Label:        ${X} ${row.label}`);
  console.log(`${C}Created by:   ${X} ${row.createdBy}`);
  console.log(`${C}Expires:      ${X} ${row.expiresAt ? row.expiresAt.toISOString() : 'never'}`);
  console.log(`${C}Max uses:     ${X} ${row.maxUses == null ? 'unlimited' : row.maxUses}`);
  console.log(`${C}Allowed admins:${X} ${row.allowedAdminEmails.length ? row.allowedAdminEmails.join(', ') : 'all (default allowlist)'}\n`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('\n❌ Register failed:', e.message);
  process.exit(1);
});

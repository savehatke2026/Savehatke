// ============================================
// SaveHatke — Register a Backup Code (cleartext → code stores)
// ============================================
// Run:
//   node server/scripts/register-backup-code.js --code "SH-BK-XXXX-XXXX-XXXX-XXXX" --label "Primary SOS code"
//
// Use this when the cleartext was generated elsewhere (e.g. by an admin
// in chat) and you want to persist the bcrypt hash + metadata.
//
// The code is written to every store that answers — Supabase (table
// backup_codes) and MongoDB — because a break-glass credential that only one
// database can verify is no use on the day that database is unreachable. One
// store is enough to succeed; the script says which ones took it.
//
// The script will NOT echo the cleartext — it only stores the hash.

const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const backupCodeStore = require('../services/backupCodeStore');

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', C = '\x1b[36m', X = '\x1b[0m';

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
if (!/^SH-BK-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/i.test(CODE.trim())) {
  console.error(`Invalid code format. Expected SH-BK-XXXX-XXXX-XXXX-XXXX (hex). Got: "${CODE}"`);
  process.exit(1);
}

/**
 * Best-effort Mongo connect. A failure is reported and the run continues on
 * whatever other store is configured — the whole point of registering a
 * break-glass code in more than one place.
 */
async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log(`  ${Y}·${X} MongoDB: MONGODB_URI is not set — skipping.`);
    return false;
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, bufferCommands: false });
    console.log(`  ${G}·${X} MongoDB: connected to ${mongoose.connection.host}/${mongoose.connection.name}`);
    return true;
  } catch (err) {
    console.log(`  ${Y}·${X} MongoDB: ${err.message.split('\n')[0]}`);
    return false;
  }
}

async function main() {
  console.log('');
  console.log(`${Y}== Registering an SOS backup code ==${X}`);
  console.log('');
  console.log('Stores:');
  console.log(`  ${backupCodeStore.describeStores().supabase ? G + '·' + X : Y + '·' + X} Supabase: ${backupCodeStore.describeStores().supabase ? 'configured' : 'SUPABASE_URL / SUPABASE_SERVICE_KEY missing — skipping'}`);
  await connectMongo();
  console.log('');

  const expiresAt = parseDurationToDate(EXPIRES);
  const maxUses = MAX_USES ? Number(MAX_USES) : null;
  if (MAX_USES && (!Number.isInteger(maxUses) || maxUses < 1)) {
    throw new Error(`Invalid --max-uses "${MAX_USES}"`);
  }
  const allowedAdminEmails = ALLOWED
    ? ALLOWED.split(',').map((s) => s.toLowerCase().trim()).filter(Boolean)
    : [];

  // Hashed once and shared by every store, so one code stays one code — same
  // id, same prefix — however many places hold it.
  const cleartext = CODE.trim().toUpperCase();
  const hash = await bcrypt.hash(cleartext, 10);
  const codePrefix = crypto.createHash('sha256').update(hash).digest('hex').slice(0, 6);
  const id = require('uuid').v4();

  const { written, failed } = await backupCodeStore.create({
    id,
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

  failed.forEach((f) => console.log(`  ${R}✗${X} ${f.store}: ${f.error}`));

  if (!written.length) {
    throw new Error('No store accepted the code. Nothing was saved.');
  }

  console.log('');
  console.log(`${G}✅ Backup code registered in: ${written.map((w) => w.store).join(', ')}${X}`);
  console.log('');
  console.log(`${C}ID:            ${X} ${id}`);
  console.log(`${C}Prefix:        ${X} ${codePrefix}  (visible in audit logs)`);
  console.log(`${C}Label:         ${X} ${LABEL}`);
  console.log(`${C}Created by:    ${X} ${CREATED_BY}`);
  console.log(`${C}Expires:       ${X} ${expiresAt ? expiresAt.toISOString() : 'never'}`);
  console.log(`${C}Max uses:      ${X} ${maxUses == null ? '1 (single use — the SOS route treats no cap as one use)' : maxUses}`);
  console.log(`${C}Allowed admins:${X} ${allowedAdminEmails.length ? allowedAdminEmails.join(', ') : 'all (default allowlist)'}`);
  console.log('');

  if (mongoose.connection.readyState === 1) await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(`\n${R}❌ Register failed:${X} ${e.message}`);
  try { if (mongoose.connection.readyState === 1) await mongoose.disconnect(); } catch (err) { /* ignore */ }
  process.exit(1);
});

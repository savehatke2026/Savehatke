// ============================================
// SaveHatke — Mint a Backup Code (writes to MongoDB)
// ============================================
// Run: `node server/scripts/mint-backup-code.js [--label "..."] [--expires 30d] [--max-uses 5]`
//
// Connects to MongoDB, mints one fresh code, persists only the bcrypt
// hash + a 6-char prefix, and prints the cleartext to stdout ONCE.
// Store it somewhere safe (password manager / printed and locked away)
// and never share it over an unsecured channel.

const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const BackupCode = require('../models/BackupCode');

// ── Tiny argv parser ──
function getArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const LABEL = getArg('label', 'Primary SOS code');
const EXPIRES = getArg('expires', '');     // e.g. "30d", "12h", "1y", or ISO date
const MAX_USES = getArg('max-uses', '');   // integer, empty = unlimited
const ALLOWED = getArg('allowed', '');     // comma-sep, empty = all
const CREATED_BY = getArg('created-by', 'cli-mint');

function parseDurationToDate(s) {
  if (!s) return null;
  // ISO date?
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

  // 4 groups of 4 hex chars = 64 bits of entropy
  const segs = [];
  for (let i = 0; i < 4; i++) segs.push(crypto.randomBytes(2).toString('hex').toUpperCase());
  const cleartext = `SH-BK-${segs.join('-')}`;
  const hash = await bcrypt.hash(cleartext, 10);
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

  const Y = '\x1b[33m', G = '\x1b[32m', C = '\x1b[36m', R = '\x1b[31m', X = '\x1b[0m';
  console.log(`${Y}╔════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  SaveHatke — Backup code minted & stored in MongoDB                ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════╝${X}\n`);

  console.log(`${C}ID:           ${X} ${row.id}`);
  console.log(`${C}Prefix:       ${X} ${row.codePrefix}  (shown in audit logs)`);
  console.log(`${C}Label:        ${X} ${row.label}`);
  console.log(`${C}Created by:   ${X} ${row.createdBy}`);
  console.log(`${C}Expires:      ${X} ${row.expiresAt ? row.expiresAt.toISOString() : 'never'}`);
  console.log(`${C}Max uses:     ${X} ${row.maxUses == null ? 'unlimited' : row.maxUses}`);
  console.log(`${C}Allowed admins:${X} ${row.allowedAdminEmails.length ? row.allowedAdminEmails.join(', ') : 'all (default allowlist)'}\n`);

  console.log(`${Y}┌──────────────────────────────────────────────────────────────────┐${X}`);
  console.log(`${Y}│${X}  ${R}CLEARTEXT BACKUP CODE (shown ONCE):${X}                              ${Y}│${X}`);
  console.log(`${Y}│${X}                                                                  ${Y}│${X}`);
  console.log(`${Y}│${X}       ${G}${cleartext}${X}                                       ${Y}│${X}`);
  console.log(`${Y}│${X}                                                                  ${Y}│${X}`);
  console.log(`${Y}│${X}  ${R}Copy this NOW.${X} It cannot be recovered from the database.         ${Y}│${X}`);
  console.log(`${Y}└──────────────────────────────────────────────────────────────────┘${X}\n`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('\n❌ Mint failed:', e.message);
  process.exit(1);
});

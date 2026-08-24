// ============================================
// SaveHatke — Generate a Backup-Code (SOS)
// ============================================
// Run: `node server/scripts/generate-backup-code.js`
//
// Prints ONE fresh code in the cleartext form you'll type into the
// login email field, plus the bcrypt hash to paste into the BACKUP_CODES
// env var. Generate as many as you want, then list them comma-separated:
//
//   BACKUP_CODES="$2b$10$hash1,$2b$10$hash2,$2b$10$hash3"
//
// The cleartext is shown only on stdout here — never write it to disk,
// never commit it, never share it over an unsecured channel.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COUNT = Number(process.argv[2] || 1);
if (!Number.isInteger(COUNT) || COUNT < 1 || COUNT > 50) {
  console.error('Usage: node server/scripts/generate-backup-code.js [count]');
  console.error('  count: how many codes to mint (1-50, default 1)');
  process.exit(1);
}

function mintCode() {
  // 4 groups of 4 hex chars = 64 bits of entropy. The SH-BK- prefix
  // makes it easy to spot in logs / audit sheets.
  const segs = [];
  for (let i = 0; i < 4; i++) {
    segs.push(crypto.randomBytes(2).toString('hex').toUpperCase());
  }
  return `SH-BK-${segs.join('-')}`;
}

console.log('\n\x1b[33m╔════════════════════════════════════════════════════════════════════╗');
console.log(`║  SaveHatke — ${String(COUNT).padStart(2, ' ')} Backup Code${COUNT === 1 ? '' : 's'} Generated                                ║`);
console.log('║                                                                    ║');
console.log('║  Treat these like root passwords. The cleartext is only on stdout. ║');
console.log('║  Store the hash list in your .env as BACKUP_CODES (comma-sep).    ║');
console.log('╚════════════════════════════════════════════════════════════════════╝\x1b[0m\n');

const hashes = [];
for (let i = 0; i < COUNT; i++) {
  const code = mintCode();
  const hash = bcrypt.hashSync(code, 10);
  hashes.push(hash);

  console.log(`\x1b[36mCode ${String(i + 1).padStart(2, ' ')}:\x1b[0m  ${code}`);
  console.log(`\x1b[90mHash ${String(i + 1).padStart(2, ' ')}:\x1b[0m  ${hash}\n`);
}

if (COUNT > 1) {
  console.log('\x1b[33m────────────────────────────────────────────────────────────────────');
  console.log('Paste this into your .env (one line, comma-separated):\n');
  console.log(`\x1b[32mBACKUP_CODES="${hashes.join(',')}"\x1b[0m\n`);
} else {
  console.log('\x1b[33m────────────────────────────────────────────────────────────────────');
  console.log('Paste this into your .env:\n');
  console.log(`\x1b[32mBACKUP_CODES="${hashes[0]}"\x1b[0m\n`);
}

console.log('\x1b[31m⚠️  Remember: never commit the cleartext code or your .env file.\x1b[0m\n');

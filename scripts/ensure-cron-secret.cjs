// One-shot helper: ensure CRON_SECRET exists in server/.env.
// Prints only whether it wrote, never the value.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execSync } = require('child_process');

const target = path.join(__dirname, '..', 'server', '.env');
let body = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';

if (/^\s*CRON_SECRET\s*=/m.test(body)) {
  console.log('CRON_SECRET already present in server/.env — left unchanged.');
} else {
  if (body && !body.endsWith('\n')) body += '\n';
  body += '\n# Cron authentication. Vercel Cron presents this as Authorization: Bearer <CRON_SECRET>.\n';
  body += '# 48 random bytes, generated ' + new Date().toISOString().slice(0, 10) + '. Rotate by deleting this line and re-running scripts/ensure-cron-secret.cjs.\n';
  body += 'CRON_SECRET=' + crypto.randomBytes(48).toString('base64url') + '\n';
  fs.writeFileSync(target, body, { mode: 0o600 });
  console.log('CRON_SECRET written to server/.env (48 random bytes; value deliberately not printed).');
}

let ignored = false;
try {
  execSync('git check-ignore -q server/.env', { cwd: path.join(__dirname, '..') });
  ignored = true;
} catch (e) { ignored = false; }

console.log('server/.env exists :', fs.existsSync(target));
console.log('server/.env gitignored :', ignored);

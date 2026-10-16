// Two-factor authentication is disabled — and nothing may quietly depend on it.
//
// This file started as the 2FA wiring suite: it proved the feature was mounted
// and live. The feature was then deliberately removed, so the guarantee flipped.
// The wiring tests that remain are the ones that stop a half-removal from
// coming back:
//
//   1. no 2FA router, service or mount may reappear
//   2. NO server module may require a file that does not exist  <- the
//      original defect. The four suites that used to fail could not resolve
//      '../services/twoFactorService', so this check is the general guard.
//   3. server.js, the auth router, the Admin model and the email service must
//      not reference the feature at all
//   4. the auth router must still load and still expose its real routes —
//      disabling a factor must not break the rest of authentication
//
// Run: node server/tests/twoFactorWiring.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const REPO = path.resolve(SERVER, '..');

let pass = 0;
let failures = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ' + name); }
  catch (e) { failures += 1; console.error('  FAIL  ' + name + '\n        ' + e.message); }
}

const read = (p) => fs.readFileSync(p, 'utf8');
const serverEntry = read(path.join(SERVER, 'server.js'));
const authRoute = read(path.join(SERVER, 'routes', 'auth.js'));

// ── 1. The feature stays off ─────────────────────────────────────────────

check('the 2FA router file is gone', () => {
  assert.ok(!fs.existsSync(path.join(SERVER, 'routes', 'twoFactor.js')),
    'server/routes/twoFactor.js must not come back');
});

check('the 2FA service module is gone', () => {
  assert.ok(!fs.existsSync(path.join(SERVER, 'services', 'twoFactorService.js')),
    'server/services/twoFactorService.js must not come back');
});

check('server.js mounts no 2FA route and requires no 2FA module', () => {
  // Prose explaining the removal is required; an actual mount or require is not.
  assert.doesNotMatch(serverEntry, /require\(\s*['"][^'"]*twoFactor/i,
    'server.js must not require a twoFactor module');
  assert.doesNotMatch(serverEntry, /app\.use\(\s*['"][^'"]*2fa/i,
    'server.js must not mount a 2FA router');
  assert.doesNotMatch(serverEntry, /require\(\s*['"][^'"]*2fa/i);
});

check('server.js documents why the mount is absent', () => {
  // The old audit finding was a feature whose router existed but was never
  // mounted. That ambiguity is what let dead UI ship; the intent is now written
  // down so it is a deliberate state, not an accident.
  assert.match(serverEntry, /Two-factor authentication has been removed/i);
});

check('the auth router has no 2FA gate', () => {
  assert.doesNotMatch(authRoute, /require\([^)]*twoFactor/i);
  assert.doesNotMatch(authRoute, /twoFactorService/i);
});

// ── 2. No module may require a file that does not exist ──────────────────
// This is the check that would have caught the four failing suites.

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

check('every relative require in server/ resolves to a real file', () => {
  const files = walk(SERVER);
  const broken = [];
  for (const file of files) {
    const src = read(file);
    const specs = [...src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const spec of specs) {
      const base = path.resolve(path.dirname(file), spec);
      const candidates = [base, base + '.js', base + '.json', base + '.cjs', path.join(base, 'index.js')];
      if (!candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile())) {
        broken.push(`${path.relative(REPO, file)} -> ${spec}`);
      }
    }
  }
  assert.strictEqual(broken.length, 0, 'unresolvable require(s):\n        ' + broken.join('\n        '));
});

check('no server module references the 2FA service by name', () => {
  const hits = walk(SERVER)
    .filter((f) => !path.basename(f).startsWith('twoFactor'))
    .filter((f) => /twoFactorService/.test(read(f)))
    .map((f) => path.relative(REPO, f));
  assert.strictEqual(hits.length, 0, 'still references twoFactorService: ' + hits.join(', '));
});

check('the app no longer needs a 2FA encryption key', () => {
  const envPath = path.join(REPO, '.env');
  if (fs.existsSync(envPath)) {
    assert.doesNotMatch(read(envPath), /^TWOFA_ENCRYPTION_KEY=/m,
      '.env must not define TWOFA_ENCRYPTION_KEY');
  }
  // Skip this file: it necessarily names the key in order to forbid it.
  const hits = walk(SERVER)
    .filter((f) => path.resolve(f) !== path.resolve(__filename))
    .filter((f) => /TWOFA_ENCRYPTION_KEY/.test(read(f)))
    .map((f) => path.relative(REPO, f));
  assert.strictEqual(hits.length, 0, 'still reads TWOFA_ENCRYPTION_KEY: ' + hits.join(', '));
});

// ── 3. Authentication itself is untouched ────────────────────────────────

check('the auth router still mounts and still serves its routes', () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-no2fa-wiring-0123456789abcdef';
  const authRouter = require('../routes/auth');
  assert.ok(authRouter, 'routes/auth must still export a router');

  // Walk the real router so a route cannot be "present but unreachable".
  const found = new Set();
  (function walk(stack) {
    for (const layer of stack || []) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
          for (const p of paths) found.add(m.toUpperCase() + ' ' + p);
        }
      }
      if (layer.handle && layer.handle.stack) walk(layer.handle.stack);
    }
  })(authRouter.stack);

  for (const p of ['GET /google-redirect', 'GET /me', 'POST /logout', 'POST /refresh', 'GET /sessions']) {
    assert.ok(found.has(p), `the auth router must still declare ${p} (found: ${[...found].sort().join(', ')})`);
  }
});

check('the sign-in limiter still guards the auth router in server.js', () => {
  // Removing the feature must not have widened the rate limit.
  assert.match(serverEntry, /authLimiter/, 'server.js must still mount a limiter on /api/auth');
  assert.match(serverEntry, /app\.use\('\/api\/auth'[\s\S]{0,200}authLimiter/);
});

check('the session cookie and the admin allowlist are still the login contract', () => {
  const authMiddleware = read(path.join(SERVER, 'middleware', 'auth.js'));
  const securityConfig = read(path.join(SERVER, 'config', 'security.js'));
  assert.match(authMiddleware, /SESSION_COOKIE_NAME\s*=\s*['"]sh_session['"]/,
    'the session cookie name must not change');
  assert.match(authMiddleware, /httpOnly/i, 'the session cookie must stay HttpOnly');
  // The admin allowlist is enforced at the roster guard the sign-in path calls.
  assert.match(securityConfig, /getAdminAllowlist/, 'the admin allowlist check must remain');
  assert.match(securityConfig, /ensureAdminRosterReady/);
  assert.match(authRoute, /ensureAdminRosterReady/, 'sign-in must still consult the admin roster guard');
  assert.match(authRoute, /jwt/i, 'JWT signing must remain in the auth path');
});

check('security.js still loads and exposes its admin roster guard', () => {
  const security = require('../config/security');
  assert.strictEqual(typeof security.ensureAdminRosterReady, 'function');
});

console.log(`\n${pass} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
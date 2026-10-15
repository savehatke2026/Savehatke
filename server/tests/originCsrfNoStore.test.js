// Regression: sensitive API responses carry `Cache-Control: no-store` even when
// the origin/CSRF layer rejects them before any route runs.
// Run: node server/tests/originCsrfNoStore.test.js
//
// Mounts the REAL noStoreSensitiveApi middleware, followed by the same
// origin/CSRF rules as server/server.js (~L198), in the same order server.js
// uses (header middleware first). Every rejection must stay a rejection, and an
// allowed request must still reach its handler. Nothing is weakened.

const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const SERVER = path.join(__dirname, '..');
const express = require(path.join(SERVER, '..', 'node_modules', 'express'));
const { noStoreSensitiveApi } = require(path.join(SERVER, 'middleware', 'sensitiveCache.js'));

const allowedOrigins = new Set(['https://savehatke.vercel.app']);

const app = express();
app.use(express.json());
app.use(noStoreSensitiveApi);
// Mirror of the origin/CSRF layer in server/server.js. Kept identical on purpose.
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (origin && !allowedOrigins.has(origin)) {
    return res.status(403).json({ error: 'Request origin is not allowed.' });
  }
  if (!safeMethod && req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'Cross-site request is not allowed.' });
  }
  const hasSessionCookie = String(req.headers.cookie || '').split(';').some((part) => part.trim().startsWith('sh_session='));
  if (!safeMethod && hasSessionCookie && !origin) {
    return res.status(403).json({ error: 'A same-origin request is required.' });
  }
  return next();
});

// Route handlers. Reaching one of these proves the request was allowed through.
app.get('/api/admin/finance/revenue', (req, res) => res.json({ total: 1 }));
app.post('/api/payment/create', (req, res) => res.json({ ok: true }));
app.get('/api/coupons/recent-sales', (req, res) => { res.set('Cache-Control', 'public, max-age=60'); res.json({ sales: [] }); });

const server = app.listen(0, '127.0.0.1');
let port = 0;
const ready = new Promise((resolve) => server.on('listening', () => { port = server.address().port; resolve(); }));

function call(method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (method === 'POST') req.end('{}'); else req.end();
  });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('foreign Origin on a sensitive GET: 403, still rejected, no-store', async () => {
  const r = await call('GET', '/api/admin/finance/revenue', { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.match(r.body, /origin is not allowed/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['pragma'], 'no-cache');
});

test('cross-site POST to a sensitive route: 403, still rejected, no-store', async () => {
  const r = await call('POST', '/api/payment/create', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://savehatke.vercel.app' });
  assert.equal(r.status, 403);
  assert.match(r.body, /Cross-site/);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('cookie-authenticated POST without Origin: 403, still rejected, no-store', async () => {
  const r = await call('POST', '/api/payment/create', { Cookie: 'sh_session=abc' });
  assert.equal(r.status, 403);
  assert.match(r.body, /same-origin/);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('allowed Origin on a sensitive GET: reaches handler (200) with no-store', async () => {
  const r = await call('GET', '/api/admin/finance/revenue', { Origin: 'https://savehatke.vercel.app' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('public recent-sales keeps its own public cache header, not no-store', async () => {
  const r = await call('GET', '/api/coupons/recent-sales', { Origin: 'https://evil.example' });
  assert.equal(r.status, 403, 'origin check still applies to public routes too');
  assert.notEqual(r.headers['cache-control'], 'no-store', 'public route must not be marked no-store by this layer');
});

let passed = 0;
let failed = 0;
(async () => {
  await ready;
  for (const t of tests) {
    try { await t.fn(); passed += 1; console.log('  ok   ' + t.name); }
    catch (e) { failed += 1; console.error('  FAIL ' + t.name + '\n       ' + e.message); }
  }
  server.close();
  console.log(`\noriginCsrfNoStore: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

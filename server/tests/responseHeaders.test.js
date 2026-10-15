// Real response-header checks over HTTP (mocked handlers, no network).
// Run: node server/tests/responseHeaders.test.js
//
// Mounts the REAL noStoreSensitiveApi middleware on a real express app, in the
// same order server.js uses, and reads the Cache-Control header off the wire.
// The route handlers are stubs, so these prove the header policy, not the
// handlers' business logic.

const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const SERVER = path.join(__dirname, '..');
const express = require(path.join(SERVER, '..', 'node_modules', 'express'));
const { noStoreSensitiveApi } = require(path.join(SERVER, 'middleware', 'sensitiveCache.js'));

const app = express();
app.use(express.json());
app.use(noStoreSensitiveApi);

// Sensitive routes (must be no-store).
app.get('/api/tracker/list', (req, res) => res.json({ items: [] }));
app.post('/api/chat', (req, res) => res.json({ reply: 'hi' }));
app.get('/api/admin/finance/revenue', (req, res) => res.json({ total: 1 }));
app.get('/api/payment/status/:id', (req, res) => res.status(404).json({ error: 'nope' }));
app.get('/api/auth/me', (req, res) => res.status(401).json({ error: 'expired' }));

// Public, cacheable routes (must keep their own header, or none).
app.get('/api/brands', (req, res) => { res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300'); res.json({ brands: [] }); });
app.get('/api/brand-assets/:brand', (req, res) => { res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600'); res.json({}); });
app.get('/api/coupons/recent-sales', (req, res) => { res.set('Cache-Control', 'public, max-age=60'); res.json({ sales: [] }); });
app.get('/api/chat/config', (req, res) => res.json({ enabled: true }));
app.get('/api/chat/status', (req, res) => res.json({ enabled: true }));
app.get('/api/settings', (req, res) => res.json({ settings: {} }));

const server = app.listen(0, '127.0.0.1');
let port = 0;
server.on('listening', () => { port = server.address().port; });

function call(method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
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

for (const [m, p] of [
  ['GET', '/api/tracker/list'],
  ['POST', '/api/chat'],
  ['GET', '/api/admin/finance/revenue'],
  ['GET', '/api/payment/status/x'],
  ['GET', '/api/auth/me'],
]) {
  test(`${m} ${p}: Cache-Control is no-store on the wire`, async () => {
    const r = await call(m, p);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['pragma'], 'no-cache');
  });
}

test('no-store is set on error responses too (401/404)', async () => {
  const r401 = await call('GET', '/api/auth/me');
  assert.equal(r401.status, 401);
  assert.equal(r401.headers['cache-control'], 'no-store');
  const r404 = await call('GET', '/api/payment/status/x');
  assert.equal(r404.status, 404);
  assert.equal(r404.headers['cache-control'], 'no-store');
});

test('POST /api/chat is no-store but GET /api/chat/config is not', async () => {
  const post = await call('POST', '/api/chat');
  assert.equal(post.headers['cache-control'], 'no-store');
  const cfg = await call('GET', '/api/chat/config');
  assert.notEqual(cfg.headers['cache-control'], 'no-store');
});

test('GET /api/chat/status is not no-store (public widget status)', async () => {
  const r = await call('GET', '/api/chat/status');
  assert.notEqual(r.headers['cache-control'], 'no-store');
});

test('public brand list keeps its own public cache header', async () => {
  const r = await call('GET', '/api/brands');
  assert.equal(r.headers['cache-control'], 'public, max-age=60, stale-while-revalidate=300');
});

test('brand asset resolver keeps its own public cache header', async () => {
  const r = await call('GET', '/api/brand-assets/Amazon');
  assert.equal(r.headers['cache-control'], 'public, max-age=300, stale-while-revalidate=600');
});

test('recent-sales keeps its public max-age=60', async () => {
  const r = await call('GET', '/api/coupons/recent-sales');
  assert.equal(r.headers['cache-control'], 'public, max-age=60');
});

test('/api/settings is not marked no-store (shared public settings)', async () => {
  const r = await call('GET', '/api/settings');
  assert.notEqual(r.headers['cache-control'], 'no-store');
});

test('a sensitive response body is unchanged by the header policy', async () => {
  const r = await call('GET', '/api/tracker/list');
  assert.deepEqual(JSON.parse(r.body), { items: [] });
});

let passed = 0;
let failed = 0;
(async () => {
  while (!port) await new Promise((r) => setTimeout(r, 5));
  for (const t of tests) {
    try { await t.fn(); passed += 1; console.log('  ok   ' + t.name); }
    catch (e) { failed += 1; console.error('  FAIL ' + t.name + '\n       ' + e.message); }
  }
  server.close();
  console.log(`\nresponseHeaders: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

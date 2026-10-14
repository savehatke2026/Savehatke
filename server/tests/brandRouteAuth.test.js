// Route-level auth guard for the admin brand endpoints.
// Mounts the real adminRouter on a bare express app and confirms that
// anonymous and non-admin requests never reach a handler.
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-brand-auth-0123456789';
const { adminRouter } = require('../routes/brands');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use('/api/admin/brands', adminRouter);

function request(method, path, token) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(method === 'GET' ? undefined : '{}');
    });
  });
}

(async () => {
  const cases = [
    ['GET', '/api/admin/brands'],
    ['GET', '/api/admin/brands/drive-logos'],
    ['POST', '/api/admin/brands'],
    ['PUT', '/api/admin/brands/b_x'],
    ['POST', '/api/admin/brands/b_x/active'],
  ];
  let pass = 0;
  for (const [method, path] of cases) {
    const anon = await request(method, path);
    assert.ok(anon.status === 401 || anon.status === 403, `${method} ${path} anon -> ${anon.status}`);
    pass++;
  }
  // Non-admin user token must be rejected too.
  const userToken = jwt.sign({ id: 'u1', email: 'u@x.com', role: 'user' }, process.env.JWT_SECRET);
  for (const [method, path] of cases) {
    const r = await request(method, path, userToken);
    assert.ok(r.status === 401 || r.status === 403, `${method} ${path} user -> ${r.status}`);
    pass++;
  }
  console.log(`brandRouteAuth: ${pass} passed, 0 failed`);
  process.exit(0);
})().catch((e) => {
  console.error('brandRouteAuth FAILED:', e.message);
  process.exit(1);
});

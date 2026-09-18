// Verification harness for the Coupon AI Scanner (screenshot → form fields).
//
// Regression guard for the failure that made every scan end in the generic
// "Could not read the coupon": the Gemini key is on the free tier (5 requests
// per minute, PER MODEL), and callVision() had no retry and no fallback, so the
// first 429/503 killed the scan and the real reason was never surfaced.
//
//   node verify-coupon-scan.cjs            offline checks (no network)
//   node verify-coupon-scan.cjs --live X   also run a real Gemini extraction on
//                                          image X (spends one API call)
//
// Loads the REAL modules — nothing is re-implemented here.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

// Root .env, so the module under test sees the same config the server does.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

let pass = 0;
let fail = 0;
const t = (ok, name, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const section = (s) => console.log(`\n── ${s} ──`);

// ═══ 1. Files still parse, and the deploy config still carries the timeout ═══
section('static checks');

for (const f of ['server/services/couponVision.js', 'server/routes/coupons.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(__dirname, f)], { stdio: 'pipe' });
    t(true, `syntax ok: ${f}`);
  } catch (e) {
    t(false, `syntax ok: ${f}`, String(e.stderr || e.message).slice(0, 200));
  }
}

// A vision call takes 8–40s; without maxDuration the serverless default cuts it
// off long before it can answer.
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'vercel.json'), 'utf8'));
  const fn = (cfg.builds || []).find((b) => b.src === 'api/index.js');
  t(!!(fn && fn.config && fn.config.maxDuration >= 60), 'vercel.json: api function maxDuration >= 60', fn && fn.config ? String(fn.config.maxDuration) : 'missing');
} catch (e) {
  t(false, 'vercel.json is valid JSON with a maxDuration', e.message);
}

try {
  const html = fs.readFileSync(path.join(__dirname, 'public/sell.html'), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  let bad = null;
  for (const b of blocks) { try { new Function(b); } catch (e) { bad = e.message; } }
  t(!bad, `sell.html inline scripts compile (${blocks.length} blocks)`, bad || '');
  // The busy state must retry the SAME screenshot, not ask for a new one.
  t(/showAiError\('busy'/.test(html), "sell.html distinguishes a 'busy' (retryable) failure");
  t(/retry\.onclick = rescanAiScreenshot/.test(html), 'busy retry re-runs the same screenshot');
} catch (e) {
  t(false, 'sell.html readable', e.message);
}

// ═══ 2. The fallback machinery ═══
section('fallback + retry');

const cv = require('./server/services/couponVision');
const chain = cv.visionModelChain();
t(chain.length >= 2, 'model chain has fallbacks', chain.join(' → '));
t(chain[0] === cv.getVisionModel(), 'primary model stays first');
t(chain.length === new Set(chain).size, 'chain has no duplicates');
t(typeof cv.parseRetryAfterMs === 'function', 'retry hint parser is exported');
t(cv.parseRetryAfterMs('{"retryDelay":"29s"}') === 29000, 'parses structured retryDelay');
t(cv.parseRetryAfterMs('Please retry in 29.635131934s.') === 29635, 'parses "retry in Xs" prose');
t(cv.parseRetryAfterMs('nothing here') === null, 'no hint → null');
t(cv.parseRetryAfterMs('{"retryDelay":"0s"}') === null, 'zero delay → null');

// ═══ 3. Failure reason → HTTP status, through the REAL route ═══
section('scan route status mapping');

const auth = require('./server/middleware/auth');
auth.authenticateToken = (req, _res, next) => { req.user = { id: 'verify', email: 'verify@local', role: 'admin' }; next(); };

const vision = require('./server/services/couponVision');
let nextVisionResult = null;
vision.analyzeCouponImage = async () => nextVisionResult;

const express = require('express');
const app = express();
app.use(express.json({ limit: '12mb' }));
app.use('/api/coupons', require('./server/routes/coupons'));

const server = app.listen(0, async () => {
  const port = server.address().port;
  const post = (body) => new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/coupons/scan', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }
    );
    req.end(data);
  });

  // 'AAAA' is enough: the vision call is stubbed, the route only checks that
  // dataBase64 decodes to something.
  const send = (result) => { nextVisionResult = result; return post({ filename: 'a.png', contentType: 'image/png', dataBase64: 'AAAA' }); };

  // Capacity problems must be retryable statuses; image verdicts stay 422.
  const CASES = [
    [{ ok: false, reason: 'quota_exhausted', message: 'limit', retryAfterMs: 29000 }, 429, true],
    [{ ok: false, reason: 'overloaded', message: 'busy' }, 503, false],
    [{ ok: false, reason: 'timeout', message: 'slow' }, 504, false],
    [{ ok: false, reason: 'auth_error', message: 'n/a' }, 503, false],
    [{ ok: false, reason: 'network_error', message: 'n/a' }, 503, false],
    [{ ok: false, reason: 'bad_json', message: 'unreadable' }, 502, false],
    [{ ok: false, reason: 'not_configured', message: 'no key' }, 503, false],
    [{ ok: false, reason: 'blurry', message: 'blurry' }, 422, false],
    [{ ok: false, reason: 'too_dark', message: 'dark' }, 422, false],
    [{ ok: false, reason: 'low_resolution', message: 'small' }, 422, false],
    [{ ok: false, reason: 'cropped', message: 'cut off' }, 422, false],
    [{ ok: false, reason: 'not_coupon', message: 'not a coupon' }, 422, false],
    [{ ok: false, reason: 'insufficient_data', message: 'too little' }, 422, false],
  ];

  for (const [result, wantStatus, wantRetry] of CASES) {
    const r = await send(result);
    let body = {};
    try { body = JSON.parse(r.body); } catch (e) {}
    t(r.status === wantStatus && body.reason === result.reason,
      `${result.reason} → HTTP ${wantStatus} + reason echoed`, `got ${r.status}/${body.reason}`);
    if (wantRetry) t(!!r.headers['retry-after'], 'quota_exhausted sends Retry-After', r.headers['retry-after']);
  }

  // A successful scan must keep the shape the form depends on.
  const okRes = await send({
    ok: true,
    fields: { coupon_code: { value: 'TEST10', confidence: 0.99, verify: false } },
    quality: { isCoupon: true, readable: true },
    filledCount: 1,
    image: { width: 100, height: 100, bytes: 4, type: 'image/png' },
  });
  const okBody = JSON.parse(okRes.body);
  t(okRes.status === 200 && okBody.ok === true && okBody.fields.coupon_code.value === 'TEST10', 'success path unchanged');
  t(!!(okBody.locked && okBody.locked.source === 'user-submitted'), 'source/status still forced server-side');
  t(typeof okBody.verifyBelow === 'number', 'verifyBelow still returned for the form');

  server.close();

  // ═══ 4. Optional live extraction ═══
  const liveIdx = process.argv.indexOf('--live');
  const livePath = liveIdx !== -1 ? process.argv[liveIdx + 1] : null;

  if (!livePath) {
    console.log('\n(live extraction skipped — pass `--live <coupon.png>` to run one real Gemini call)');
    return finish();
  }

  section('live extraction');
  if (!fs.existsSync(livePath)) {
    t(false, `image exists: ${livePath}`);
    return finish();
  }
  // Restore the real implementation before exercising it.
  delete require.cache[require.resolve('./server/services/couponVision')];
  const live = require('./server/services/couponVision');
  const buf = fs.readFileSync(livePath);
  const mime = /\.png$/i.test(livePath) ? 'image/png' : /\.webp$/i.test(livePath) ? 'image/webp' : 'image/jpeg';

  console.log(`scanning ${path.basename(livePath)} (${buf.length} bytes) — primary model may be quota-limited…`);
  const started = Date.now();
  live.analyzeCouponImage({ buffer: buf, mimeType: mime }).then((out) => {
    const ms = Date.now() - started;
    console.log(`ok=${out.ok} reason=${out.reason || '-'} model=${out.model || '-'} took=${ms}ms`);
    if (out.message) console.log(`message: ${out.message}`);
    t(out.ok === true, 'live scan succeeds', out.ok ? `served by ${out.model}` : out.reason);
    if (out.ok) {
      const filled = Object.entries(out.fields).filter(([, v]) => v.value !== null);
      console.log('  read: ' + filled.map(([k, v]) => `${k}=${v.value}`).join(', '));
      t(filled.length >= 2, `read at least 2 fields (${filled.length})`);
    }
    finish();
  }).catch((e) => { t(false, 'live scan did not throw', e.message); finish(); });
});

function finish() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

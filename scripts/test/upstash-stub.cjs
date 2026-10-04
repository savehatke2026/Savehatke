'use strict';

// ============================================================================
// Local Upstash Redis stub (test-only)
// ============================================================================
// An HTTP server that speaks the small slice of the Upstash REST protocol that
// @upstash/redis + @upstash/ratelimit actually use, so the distributed rate
// limiter can be exercised END TO END in tests without any real credentials
// and without network access.
//
// It implements the two Lua scripts @upstash/ratelimit sends:
//   • sliding window  (GET + INCRBY + PEXPIRE, current/previous bucket)
//   • fixed window    (INCRBY + PEXPIRE)
// plus the plain commands the SDK uses for them.
//
// The store is module-level, so TWO limiter instances built against the same
// stub share counters — which is exactly the property under test: that moving
// from per-process counters to a shared store makes N instances spend ONE
// budget. Point two separate Ratelimit clients at this server and the budget
// must still be enforced.
//
// Failure injection: call `failNext(n)` (or set `mode = 'down'`) and the stub
// returns 500s, which is how the Redis-unavailable fallback policy is tested.
//
// This file is test infrastructure. It is never required by server code.

const http = require('http');

const WINDOW_UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };

function createUpstashStub() {
  /** key -> { value: number, expiresAt: number|null } */
  const store = new Map();
  const state = { mode: 'up', failCount: 0, requests: 0, keysSeen: [] };

  function now() { return Date.now(); }

  function live(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  function getNum(key) {
    const entry = live(key);
    return entry ? Number(entry.value) || 0 : 0;
  }

  function incrBy(key, by) {
    const entry = live(key);
    const next = (entry ? Number(entry.value) || 0 : 0) + by;
    store.set(key, { value: next, expiresAt: entry ? entry.expiresAt : null });
    return next;
  }

  function pexpire(key, ms) {
    const entry = live(key);
    if (!entry) return 0;
    entry.expiresAt = now() + Number(ms);
    return 1;
  }

  function parseDurationToMs(spec) {
    const m = /^(\d+(?:\.\d+)?)\s?(ms|s|m|h|d)$/.exec(String(spec).trim());
    if (!m) return 60000;
    return Math.round(Number(m[1]) * WINDOW_UNITS[m[2]]);
  }

  // ── Script identification ────────────────────────────────────────────────
  // @upstash/ratelimit calls evalsha with the SHA ONLY (the Lua source is sent
  // just once, via eval, when Redis reports NOSCRIPT). The stub therefore has
  // to recognise the scripts by hash. These are the published hashes from
  // @upstash/ratelimit's own src/lua-scripts/hash.ts for the single-region
  // limiters this app uses.
  const SCRIPT_HASHES = {
    'b2efc02798c8e9b471a10f9b1d5745db89923ff3': 'fixed-window',
    '823cb2a5a902d69681244f5e28e5ebb8f2a89edd': 'fixed-window-remaining',
    '74740bb3d7792848093cdef586b6b6037c455fd6': 'sliding-window',
    '7ca36169e0fc9caedd81b4eef8e99854c157f9b5': 'sliding-window-remaining',
    'd60be5bd3d83482ae229309f1f7425424f891204': 'token-bucket',
    '40daf4a441df736f5c99f8b77bbe176c909e5de4': 'token-bucket-remaining',
    '1861a700bafe96c833a483af6b1c28a8897cfdb0': 'cached-fixed-window',
    'eb82f0e853d2fc9a236fa9bfbe704fda6ac2fc36': 'cached-fixed-window-remaining',
  };

  /** Classify an incoming eval: by hash if we have one, else by script source. */
  function classifyScript(scriptOrSha) {
    const s = String(scriptOrSha || '');
    if (SCRIPT_HASHES[s]) return SCRIPT_HASHES[s];
    if (/currentKey/.test(s)) return 'sliding-window';
    if (/INCRBY/.test(s) || /local key\s*=\s*KEYS\[1\]/.test(s)) return 'fixed-window';
    return 'unknown';
  }

  function runSliding(keys, argv) {
    const currentKey = keys[0];
    const previousKey = keys[1];
    const dynamicLimitKey = keys[2] || '';
    const tokens = Number(argv[0]);
    const nowMs = Number(argv[1]);
    const window = Number(argv[2]);
    const incrementBy = Number(argv[3]);

    let effectiveLimit = tokens;
    if (dynamicLimitKey) {
      const dyn = live(dynamicLimitKey);
      if (dyn) effectiveLimit = Number(dyn.value);
    }

    const cur = getNum(currentKey);
    let prev = getNum(previousKey);
    const percentageInCurrent = (nowMs % window) / window;
    prev = Math.floor((1 - percentageInCurrent) * prev);

    if (incrementBy > 0 && prev + cur >= effectiveLimit) {
      return [-1, effectiveLimit];
    }
    const newValue = incrBy(currentKey, incrementBy);
    if (newValue === incrementBy) pexpire(currentKey, window * 2 + 1000);
    return [newValue, effectiveLimit];
  }

  function runFixed(keys, argv) {
    const key = keys[0];
    const dynamicLimitKey = keys[1] || '';
    const tokens = Number(argv[0]);
    const window = Number(argv[1]);
    const incrementBy = Number(argv[2]);

    let effectiveLimit = tokens;
    if (dynamicLimitKey) {
      const dyn = live(dynamicLimitKey);
      if (dyn) effectiveLimit = Number(dyn.value);
    }
    const r = incrBy(key, incrementBy);
    if (r === incrementBy) pexpire(key, window);
    return [r, effectiveLimit];
  }

  function runScript(scriptOrSha, keys, argv) {
    const kind = classifyScript(scriptOrSha);
    switch (kind) {
      case 'sliding-window':
        return runSliding(keys, argv);
      case 'fixed-window':
      case 'cached-fixed-window':
        return runFixed(keys, argv);
      case 'sliding-window-remaining': {
        // [remaining, limit]
        const currentKey = keys[0];
        const previousKey = keys[1];
        const tokens = Number(argv[0]);
        const nowMs = Number(argv[1]);
        const window = Number(argv[2]);
        const cur = getNum(currentKey);
        let prev = getNum(previousKey);
        prev = Math.floor((1 - ((nowMs % window) / window)) * prev);
        return [Math.max(0, tokens - (cur + prev)), tokens];
      }
      case 'fixed-window-remaining':
      case 'cached-fixed-window-remaining':
        return [Math.max(0, Number(argv[0]) - getNum(keys[0])), Number(argv[0])];
      default:
        // Unrecognised script: return a well-formed [0, 0] rather than throwing,
        // so a future SDK change surfaces as a failing assertion in the suite
        // instead of an obscure stub crash.
        return [0, 0];
    }
  }

  function handleCommand(cmd) {
    const [nameRaw, ...rest] = cmd;
    const name = String(nameRaw || '').toUpperCase();

    if (name === 'EVALSHA' || name === 'EVAL') {
      // Upstash sends: [EVALSHA, <script-or-sha>, <numkeys>, ...keys, ...args]
      const scriptOrSha = String(rest[0] || '');
      const numKeys = Number(rest[1]) || 0;
      const keys = rest.slice(2, 2 + numKeys).map(String);
      const argv = rest.slice(2 + numKeys).map(String);
      for (const k of keys) if (k && !state.keysSeen.includes(k)) state.keysSeen.push(k);
      return runScript(scriptOrSha, keys, argv);
    }

    if (name === 'GET') {
      const entry = live(String(rest[0]));
      return entry ? String(entry.value) : null;
    }
    if (name === 'INCRBY') return incrBy(String(rest[0]), Number(rest[1]) || 0);
    if (name === 'PEXPIRE' || name === 'EXPIRE') {
      const unit = name === 'EXPIRE' ? 1000 : 1;
      return pexpire(String(rest[0]), (Number(rest[1]) || 0) * unit);
    }
    if (name === 'PTTL' || name === 'TTL') {
      const entry = live(String(rest[0]));
      if (!entry || entry.expiresAt === null) return -1;
      const ms = entry.expiresAt - now();
      return name === 'TTL' ? Math.ceil(ms / 1000) : ms;
    }
    if (name === 'DEL') {
      let n = 0;
      for (const k of rest) if (store.delete(String(k))) n += 1;
      return n;
    }
    if (name === 'PING') return 'PONG';
    // Unknown command: succeed with null rather than erroring, so a future SDK
    // change shows up as a test failure rather than a confusing stub crash.
    return null;
  }

  const server = http.createServer((req, res) => {
    state.requests += 1;

    if (state.mode === 'down' || state.failCount > 0) {
      if (state.failCount > 0) state.failCount -= 1;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SIMULATED_UPSTASH_OUTAGE' }));
      return;
    }

    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch (e) { body = null; }
      if (state.trace) console.log('[stub] <<', JSON.stringify(body).slice(0, 300));
      if (!body) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad request' }));
        return;
      }

      try {
        // A single command is a flat array; a pipeline is an array of arrays.
        const isPipeline = Array.isArray(body[0]);
        if (isPipeline) {
          // Upstash answers a pipeline with one { result, error } envelope PER
          // COMMAND, in order. @upstash/redis' auto-pipeline executor reads
          // `results[i].result` and checks `results[i].error`, so returning a
          // bare array of values here makes every command resolve to undefined.
          const results = body.map((cmd) => {
            try { return { result: handleCommand(cmd), error: undefined }; }
            catch (e) { return { result: undefined, error: String((e && e.message) || e) }; }
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const payload = JSON.stringify(results);
          if (state.trace) console.log('[stub] >>', payload.slice(0, 300));
          res.end(payload);
          return;
        }
        const result = handleCommand(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const payload = JSON.stringify({ result });
        if (state.trace) console.log('[stub] >>', payload.slice(0, 300));
        res.end(payload);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e && e.message || e) }));
      }
    });
  });

  return {
    server,
    state,
    /** Start on an ephemeral port; resolves to { url, close }. */
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => server.close(resolve)),
        state,
        /**
         * Clear the stored counters and the key trace.
         *
         * Deliberately does NOT touch the failure mode. It used to set
         * mode = 'up', so the natural-looking sequence
         *     stub.setDown(true); stub.reset();
         * silently brought the stub back online and the outage test passed
         * against a healthy server. Mode is owned by setDown()/failNext() only.
         */
        reset() { store.clear(); state.failCount = 0; state.keysSeen.length = 0; },
        failNext(n = 1) { state.failCount = n; },
        setDown(down) { state.mode = down ? 'down' : 'up'; },
        isDown() { return state.mode === 'down' || state.failCount > 0; },
        size() { return store.size; },
      };
    },
  };
}

/** Convenience: start a stub and get back its URL plus controls. */
async function startUpstashStub() {
  return createUpstashStub().listen();
}

module.exports = { createUpstashStub, startUpstashStub };

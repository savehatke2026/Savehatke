// ============================================
// SaveHatke — OpenRouter AI Service (Server-Only)
// ============================================
// Talks to OpenRouter's OpenAI-compatible chat/completions endpoint:
//
//   POST https://openrouter.ai/api/v1/chat/completions
//
// This is the SINGLE seam between SaveHatke and any external reasoning
// provider. The Gemini service it replaces had two jobs (chat + vision); the
// OpenRouter service exposes both because OpenRouter's chat/completions
// endpoint also accepts the OpenAI `image_url` content type, so vision is a
// specialised chat call rather than a separate HTTP shape.
//
// SECURITY
// - OPENROUTER_API_KEY is read from server-side env only. It is never returned
//   to any client, never logged, never embedded in frontend code, and never
//   present in any URL.
// - Attribution headers (`HTTP-Referer`, `X-Title`) are required by OpenRouter
//   for free-tier traffic to be reliably served. They are hard-coded to the
//   public SaveHatke site values so the same value is sent on every call.
// - The default model and fallback model are server-controlled. The chatbot
//   service validates the model name before passing it here so a frontend
//   can never select an arbitrary OpenRouter model.
//
// RELIABILITY
// - One primary + one fallback model, configurable via env. On a transient
//   provider failure (408/425/429/5xx) the fallback is tried exactly once.
//   Non-transient failures (400/401/403) are returned without a fallback so a
//   bad request or invalid key is not silently retried against another model.
// - Whole-call timeout enforced server-side via `AbortController` so a hung
//   socket cannot stall the serverless function past its wall-clock budget.
//
// USAGE
//   const or = require('./openrouterService');
//   const r = await or.chatCompletion(messages, opts);   // text/chat
//   const v = await or.visionCompletion({ text, imageBase64, mimeType }, opts); // image
//   if (!r.ok) console.warn(r.error, r.status);
//
// Returned shape mirrors the previous Gemini service so the chatbot pipeline
// (tool-call loop, sanitisation, logging) keeps working unchanged:
//   { ok, content, toolCalls, model, error?, status?, finishReason?, detail? }

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_PRIMARY_MODEL = 'nvidia/nemotron-3-ultra:free';
const DEFAULT_FALLBACK_MODEL = 'openrouter/free';
// A free vision-capable default. The user can override with
// OPENROUTER_VISION_MODEL. The previous Gemini Vision call accepted JPEG/PNG/
// WebP; OpenRouter's image_url content type uses the same MIME types, so the
// upstream client (couponVision.js) sends them through unchanged.
const DEFAULT_VISION_MODEL = 'google/gemma-3-27b-it:free';

// Free models are rate-limited per provider; the response header
// `Retry-After` (seconds) is the right value to surface to the caller when a
// 429 returns, so the existing 429 handling in chatbotService stays accurate.
function isConfigured() {
  return !!process.env.OPENROUTER_API_KEY;
}

function getBaseUrl() {
  return (process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function getDefaultModel() {
  return process.env.OPENROUTER_MODEL || DEFAULT_PRIMARY_MODEL;
}

function getFallbackModel() {
  // Explicit empty string disables the fallback. The chatbot service treats
  // `null` as "no fallback configured".
  const raw = process.env.OPENROUTER_FALLBACK_MODEL;
  if (raw === '' || raw === 'none') return null;
  return raw || DEFAULT_FALLBACK_MODEL;
}

function getVisionModel() {
  return process.env.OPENROUTER_VISION_MODEL || DEFAULT_VISION_MODEL;
}

// ── Headers ────────────────────────────────────────────────────────────────
// OpenRouter asks for two attribution headers on every request so they can
// route / rank free-tier traffic. Both are public values: SaveHatke's own
// site URL and the SaveHatke brand. They are not secrets — they are the same
// string every official client sends — so they live in code, not env.
function buildHeaders() {
  if (!isConfigured()) {
    throw new Error('OpenRouter API key is not set (OPENROUTER_API_KEY).');
  }
  const site = (process.env.SITE_URL || 'https://savehatke.com').replace(/\/+$/, '');
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
    'HTTP-Referer': site,
    'X-Title': 'SaveHatke',
  };
}

// ── Tool normalisation ─────────────────────────────────────────────────────
// OpenRouter's tool-calling shape is OpenAI's: a `tools` array of
// `{type:'function', function:{name, description, parameters}}` and assistant
// tool_calls in `{role:'assistant', tool_calls:[{id, type:'function',
// function:{name, arguments}}]}`. The chatbot service already emits this
// shape, so no transformation is needed.
//
// Some free providers echo `tool_calls` back with the `arguments` field as a
// JSON object rather than a JSON string. We coerce both forms to the string
// form expected downstream so the JSON.parse(...) in the chatbot service keeps
// working without a special case.
function normaliseToolCall(tc) {
  if (!tc || typeof tc !== 'object') return null;
  const fn = tc.function || {};
  let args = fn.arguments;
  if (args && typeof args !== 'string') {
    try { args = JSON.stringify(args); } catch (e) { args = '{}'; }
  }
  return {
    id: tc.id || ('call_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)),
    type: 'function',
    function: {
      name: fn.name || 'unknown',
      arguments: args || '{}',
    },
  };
}

// ── Chat completion ────────────────────────────────────────────────────────
// @param {Array} messages — OpenAI-style: [{role:'system'|'user'|'assistant'|'tool', content}]
// @param {object} opts   — { model, temperature, maxTokens, timeoutMs, tools, tool_choice }
// @returns {Promise<{ok, content, toolCalls, model, finishReason, error?, status?, detail?}>}
async function chatCompletion(messages, opts = {}) {
  return chatCompletionWith(messages, opts, /* allowFallback */ true);
}

// Same as chatCompletion but skips the fallback — used by the chatbot service
// after it has already decided to try the fallback, so it does not recurse.
async function chatCompletionPrimary(messages, opts = {}) {
  return chatCompletionWith(messages, opts, /* allowFallback */ false);
}

async function chatCompletionWith(messages, opts = {}, allowFallback) {
  if (!isConfigured()) {
    return { ok: false, error: 'not_configured', model: opts.model || getDefaultModel() };
  }

  const primary = opts.model || getDefaultModel();
  const fallback = allowFallback ? getFallbackModel() : null;
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const chain = fallback && fallback !== primary ? [primary, fallback] : [primary];

  let last = null;
  for (const model of chain) {
    const result = await callOnce(messages, { ...opts, model, timeoutMs });
    last = result;
    if (result.ok) return result;

    // Do not retry on non-transient errors. A bad request (400) is the
    // caller's fault; an invalid key (401/403) cannot succeed on another
    // model; a content-blocked response (the model refused) is a verdict,
    // not a capacity problem.
    if (!isTransient(result)) return result;

    // Surface a one-line warning so a misconfigured model is easy to spot in
    // server logs. The full error detail stays in `result.detail` for the
    // chatbot service's existing log row.
    console.warn(`[openrouter] model ${model} returned ${result.error || 'error'} ${result.status || ''} — trying ${fallback ? 'fallback' : 'no further fallback'}.`);
  }

  return last;
}

function isTransient(result) {
  if (!result || result.ok) return false;
  if (result.error === 'timeout') return true;
  if (result.error === 'network_error') return true;
  if (result.error === 'rate_limited') return true;        // 429
  if (result.error === 'server_error') return true;        // 5xx
  return false;
}

function clampTimeout(ms) {
  // Floor at 5s so a 0/NaN does not abort instantly; ceiling at the platform
  // limit so the serverless function's hard timeout wins, not us.
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 30000;
  return Math.min(Math.max(n, 5000), 120000);
}

async function callOnce(messages, opts) {
  const model = opts.model;
  const timeoutMs = opts.timeoutMs;

  const payload = {
    model,
    messages,
    temperature: clamp(opts.temperature, 0, 2, 0.4),
    max_tokens: clamp(opts.maxTokens, 16, 8192, 1024),
    stream: false,
  };
  if (opts.tools && opts.tools.length) {
    payload.tools = opts.tools;
    if (opts.tool_choice) payload.tool_choice = opts.tool_choice;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(getBaseUrl() + '/chat/completions', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const errType = classifyStatus(res.status, errText);
      return {
        ok: false,
        error: errType,
        status: res.status,
        model,
        latencyMs: Date.now() - started,
        detail: errText.slice(0, 200),
      };
    }

    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
      return {
        ok: false,
        error: 'empty_response',
        model,
        latencyMs: Date.now() - started,
        detail: 'OpenRouter returned no choices.',
      };
    }

    const choice = data.choices[0];
    const message = choice.message || {};
    const content = typeof message.content === 'string' ? message.content : '';
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls = rawCalls.map(normaliseToolCall).filter(Boolean);

    return {
      ok: true,
      content,
      toolCalls,
      model: data.model || model,
      finishReason: String(choice.finish_reason || 'stop').toLowerCase(),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, error: 'timeout', model, latencyMs: Date.now() - started };
    }
    return { ok: false, error: 'network_error', model, latencyMs: Date.now() - started, detail: (err && err.message) || '' };
  } finally {
    clearTimeout(timer);
  }
}

// ── Vision completion ──────────────────────────────────────────────────────
// Coupon screenshot scanning uses an image+text prompt that must come back as
// strict JSON. OpenRouter's image_url content type accepts the same
// data:image/...;base64,... URLs the previous Gemini Vision call did, so the
// upstream code in couponVision.js only needs to swap the HTTP target.
//
// @param {object} input — { text: string, imageBase64: string, mimeType: string }
// @param {object} opts  — { model, timeoutMs, schemaHint }
// @returns {Promise<{ok, content, model, error?, status?, detail?}>}
async function visionCompletion(input, opts = {}) {
  if (!isConfigured()) {
    return { ok: false, error: 'not_configured', model: opts.model || getVisionModel() };
  }

  const model = opts.model || getVisionModel();
  const timeoutMs = clampTimeout(opts.timeoutMs);

  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: String(input.text || '').slice(0, 16000) },
      {
        type: 'image_url',
        // The previous Gemini Vision call sent raw base64. OpenRouter's image_url
        // wants a URL — a data: URL is the right shape for inline bytes.
        image_url: {
          url: `data:${input.mimeType || 'image/png'};base64,${input.imageBase64}`,
        },
      },
    ],
  }];

  const payload = {
    model,
    messages,
    temperature: 0,                                // extraction, not creativity
    max_tokens: clamp(opts.maxTokens, 64, 8192, 4096),
    // Many free providers support a JSON response mode; we ask politely but do
    // not fail if the model returns prose — the upstream code already calls
    // parseJsonLoosely on whatever comes back.
    ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(getBaseUrl() + '/chat/completions', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        error: classifyStatus(res.status, errText),
        status: res.status,
        model,
        latencyMs: Date.now() - started,
        detail: errText.slice(0, 300),
      };
    }

    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
      return {
        ok: false,
        error: 'empty_response',
        model,
        latencyMs: Date.now() - started,
        detail: 'OpenRouter returned no choices.',
      };
    }

    const message = data.choices[0].message || {};
    const content = typeof message.content === 'string' ? message.content : '';
    return {
      ok: true,
      content,
      model: data.model || model,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, error: 'timeout', model, latencyMs: Date.now() - started };
    }
    return { ok: false, error: 'network_error', model, latencyMs: Date.now() - started, detail: (err && err.message) || '' };
  } finally {
    clearTimeout(timer);
  }
}

function classifyStatus(status, errText) {
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 425) return 'timeout';
  if (status === 400) return 'bad_request';
  if (status === 401 || status === 403) return 'auth_error';
  if (status >= 500) return 'server_error';
  // OpenRouter occasionally returns 404 when a model id is invalid (e.g.
  // provider-side deprecation). Treat that as a non-transient caller error so
  // the fallback path can take over.
  if (status === 404) return 'bad_request';
  // 413 is "request body too large" — image base64 can blow the per-request
  // cap on free providers. Surface it as bad_request so the caller can
  // downscale the image rather than retry.
  if (status === 413) return 'bad_request';
  return 'api_error';
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// ── Server-side model allowlist ─────────────────────────────────────────────
// The frontend must never be able to select an arbitrary OpenRouter model.
// The chatbot settings row already coerces the model name (it rejects names
// containing '/' or the retired gemini-2.5-flash) before it reaches here, but
// a second guard here keeps a bypass from a misconfigured admin panel or a
// future caller from silently spending the free quota on an unrelated model.
//
// Allowlists:
//   - OPENROUTER_ALLOWED_MODELS  comma-separated; if non-empty, only these
//                                exact model ids are accepted. Empty (default)
//                                means "any of the configured primary /
//                                fallback / vision defaults are allowed" —
//                                which is the documented SaveHatke AI surface.
//
//   - OPENROUTER_BLOCKED_MODELS  comma-separated; these are always refused,
//                                so a compromised admin row that points at a
//                                paid-only model cannot drain quota.
function isModelAllowed(model) {
  if (!model || typeof model !== 'string') return false;
  const allowed = (process.env.OPENROUTER_ALLOWED_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(model)) return false;
  const blocked = (process.env.OPENROUTER_BLOCKED_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (blocked.includes(model)) return false;
  return true;
}

module.exports = {
  // Configuration / introspection (used by admin status + provider.js)
  isConfigured,
  getBaseUrl,
  getDefaultModel,
  getFallbackModel,
  getVisionModel,
  isModelAllowed,

  // Calls
  chatCompletion,
  chatCompletionPrimary,
  visionCompletion,

  // Exposed for tests / advanced callers
  _internal: { classifyStatus, isTransient, clampTimeout },
};
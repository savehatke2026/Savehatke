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
// - Fixed model chains, configurable via env. Chat walks Nemotron 3 Ultra →
//   Nemotron 3 Super → Gemma 4 31B → Gemma 4 26B; vision walks Gemma 4 31B →
//   Gemma 4 26B → Nemotron 3 Nano Omni. One attempt per model, first success
//   wins. A transient provider failure (429/5xx/timeout/network) moves to the
//   next model; non-transient failures (400/401/403) are returned without a
//   fallback so a bad request or invalid key is not retried against other
//   models and other quotas are not consumed.
// - Whole-call timeout enforced server-side via `AbortController`; each
//   attempt gets only the time remaining, and a fallback that cannot
//   reasonably finish is skipped, so the chain can never exceed the budget.
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
const DEFAULT_PRIMARY_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
// Fixed fallback chain for normal text chat. One attempt per model, in order,
// first success wins — a model is never retried and the walk stops as soon as
// one answers. (Verified live against the OpenRouter catalog: the shorter
// `nvidia/nemotron-3-super:free` id does not exist; this is the same model.)
const DEFAULT_CHAT_FALLBACKS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
];
// A free vision-capable default. The user can override with
// OPENROUTER_VISION_MODEL. The previous Gemini Vision call accepted JPEG/PNG/
// WebP; OpenRouter's image_url content type uses the same MIME types, so the
// upstream client (couponVision.js) sends them through unchanged. Deliberately
// separate from the chat chain: chat models are text-only, the scanner needs
// image input.
const DEFAULT_VISION_MODEL = 'google/gemma-4-31b-it:free';
const DEFAULT_VISION_FALLBACKS = [
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
];

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

function parseModelList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Fallback chain for normal text chat. OPENROUTER_CHAT_FALLBACK_MODELS
// (comma-separated) overrides the defaults; an explicit empty value or 'none'
// disables fallbacks entirely. The legacy single-model
// OPENROUTER_FALLBACK_MODEL variable (previously `openrouter/free`) is no
// longer read — the goal is to always know exactly which model answered.
function getChatFallbackModels() {
  const raw = process.env.OPENROUTER_CHAT_FALLBACK_MODELS;
  if (raw !== undefined) {
    if (raw.trim() === '' || raw.trim().toLowerCase() === 'none') return [];
    return parseModelList(raw);
  }
  return DEFAULT_CHAT_FALLBACKS.slice();
}

// Fallback chain for coupon screenshot scanning (image-capable models only).
// couponVision.js delegates here so the scanner and the model allowlist share
// one source of truth.
function getVisionFallbackModels() {
  const raw = process.env.OPENROUTER_VISION_FALLBACK_MODELS;
  if (raw !== undefined) {
    if (raw.trim() === '' || raw.trim().toLowerCase() === 'none') return [];
    return parseModelList(raw);
  }
  return DEFAULT_VISION_FALLBACKS.slice();
}

function getVisionModel() {
  return process.env.OPENROUTER_VISION_MODEL || DEFAULT_VISION_MODEL;
}

// Structured, safe AI logging: request id + model + outcome metadata only.
// Never logs API keys, authorization headers, message contents or user data.
function aiLog(opts, event, fields) {
  const reqId = (opts && opts.requestId) || '-';
  const extra = Object.entries(fields || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`[ai] req=${reqId} ${event}${extra ? ' ' + extra : ''}`);
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
  const site = (process.env.SITE_URL || 'https://savehatke.vercel.app').replace(/\/+$/, '');
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
// @param {object} opts   — { model, temperature, maxTokens, timeoutMs, tools, tool_choice, requestId }
// @returns {Promise<{ok, content, toolCalls, model, finishReason, error?, status?, detail?}>}
async function chatCompletion(messages, opts = {}) {
  return chatCompletionWith(messages, opts, /* walk */ 'full');
}

// Continue the chat chain FROM a specific model — the model that is already
// answering (e.g. the one that requested a tool call). Used for tool-call
// follow-ups so the same model writes the final answer. The canonical chain is
// the one the caller configured (opts.model = the configured head model, e.g.
// the admin's settings.model); the walk starts at opts.fromModel's position in
// it and moves forward only: earlier positions just failed seconds ago, so
// re-trying them would only burn quota. A from-model outside the configured
// chain heads it.
async function chatCompletionFrom(messages, opts = {}) {
  return chatCompletionWith(messages, opts, 'from');
}

// Single model, single attempt, no walk. Kept for callers that manage their
// own retry policy.
async function chatCompletionPrimary(messages, opts = {}) {
  return chatCompletionWith(messages, opts, 'single');
}

// Minimum wall-clock a chat attempt needs before it is worth starting. When
// less than this remains of the whole-call budget, further fallbacks are
// skipped — a request that cannot reasonably finish would only push the
// serverless function closer to its hard timeout without ever answering.
const MIN_ATTEMPT_MS = 5000;

function fullChatChain(opts) {
  const primary = opts.model || getDefaultModel();
  return [...new Set([primary, ...getChatFallbackModels()])].filter(Boolean);
}

async function chatCompletionWith(messages, opts = {}, walk) {
  if (!isConfigured()) {
    return { ok: false, error: 'not_configured', model: opts.model || getDefaultModel() };
  }

  // The caller's timeout is a WHOLE-CALL budget spanning every model attempt,
  // so primary + fallbacks can never exceed it and the serverless function
  // stays inside its wall clock. Each attempt gets whatever time remains;
  // attempts that cannot reasonably finish are skipped (see MIN_ATTEMPT_MS).
  const deadline = Date.now() + clampTimeout(opts.timeoutMs);
  let chain;
  if (walk === 'single') {
    chain = [opts.model || getDefaultModel()];
  } else if (walk === 'from') {
    const from = opts.fromModel || opts.model || getDefaultModel();
    const full = [...new Set([opts.model || getDefaultModel(), ...getChatFallbackModels()])].filter(Boolean);
    const idx = full.indexOf(from);
    chain = idx === -1 ? [...new Set([from, ...full])] : full.slice(idx);
  } else {
    chain = fullChatChain(opts);
  }

  let last = null;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const remaining = deadline - Date.now();
    if (i > 0 && remaining < MIN_ATTEMPT_MS) {
      aiLog(opts, 'AI fallback skipped', { model, reason: 'insufficient_time_remaining', remaining_ms: Math.round(remaining) });
      break;
    }
    aiLog(opts, 'AI request started', { model, attempt: `${i + 1}/${chain.length}`, budget_ms: Math.round(remaining) });
    const result = await callOnce(messages, { ...opts, model, timeoutMs: remaining });
    last = result;
    if (result.ok) {
      aiLog(opts, 'AI request succeeded', { model, latency_ms: result.latencyMs, fallback_index: i });
      return result;
    }
    aiLog(opts, 'AI model failed', { model, reason: result.error || 'error', status: result.status || '-', latency_ms: result.latencyMs });

    // Do not retry on non-transient errors, and never retry the same model:
    // one attempt per model, walk stops at the first success. A bad request
    // (400) is the caller's fault; an invalid key (401/403) cannot succeed on
    // another model; a content-blocked response (the model refused) is a
    // verdict, not a capacity problem.
    if (!isTransient(result)) return result;
    if (i < chain.length - 1) {
      aiLog(opts, 'Trying fallback', { model: chain[i + 1] });
    }
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
//
// Allowlists:
//   - OPENROUTER_ALLOWED_MODELS  comma-separated; if non-empty, only these
//                                exact model ids are accepted.
//   - OPENROUTER_BLOCKED_MODELS  comma-separated; these are always refused,
//                                so a compromised admin row that points at a
//                                paid-only model cannot drain quota.
//
// With both unset (the default) the gate is CLOSED: only the documented
// chat chain (Nemotron 3 Ultra / Super, Gemma 4 31B / 26B) and vision chain
// (Gemma 4 31B / 26B, Nemotron 3 Nano Omni) are accepted. Paid models,
// unknown models, embedding / reranker / safety-only models and any other id
// are rejected, so no caller — admin panel included — can steer free quota
// to an arbitrary model.
function isModelAllowed(model) {
  if (!model || typeof model !== 'string') return false;
  const blocked = parseModelList(process.env.OPENROUTER_BLOCKED_MODELS);
  if (blocked.includes(model)) return false;
  const allowed = parseModelList(process.env.OPENROUTER_ALLOWED_MODELS);
  if (allowed.length > 0) return allowed.includes(model);
  return [...new Set([...fullChatChain({}), getVisionModel(), ...getVisionFallbackModels()])].includes(model);
}

module.exports = {
  // Configuration / introspection (used by admin status + provider.js)
  isConfigured,
  getBaseUrl,
  getDefaultModel,
  getChatFallbackModels,
  getVisionFallbackModels,
  getVisionModel,
  isModelAllowed,

  // Calls
  chatCompletion,
  chatCompletionFrom,
  chatCompletionPrimary,
  visionCompletion,

  // Exposed for tests / advanced callers
  _internal: { classifyStatus, isTransient, clampTimeout, aiLog },
};
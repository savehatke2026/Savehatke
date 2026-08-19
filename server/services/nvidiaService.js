// ============================================
// SaveHatke — NVIDIA AI Service (Server-Only)
// ============================================
// Talks to the NVIDIA NIM API (OpenAI-compatible /v1/chat/completions).
// SECURITY: The NVIDIA API key lives ONLY in server-side environment
// variables. It is never returned to any client, never logged, and never
// embedded in frontend code.

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MODEL = 'meta/llama-3.1-8b-instruct';

function isConfigured() {
  return !!process.env.NVIDIA_API_KEY;
}

function getBaseUrl() {
  return (process.env.NVIDIA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function getDefaultModel() {
  return process.env.NVIDIA_MODEL || DEFAULT_MODEL;
}

/**
 * Call the NVIDIA chat completions API.
 * @param {Array} messages — [{role:'system'|'user'|'assistant'|'tool', content}]
 * @param {object} opts — { model, temperature, maxTokens, timeoutMs, tools }
 * @returns {Promise<{ok:boolean, content:string, toolCalls:Array, model:string, finishReason:string, error?:string}>}
 */
async function chatCompletion(messages, opts = {}) {
  if (!isConfigured()) {
    return { ok: false, error: 'not_configured', model: opts.model || getDefaultModel() };
  }

  const model = opts.model || getDefaultModel();
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 30000, 5000), 120000);

  const body = {
    model,
    messages,
    temperature: Math.min(Math.max(Number(opts.temperature ?? 0.4), 0), 2),
    max_tokens: Math.min(Math.max(Number(opts.maxTokens) || 1024, 64), 4096),
    stream: false,
  };
  if (Array.isArray(opts.tools) && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${getBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // SECURITY: bearer key is server-side only; never surface it in responses or logs
        'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errType = 'api_error';
      if (res.status === 401 || res.status === 403) errType = 'auth_error';
      else if (res.status === 429) errType = 'rate_limited';
      return { ok: false, error: errType, status: res.status, model, detail: errText.slice(0, 200) };
    }

    const data = await res.json();
    const choice = data.choices && data.choices[0];
    const message = choice && choice.message ? choice.message : {};

    // Extract tool calls (OpenAI-compatible format) if present
    const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? message.tool_calls
      : [];

    return {
      ok: true,
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls,
      model: data.model || model,
      finishReason: choice ? choice.finish_reason : 'stop',
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, error: 'timeout', model };
    }
    return { ok: false, error: 'network_error', model };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  isConfigured,
  getBaseUrl,
  getDefaultModel,
  chatCompletion,
};

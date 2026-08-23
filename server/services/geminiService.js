// ============================================
// SaveHatke — Gemini AI Service (Server-Only)
// ============================================
// Talks to the Google Gemini API (generativelanguage.googleapis.com,
// models/{model}:generateContent). Accepts and returns OpenAI-style
// messages/tool-calls so the chatbot engine stays provider-agnostic.
// SECURITY: The Gemini API key lives ONLY in server-side environment
// variables. It is never returned to any client, never logged, and never
// embedded in frontend code.

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
// gemini-2.5-flash was retired for new API keys (404 "no longer available
// to new users") — 3.6-flash is the current recommended Flash model.
// NOTE: 3.x Flash models REJECT generationConfig.thinkingConfig (400), so
// the thinking-budget workaround below stays scoped to 2.5 models only.
const DEFAULT_MODEL = 'gemini-3.6-flash';

function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

function getBaseUrl() {
  return (process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function getDefaultModel() {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

/**
 * Convert OpenAI-style messages ([{role:'system'|'user'|'assistant'|'tool'}])
 * into Gemini's { systemInstruction, contents } shape.
 */
function toGeminiPayload(messages) {
  const systemTexts = [];
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (msg.content) systemTexts.push(String(msg.content));
      continue;
    }
    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: String(msg.content || '') }] });
      continue;
    }
    if (msg.role === 'assistant') {
      const parts = [];
      if (msg.content) parts.push({ text: String(msg.content) });
      for (const tc of msg.tool_calls || []) {
        if (!tc || !tc.function || !tc.function.name) continue;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
        // Gemini 3.x requires the thoughtSignature from the original tool
        // call to be echoed back on the functionCall part — omitting it
        // makes the follow-up request fail with a 400.
        const fnPart = { functionCall: { name: tc.function.name, args } };
        if (tc.thoughtSignature) fnPart.thoughtSignature = tc.thoughtSignature;
        parts.push(fnPart);
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }
    if (msg.role === 'tool') {
      // Gemini expects a user turn carrying functionResponse parts
      let response;
      try { response = JSON.parse(String(msg.content || '{}')); } catch (e) { response = { result: String(msg.content || '') }; }
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: msg.name || 'tool', response } }],
      });
      continue;
    }
  }

  const payload = { contents };
  if (systemTexts.length > 0) {
    payload.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
  }
  return payload;
}

/**
 * Convert OpenAI-style tool definitions
 * ([{type:'function', function:{name, description, parameters}}])
 * into Gemini's tools: [{ functionDeclarations: [...] }] shape.
 */
function toGeminiTools(tools) {
  const declarations = [];
  for (const t of tools || []) {
    const fn = t && t.function ? t.function : t;
    if (!fn || !fn.name) continue;
    declarations.push({
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} },
    });
  }
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;
}

/**
 * Call the Gemini generateContent API.
 * @param {Array} messages — [{role:'system'|'user'|'assistant'|'tool', content}]
 * @param {object} opts — { model, temperature, maxTokens, timeoutMs, tools }
 * @returns {Promise<{ok:boolean, content:string, toolCalls:Array, model:string, finishReason:string, error?:string}>}
 */
async function chatCompletion(messages, opts = {}) {
  const result = await chatCompletionOnce(messages, opts);

  // A stored/requested model may have been retired by Google (404 "no
  // longer available"). Retry once with the current default model instead
  // of failing the whole chat request.
  if (
    !result.ok &&
    result.error === 'api_error' &&
    result.status === 404 &&
    /no longer available/i.test(String(result.detail || '')) &&
    result.model !== getDefaultModel()
  ) {
    console.warn(`[Gemini] Model ${result.model} is no longer available — retrying with ${getDefaultModel()}. Update GEMINI_MODEL/chatbot settings to remove this warning.`);
    return chatCompletionOnce(messages, { ...opts, model: getDefaultModel() });
  }
  return result;
}

async function chatCompletionOnce(messages, opts = {}) {
  if (!isConfigured()) {
    return { ok: false, error: 'not_configured', model: opts.model || getDefaultModel() };
  }

  const model = opts.model || getDefaultModel();
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 30000, 5000), 120000);

  const payload = toGeminiPayload(messages);
  payload.generationConfig = {
    temperature: Math.min(Math.max(Number(opts.temperature ?? 0.4), 0), 2),
    maxOutputTokens: Math.min(Math.max(Number(opts.maxTokens) || 1024, 64), 8192),
  };
  // 2.5 Flash models spend the output budget on internal "thinking" by
  // default; disable it so short chatbot replies aren't starved of tokens.
  if (/gemini-2\.5-flash/.test(model)) {
    payload.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const tools = toGeminiTools(opts.tools);
  if (tools) payload.tools = tools;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${getBaseUrl()}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // SECURITY: API key is server-side only; sent as header so it never
        // appears in URLs, responses or logs
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errType = 'api_error';
      if (res.status === 429) errType = 'rate_limited';
      else if (res.status === 401 || res.status === 403 || /api key not valid/i.test(errText)) errType = 'auth_error';
      return { ok: false, error: errType, status: res.status, model, detail: errText.slice(0, 200) };
    }

    const data = await res.json();
    const candidate = data.candidates && data.candidates[0];

    if (!candidate || !candidate.content) {
      const blockReason = (data.promptFeedback && data.promptFeedback.blockReason) ||
        (candidate && candidate.finishReason) || 'empty_response';
      return { ok: false, error: 'content_blocked', model, detail: String(blockReason).slice(0, 200) };
    }

    // Flatten parts: text parts → content, functionCall parts → OpenAI-style
    // toolCalls. The thoughtSignature is preserved so it can be echoed back
    // on the next round-trip (required by Gemini 3.x for tool calling).
    let content = '';
    const toolCalls = [];
    for (const part of candidate.content.parts || []) {
      if (typeof part.text === 'string') content += part.text;
      if (part.functionCall && part.functionCall.name) {
        toolCalls.push({
          id: part.functionCall.id || 'call_' + (toolCalls.length + 1) + '_' + Date.now().toString(36),
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        });
      }
    }

    return {
      ok: true,
      content,
      toolCalls,
      model: data.modelVersion || model,
      finishReason: String(candidate.finishReason || 'STOP').toLowerCase(),
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

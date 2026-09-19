// ============================================
// SaveHatke AI — Provider Abstraction (Server-Only)
// ============================================
// One interface, two implementations behind it:
//
//   SAVEHATKE_AI (default) — the custom engine in services/ai/
//   GEMINI                 — the previous reasoning layer, kept selectable
//                            during development so the two can be compared
//                            in place before Gemini is retired.
//
// The chatbot service depends on THIS module, never on a provider directly, so
// swapping or removing a provider is a change in one file. Both providers
// return the same shape, which is what keeps /api/chat's contract stable.
//
// SECURITY: this module never touches an API key. The Gemini provider reads its
// own key from the environment internally; nothing here logs, returns or
// forwards a credential.

const config = require('./config');
const savehatkeAI = require('./savehatkeAI');

function getProviderName() {
  return config.provider;
}

function isConfigured() {
  if (getProviderName() === 'GEMINI') {
    // eslint-disable-next-line global-require
    return require('../geminiService').isConfigured();
  }
  return config.enabled;
}

/**
 * Run a message through the selected provider.
 *
 * @param {object} input
 * @param {string} input.message
 * @param {string} [input.conversationId]
 * @param {object|null} [input.user]
 * @param {Array} [input.adminKnowledge]
 * @param {object} [input.geminiContext] — { settings, history, toolDefs, callOpts,
 *        executeTool } supplied by the caller when the Gemini provider is
 *        selected, because that path needs the pre-existing prompt/tool wiring.
 * @param {Function} [input.log]
 * @returns {Promise<object>} a normalised result
 */
async function generate(input = {}) {
  const provider = getProviderName();

  if (provider === 'GEMINI') {
    return generateWithGemini(input);
  }
  return generateWithSaveHatkeAI(input);
}

async function generateWithSaveHatkeAI(input) {
  const result = await savehatkeAI.handle({
    message: input.message,
    conversationId: input.conversationId,
    user: input.user,
    adminKnowledge: input.adminKnowledge,
    log: input.log,
  });
  return {
    provider: 'SAVEHATKE_AI',
    ok: result.ok !== false,
    text: result.text || '',
    cards: result.cards || [],
    chips: result.chips || [],
    support: result.support,
    blocked: Boolean(result.blocked),
    category: result.category || null,
    loginRequired: Boolean(result.loginRequired),
    model: 'savehatke-ai',
    meta: result.meta || {},
  };
}

/**
 * The Gemini path, preserved so the previous behaviour remains available.
 * It executes the tool loop the chatbot service used to own; the caller passes
 * everything it needs because the prompt assembly stays where it already lives.
 */
async function generateWithGemini(input) {
  // eslint-disable-next-line global-require
  const gemini = require('../geminiService');
  const ctx = input.geminiContext || {};
  const { settings, aiMessages, callOpts, executeTool } = ctx;

  if (!gemini.isConfigured()) {
    return {
      provider: 'GEMINI',
      ok: false,
      error: 'not_configured',
      text: '',
      cards: [],
      chips: [],
      model: settings ? settings.model : 'gemini',
      meta: {},
    };
  }

  let result = await gemini.chatCompletion(aiMessages, callOpts);
  let loop = 0;
  const maxLoop = config.toolRounds;

  while (result.ok && result.toolCalls && result.toolCalls.length > 0 && loop < maxLoop) {
    loop += 1;
    aiMessages.push({ role: 'assistant', content: result.content || '', tool_calls: result.toolCalls });
    for (const tc of result.toolCalls) {
      const fnName = tc.function && tc.function.name;
      let fnArgs = {};
      try { fnArgs = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) { /* ignored */ }
      const toolResult = await executeTool(fnName, fnArgs, settings, input.user);
      aiMessages.push({
        role: 'tool',
        name: fnName,
        content: JSON.stringify(toolResult).slice(0, 4000),
        tool_call_id: tc.id || ('call_' + loop),
      });
    }
    result = await gemini.chatCompletion(aiMessages, callOpts);
  }

  // Tool rounds exhausted but no text produced — ask once more without tools.
  if (result.ok && !result.content && (!result.toolCalls || result.toolCalls.length === 0 || loop >= maxLoop)) {
    result = await gemini.chatCompletion(aiMessages, { ...callOpts, tools: undefined });
  }

  if (!result.ok) {
    return {
      provider: 'GEMINI',
      ok: false,
      error: result.error || 'api_error',
      text: '',
      cards: [],
      chips: [],
      model: result.model || (settings && settings.model),
      meta: {},
    };
  }

  return {
    provider: 'GEMINI',
    ok: true,
    text: result.content || '',
    cards: [],
    chips: [],
    model: result.model,
    meta: {},
  };
}

/** Provider status for the admin surface. Never returns a key. */
function describeProviders() {
  return [
    {
      name: 'SAVEHATKE_AI',
      active: config.provider === 'SAVEHATKE_AI',
      configured: config.enabled,
      requiresKey: false,
      description: 'Custom SaveHatke engine — CPU-only, no external AI service.',
      status: savehatkeAI.describe(),
    },
    {
      name: 'GEMINI',
      active: config.provider === 'GEMINI',
      // eslint-disable-next-line global-require
      configured: require('../geminiService').isConfigured(),
      requiresKey: true,
      description: 'Previous reasoning layer. Kept selectable during development.',
    },
  ];
}

module.exports = {
  generate,
  getProviderName,
  isConfigured,
  describeProviders,
  savehatkeAI,
};
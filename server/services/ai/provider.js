// ============================================
// SaveHatke AI — Provider Abstraction (Server-Only)
// ============================================
// One interface, two implementations behind it:
//
//   SAVEHATKE_AI — the custom engine in services/ai/ (CPU-only, no external
//                  AI service; uses local knowledge + deterministic tools)
//   OPENROUTER   — OpenRouter-hosted free models (NVIDIA Nemotron 3 Ultra
//                  primary; Nemotron 3 Super → Gemma 4 31B → Gemma 4 26B take
//                  over on transient errors). Replaces the previous Gemini
//                  provider.
//
// The chatbot service depends on THIS module, never on a provider directly, so
// swapping or removing a provider is a change in one file. Both providers
// return the same shape, which is what keeps /api/chat's contract stable.
//
// SECURITY: this module never touches an API key. The OpenRouter provider
// reads its own key from the environment internally; nothing here logs,
// returns or forwards a credential.

const config = require('./config');
const savehatkeAI = require('./savehatkeAI');

function getProviderName() {
  return config.provider;
}

function isConfigured() {
  if (getProviderName() === 'OPENROUTER') {
    // eslint-disable-next-line global-require
    return require('../openrouterService').isConfigured();
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
 * @param {object} [input.openrouterContext] — { settings, aiMessages, callOpts,
 *        executeTool } supplied by the caller when the OpenRouter provider is
 *        selected, because that path needs the pre-existing prompt/tool wiring.
 * @param {Function} [input.log]
 * @returns {Promise<object>} a normalised result
 */
async function generate(input = {}) {
  const provider = getProviderName();

  if (provider === 'OPENROUTER') {
    return generateWithOpenRouter(input);
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
 * The OpenRouter path, replacing the previous Gemini call. The provider
 * wrapper handles the primary → fallback chain on transient errors and the
 * server-side timeout, so this method only orchestrates the tool-call loop.
 */
async function generateWithOpenRouter(input) {
  // eslint-disable-next-line global-require
  const openrouter = require('../openrouterService');
  const ctx = input.openrouterContext || {};
  const { settings, aiMessages, callOpts, executeTool } = ctx;

  if (!openrouter.isConfigured()) {
    return {
      provider: 'OPENROUTER',
      ok: false,
      error: 'not_configured',
      text: '',
      cards: [],
      chips: [],
      model: settings ? settings.model : 'openrouter',
      meta: {},
    };
  }

  // The wrapper already walked the fallback chain if the primary returned a
  // transient error. We do NOT re-enter chatCompletion() (which would restart
  // the chain from the top), only chatCompletionFrom() so follow-up rounds
  // stay on the model that is already answering.
  let result = await openrouter.chatCompletion(aiMessages, callOpts);
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
    result = await openrouter.chatCompletionFrom(aiMessages, { ...callOpts, fromModel: result.model });
  }

  // Tool rounds exhausted but no text produced — ask once more without tools.
  if (result.ok && !result.content && (!result.toolCalls || result.toolCalls.length === 0 || loop >= maxLoop)) {
    result = await openrouter.chatCompletionFrom(aiMessages, { ...callOpts, fromModel: result.model, tools: undefined });
  }

  if (!result.ok) {
    return {
      provider: 'OPENROUTER',
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
    provider: 'OPENROUTER',
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
  // eslint-disable-next-line global-require
  const openrouter = require('../openrouterService');
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
      name: 'OPENROUTER',
      active: config.provider === 'OPENROUTER',
      configured: openrouter.isConfigured(),
      requiresKey: true,
      description: 'Free OpenRouter-hosted models (Nemotron 3 Ultra primary; Super → Gemma 4 chain on transient errors).',
      primaryModel: openrouter.getDefaultModel(),
      fallbackModels: openrouter.getChatFallbackModels(),
      visionModel: openrouter.getVisionModel(),
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
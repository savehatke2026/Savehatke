// ============================================
// SaveHatke AI — Engine Configuration (Server-Only)
// ============================================
// Every tunable for the custom SaveHatke AI engine lives here so behaviour can
// be adjusted by environment (Vercel dashboard) without touching engine code.
//
// SECURITY: no secret is ever defined here. Provider keys are read from the
// environment by the provider they belong to (e.g. geminiService), never
// re-exported through this module, and never surfaced to a client.

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === '1';
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function float(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Provider selection.
 *   SAVEHATKE_AI — the custom engine (default)
 *   GEMINI       — the previous reasoning layer, kept selectable during
 *                  development so the two can be compared in place.
 */
function getProvider() {
  const raw = String(process.env.AI_PROVIDER || 'SAVEHATKE_AI').trim().toUpperCase();
  return raw === 'GEMINI' ? 'GEMINI' : 'SAVEHATKE_AI';
}

const config = {
  get provider() { return getProvider(); },

  // Master switch for the custom engine. When false the caller falls back to
  // the knowledge-only / static fallback path that already exists.
  get enabled() { return bool(process.env.AI_ENABLED, true); },

  // Runtime model artifacts (compiled by scripts/ai/train.js and statically
  // required so the Vercel bundler traces them into the function).
  get modelPath() { return process.env.AI_MODEL_PATH || 'server/models/ai'; },

  // Confidence bands. >= high → answer directly; >= medium → answer but invite
  // a clarifying follow-up; below medium → ask for detail rather than guess.
  get confidenceThreshold() { return float(process.env.AI_CONFIDENCE_THRESHOLD, 0.55); },
  get highConfidence() { return float(process.env.AI_HIGH_CONFIDENCE, 0.80); },

  // How many retrieval candidates the knowledge engine may consider, and how
  // many it may hand to the response engine.
  get maxKnowledgeHits() { return int(process.env.AI_MAX_KNOWLEDGE_HITS, 3); },
  get maxContext() { return int(process.env.AI_MAX_CONTEXT, 20); },

  // Tool rounds. The custom engine plans tools deterministically, so one round
  // is normally enough; the ceiling mirrors the old Gemini loop bound.
  get toolRounds() { return int(process.env.AI_TOOL_ROUNDS, 2); },

  // Reply size caps.
  get maxTokens() { return int(process.env.AI_MAX_TOKENS, 1024); },
  get maxMessageLength() { return int(process.env.AI_MAX_MESSAGE_LENGTH, 1000); },
  get maxReplyLength() { return int(process.env.AI_MAX_REPLY_LENGTH, 4000); },

  // Whole-engine wall clock. Kept well under the platform timeout; the engine
  // degrades to a knowledge/static answer rather than hanging.
  get timeoutMs() { return int(process.env.AI_TIMEOUT, 8000); },

  // Cards/chips the widget can render per reply. The frontend caps cards at 3
  // and requires 2–4 chips, so these are aligned with it deliberately.
  get maxCards() { return int(process.env.AI_MAX_CARDS, 3); },
  get maxChips() { return int(process.env.AI_MAX_CHIPS, 4); },

  // Conversation memory (in-process only). The Google Sheets transcript stays
  // the durable record; this is a short-lived aid for follow-ups like
  // "which one expires first?".
  get memoryTtlMs() { return int(process.env.AI_MEMORY_TTL_MS, 30 * 60 * 1000); },
  get memoryMaxTurns() { return int(process.env.AI_MEMORY_MAX_TURNS, 12); },
  get memoryMaxEntries() { return int(process.env.AI_MEMORY_MAX_ENTRIES, 500); },

  // Support desk hours shown when live ticket data is unavailable.
  get supportHours() { return process.env.AI_SUPPORT_HOURS || 'Mon–Sat, 9 AM–7 PM IST'; },
};

module.exports = config;
module.exports.getProvider = getProvider;
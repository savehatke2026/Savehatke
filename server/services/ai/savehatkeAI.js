// ============================================
// SaveHatke AI — Engine Orchestrator (Server-Only)
// ============================================
// The pipeline the brief specifies, in order:
//
//   message
//     → securityEngine.scanInput        (before anything reasons)
//     → intentEngine.classify           (intent + entities)
//     → contextManager                  (memory, follow-up resolution)
//     → reasoningCore.plan              (choose tool / direct / clarify)
//     → toolRouter.execute              (live backend data, session identity)
//     → knowledgeEngine.retrieve        (official answers)
//     → responseEngine                  (compose from verified facts)
//     → securityEngine.filterOutput     (after generation)
//     → { text, cards, chips, meta }
//
// The engine is intentionally linear and inspectable: no component can skip a
// stage, and the security filter has the last word.
//
// AUTHORITY: this module never computes a business value. Earnings, payout
// state and coupon availability come from toolRouter, which reads the same
// services the website uses. If a read fails, the engine reports the failure.

const config = require('./config');
const security = require('./securityEngine');
const intentEngine = require('./intentEngine');
const contextManager = require('./contextManager');
const reasoningCore = require('./reasoningCore');
const toolRouter = require('./toolRouter');
const knowledgeEngine = require('./knowledgeEngine');
const responseEngine = require('./responseEngine');
const modelLoader = require('./modelLoader');

/**
 * Handle one message end to end.
 *
 * @param {object} input
 * @param {string} input.message
 * @param {string} [input.conversationId]
 * @param {object|null} [input.user] — verified session identity ({id,email,role})
 * @param {Array}  [input.adminKnowledge] — enabled rows from the admin knowledge sheet
 * @param {Function} [input.log] — optional structured logger
 * @returns {Promise<{ok, text, cards, chips, meta, blocked?, category?}>}
 */
async function handle(input = {}) {
  const started = Date.now();
  const rawMessage = String(input.message || '');
  const conversationId = input.conversationId || null;
  const user = input.user || null;
  const log = typeof input.log === 'function' ? input.log : () => {};

  const meta = {
    engine: 'SaveHatke AI',
    provider: config.provider,
    intent: null,
    confidence: 0,
    band: null,
    tool: null,
    toolsUsed: [],
    knowledgeHits: 0,
    followUp: false,
    blocked: false,
    blockedCategory: null,
    redactions: [],
    latencyMs: 0,
    degraded: false,
  };

  const finish = (result) => {
    meta.latencyMs = Date.now() - started;
    return { ...result, meta };
  };

  // ── Stage 1: input security ────────────────────────────────────────────
  // Runs before tokenisation, classification and any tool. The engine never
  // reasons about a message that failed this gate.
  const stripped = security.stripInvisible(rawMessage);
  const scan = security.scanInput(stripped);
  if (scan.blocked) {
    meta.blocked = true;
    meta.blockedCategory = scan.category;
    log({ status: 'blocked', errorType: scan.category, meta });
    return finish({
      ok: false,
      blocked: true,
      category: scan.category,
      text: scan.reply,
      cards: [],
      chips: ['Show me coupons', 'How does SaveHatke work?', 'Contact support'],
    });
  }

  // ── Stage 2: intent + entities ─────────────────────────────────────────
  const classification = intentEngine.classify(stripped);
  meta.intent = classification.intent;
  meta.confidence = classification.confidence;
  meta.band = classification.band;

  // ─ Stage 3: conversation context ──────────────────────────────────────
  const context = contextManager.begin(conversationId, user);
  const reference = contextManager.resolveReference(stripped, conversationId, user);
  meta.followUp = Boolean(reference.isFollowUp);

  // A follow-up inherits the previous turn's entities so "which one" and
  // "those under ₹200" still know what is being referred to.
  if (reference.isFollowUp) {
    classification.entities = contextManager.mergeEntities(conversationId, user, classification.entities);
  }

  // ── Stage 4: plan ──────────────────────────────────────────────────────
  const plan = reasoningCore.plan({ classification, user, context, reference });
  meta.plan = plan.action;

  let composed = null;
  let toolResult = null;

  // ─ Stage 5a: clarification (no guessing) ──────────────────────────────
  if (plan.action === 'clarify') {
    composed = responseEngine.composeClarification(classification);
  // ── Stage 5b: login gate ───────────────────────────────────────────────
  } else if (plan.action === 'login_required') {
    composed = {
      text: plan.reply,
      cards: [],
      chips: responseEngine.finaliseChips(plan.chips, []),
      tool: null,
      grounded: true,
      loginRequired: true,
    };
  // ── Stage 5c: fixed product knowledge ──────────────────────────────────
  } else if (plan.action === 'answer') {
    composed = responseEngine.composeDirectAnswer(plan.directAnswer);
  // ── Stage 5d: tool-backed answer ───────────────────────────────────────
  } else if (plan.action === 'tool') {
    const toolName = plan.tools[0].name;
    const toolArgs = plan.args || plan.tools[0].args || {};

    if (toolName === 'search_knowledge') {
      // Knowledge retrieval is a read of the knowledge base, not a business tool.
      const hits = knowledgeEngine.retrieve(stripped, {
        intent: classification.intent,
        entities: classification.entities,
        adminEntries: input.adminKnowledge || [],
        limit: config.maxKnowledgeHits,
      });
      meta.knowledgeHits = hits.length;
      meta.tool = 'search_knowledge';
      meta.toolsUsed = ['search_knowledge'];
      const confidence = knowledgeEngine.hitConfidence(hits);
      composed = responseEngine.composeFromKnowledge(hits, confidence);
    } else {
      // Identity comes only from the verified session; the plan cannot supply it.
      toolResult = await toolRouter.execute(toolName, toolArgs, { user, conversationId });
      meta.tool = toolName;
      meta.toolsUsed = [toolName];

      // A tool that needs a login returns login_required; surface it as such so
      // the route can answer 401 like the old pipeline did.
      if (toolResult && toolResult.error === 'login_required') {
        composed = responseEngine.composeToolReply(toolName, toolResult, plan);
        composed.loginRequired = true;
      } else {
        composed = responseEngine.composeToolReply(toolName, toolResult, plan, {
          lowConfidence: classification.band === 'medium',
        });
      }

      // One optional follow-up tool: a payout question that finds money owed but
      // no destination benefits from the profile's payout-details state, and an
      // earnings question is more useful with the payout position. Bounded to a
      // single extra call to keep latency flat.
      if (config.toolRounds > 1 && toolResult && toolResult.ok) {
        const followUpTool = pickFollowUpTool(toolName, toolResult, user);
        if (followUpTool) {
          const second = await toolRouter.execute(followUpTool.name, followUpTool.args, { user, conversationId });
          if (second && second.ok) {
            meta.toolsUsed.push(followUpTool.name);
            toolResult = { [toolName]: toolResult, [followUpTool.name]: second };
            composed = mergeFollowUp(composed, followUpTool.name, second);
          }
        }
      }
    }
  // ── Stage 5e: knowledge fallback for unclassified-but-answerable ───────
  } else {
    const hits = knowledgeEngine.retrieve(stripped, {
      intent: classification.intent,
      entities: classification.entities,
      adminEntries: input.adminKnowledge || [],
      limit: config.maxKnowledgeHits,
    });
    meta.knowledgeHits = hits.length;
    composed = responseEngine.composeFromKnowledge(hits, knowledgeEngine.hitConfidence(hits));
  }

  if (!composed) {
    composed = responseEngine.composeClarification(classification);
  }

  // ── Stage 6: output security (last word) ───────────────────────────────
  // Coupon codes are permitted only when the reply came from the buyer's own
  // purchase list, which is the one tool authorized to return one.
  const revealCodes = meta.tool === 'check_purchases';
  const filtered = security.filterOutput(composed.text, {
    revealCodes,
    maxLength: config.maxReplyLength,
  });
  meta.redactions = filtered.redacted;

  // ── Stage 7: groundedness check ────────────────────────────────────────
  // Any monetary figure in the reply must appear in the tool result it came
  // from. A mismatch means the reply invented a number, which must not ship.
  if (toolResult && composed.grounded) {
    const flat = Array.isArray(toolResult)
      ? toolResult
      : Object.values(toolResult);
    const check = security.verifyGrounded(filtered.text, flat);
    if (!check.ok) {
      meta.groundednessFailure = check.suspicious;
      meta.degraded = true;
      log({ status: 'groundedness_failure', meta });
      const safe = {
        text: responseEngine.RETRIEVAL_FAILED,
        cards: [],
        chips: responseEngine.finaliseChips(['Try again', 'Contact support'], []),
        tool: meta.tool,
        grounded: false,
      };
      composed = safe;
    }
  }

  // ─ Stage 8: remember the exchange (bounded, redacted) ──────────────────
  // Recorded AFTER filtering, so a scrubbed reply is what gets remembered.
  contextManager.record(conversationId, user, {
    userText: stripped,
    assistantText: filtered.text,
    intent: meta.intent,
    entities: classification.entities,
    tool: meta.tool ? { name: meta.tool, summary: summariseForMemory(meta.tool, toolResult) } : null,
  });

  meta.redactions = meta.redactions || [];
  if (meta.redactions.length) log({ status: 'output_redacted', meta });

  return finish({
    ok: true,
    text: filtered.text,
    cards: composed.cards || [],
    chips: composed.chips || [],
    support: composed.support,
    loginRequired: Boolean(composed.loginRequired),
    grounded: Boolean(composed.grounded),
    intent: meta.intent,
    confidence: meta.confidence,
  });
}

/**
 * Choose at most one additional tool that makes the answer materially better.
 * Bounded and explicit — no open-ended agent loop.
 */
function pickFollowUpTool(primaryTool, result, user) {
  if (!user || !user.email) return null;
  if (primaryTool === 'check_payout_status' && result.ok && result.owedAmount > 0 && !result.hasDestination) {
    return { name: 'get_user_profile', args: {} };
  }
  if (primaryTool === 'check_earnings' && result.ok && result.soldCoupons > 0) {
    return { name: 'check_payout_status', args: {} };
  }
  return null;
}

/**
 * Fold a second tool's facts into the composed reply without letting it
 * contradict the first. Only additive phrasing is used.
 */
function mergeFollowUp(composed, toolName, result) {
  const text = String(composed.text || '');
  if (toolName === 'get_user_profile' && result && !result.hasPayoutDetails) {
    return {
      ...composed,
      text: `${text}\n\nOne thing to sort out: your payout details aren't on file yet, so add a UPI ID or QR code in your account settings and the payout can be processed.`,
      chips: responseEngine.finaliseChips(['Add payout details'].concat(composed.chips || []), []),
    };
  }
  if (toolName === 'check_payout_status' && result && result.ok) {
    if (result.owedAmount > 0) {
      return {
        ...composed,
        text: `${text} ${toolRouter.formatINR(result.owedAmount)} of that is still waiting to be paid out.`,
        chips: responseEngine.finaliseChips(['Where is my payout?'].concat(composed.chips || []), []),
      };
    }
    if (result.paidAmount > 0) {
      return {
        ...composed,
        text: `${text} ${toolRouter.formatINR(result.paidAmount)} has already been paid out to you.`,
        chips: composed.chips,
      };
    }
  }
  return composed;
}

/** A slim, code-free projection of a tool result for conversation memory. */
function summariseForMemory(toolName, result) {
  if (!result || typeof result !== 'object') return null;
  const r = Array.isArray(result) ? result[0] : result;
  switch (toolName) {
    case 'search_coupons':
      return {
        brands: (r.results || []).map((c) => c.brand).slice(0, 5),
        totalMatches: r.totalMatches,
      };
    case 'check_earnings':
      return { soldCoupons: r.soldCoupons, totalEarned: r.totalEarned };
    case 'check_payout_status':
      return { owedAmount: r.owedAmount, paidAmount: r.paidAmount };
    default:
      // contextManager.stripSensitive removes codes and secrets from this.
      return r;
  }
}

/** Diagnostics — no secrets, safe for an admin status view. */
function describe() {
  const model = modelLoader.describe();
  return {
    ...model,
    enabled: config.enabled,
    confidenceThreshold: config.confidenceThreshold,
    highConfidence: config.highConfidence,
    knowledgeEntries: knowledgeEngine.count(),
    knowledgeCategories: knowledgeEngine.listCategories().length,
    toolsAvailable: toolRouter.availableTools({ user: null }).length,
    memory: contextManager.stats(),
    payoutPricingModel: toolRouter.PAYOUT_PRICING_MODEL,
  };
}

module.exports = {
  handle,
  describe,
  // exposed so the caller can build the admin knowledge list once per request
  TOOL_LEVELS: toolRouter.LEVEL,
};
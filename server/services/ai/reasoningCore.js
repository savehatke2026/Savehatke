// ============================================
// SaveHatke AI — Reasoning Core (Server-Only)
// ============================================
// Turns a classified intent plus its entities into a concrete plan: which tool
// (if any) to call, with which arguments, or whether the question can be
// answered directly from fixed product knowledge.
//
// This is the component a learned policy model would replace later. Keeping it
// separate from savehatkeAI.js is deliberate: the orchestrator owns the
// pipeline and the safety ordering, this file owns only the decision of "what
// does this question need?".
//
// AUTHORITY: the planner only ever chooses from the toolRouter allowlist. It
// cannot invent a tool name, cannot pass an identity, and cannot widen scope —
// arguments are limited to search criteria, and user identity is supplied by
// the caller from the verified session.

const config = require('./config');
const intentEngine = require('./intentEngine');
const toolRouter = require('./toolRouter');

// Intents answered from fixed product knowledge. These are stable facts about
// how SaveHatke works, so they need no datastore read.
const DIRECT_ANSWERS = {
  GREETING: {
    text: "Hey! I'm the SaveHatke AI Assistant. I can help you find coupons, understand buying and selling, check your earnings and payouts, or sort out your account. What do you need?",
    chips: ['Show me coupons', 'How does SaveHatke work?', 'Check my earnings', 'How do I sell?'],
  },
  GOODBYE: {
    text: 'Happy to help any time. Come back whenever you need a hand with coupons or your account.',
  },
  THANKS: {
    text: "You're welcome! Anything else I can help you with?",
  },
  GENERAL_HELP: {
    text: "I can help with a few things here:\n\n• Finding coupons — tell me a brand, category or budget\n• Buying — how checkout and delivery of the code work\n• Selling — whether you can list, and how submissions are reviewed\n• Earnings and payouts — what you've earned and where your payout stands\n• Account and security — sign-in, sessions, 2FA and privacy\n• Support — raising a ticket and checking its status\n\nWhat would you like to start with?",
    chips: ['Show me coupons', 'Can I sell a coupon?', 'Check my earnings', 'Contact support'],
  },
  WEBSITE_NAVIGATION: {
    text: "Here's where things live on SaveHatke:\n\n• **Marketplace** — browse and buy available coupons\n• **Sell** — submit a coupon for review (invite-only for now)\n• **Dashboard** — your submissions, purchases, earnings and payouts\n• **Price Tracker** — watch a product price and get alerts\n• **Support** — raise and track a ticket\n\nTell me what you're trying to do and I'll point you at the right page.",
    chips: ['Open the marketplace', 'Check my earnings', 'How does the tracker work?', 'Contact support'],
  },
  TWO_FACTOR_AUTH: {
    text: "SaveHatke accounts are passwordless — you sign in with a one-time code sent to your email, or with Google. Two-factor authentication adds a second step on top of that, using an authenticator app, and you get backup codes for when you can't use the app.\n\nYou set all of this up yourself from Security in your account settings. I can explain how it works, but I can never view, generate or accept a code — never share an OTP, 2FA code or backup code with anyone, including me.",
    chips: ['Where are my security settings?', 'Is SaveHatke safe?', 'Contact support'],
  },
  SECURITY: {
    text: "A quick summary of how SaveHatke protects you:\n\n• Sign-in uses a one-time email code or Google — there's no password to leak\n• Sessions expire automatically (48 hours for users, 2 hours for admins)\n• Payments run through the payment provider's own secure flow\n• Payouts require a verified destination on your account\n• Coupon codes are released only after a completed purchase\n\nAnd to be clear about what I can do: I can explain and guide, but I can't access credentials, change account settings, or approve anything. If you're ever asked for an OTP or a code by someone claiming to be support, that's not us — report it.",
    chips: ['How do I report fraud?', 'Where are my security settings?', 'Contact support'],
  },
  REFUND: {
    text: "Here's how refunds work: if a coupon turns out to be invalid, the purchase is reviewed and, when it's confirmed, the amount is returned to you. Refunds are handled by the support team through a proper review — I can't issue or approve one myself.\n\nIf you think you're owed a refund, raise a ticket with the coupon details and our team will take it from there.",
    chips: ['Contact support', 'Where are my purchases?', 'How does buying work?'],
  },
};

// A navigation hint per intent, used to give a reply a concrete next step.
const NEXT_STEP_HINT = {
  SEARCH_COUPON: 'Browse the marketplace for live listings.',
  BUY_COUPON: 'Checkout is on the coupon page in the marketplace.',
  SELL_COUPON: 'Submission is on the Sell page once you have access.',
  EARNINGS: 'Your full breakdown is on your dashboard.',
  PAYOUT_STATUS: 'Payout details and requests are in your dashboard.',
  PURCHASE_HISTORY: 'Your purchased coupons are in your dashboard.',
  SUPPORT_TICKETS: 'Cases are on the Support page.',
  PRICE_TRACKER: 'The Price Tracker is in your dashboard.',
  ACCOUNT: 'Account settings are in your profile.',
  PROFILE: 'Profile and payout details are in your account settings.',
  SUBMISSION_STATUS: 'Your submission statuses are on your dashboard.',
};

// Which tool a given intent maps to when the user is signed in.
const INTENT_TOOL = {
  SEARCH_COUPON: 'search_coupons',
  COUPON_DETAILS: 'search_coupons',
  BUY_COUPON: 'search_coupons',
  SELL_COUPON: 'check_sell_eligibility',
  SELL_ELIGIBILITY: 'check_sell_eligibility',
  SUBMISSION_STATUS: 'check_submissions',
  EARNINGS: 'check_earnings',
  PAYOUT_STATUS: 'check_payout_status',
  PAYOUT_LADDER: 'check_payout_ladder',
  PURCHASE_HISTORY: 'check_purchases',
  SUPPORT_TICKETS: 'check_support_tickets',
  PRICE_TRACKER: 'get_price_tracker',
  ACCOUNT: 'get_user_profile',
  PROFILE: 'get_user_profile',
  MAINTENANCE: 'get_maintenance_status',
};

// Intents that genuinely need a signed-in user. Kept explicit rather than
// derived, so the login prompt is never shown for a question we can answer.
const REQUIRES_LOGIN = new Set([
  'EARNINGS', 'PAYOUT_STATUS', 'PURCHASE_HISTORY', 'SUBMISSION_STATUS',
  'SELL_ELIGIBILITY', 'SELL_COUPON', 'PRICE_TRACKER', 'PROFILE',
]);

// Intents where a signed-out user still gets a useful answer, with a note.
const GUEST_FRIENDLY = new Set(['SUPPORT_TICKETS', 'ACCOUNT']);

const LOGIN_PROMPTS = {
  EARNINGS: "I can show you exactly what you've earned, but I need to know who you are first. Please sign in and ask me again — your earnings are tied to your account, so I won't guess at them.",
  PAYOUT_STATUS: "Your payout information is tied to your account, so you'll need to sign in for me to check it. Once you're in, ask me again and I'll pull up the exact status.",
  PURCHASE_HISTORY: "I can only show purchases to the account that made them. Sign in and ask me again — then I'll list them for you.",
  SUBMISSION_STATUS: "Your submissions are private to your account. Sign in and ask me again and I'll show you where each one stands.",
  SELL_ELIGIBILITY: "I can check that for you once you're signed in — eligibility is tied to your account email. Sign in and ask me again.",
  SELL_COUPON: "Selling is invite-only at the moment, and eligibility is checked against your account. Sign in and ask me again and I'll tell you where you stand.",
  PRICE_TRACKER: "Your tracked products are saved to your account. Sign in and ask me again and I'll list them.",
  PROFILE: "Profile details are private to your account. Sign in and ask me again and I'll show you your summary.",
  DEFAULT: "I need you to be signed in for that one — it's account-specific information. Sign in and ask me again.",
};

/**
 * Build a plan for a classified message.
 *
 * @param {object} input
 * @param {{intent:string, confidence:number, entities:object, band:string, alternatives:Array}} input.classification
 * @param {object|null} input.user — verified session identity
 * @param {object} input.context — contextManager entry
 * @param {{isFollowUp:boolean, referent:object|null}} input.reference
 * @returns {{action:string, tools:Array, args:object, directAnswer:object|null, reply:string|null, chips:Array, reason:string}}
 */
function plan({ classification, user, context, reference }) {
  const intent = classification.intent;
  const confidence = classification.confidence;
  const isAuthenticated = Boolean(user && user.email);

  // ─ 1. Low confidence or unknown → clarify, never guess ──
  if (intent === 'UNKNOWN' || confidence < config.confidenceThreshold) {
    // A referential follow-up with a known referent is not really unknown: the
    // previous turn told us what "which one" means.
    if (reference && reference.isFollowUp && reference.referent && reference.referent.tool) {
      const tool = reference.referent.tool.name;
      if (tool === 'search_coupons') {
        return {
          action: 'tool',
          tools: [{ name: 'search_coupons', args: contextArgs(classification.entities, reference) }],
          args: contextArgs(classification.entities, reference),
          directAnswer: null,
          reply: null,
          chips: [],
          reason: 'followup_reuses_search',
        };
      }
    }
    return {
      action: 'clarify',
      tools: [],
      args: {},
      directAnswer: null,
      reply: null,
      chips: [],
      reason: intent === 'UNKNOWN' ? 'no_confident_intent' : 'low_confidence',
    };
  }

  // ─ 2. Fixed product knowledge ──
  const direct = DIRECT_ANSWERS[intent];
  if (direct) {
    return {
      action: 'answer',
      tools: [],
      args: {},
      directAnswer: direct,
      reply: null,
      chips: direct.chips || [],
      reason: 'direct_answer',
    };
  }

  // ── 3. Login gate for account-scoped intents ──
  if (!isAuthenticated && REQUIRES_LOGIN.has(intent)) {
    return {
      action: 'login_required',
      tools: [],
      args: {},
      directAnswer: null,
      reply: LOGIN_PROMPTS[intent] || LOGIN_PROMPTS.DEFAULT,
      chips: ['How do I sign in?', 'How does SaveHatke work?', 'Show me coupons'],
      reason: 'auth_required',
    };
  }

  // ── 4. Tool-backed intents ──
  const toolName = INTENT_TOOL[intent];
  if (toolName) {
    // A guest asking about support tickets gets the process, not the (empty)
    // list — there is nothing to list without an account.
    if (!isAuthenticated && GUEST_FRIENDLY.has(intent)) {
      return {
        action: 'answer',
        tools: [],
        args: {},
        directAnswer: {
          text: "I can help with that. Support cases are raised and tracked on the Support page — you pick a category, describe the issue, and optionally attach a screenshot. You'll get replies in the case thread.\n\nIf you sign in and ask me again, I can check the status of your own tickets.",
          chips: ['Contact support', 'How does SaveHatke work?', 'Where are my purchases?'],
        },
        reply: null,
        chips: [],
        reason: 'guest_support_process',
      };
    }

    const args = toolName === 'search_coupons'
      ? contextArgs(classification.entities, reference)
      : {};

    return {
      action: 'tool',
      tools: [{ name: toolName, args }],
      args,
      directAnswer: null,
      reply: null,
      chips: [],
      reason: 'intent_tool',
      hint: NEXT_STEP_HINT[intent] || null,
      // Carried so the response engine can tell a "how does this work" question
      // apart from an "am I allowed" question when they share one tool.
      intent,
    };
  }

  // ─ 5. Knowledge-driven intents (HOW_IT_WORKS, FAQ, and anything else) ──
  return {
    action: 'knowledge',
    tools: [{ name: 'search_knowledge', args: { query: classification.entities.searchQuery || '' } }],
    args: {},
    directAnswer: null,
    reply: null,
    chips: [],
    reason: 'knowledge_lookup',
  };
}

/**
 * Merge follow-up entities with the referent turn's so "show me those under
 * ₹200" keeps the brand the user named two turns ago.
 */
function contextArgs(entities, reference) {
  const merged = { ...(entities || {}) };
  if (reference && reference.isFollowUp && reference.referent && reference.referent.entities) {
    const prev = reference.referent.entities;
    if (!merged.brand && prev.brand) merged.brand = prev.brand;
    if (!merged.category && prev.category) merged.category = prev.category;
  }
  // search_coupons accepts a single query string; derive one from the entities
  // when no explicit free-text query survived extraction.
  if (!merged.query) {
    const bits = [merged.brand, merged.category].filter(Boolean);
    if (!bits.length && merged.searchQuery) bits.push(merged.searchQuery);
    if (bits.length) merged.query = bits.join(' ');
  }
  return merged;
}

/**
 * Decide whether a reply asserts anything the backend did not confirm.
 * Called by the orchestrator after composition; kept here because it encodes
 * the same authority rule the planner does.
 */
function assertGroundedness(replyText, toolResults) {
  const security = require('./securityEngine');
  const combined = (toolResults || []).map((t) => t.result).filter(Boolean);
  return security.verifyGrounded(replyText, combined);
}

/** Exposed for tests and for the admin-facing intent map. */
function intentMap() {
  return Object.entries(INTENT_TOOL).map(([intent, tool]) => ({
    intent,
    tool,
    requiresAuth: REQUIRES_LOGIN.has(intent),
    direct: Boolean(DIRECT_ANSWERS[intent]),
  }));
}

module.exports = {
  plan,
  intentMap,
  assertGroundedness,
  DIRECT_ANSWERS,
  INTENT_TOOL,
  REQUIRES_LOGIN,
  contextArgs,
};
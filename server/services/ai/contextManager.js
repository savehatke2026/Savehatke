// ============================================
// SaveHatke AI — Context Manager (Server-Only)
// ============================================
// Lightweight, bounded conversation memory so follow-ups resolve.
//
//   User: "Show me Nike coupons."
//   AI:   "...here are the Nike coupons..."
//   User: "Which one expires first?"
//
// The Google Sheets transcript remains the durable, admin-visible record. This
// store exists only to hand the response engine the few recent turns plus the
// last tool result, so "which one" has a referent.
//
// SECURITY (mirrors the baseline's memory-control rules):
//   - Memory is keyed by conversation id AND the authenticated user id, so one
//     user's context can never surface in another's session.
//   - Nothing secret is ever written: no coupon codes, no tokens, no OTPs,
//     no unmasked payout destinations. Coupon codes are stripped before a tool
//     result is recorded (see stripSensitive), so a code cannot be replayed
//     back to a user who has not purchased.
//   - Entries expire (AI_MEMORY_TTL_MS) and the store is size-capped, which
//     keeps a serverless instance's memory flat.
//   - Stored content is treated as data on read. It can inform phrasing; it can
//     never grant permission, because authorization is re-derived per message
//     from the live session and re-checked by the tool router.

const config = require('./config');

const store = new Map();

// Fields that must never enter memory. Coupon codes are the important one: the
// whole purchase-gated disclosure model depends on a code not leaking back out
// of a conversation.
const SENSITIVE_KEYS = new Set([
  'code', 'couponcode', 'coupon_code', 'otp', 'token', 'password',
  'secret', 'apikey', 'api_key', 'sessiontoken', 'session_token',
  'backupcode', 'backup_code', 'recoverycode', 'recovery_code',
  'upifull', 'accountnumber', 'account_number', 'qrfileid',
]);

function keyFor(conversationId, user) {
  const uid = user && user.id ? String(user.id) : 'guest';
  const cid = String(conversationId || 'unknown');
  return `${cid}::${uid}`;
}

/**
 * Remove sensitive fields from a value before it is remembered.
 * Also scrubs anything that looks like a coupon code or a token.
 */
function stripSensitive(value, depth = 0) {
  if (depth > 6) return undefined;
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => stripSensitive(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((k) => {
      const lower = String(k).toLowerCase().replace(/[^a-z_]/g, '');
      if (SENSITIVE_KEYS.has(lower)) return; // dropped entirely
      out[k] = stripSensitive(value[k], depth + 1);
    });
    return out;
  }
  if (typeof value === 'string') {
    let s = value;
    // Token / key shapes.
    s = s.replace(/(sk-[a-zA-Z0-9]{10,}|Bearer\s+[A-Za-z0-9._-]{15,})/gi, '[redacted]');
    // A long uppercase alphanumeric run is almost certainly a coupon code.
    s = s.replace(/\b[A-Z0-9]{8,16}\b/g, '[redacted]');
    return s.slice(0, 2000);
  }
  return value;
}

function prune() {
  const now = Date.now();
  const ttl = config.memoryTtlMs;
  for (const [k, v] of store) {
    if (now - v.touchedAt > ttl) store.delete(k);
  }
  // Hard cap: drop oldest first so a warm instance cannot grow without bound.
  const max = config.memoryMaxEntries;
  if (store.size > max) {
    const entries = [...store].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    const excess = store.size - max;
    for (let i = 0; i < excess; i += 1) store.delete(entries[i][0]);
  }
}

function get(conversationId, user) {
  const key = keyFor(conversationId, user);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.touchedAt > config.memoryTtlMs) {
    store.delete(key);
    return null;
  }
  entry.touchedAt = Date.now();
  return entry;
}

/**
 * Begin (or refresh) a conversation context.
 * @returns {object} the context record
 */
function begin(conversationId, user) {
  prune();
  const key = keyFor(conversationId, user);
  let entry = store.get(key);
  if (!entry) {
    entry = {
      conversationId: String(conversationId || 'unknown'),
      userId: user && user.id ? String(user.id) : 'guest',
      turns: [],
      lastTool: null,
      lastIntent: null,
      lastEntities: {},
      createdAt: Date.now(),
      touchedAt: Date.now(),
    };
    store.set(key, entry);
  }
  entry.touchedAt = Date.now();
  return entry;
}

/**
 * Record one exchange. Only the minimum needed for continuity is kept: a short
 * user line, a short assistant line, the intent, and the tools that ran.
 */
function record(conversationId, user, { userText, assistantText, intent, entities, tool }) {
  const entry = begin(conversationId, user);
  entry.turns.push({
    at: Date.now(),
    user: stripSensitive(String(userText || '').slice(0, 500)),
    assistant: stripSensitive(String(assistantText || '').slice(0, 800)),
    intent: intent || null,
  });
  const maxTurns = config.memoryMaxTurns;
  if (entry.turns.length > maxTurns) entry.turns = entry.turns.slice(-maxTurns);
  if (intent) entry.lastIntent = intent;
  if (entities && Object.keys(entities).length) entry.lastEntities = stripSensitive(entities);
  if (tool) {
    entry.lastTool = {
      name: tool.name,
      // A slim projection only — never the whole tool payload, and never a code.
      summary: stripSensitive(tool.summary || null),
      at: Date.now(),
    };
  }
  entry.touchedAt = Date.now();
  return entry;
}

/**
 * Resolve a referential follow-up ("which one", "the first one", "that brand")
 * against the previous tool result and entities.
 * @returns {{isFollowUp:boolean, referent:object|null, hint:string|null}}
 */
function resolveReference(text, conversationId, user) {
  const lower = String(text || '').toLowerCase();
  const entry = get(conversationId, user);
  if (!entry) return { isFollowUp: false, referent: null, hint: null };

  const referential = /\b(which one|which ones|the first|the second|the last|that one|this one|those|these|it|them|its|that brand|same brand|same category|one of them|expires first|cheapest|costliest|first one|second one)\b/.test(lower);
  if (!referential) return { isFollowUp: false, referent: null, hint: null };

  return {
    isFollowUp: true,
    referent: {
      intent: entry.lastIntent,
      entities: entry.lastEntities,
      tool: entry.lastTool,
      // The most recent assistant turn is the literal referent for "that one".
      previousReply: entry.turns.length ? entry.turns[entry.turns.length - 1].assistant : null,
    },
    hint: entry.lastTool ? entry.lastTool.name : entry.lastIntent,
  };
}

/**
 * A bounded, ordered turn list for knowledge/response grounding.
 * Assistant turns are included so the answer can stay consistent with what was
 * already said, and they are marked untrusted data by the caller.
 */
function recentTurns(conversationId, user, limit) {
  const entry = get(conversationId, user);
  if (!entry) return [];
  const n = Math.min(limit || 6, config.memoryMaxTurns);
  return entry.turns.slice(-n).map((t) => ({ user: t.user, assistant: t.assistant, intent: t.intent }));
}

/** Merge follow-up entities with the ones the referent turn established. */
function mergeEntities(conversationId, user, entities) {
  const entry = get(conversationId, user);
  const base = (entry && entry.lastEntities) || {};
  const merged = { ...base, ...(entities || {}) };
  // A follow-up naming a new brand must not inherit the old one's other slots.
  if (entities && entities.brand && base.brand && entities.brand !== base.brand) {
    if (!entities.category) delete merged.category;
  }
  return merged;
}

function clear(conversationId, user) {
  store.delete(keyFor(conversationId, user));
}

function stats() {
  prune();
  return { entries: store.size, ttlMs: config.memoryTtlMs, maxTurns: config.memoryMaxTurns };
}

module.exports = {
  begin,
  record,
  get,
  clear,
  stats,
  resolveReference,
  recentTurns,
  mergeEntities,
  stripSensitive,
  keyFor,
};
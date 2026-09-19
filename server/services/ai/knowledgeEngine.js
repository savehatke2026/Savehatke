// ============================================
// SaveHatke AI — Knowledge Engine (Server-Only)
// ============================================
// Lightweight retrieval over two knowledge sources:
//   1. data/ai/knowledge.json — the shipped SaveHatke knowledge base.
//   2. The admin-managed ChatbotKnowledge Google Sheet, which the existing
//      admin UI already edits. It stays authoritative: an admin's entry can
//      override a shipped answer, and a disabled entry is never used.
//
// Deliberately NOT an embedding service. Retrieval is keyword + normalised
// token + intent + category matching with weighted relevance scoring, which is
// fast on CPU, has no external dependency, and cannot leak data to a third
// party. The interface (retrieve → ranked hits) is what the response engine
// consumes, so a local embedding model can be dropped in later without touching
// callers.
//
// SECURITY: an admin's knowledge entry is DATA. It informs an answer; it can
// never grant a permission, unlock a tool or override the security engine.

const config = require('./config');
const tokenizer = require('./tokenizer');

// Statically required so the bundler traces it into the serverless function.
const SHIPPED = require('../../../data/ai/knowledge.json');

const ENTRIES = Array.isArray(SHIPPED) ? SHIPPED : (SHIPPED.entries || []);

// Build a searchable index once per warm instance.
let index = null;

function buildIndex() {
  return ENTRIES.map((e) => {
    const question = String(e.question || '');
    const answer = String(e.answer || '');
    const keywords = Array.isArray(e.keywords) ? e.keywords.join(' ') : String(e.keywords || '');
    const questionTokens = new Set(tokenizer.tokenize(question));
    const keywordTokens = new Set(tokenizer.tokenize(keywords));
    return {
      id: e.id,
      category: e.category || 'Other',
      question,
      answer,
      keywords,
      enabled: e.enabled !== false,
      intent: e.intent || null,
      source: 'builtin',
      questionTokens,
      keywordTokens,
      answerLower: answer.toLowerCase(),
      questionLower: question.toLowerCase(),
    };
  });
}

function getIndex() {
  if (!index) index = buildIndex();
  return index;
}

/** Convert an admin knowledge row into the same indexed shape. */
function normaliseAdminEntry(row) {
  const question = String(row.question || '');
  const answer = String(row.answer || '');
  const keywords = String(row.keywords || '');
  return {
    id: row.id,
    category: row.category || 'Other',
    question,
    answer,
    keywords,
    enabled: row.enabled === true || row.enabled === 'true' || row.enabled === '1',
    intent: null,
    source: 'admin',
    questionTokens: new Set(tokenizer.tokenize(question)),
    keywordTokens: new Set(tokenizer.tokenize(keywords)),
    answerLower: answer.toLowerCase(),
    questionLower: question.toLowerCase(),
  };
}

/**
 * Score one entry against a query.
 * Weighting reflects what actually predicts a good answer:
 *   - an exact keyword-token overlap is strong
 *   - overlap with the question text is stronger
 *   - a near-exact question match is decisive
 *   - phrase containment in the answer is weakest (it often matches fluff)
 */
function scoreEntry(entry, queryTokens, rawQuery) {
  const qLower = String(rawQuery || '').toLowerCase();
  const terms = [...new Set(queryTokens)].filter((t) => t.length > 2 || t.includes('\u0001E'));
  if (!terms.length) return 0;

  let score = 0;
  let hits = 0;

  terms.forEach((t) => {
    if (entry.keywordTokens.has(t)) { score += 3; hits += 1; return; }
    if (entry.questionTokens.has(t)) { score += 2.5; hits += 1; return; }
    // Partial prefix match covers plural/stem variants without a stemmer.
    const prefixHit = [...entry.keywordTokens].some((k) => k.startsWith(t) || t.startsWith(k));
    if (prefixHit) { score += 1.2; hits += 1; return; }
    if (entry.answerLower.includes(t)) { score += 0.8; hits += 1; }
  });

  // A query that covers little of the entry is probably a different topic.
  if (hits === 0) return 0;
  score += (hits / terms.length) * 2;

  // A near-exact question match wins outright.
  if (qLower.length > 6) {
    if (entry.questionLower === qLower) score += 6;
    else if (entry.questionLower.includes(qLower)) score += 3;
    else if (qLower.includes(entry.questionLower) && entry.questionLower.length > 10) score += 2;
  }

  return score;
}

/**
 * Retrieve ranked knowledge hits.
 *
 * @param {string} query — the user's message
 * @param {object} [opts]
 * @param {string} [opts.intent] — the classified intent, used as a boost
 * @param {object} [opts.entities]
 * @param {Array}  [opts.adminEntries] — rows from the admin knowledge sheet
 * @param {number} [opts.limit]
 * @returns {Array<{id,category,question,answer,score,source}>}
 */
function retrieve(query, opts = {}) {
  const queryTokens = tokenizer.tokenize(query);
  if (!queryTokens.length) return [];

  // Admin entries take precedence over a shipped entry with the same question,
  // so an admin edit always wins.
  const admin = (opts.adminEntries || []).map(normaliseAdminEntry).filter((e) => e.enabled);
  const adminQuestions = new Set(admin.map((e) => e.questionLower));

  const candidates = [
    ...admin,
    ...getIndex().filter((e) => e.enabled && !adminQuestions.has(e.questionLower)),
  ];

  const scored = [];
  candidates.forEach((entry) => {
    let score = scoreEntry(entry, queryTokens, query);
    if (score <= 0) return;

    // Intent alignment is a meaningful signal: a SELL_ELIGIBILITY question is
    // far more likely to be answered by a Coupon Selling entry.
    if (opts.intent && entry.intent && entry.intent === opts.intent) score += 2.5;
    if (opts.intent && !entry.intent) {
      const intentCategoryMap = {
        SELL_ELIGIBILITY: 'Coupon Selling',
        SELL_COUPON: 'Coupon Selling',
        SUBMISSION_STATUS: 'Coupon Submission',
        EARNINGS: 'Earnings',
        PAYOUT_STATUS: 'Earnings',
        PAYOUT_LADDER: 'Earnings',
        BUY_COUPON: 'Coupon Buying',
        PURCHASE_HISTORY: 'Coupon Buying',
        SEARCH_COUPON: 'Coupon Rules',
        SECURITY: 'Security',
        TWO_FACTOR_AUTH: 'Security',
        ACCOUNT: 'Account',
        PROFILE: 'Account',
        SUPPORT_TICKETS: 'Support',
        HOW_IT_WORKS: 'How SaveHatke Works',
        FAQ: 'How SaveHatke Works',
        REFUND: 'Coupon Rules',
      };
      if (intentCategoryMap[opts.intent] === entry.category) score += 2;
    }

    // A brand or category in the entities nudges a matching entry up.
    if (opts.entities) {
      if (opts.entities.brand && entry.answerLower.includes(String(opts.entities.brand).toLowerCase())) score += 1;
      if (opts.entities.category && entry.answerLower.includes(String(opts.entities.category).toLowerCase())) score += 1;
    }

    scored.push({
      id: entry.id,
      category: entry.category,
      question: entry.question,
      answer: entry.answer,
      keywords: entry.keywords,
      source: entry.source,
      score: Number(score.toFixed(3)),
    });
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit || config.maxKnowledgeHits);
}

/**
 * Confidence that the top hit actually answers the question, in 0..1.
 * Used by the engine to decide between answering and asking for detail — a
 * weak retrieval must not be presented as an authoritative answer.
 */
function hitConfidence(hits) {
  if (!hits || !hits.length) return 0;
  const top = hits[0].score;
  const second = hits.length > 1 ? hits[1].score : 0;
  // Absolute strength, tempered by how clearly the best hit leads.
  const absolute = Math.min(top / 12, 1);
  const dominance = top > 0 ? Math.min((top - second) / top + 0.4, 1) : 0;
  return Number(Math.min(0.97, absolute * 0.65 + dominance * 0.35).toFixed(2));
}

function listCategories() {
  const cats = new Set();
  getIndex().forEach((e) => cats.add(e.category));
  return [...cats].sort();
}

function count() {
  return getIndex().length;
}

module.exports = {
  retrieve,
  hitConfidence,
  listCategories,
  count,
  // exposed so tests can assert the shipped base is intact
  ENTRIES,
};
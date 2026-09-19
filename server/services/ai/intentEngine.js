// ============================================
// SaveHatke AI — Intent Engine (Server-Only)
// ============================================
// Classifies a message into one of the SaveHatke intents and extracts the
// entities the tool layer needs.
//
// Two classifiers run and vote:
//   1. A deterministic rule scorer over the taxonomy in models/ai/intents.json
//      (keywords, strong phrases, regexes, entity boosts).
//   2. A learned multinomial Naive Bayes model compiled by scripts/ai/train.js,
//      loaded only if present.
// The rule scorer is the floor: it is statically required, so the engine
// classifies correctly on a cold start before any model exists. The learned
// model adds weight once trained but can never lower a high-confidence rule
// match — a security-relevant property, because intents like SELL_ELIGIBILITY
// and PAYOUT_STATUS drive tool selection.
//
// Returns { intent, confidence, entities, alternatives, source }.

const config = require('./config');
const tokenizer = require('./tokenizer');

// Statically required so the Vercel bundler traces it into the function.
const TAXONOMY = require('../../models/ai/intents.json');

// The learned model is optional. It is loaded lazily and cached for the life of
// the warm instance. A missing or malformed file is not an error — the rule
// scorer answers on its own.
let learnedModel = null;
let learnedLoadAttempted = false;

function loadLearnedModel() {
  if (learnedLoadAttempted) return learnedModel;
  learnedLoadAttempted = true;
  try {
    // eslint-disable-next-line global-require
    learnedModel = require('../../models/ai/weights/classifier.json');
    if (!learnedModel || !learnedModel.labels || !learnedModel.logProb) {
      learnedModel = null;
    }
  } catch (e) {
    learnedModel = null;
  }
  return learnedModel;
}

// ─ Entity extraction ─────────────────────────────────────────────────────
// Brands seen in the SaveHatke catalogue. Kept as data (not code) so the list
// can grow without touching the engine. Matching is on normalised tokens.
const BRAND_ALIASES = {
  nykaa: 'Nykaa', nyka: 'Nykaa',
  amazon: 'Amazon', amzn: 'Amazon',
  flipkart: 'Flipkart', fk: 'Flipkart',
  myntra: 'Myntra',
  ajio: 'AJIO',
  swiggy: 'Swiggy', zomato: 'Zomato',
  paytm: 'Paytm', phonepe: 'PhonePe', gpay: 'Google Pay',
  meesho: 'Meesho', snapdeal: 'Snapdeal',
  tatacliq: 'Tata CLiQ', titan: 'Titan', westside: 'Westside',
  croma: 'Croma', bigbasket: 'BigBasket', blinkit: 'Blinkit',
  zepto: 'Zepto', dunzo: 'Dunzo', uber: 'Uber', ola: 'Ola',
  makemytrip: 'MakeMyTrip', mmt: 'MakeMyTrip', goibibo: 'Goibibo',
  bookmyshow: 'BookMyShow', bms: 'BookMyShow',
  dominos: 'Domino\'s', kfc: 'KFC', mcdonalds: 'McDonald\'s', starbucks: 'Starbucks',
  lenskart: 'Lenskart', decathlon: 'Decathlon', nike: 'Nike', adidas: 'Adidas',
  puma: 'Puma', levis: 'Levi\'s', zara: 'Zara', hm: 'H&M',
  nykaafashion: 'Nykaa Fashion', boat: 'boAt', oneplus: 'OnePlus',
  samsung: 'Samsung', apple: 'Apple', xiaomi: 'Xiaomi', realme: 'realme',
  jiomart: 'JioMart', reliance: 'Reliance', dmart: 'DMart',
  firstcry: 'FirstCry', mamaearth: 'Mamaearth', purplle: 'Purplle',
  apollo: 'Apollo', netmeds: 'Netmeds', pharmeasy: 'PharmEasy',
  iced: 'ICICI', hdfc: 'HDFC', axis: 'Axis', sbi: 'SBI',
  redbus: 'redBus', irctc: 'IRCTC', indigo: 'IndiGo',
  airtel: 'Airtel', jio: 'Jio', vi: 'Vi',
};

// Category vocabulary → canonical category label.
const CATEGORY_ALIASES = {
  food: 'Food', restaurant: 'Food', dining: 'Food', food_delivery: 'Food',
  fashion: 'Fashion', clothing: 'Fashion', apparel: 'Fashion', clothes: 'Fashion',
  beauty: 'Beauty', cosmetics: 'Beauty', makeup: 'Beauty', skincare: 'Beauty',
  electronics: 'Electronics', gadget: 'Electronics', gadgets: 'Electronics', mobile: 'Electronics',
  travel: 'Travel', flight: 'Travel', hotel: 'Travel', train: 'Travel', bus: 'Travel',
  grocery: 'Grocery', groceries: 'Grocery', supermarket: 'Grocery',
  entertainment: 'Entertainment', movie: 'Entertainment', movies: 'Entertainment',
  health: 'Health', pharmacy: 'Health', medicine: 'Health', fitness: 'Health',
  recharge: 'Recharge', bill: 'Recharge', bills: 'Recharge',
  home: 'Home', furniture: 'Home', decor: 'Home',
  education: 'Education', course: 'Education', learning: 'Education',
  gaming: 'Gaming', game: 'Gaming',
  subscription: 'Subscription', ott: 'Subscription', streaming: 'Subscription',
};

function titleCase(s) {
  return String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function parseAmount(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^\d.]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract entities from a message.
 * Literal shapes (price, email, url, ids) come from the tokenizer's masking so
 * their exact form survives normalisation; brands and categories are matched on
 * normalised tokens.
 * @param {string} text
 * @param {string[]} [tokens] — pre-tokenised, to avoid redoing the work
 * @returns {object} entities
 */
function extractEntities(text, tokens) {
  const raw = String(text || '');
  const toks = tokens || tokenizer.tokenize(raw);
  const lower = raw.toLowerCase();
  const entities = {};

  // ── Literal shapes ──
  const literals = tokenizer.extractLiterals(raw);
  if (literals.email && literals.email.length) entities.email = literals.email[0];
  if (literals.url && literals.url.length) entities.url = literals.url[0];

  // Price extraction. Two shapes matter and they must both work:
  //   1. A currency-marked amount — "₹200", "Rs 200", "200 rupees"
  //   2. A bare number bound by a comparator — "under 200", "above 300"
  // The second is extremely common ("show coupons under 100") and carries no
  // currency symbol at all, so the comparator is what identifies the number.
  const underRe = /\b(under|below|less\s+than|upto|up\s+to|max|maximum|within|cheaper\s+than)\s*(?:₹|rs\.?|inr)?\s*([\d][\d,]*)/i;
  const overRe = /\b(above|over|more\s+than|at\s+least|min|minimum|starting\s+from|greater\s+than)\s*(?:₹|rs\.?|inr)?\s*([\d][\d,]*)/i;
  const underMatch = lower.match(underRe);
  const overMatch = lower.match(overRe);
  if (underMatch) entities.maxPrice = parseAmount(underMatch[2]);
  if (overMatch) entities.minPrice = parseAmount(overMatch[2]);

  if (!entities.maxPrice && !entities.minPrice) {
    const priceMatches = (literals.price || []).map(parseAmount).filter((n) => n != null);
    if (priceMatches.length) entities.price = priceMatches[0];
  } else {
    entities.price = entities.maxPrice != null ? entities.maxPrice : entities.minPrice;
  }

  // Basket brands that appear as `something` within the message: "Nike ke coupons"
  const brands = [];
  toks.forEach((t) => {
    const alias = BRAND_ALIASES[t];
    if (alias && !brands.includes(alias)) brands.push(alias);
  });
  if (brands.length) entities.brand = brands[0];
  if (brands.length > 1) entities.brands = brands;

  const categories = [];
  toks.forEach((t) => {
    const cat = CATEGORY_ALIASES[t];
    if (cat && !categories.includes(cat)) categories.push(cat);
  });
  if (categories.length) entities.category = categories[0];

  // ── Identifiers ──
  const idLike = literals.identifier || [];
  const hashtags = literals.hashtagId || [];
  const allIds = idLike.concat(hashtags);
  if (allIds.length) {
    const ticket = allIds.find((v) => /^(t|ticket)/i.test(v.replace(/^#/, '')));
    if (ticket) entities.ticketId = ticket.replace(/^#/, '');
    else entities.couponId = allIds[0].replace(/^#/, '');
  }

  // ── Dates / relative time ──
  const dateRe = /\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2}|today|tomorrow|yesterday|this\s+week|next\s+week|this\s+month|next\s+month|aaj|kal)\b/i;
  const dateMatch = lower.match(dateRe);
  if (dateMatch) entities.date = dateMatch[1];

  // ── Status words that steer an answer ──
  const statusWords = ['pending', 'approved', 'rejected', 'sold', 'active', 'paid', 'processing', 'failed', 'resolved', 'closed', 'open'];
  const found = statusWords.filter((w) => new RegExp(`\\b${w}\\b`).test(lower));
  if (found.length) entities.status = found[0];

  // ── Free-text search query for coupon search ──
  // Strips the interrogative scaffolding so the tool gets a usable keyword.
  const stripped = lower
    .replace(/\b(show|me|find|search|get|any|the|a|an|please|plz|pls|do|you|have|i|want|need|looking|for|coupons?|deals?|offers?|discounts?|dikhao|batao|chahiye|ke|ka|ki|hai|kar)\b/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped && !brands.length && !categories.length) entities.searchQuery = stripped;

  return entities;
}

// ── Rule scorer ───────────────────────────────────────────────────────────
function countOccurrences(haystack, needle) {
  if (!needle || !haystack) return 0;
  const re = new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'g');
  const m = haystack.match(re);
  return m ? m.length : 0;
}

/**
 * Score every intent against the message.
 * @returns {Array<{intent:string, score:number, rules:number}>} sorted desc
 */
function scoreByRules(text, tokens, entities) {
  const lower = String(text || '').toLowerCase();
  const tokenSet = new Set(tokens);
  // Phrases are matched against BOTH the raw lowercase text and a normalised
  // token string. The normalised form is what makes a Hinglish message match an
  // English phrase: "mere purchases dikhao" normalises to "my purchases show",
  // which contains the strong phrase "my purchases".
  const normalised = tokens.join(' ');
  const results = [];

  const hasPhrase = (phrase) => {
    const p = String(phrase).toLowerCase();
    return lower.includes(p) || normalised.includes(p);
  };

  Object.entries(TAXONOMY.intents).forEach(([intent, def]) => {
    if (intent === 'UNKNOWN') return;
    let score = 0;
    let ruleHits = 0;

    // Keyword hits: weight 1 each, but only count distinct vocabulary.
    (def.keywords || []).forEach((kw) => {
      const key = kw.includes(' ') ? null : kw;
      if (key && tokenSet.has(key)) { score += 1; ruleHits += 1; }
      else if (kw.includes(' ') && hasPhrase(kw)) { score += 1; ruleHits += 1; }
    });

    // Strong phrases: weight 2.5 each — these are the deliberate markers.
    (def.strong || []).forEach((phrase) => {
      if (hasPhrase(phrase)) { score += 2.5; ruleHits += 1; }
    });

    // Patterns: weight 3 each.
    (def.patterns || []).forEach((pattern) => {
      try {
        if (new RegExp(pattern, 'i').test(lower)) { score += 3; ruleHits += 1; }
      } catch (e) { /* a malformed pattern must not break classification */ }
    });

    if (score > 0) results.push({ intent, score, rules: ruleHits });
  });

  // Entity-driven boosts. A brand or category mention strongly implies a
  // coupon search when no other intent claimed the message.
  const hasBrandOrCategory = Boolean(entities.brand || entities.category);
  if (hasBrandOrCategory) {
    const boost = (name, amount) => {
      const hit = results.find((r) => r.intent === name);
      if (hit) hit.score += amount;
      else results.push({ intent: name, score: amount, rules: 1 });
    };
    boost('SEARCH_COUPON', 2.5);
    if (entities.price != null) boost('SEARCH_COUPON', 1);
  }
  // A stated price with no other context is a coupon search.
  if (entities.price != null && results.length === 0) {
    results.push({ intent: 'SEARCH_COUPON', score: 2, rules: 1 });
  }
  // An explicit status word plus submission vocabulary is a submission question.
  if (entities.status && /submission|submitted|review/.test(lower)) {
    const hit = results.find((r) => r.intent === 'SUBMISSION_STATUS');
    if (hit) hit.score += 1.5;
  }

  // ── "list coupons" is browsing; "list my coupon" is selling ──
  // The verb "list" is genuinely ambiguous. A possessive or a submit cue makes
  // it a selling question; a bare plural object makes it browsing.
  if (/\b(list|show|see|view)\b/.test(lower) && /\bcoupons?\b/.test(lower)) {
    const sell = results.find((r) => r.intent === 'SELL_COUPON');
    const search = results.find((r) => r.intent === 'SEARCH_COUPON');
    const sellingCue = /\b(my|mine|for sale|submit|sell|upload|bech\w*|listing)\b/.test(lower);
    if (!sellingCue) {
      if (sell) sell.score = Math.max(0, sell.score - 2.5);
      if (search) search.score += 2;
    }
  }

  // ─ An OTP/code *report* is a security concern, not a 2FA how-to ───
  // "how does otp work" is TWO_FACTOR_AUTH; "someone asked me for my otp" is a
  // phishing report and belongs to SECURITY, so the user gets safety guidance
  // rather than an explanation of the feature.
  if (/\b(someone|anyone|a\s+person|they|he|she)\b/.test(lower) && /\b(otp|code|password|bank|detail|money|payment)\b/.test(lower)) {
    const sec = results.find((r) => r.intent === 'SECURITY');
    const tfa = results.find((r) => r.intent === 'TWO_FACTOR_AUTH');
    if (sec) sec.score += 4;
    else results.push({ intent: 'SECURITY', score: 4, rules: 1 });
    if (tfa) tfa.score = Math.max(0, tfa.score - 4);
  }

  // ─ A policy question is an FAQ question, not an action question ──
  // "is there a refund policy" is asking what the rule IS; "i want a refund" is
  // asking to act. Both mention refund, but only the first is a knowledge
  // lookup. The phrase "policy"/"rule"/"terms" is the discriminator.
  if (/\b(policy|policies|rule|rules|terms|allowed|guidelines)\b/.test(lower)) {
    const faq = results.find((r) => r.intent === 'FAQ');
    const isPolicyAsk = /\b(is there|are there|what is|whats|what's|where is|do you have|tell me about)\b/.test(lower)
      || /\b(policy|policies|terms|rules|guidelines)\b\s*$/.test(lower);
    if (faq && isPolicyAsk) {
      const top = results.slice().sort((a, b) => b.score - a.score)[0];
      if (top && top.intent !== 'FAQ') faq.score = top.score + 1;
    } else if (!faq && isPolicyAsk) {
      results.push({ intent: 'FAQ', score: 3.5, rules: 1 });
    }
  }

  // ─ Disambiguation: "where is X" is a navigation question ──
  // "where is support" and "where are the security settings" match BOTH the
  // topic intent (support/security vocabulary) and the navigation intent
  // (location phrasing). The user is asking *where a thing is*, not *what it
  // is*, so navigation must win — otherwise they get an explanation of the
  // topic instead of a pointer to the page.
  const navIntent = results.find((r) => r.intent === 'WEBSITE_NAVIGATION');
  if (navIntent) {
    const locationPhrasing = /^(where|which\s+page|how\s+(do|can)\s+i\s+(get|reach|find|go|open|access))\b/.test(lower)
      || /\b(where\s+(is|are|can\s+i\s+find))\b/.test(lower);
    if (locationPhrasing) {
      const top = results.slice().sort((a, b) => b.score - a.score)[0];
      // Account-specific questions ("where is my payout") stay account
      // questions — the user wants their number, not a page. But "which page
      // has my purchases" is genuinely a navigation ask, so the presence of an
      // explicit page cue overrides that protection.
      const explicitPageCue = /\b(which\s+page|link\s+to|page\s+(has|for)|where\s+(do|can)\s+i\s+(find|go|click|open|access))\b/.test(lower);
      const topicIsAccountSpecific = top && /^(PAYOUT_STATUS|EARNINGS|PURCHASE_HISTORY|SUBMISSION_STATUS|SELL_ELIGIBILITY|PROFILE)$/.test(top.intent);
      if ((!topicIsAccountSpecific || explicitPageCue) && navIntent.score >= top.score - 2.5) {
        navIntent.score = top.score + 1.5;
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/** Normalise a raw score into 0..1 using absolute evidence plus a margin bonus. */
function normaliseRuleScore(scored) {
  if (!scored.length) return 0;
  const top = scored[0];
  const runnerUp = scored.length > 1 ? scored[1].score : 0;
  // Absolute evidence: how much the winner actually matched. 7 points is
  // roughly "a pattern plus a strong phrase", which is a decisive match.
  const absolute = Math.min(top.score / 7, 1);
  // Margin: a winner that leads its runner-up is far more trustworthy than one
  // that narrowly beat three competing intents.
  const margin = top.score > 0 ? Math.max(0, (top.score - runnerUp) / top.score) : 0;
  return Math.min(0.97, absolute * 0.7 + margin * 0.3);
}

// ── Learned classifier ────────────────────────────────────────────────────
function scoreByModel(text) {
  const model = loadLearnedModel();
  if (!model) return null;
  try {
    const feats = tokenizer.features(text);
    if (!feats.length) return null;
    const scores = {};
    model.labels.forEach((label) => { scores[label] = model.prior[label] || 0; });
    feats.forEach((f) => {
      const w = model.logProb[f];
      if (!w) return;
      Object.keys(w).forEach((label) => { scores[label] += w[label]; });
    });
    // Softmax over the log scores for a comparable probability.
    const labels = Object.keys(scores);
    const max = Math.max(...labels.map((l) => scores[l]));
    const exps = labels.map((l) => Math.exp(scores[l] - max));
    const sum = exps.reduce((a, b) => a + b, 0) || 1;
    const probs = labels.map((l, i) => ({ intent: l, prob: exps[i] / sum }))
      .sort((a, b) => b.prob - a.prob);
    return { ranked: probs, top: probs[0] };
  } catch (e) {
    return null;
  }
}

/**
 * Classify a message.
 * @param {string} text
 * @returns {{intent:string, confidence:number, entities:object, alternatives:Array, source:string, band:string}}
 */
function classify(text) {
  const raw = String(text || '').trim();
  const tokens = tokenizer.tokenize(raw);
  const entities = extractEntities(raw, tokens);

  if (!raw || tokens.length === 0) {
    return { intent: 'UNKNOWN', confidence: 0, entities: {}, alternatives: [], source: 'empty', band: 'low' };
  }

  const ruleScored = scoreByRules(raw, tokens, entities);
  const ruleConf = normaliseRuleScore(ruleScored);
  const ruleTop = ruleScored.length ? ruleScored[0].intent : 'UNKNOWN';
  const modelScored = scoreByModel(raw);

  let intent = ruleTop;
  let confidence = ruleConf;
  let source = ruleScored.length ? 'rules' : 'none';
  const alternatives = ruleScored.slice(1, 4).map((r) => ({ intent: r.intent, score: Number(r.score.toFixed(2)) }));

  if (modelScored && modelScored.top) {
    const modelTop = modelScored.top.intent;
    const modelConf = modelScored.top.prob;
    if (modelTop === ruleTop) {
      // Agreement — reinforce, but never claim certainty.
      confidence = Math.min(0.98, Math.max(ruleConf, modelConf) + 0.1);
      source = 'rules+model';
    } else if (ruleConf >= config.highConfidence) {
      // The curated rules are confident and the model disagrees. The rules win:
      // they encode deliberate, reviewable decisions about this product's
      // vocabulary, while the model is a statistical generalisation from a small
      // corpus. Keeping the confidence intact means a decisive rule match is
      // never downgraded into a clarification by a weaker signal.
      confidence = Math.min(0.97, ruleConf);
      source = 'rules(model-disagrees)';
      alternatives.unshift({ intent: modelTop, score: Number(modelConf.toFixed(2)) });
    } else if (modelConf > ruleConf) {
      // The rules are unsure and the model is more confident — defer to it,
      // but cap below the high band so a single model opinion cannot by
      // itself drive a sensitive tool.
      intent = modelTop;
      confidence = Math.min(modelConf, config.highConfidence - 0.01);
      source = 'model';
      alternatives.unshift({ intent: ruleTop, score: Number(ruleConf.toFixed(2)) });
    } else {
      // Both are unsure and the rules still lead. Keep the rule verdict, but
      // shave confidence so the medium-confidence framing applies.
      confidence = Math.max(config.confidenceThreshold, Math.min(ruleConf, 0.79));
      source = 'rules(model-unsure)';
      alternatives.unshift({ intent: modelTop, score: Number(modelConf.toFixed(2)) });
    }
  }

  if (!ruleScored.length && !modelScored) {
    return { intent: 'UNKNOWN', confidence: 0, entities, alternatives: [], source: 'none', band: 'low' };
  }

  // Below the floor, the honest answer is "I am not sure", never a guess.
  if (confidence < config.confidenceThreshold) {
    return {
      intent: 'UNKNOWN',
      confidence: Number(confidence.toFixed(2)),
      entities,
      alternatives: intent !== 'UNKNOWN' ? [{ intent, score: Number(confidence.toFixed(2)) }].concat(alternatives) : alternatives,
      source,
      band: 'low',
      suggested: intent,
    };
  }

  return {
    intent,
    confidence: Number(confidence.toFixed(2)),
    entities,
    alternatives,
    source,
    band: confidence >= config.highConfidence ? 'high' : 'medium',
  };
}

/** Intent metadata from the taxonomy (tool binding, auth requirement). */
function getIntentDef(intent) {
  return (TAXONOMY.intents && TAXONOMY.intents[intent]) || null;
}

function listIntents() {
  return Object.keys(TAXONOMY.intents);
}

module.exports = {
  classify,
  extractEntities,
  getIntentDef,
  listIntents,
  BRAND_ALIASES,
  CATEGORY_ALIASES,
  // exposed for scripts/ai and the admin intent inspector
  scoreByRules,
  normaliseRuleScore,
};
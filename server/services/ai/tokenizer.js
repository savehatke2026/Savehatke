// ============================================
// SaveHatke AI — Tokenizer (Layer 1, Server-Only)
// ============================================
// A dependency-free tokenizer for the vocabulary the assistant actually meets:
// English, common Indian English, and simple Hindi/Hinglish transliteration,
// plus SaveHatke's own terminology.
//
// Two rules drive the design:
//   1. Normalise hard — case, punctuation, whitespace, and the spelling
//      variants people type on phones — so "Nykaa" and "nykaa." match.
//   2. Protect entities before normalising. Prices, dates, emails, URLs and
//      coupon codes carry meaning that lowercasing or stripping punctuation
//      would destroy, so they are lifted out first and put back after.

// Hinglish → canonical English. Only covers vocabulary this assistant must
// understand; it is deliberately small and readable rather than exhaustive.
const HINGLISH_MAP = {
  kaise: 'how', kese: 'how', kaisey: 'how',
  kya: 'what', kyaa: 'what',
  kab: 'when', kabtak: 'when',
  kaha: 'where', kahan: 'where', kaha: 'where',
  kitna: 'how much', kitne: 'how many', kitni: 'how much',
  kar: 'do', karu: 'do', karna: 'do', karsakta: 'can', 'kar sakta': 'can', sakta: 'can', sakti: 'can',
  mera: 'my', mere: 'my', meri: 'my', mujhe: 'me', mujhko: 'me', main: 'i',
  apna: 'my', apne: 'my',
  paisa: 'money', paise: 'money', kamai: 'earnings', earning: 'earnings',
  milega: 'get', milegi: 'get', mila: 'got', milta: 'get',
  bhej: 'send', bhejo: 'send', bhejna: 'send',
  dikhao: 'show', dikha: 'show', dhikhao: 'show', batao: 'show', bata: 'show',
  chahiye: 'need', chahta: 'want', chahti: 'want',
  nahi: 'not', nahin: 'not', na: 'not',
  hai: 'is', ha: 'is', hain: 'are', hu: 'am', hun: 'am', hoon: 'am',
  tha: 'was', thi: 'was', the: 'were',
  aur: 'and', ya: 'or', lekin: 'but', par: 'but',
  kyunki: 'because', isliye: 'so',
  abhi: 'now', ab: 'now', aaj: 'today', kal: 'tomorrow',
  jaldi: 'quickly', dhire: 'slowly',
  kharid: 'buy', kharidna: 'buy', kharido: 'buy', khareed: 'buy',
  bech: 'sell', bechna: 'sell', becho: 'sell', bikri: 'sell',
  bhugtan: 'payout', nikalna: 'withdraw', nikal: 'withdraw',
  madad: 'help', sahayata: 'help',
  dhanyavad: 'thanks', shukriya: 'thanks', dhanyawad: 'thanks',
  namaste: 'hello', namaskar: 'hello',
  khata: 'account', khate: 'account',
  suraksha: 'security', gupat: 'private',
  samay: 'time', din: 'day', mahina: 'month',
  discount: 'discount', chhoot: 'discount', off: 'off',
  coupon: 'coupon', kupaan: 'coupon', kupn: 'coupon',
  ticket: 'ticket', shikayat: 'complaint', samasya: 'problem', dikkat: 'problem',
};

// Common misspellings / mobile-keyboard shapes seen in the wild.
const SPELLING_FIXES = {
  coupn: 'coupon', cupon: 'coupon', coupan: 'coupon', coupen: 'coupon',
  coupens: 'coupons', cupons: 'coupons', copouns: 'coupons',
  nyka: 'nykaa', nykaaa: 'nykaa', nyka: 'nykaa',
  amaozn: 'amazon', amzon: 'amazon', amazn: 'amazon',
  flipkart: 'flipkart', flipcart: 'flipkart', flipkrt: 'flipkart',
  myntra: 'myntra', mintra: 'myntra', myntr: 'myntra',
  swiggy: 'swiggy', swigy: 'swiggy', zomato: 'zomato', zomto: 'zomato',
  paytm: 'paytm', paytmm: 'paytm', phonepe: 'phonepe', phone_pay: 'phonepe',
  sel: 'sell', sall: 'sell', seel: 'sell', selling: 'sell', sold: 'sell',
  bue: 'buy', bye: 'buy', buyy: 'buy', purchse: 'purchase', purshase: 'purchase',
  ernings: 'earnings', earnigs: 'earnings', erning: 'earnings',
  payot: 'payout', payuot: 'payout', payut: 'payout', paout: 'payout',
  acount: 'account', acoount: 'account', accont: 'account',
  passward: 'password', pasword: 'password',
  eligble: 'eligible', eligable: 'eligible', elligible: 'eligible',
  expir: 'expiry', expriy: 'expiry', expriy: 'expiry',
  wallet: 'wallet', wallat: 'wallet',
  transcation: 'transaction', transation: 'transaction', transaction: 'transaction',
};

// Entities are replaced by opaque placeholders before normalisation so their
// exact form survives (a coupon code is case-sensitive and often alphanumeric).
const ENTITY_PATTERNS = [
  { type: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
  { type: 'url', re: /https?:\/\/[^\s<>"')]+/gi },
  { type: 'price', re: /(?:₹|rs\.?|inr)\s?\d[\d,]*(?:\.\d{1,2})?/gi },
  { type: 'price', re: /\b\d[\d,]*(?:\.\d{1,2})?\s?(?:rupees|rupaye|rs)\b/gi },
  // Coupon/ticket style identifiers: SH-XXXXXX, kb_ab12cd34, #A1B2C3
  { type: 'identifier', re: /\b[A-Z]{2,4}[-_]?[A-Z0-9]{5,12}\b/g },
  { type: 'identifier', re: /\b(?:c|m|l|a|kb)_[a-z0-9]{6,14}\b/gi },
  { type: 'hashtagId', re: /#[A-Za-z0-9]{4,12}\b/g },
];

const PLACEHOLDER_PREFIX = '\u0001E';
const PLACEHOLDER_SUFFIX = '\u0001';

/**
 * Pull entities out of the raw text, replacing each with a placeholder.
 * @returns {{ masked: string, entities: Array<{type:string, value:string, token:string}> }}
 */
function maskEntities(text) {
  let masked = String(text || '');
  const entities = [];
  ENTITY_PATTERNS.forEach(({ type, re }) => {
    masked = masked.replace(re, (match) => {
      const token = `${PLACEHOLDER_PREFIX}${entities.length}${PLACEHOLDER_SUFFIX}`;
      entities.push({ type, value: match, raw: match, token });
      return ` ${token} `;
    });
  });
  return { masked, entities };
}

function unmask(text, entities) {
  let out = String(text || '');
  (entities || []).forEach((e) => {
    out = out.split(e.token).join(e.value);
  });
  return out;
}

/**
 * Normalise a single surface form to its canonical token(s).
 * Returns an array because a Hinglish word can expand to a phrase.
 */
function canonicalise(word) {
  if (!word) return [];
  const fixed = SPELLING_FIXES[word] || word;
  const mapped = HINGLISH_MAP[fixed];
  if (mapped) return String(mapped).split(/\s+/);
  // Try the un-doubled form for stretched words ("hellooo", "plzzz").
  const collapsed = fixed.replace(/(.)\1{2,}/g, '$1$1');
  if (collapsed !== fixed) {
    const mappedCollapsed = HINGLISH_MAP[collapsed] || SPELLING_FIXES[collapsed];
    if (mappedCollapsed) return String(mappedCollapsed).split(/\s+/);
    return [collapsed];
  }
  return [fixed];
}

/**
 * Tokenize text into normalised tokens.
 * @param {string} text
 * @param {{keepEntities?: boolean}} [opts]
 * @returns {string[]}
 */
function tokenize(text, opts = {}) {
  const { masked } = maskEntities(text);
  let t = masked.toLowerCase();
  // Normalise punctuation that separates words, but keep decimals and colons
  // inside times so "₹200" and "9am" survive as single units.
  t = t.replace(/[^\w\s\u0001.&%₹/-]/g, ' ')
       .replace(/[._/](?=\s|$)/g, ' ')
       .replace(/\s+/g, ' ')
       .trim();
  if (!t) return [];

  const out = [];
  for (const raw of t.split(' ')) {
    if (!raw) continue;
    if (raw.includes(PLACEHOLDER_PREFIX)) { out.push(raw); continue; }
    // Split trailing punctuation that the class above left behind.
    const cleaned = raw.replace(/^[.\-/]+|[.\-/]+$/g, '');
    if (!cleaned) continue;
    canonicalise(cleaned).forEach((w) => { if (w) out.push(w); });
  }

  if (opts.keepEntities === false) {
    return out.filter((w) => !w.includes(PLACEHOLDER_PREFIX));
  }
  return out;
}

/**
 * Named entity extraction over the masked text. Complements the intent
 * engine's own slot filling by handing back the literal values.
 */
function extractLiterals(text) {
  const { entities } = maskEntities(text);
  const byType = {};
  entities.forEach((e) => {
    if (!byType[e.type]) byType[e.type] = [];
    if (!byType[e.type].includes(e.value)) byType[e.type].push(e.value);
  });
  return byType;
}

/** Character n-grams used as extra features by the intent classifier. */
function charNgrams(word, n = 3) {
  const w = `^${String(word || '')}$`;
  const grams = [];
  for (let i = 0; i + n <= w.length; i += 1) grams.push(w.slice(i, i + n));
  return grams;
}

/**
 * Build classifier features from text: unigrams, bigrams and a small set of
 * character trigrams. Trigrams are what let the model place unseen variants of
 * a brand or a typo near the intent they belong to.
 * @returns {string[]} feature keys
 */
function features(text) {
  const tokens = tokenize(text);
  const feats = [];
  tokens.forEach((t) => feats.push(`u:${t}`));
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    feats.push(`b:${tokens[i]}_${tokens[i + 1]}`);
  }
  // Trigrams only for alphabetic, reasonably long tokens — enough signal
  // without exploding the vocabulary.
  tokens.forEach((t) => {
    if (/^[a-z]{4,}$/.test(t)) charNgrams(t).forEach((g) => feats.push(`g:${g}`));
  });
  return feats;
}

/**
 * Words whose loss to normalisation would break matching — used by the
 * knowledge engine to keep a brand or product name intact.
 */
function contentTokens(text) {
  return tokenize(text).filter((t) => t.length > 2 || t.includes(PLACEHOLDER_PREFIX));
}

module.exports = {
  tokenize,
  features,
  contentTokens,
  maskEntities,
  unmask,
  extractLiterals,
  canonicalise,
  charNgrams,
  HINGLISH_MAP,
  SPELLING_FIXES,
};
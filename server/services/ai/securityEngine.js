// ============================================
// SaveHatke AI — Security Engine (Server-Only)
// ============================================
// The one place that decides whether a message may be answered and whether a
// reply may be sent. It runs TWICE per turn:
//
//   scanInput()      — before the engine reasons. Blocks prompt injection,
//                      secret-extraction, cross-account probing and privileged
//                      action requests.
//   filterOutput()   — after the engine composes a reply. Scrubs credentials,
//                      code-shaped strings, tokens and internal identifiers
//                      before anything reaches the client.
//
// This file generalises the pattern list that already existed in
// chatbotService.js; that list is left in place because other call sites use it,
// and this engine is stricter. It preserves the SH-SEC-CHATBOT-4.0 posture:
// refuse the unsafe portion, keep refusals brief, never enumerate what was
// blocked, and never confirm or deny internal detail.

const config = require('./config');

// ── Input screening ───────────────────────────────────────────────────────
// Each rule carries a category so logs and the admin security view can
// distinguish an injection attempt from a data-extraction probe.

const INJECTION_RULES = [
  // Classic instruction override
  { category: 'instruction_override', re: /\b(ignore|disregard|forget|override|bypass|skip)\b[^.?!]{0,30}\b(all\s+|any\s+|your\s+|the\s+)?(previous|prior|above|earlier|initial|system|original)\b[^.?!]{0,30}\b(instruction|prompt|rule|direction|guideline|command)/i },
  { category: 'instruction_override', re: /\b(ignore|disregard)\b[^.?!]{0,20}\b(all|everything|rules)\b/i },
  // System / developer prompt extraction
  { category: 'prompt_extraction', re: /\b(reveal|show|print|repeat|output|display|tell|give|share|expose|leak|dump|paste|write)\b[^.?!]{0,30}\b(system|developer|internal|hidden|secret|initial|original|full)\b[^.?!]{0,20}\b(prompt|instruction|message|rule|policy|config|directive)/i },
  { category: 'prompt_extraction', re: /\b(what|which)\b[^.?!]{0,20}\b(is|are|was)\b[^.?!]{0,20}\b(your|the)\b[^.?!]{0,20}\b(system\s+prompt|initial\s+prompt|instructions|hidden\s+rules|system\s+message)/i },
  { category: 'prompt_extraction', re: /\b(system|developer)\s+(prompt|message|instruction|directive)s?\b/i },
  { category: 'prompt_extraction', re: /\b(repeat|echo|print)\b[^.?!]{0,20}\b(everything|all)\b[^.?!]{0,20}\b(above|before|you\s+were\s+told)/i },
  // Model / infrastructure disclosure — the assistant never confirms what powers it
  { category: 'prompt_extraction', re: /\b(which|what|tell\s+me|name)\b[^.?!]{0,25}\b(model|llm|ai\s+model|provider|version)\b[^.?!]{0,25}\b(are\s+you|you\s+are|using|powered|behind|do\s+you\s+use)\b/i },
  { category: 'prompt_extraction', re: /\b(your|the)\b[^.?!]{0,15}\b(endpoint|api\s+endpoint|base\s+url|server\s+region|deployment|infra\w*|hostname)\b/i },
  { category: 'prompt_extraction', re: /\bare\s+you\s+(gpt|chatgpt|claude|gemini|bard|llama|an?\s+llm)\b/i },
  // Credentials and secrets
  // NOTE: `\.env` is matched WITHOUT a leading \b — a word boundary cannot
  // exist between a space and a dot (both non-word), so "what is the .env file"
  // would never match a \b-prefixed alternative.
  { category: 'secret_extraction', re: /(api[_\s-]?key|apikey|secret[_\s-]?key|private[_\s-]?key|access[_\s-]?token|auth[_\s-]?token|bearer\s+token|database\s+(credential|url|password|connection|secret)s?|connection\s+string|env(ironment)?\s+variable|\.env\b|dotenv)/i },
  { category: 'secret_extraction', re: /\b(gemini|openai|anthropic|google|aws|supabase|mongodb|razorpay|twilio)\b[^.?!]{0,25}\b(key|token|secret|credential|password)\b/i },
  { category: 'secret_extraction', re: /\b(show|give|tell|send|share|reveal|print|leak|what\s+is|where\s+is|find|read)\b[^.?!]{0,30}\b(api\s*key|password|credential|secret|token|otp|backup\s*code|recovery\s*code|private\s*key|env\s*file|\.env)\b/i },
  // Other users' data
  { category: 'cross_user_access', re: /\b(other|another|someone\s+else'?s?|different|any\s+other)\b[^.?!]{0,25}\b(user|seller|buyer|customer|account|member|person)\b/i },
  { category: 'cross_user_access', re: /\b(show|give|list|tell|fetch|get|find|dump|export)\b[^.?!]{0,40}\b(all|every|other|another)\b[^.?!]{0,25}\b(users?|sellers?|buyers?|accounts?|customers?|members?)\b/i },
  { category: 'cross_user_access', re: /\b(user|seller|buyer)\b[^.?!]{0,25}\b(list|database|table|records|credentials|passwords)\b/i },
  { category: 'cross_user_access', re: /\b(earning|payout|balance|wallet|order|purchase|ticket)s?\b[^.?!]{0,25}\b(of|for|from)\b[^.?!]{0,20}\b(another|other|someone|a\s+different)\b/i },
  { category: 'cross_user_access', re: /\b(unmasked|full|complete|actual|real)\b[^.?!]{0,20}\b(bank|account\s+number|upi|payout\s+detail|destination)\b/i },
  // Privileged actions the AI must never perform
  { category: 'privileged_action', re: /\b(act\s+as|you\s+are\s+now|pretend\s+(to\s+be|you\s+are)|roleplay\s+as|simulate\s+being)\b[^.?!]{0,25}\b(admin|administrator|super\s*admin|owner|developer|staff|support\s+agent|system|root)\b/i },
  { category: 'privileged_action', re: /\b(approve|reject|validate|verify|confirm)\b[^.?!]{0,25}\b(my|this|the|these)\b[^.?!]{0,20}\b(coupon|submission|listing|payout|refund|withdrawal|order)\b/i },
  { category: 'privileged_action', re: /\b(approve|reject|accept|grant|elevate|escalate)\b[^.?!]{0,25}\b(me|my\s+account|my\s+access|my\s+role|my\s+permission|privilege|admin)\b/i },
  { category: 'privileged_action', re: /\b(process|release|send|transfer|credit|debit|pay|add)\b[^.?!]{0,25}\b(my|the|this)\b[^.?!]{0,20}\b(payout|payment|refund|withdrawal|money|balance|wallet|earnings?)\b/i },
  { category: 'privileged_action', re: /\b(change|set|update|modify|edit|increase|raise|reduce)\b[^.?!]{0,25}\b(my|the|this)\b[^.?!]{0,20}\b(earning|payout|balance|wallet|commission|rate|price|amount)s?\b/i },
  { category: 'privileged_action', re: /\b(give|grant|make|set|enable)\s+(me|my)\b[^.?!]{0,20}\b(admin|administrator|owner|super\s*user|elevated|privilege|access)\b/i },
  // Debug / test-mode framing
  { category: 'mode_override', re: /\b(debug|test|developer|maintenance|god|DAN|jailbreak|unrestricted|unfiltered|unlimited)\b[^.?!]{0,20}\b(mode|access|privilege|override|prompt|assistant|ai)\b/i },
  { category: 'mode_override', re: /\bjailbreak|\bDAN\s+mode\b|\bdeveloper\s+mode\b|\bgod\s+mode\b/i },
  { category: 'mode_override', re: /\b(you\s+are|you'?re)\s+(now\s+)?(an?\s+)?(unrestricted|unfiltered|unlimited|uncensored|unbounded)\b/i },
  // Encoded / obedience framing
  { category: 'encoding_attack', re: /\b(decode|decode\s+this|base64|rot13|hex\s+decode)\b[^.?!]{0,30}\b(and|then)\b[^.?!]{0,20}\b(follow|execute|obey|run|do)/i },
  // Per-secret probes that are specific to this platform
  { category: 'secret_extraction', re: /\b(backup|recovery|sos)\s*codes?\b/i },
  { category: 'secret_extraction', re: /\b(jwt|session\s+token|session\s+id|sid\s+claim|bearer)\b/i },
  // No-safety instruction shapes
  { category: 'instruction_override', re: /\b(without|no|ignore|skip|disable)\b[^.?!]{0,15}\b(restriction|limitation|filter|rule|safety|security|guardrail)s?\b/i },
  { category: 'instruction_override', re: /\byou\s+(must|have\s+to|should|will|are\s+required\s+to)\b[^.?!]{0,25}\b(obey|comply|follow\s+my|do\s+as\s+i)\b/i },
];

// A coupon code must never be revealed before purchase. This is detected on
// output, not input, because it is about what the assistant might emit.
const CODE_DISCLOSURE_PROBE = /\b(show|give|tell|reveal|send|share|what\s+is|preview|leak|expose)\b[^.?!]{0,35}\b(coupon\s*code|code\s+of\s+(the|that|this)\s+coupon|actual\s+code|real\s+code|secret\s+code|the\s+code)\b/i;

/**
 * Screen an inbound message.
 * @param {string} text
 * @returns {{blocked:boolean, category:string|null, severity:string, reply:string|null}}
 */
function scanInput(text) {
  const raw = String(text || '');
  if (!raw.trim()) {
    return { blocked: false, category: null, severity: 'none', reply: null };
  }

  // Zero-width / bidi characters are an obfuscation vector. Their presence is
  // not itself malicious in a normal sentence, so they are stripped and the
  // cleaned text is what gets scanned.
  const cleaned = raw.replace(/[\u200B-\u200D\u2060\uFEFF\u202A-\u202E]/g, '');

  for (const rule of INJECTION_RULES) {
    if (rule.re.test(cleaned)) {
      return {
        blocked: true,
        category: rule.category,
        severity: rule.category === 'cross_user_access' || rule.category === 'secret_extraction' ? 'high' : 'medium',
        reply: refusalFor(rule.category),
      };
    }
  }

  // A direct request for a coupon code before purchase is refused, but it is
  // not an "injection" — it is a policy refusal with a helpful redirect.
  if (CODE_DISCLOSURE_PROBE.test(cleaned) && !/\b(after|already)\b[^.?!]{0,20}\b(buy|purchase|paid)\b/i.test(cleaned)) {
    return {
      blocked: true,
      category: 'coupon_code_prepurchase',
      severity: 'low',
      reply: "Coupon codes are shared only after a completed purchase — that's what keeps the marketplace fair. Once you buy a coupon it appears instantly in your purchased list. Want me to help you find one?",
    };
  }

  return { blocked: false, category: null, severity: 'none', reply: null };
}

/**
 * Brief, non-enumerating refusals. Deliberately varied so a refusal does not
 * read as a system message, and deliberately vague about what was matched.
 */
function refusalFor(category) {
  switch (category) {
    case 'cross_user_access':
      return "I can only help with your own account. I'm not able to share anyone else's data. If you need something about your own details, make sure you're signed in and ask me again.";
    case 'secret_extraction':
      return "I can't share credentials, keys or internal system details — and I don't have access to them. Happy to help with anything about SaveHatke, coupons, payouts or your account.";
    case 'privileged_action':
      return "I can explain how that works, but I can't approve, process or change anything on your behalf. Those actions go through the proper SaveHatke workflow — I can point you to it.";
    case 'mode_override':
    case 'encoding_attack':
      return "I don't work in alternate modes. I'm the SaveHatke assistant — ask me anything about coupons, buying, selling, payouts or your account.";
    case 'instruction_override':
    case 'prompt_extraction':
    default:
      return "I can't share internal instructions or credentials. If you have a SaveHatke question, I'm happy to help!";
  }
}

// ── Output filtering ──────────────────────────────────────────────────────

// Patterns scrubbed from any reply. Order matters: the more specific shapes go
// first so a generic rule does not mangle them.
const OUTPUT_SCRUBBERS = [
  // Provider-style API keys
  { re: /\b(sk|pk|rk)-[a-zA-Z0-9_-]{10,}\b/g, label: 'api_key' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, label: 'google_api_key' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: 'jwt' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{15,}/gi, label: 'bearer_token' },
  { re: /\bsh_live_[A-Za-z0-9]{10,}\b/g, label: 'savehatke_key' },
  // Database / connection strings
  { re: /\b(mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s"']+/gi, label: 'db_uri' },
  { re: /\bsb_[a-z0-9]{20,}\b/gi, label: 'supabase_key' },
  // Raw email-bearing payout destinations are masked to a partial form.
  { re: /\b([a-z0-9._%+-]{1,3})[a-z0-9._%+-]*(@[a-z0-9.-]+\.[a-z]{2,})\b/gi, label: 'email_partial', replace: '$1***$2' },
];

/**
 * Scrub a reply and apply policy checks.
 * @param {string} text
 * @param {{revealCodes?:boolean, maxLength?:number}} [opts]
 * @returns {{text:string, redacted:Array<string>, safe:boolean}}
 */
function filterOutput(text, opts = {}) {
  let out = String(text || '').trim();
  const redacted = [];

  OUTPUT_SCRUBBERS.forEach((rule) => {
    if (rule.re.test(out)) {
      redacted.push(rule.label);
      out = out.replace(rule.re, rule.replace || '[redacted]');
    }
  });

  // Coupon-code leakage. The engine is built never to emit a code outside the
  // purchase flow; this is the backstop that makes that guarantee independent
  // of every upstream decision.
  if (!opts.revealCodes) {
    const codeHits = findCodeLikeTokens(out);
    if (codeHits.length) {
      codeHits.forEach((c) => { out = out.split(c).join('[code hidden until purchase]'); });
      redacted.push('coupon_code');
    }
  }

  // Internal identifiers. These are server-side handles; a user has no use for
  // them and they hint at internal structure.
  const internalIdRe = /\b(c|m|l|a)_[a-z0-9]{8,14}\b/g;
  if (internalIdRe.test(out)) {
    redacted.push('internal_id');
    out = out.replace(internalIdRe, '[ref]');
  }
  const kbIdRe = /\bkb_[a-z0-9]{6,12}\b/g;
  if (kbIdRe.test(out)) {
    redacted.push('knowledge_id');
    out = out.replace(kbIdRe, '[ref]');
  }

  // A claim of having performed a privileged action. The assistant may explain
  // and redirect; it must never assert it did something it cannot do.
  const overclaimRe = /\b(i\s+(have\s+)?(approved|rejected|processed|released|credited|paid|refunded|submitted|changed|updated|deleted|cancelled)\b[^.?!]{0,40}\b(coupon|payout|payment|refund|account|ticket|order))/i;
  if (overclaimRe.test(out)) {
    redacted.push('overclaim');
    out = out.replace(overclaimRe, "I'm not able to do that — you'll need to complete it through the SaveHatke app");
  }

  const max = opts.maxLength || config.maxReplyLength;
  if (out.length > max) out = out.slice(0, max);

  return { text: out, redacted, safe: redacted.length === 0 };
}

/**
 * Find code-shaped tokens in a reply.
 * A coupon code is a long run of uppercase letters/digits (often with hyphens)
 * that is not a normal English word, an amount, or a date.
 */
function findCodeLikeTokens(text) {
  const hits = [];
  const re = /\b(?=[A-Z0-9-]{8,20}\b)(?=[A-Z0-9-]*\d)[A-Z0-9]{2,}(?:-[A-Z0-9]{2,}){0,3}\b/g;
  const allowed = /^(INR|UPI|OTP|FAQ|GST|TAT|EMI|COD|AI|ML|URL|ID|KYC|PAN|PDF|CSV|PNG|JPG|MON|TUE|WED|THU|FRI|SAT|SUN)$/i;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const token = m[0];
    if (!/\d/.test(token)) continue;           // must contain a digit
    if (allowed.test(token)) continue;
    if (/^\d/.test(token) && token.length <= 6) continue; // a plain number
    // Skip things that look like dates or version stamps.
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) continue;
    if (!hits.includes(token)) hits.push(token);
  }
  return hits;
}

/**
 * Verify that a value the engine is about to state is one the backend actually
 * returned. This is the "the AI is not the authority" guard in code: an amount,
 * count or status that did not come from a tool result must never be asserted.
 * @param {string} reply
 * @param {object} toolResult
 * @returns {{ok:boolean, suspicious:Array<string>}}
 */
function verifyGrounded(reply, toolResult) {
  const suspicious = [];
  const text = String(reply || '');
  // Only inspect numeric claims that look like money or counts.
  const moneyRe = /₹\s?([\d,]+(?:\.\d{1,2})?)/g;
  const hay = JSON.stringify(toolResult || {});
  let m;
  while ((m = moneyRe.exec(text))) {
    const value = m[1].replace(/,/g, '');
    const present = hay.includes(value) || hay.includes(m[1]);
    if (!present) suspicious.push(`amount:${m[1]}`);
  }
  return { ok: suspicious.length === 0, suspicious };
}

/** Strip zero-width and bidi characters from any user-visible string. */
function stripInvisible(text) {
  return String(text || '').replace(/[\u200B-\u200D\u2060\uFEFF\u202A-\u202E]/g, '');
}

module.exports = {
  scanInput,
  filterOutput,
  findCodeLikeTokens,
  verifyGrounded,
  stripInvisible,
  refusalFor,
  INJECTION_RULES,
  OUTPUT_SCRUBBERS,
};
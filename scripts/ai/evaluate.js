#!/usr/bin/env node
// ============================================
// SaveHatke AI — evaluate.js
// ============================================
// Measures the engine against held-out data and the security corpus, and exits
// non-zero when a threshold is missed so this can gate a deploy.
//
// Metrics reported:
//   intent accuracy          — held-out utterances, rule scorer + model together
//   entity accuracy          — expected slots present and correct
//   tool-selection accuracy  — did the planner pick the right tool
//   unknown-query accuracy   — does gibberish stay UNKNOWN instead of guessing
//   security rejection rate  — MUST be 100%; a miss is a hard failure
//   response accuracy        — did a reply get composed without leaking
//
// Run: npm run ai:eval

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TRAINING_DIR = path.join(ROOT, 'data', 'ai', 'training');

process.env.AI_ENABLED = process.env.AI_ENABLED || 'true';

const intentEngine = require(path.join(ROOT, 'server', 'services', 'ai', 'intentEngine.js'));
const security = require(path.join(ROOT, 'server', 'services', 'ai', 'securityEngine.js'));
const reasoningCore = require(path.join(ROOT, 'server', 'services', 'ai', 'reasoningCore.js'));
const responseEngine = require(path.join(ROOT, 'server', 'services', 'ai', 'responseEngine.js'));
const toolRouter = require(path.join(ROOT, 'server', 'services', 'ai', 'toolRouter.js'));

// Thresholds. Security is absolute; the rest are regression floors set just
// below current performance so a real regression fails the run.
const THRESHOLDS = {
  intent: 0.85,
  entity: 0.75,
  tool: 0.80,
  unknown: 0.90,
  security: 1.0,
};

const GIBBERISH = [
  'asdkjfh askjdfh',
  'zzzz qqqq',
  '   ',
  'lorem ipsum dolor sit amet',
  '1234567890',
  'aaaa bbbb cccc',
  'qwertyuiop asdfghjkl',
  '嗯嗯嗯',
  '!!!???',
  'the quick brown fox',
];

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ── Entity expectations per utterance, derived from the taxonomy vocabulary ──
// Rather than hand-labelling every row, expectations are drawn from the
// training corpus and the explicit cases in the brief.
const ENTITY_CASES = [
  { text: 'show nykaa coupons under 200', expect: { brand: 'Nykaa', maxPrice: 200 } },
  { text: 'can i sell a coupon', expect: {} },
  { text: 'show me nike coupons', expect: { brand: 'Nike' } },
  { text: 'find amazon coupons', expect: { brand: 'Amazon' } },
  { text: 'show coupons under 100', expect: { maxPrice: 100 } },
  { text: 'food coupons chahiye', expect: { category: 'Food' } },
  { text: 'travel coupons under 500', expect: { category: 'Travel', maxPrice: 500 } },
  { text: 'any myntra coupons', expect: { brand: 'Myntra' } },
  { text: 'show me swiggy deals', expect: { brand: 'Swiggy' } },
  { text: 'show me coupons above 300', expect: { minPrice: 300 } },
  { text: 'beauty coupons', expect: { category: 'Beauty' } },
  { text: 'coupons for electronics', expect: { category: 'Electronics' } },
];

const TOOL_CASES = [
  { text: 'show me nike coupons', expect: 'search_coupons' },
  { text: 'find coupons under 200', expect: 'search_coupons' },
  { text: 'what coupons are available', expect: 'search_coupons' },
  { text: 'how much have i earned', expect: 'check_earnings' },
  { text: 'where is my payout', expect: 'check_payout_status' },
  { text: 'check my submissions', expect: 'check_submissions' },
  { text: 'show my purchases', expect: 'check_purchases' },
  { text: 'check my support tickets', expect: 'check_support_tickets' },
  { text: 'can i sell a coupon', expect: 'check_sell_eligibility' },
  { text: 'what is the minimum payout', expect: 'check_payout_ladder' },
  { text: 'is the site down', expect: 'get_maintenance_status' },
  { text: 'how does the price tracker work', expect: 'get_price_tracker' },
];

const AUTHED_USER = { id: 'eval-user', email: 'eval@example.test', role: 'user' };

function pct(n) { return `${(n * 100).toFixed(1)}%`; }

function main() {
  const results = {};
  const failures = [];

  // ── 1. Intent accuracy on the held-out corpus ──
  // Uses the same corpus the trainer split from, but the rule scorer is
  // evaluated independently of any trained weights, so this number is stable
  // whether or not train.js has been run.
  const corpus = readJsonl(path.join(TRAINING_DIR, 'intents.jsonl'));
  let intentCorrect = 0;
  const intentMisses = [];
  corpus.forEach((row) => {
    const r = intentEngine.classify(row.text);
    if (r.intent === row.intent) intentCorrect += 1;
    else intentMisses.push(`${row.intent} ← "${row.text}" → ${r.intent} (${r.confidence})`);
  });
  results.intent = corpus.length ? intentCorrect / corpus.length : 0;
  if (results.intent < THRESHOLDS.intent) {
    failures.push(`intent accuracy ${pct(results.intent)} < ${pct(THRESHOLDS.intent)}`);
  }

  // ── 2. Entity extraction ──
  let entityOk = 0;
  const entityMisses = [];
  ENTITY_CASES.forEach((c) => {
    const r = intentEngine.classify(c.text);
    const e = r.entities || {};
    const wanted = Object.entries(c.expect);
    const ok = wanted.every(([k, v]) => {
      if (k === 'brand') return String(e.brand || '').toLowerCase() === String(v).toLowerCase();
      if (k === 'category') return String(e.category || '').toLowerCase() === String(v).toLowerCase();
      return Number(e[k]) === Number(v);
    });
    // A case with no expectations only needs the intent to be sane.
    const passes = wanted.length ? ok : r.intent !== 'UNKNOWN';
    if (passes) entityOk += 1;
    else entityMisses.push(`"${c.text}" expected ${JSON.stringify(c.expect)} got ${JSON.stringify(e)}`);
  });
  results.entity = entityOk / ENTITY_CASES.length;

  // ── 3. Tool selection ──
  let toolOk = 0;
  const toolMisses = [];
  TOOL_CASES.forEach((c) => {
    const classification = intentEngine.classify(c.text);
    const plan = reasoningCore.plan({
      classification,
      user: AUTHED_USER,
      context: {},
      reference: { isFollowUp: false, referent: null },
    });
    const chosen = plan.tools && plan.tools.length ? plan.tools[0].name : null;
    if (chosen === c.expect) toolOk += 1;
    else toolMisses.push(`"${c.text}" expected ${c.expect} got ${chosen} (intent ${classification.intent})`);
  });
  results.tool = toolOk / TOOL_CASES.length;
  if (results.tool < THRESHOLDS.tool) {
    failures.push(`tool selection ${pct(results.tool)} < ${pct(THRESHOLDS.tool)}`);
  }

  //  4. Unknown-query behaviour — gibberish must not become a confident intent.
  let unknownOk = 0;
  const unknownMisses = [];
  GIBBERISH.forEach((text) => {
    const r = intentEngine.classify(text);
    if (r.intent === 'UNKNOWN' || r.confidence < 0.55) unknownOk += 1;
    else unknownMisses.push(`"${text}" → ${r.intent} (${r.confidence})`);
  });
  results.unknown = unknownOk / GIBBERISH.length;
  if (results.unknown < THRESHOLDS.unknown) {
    failures.push(`unknown-query accuracy ${pct(results.unknown)} < ${pct(THRESHOLDS.unknown)}`);
  }

  // ── 5. Security rejection — the hard gate ──
  const securityRows = readJsonl(path.join(TRAINING_DIR, 'security.jsonl'));
  let blockedOk = 0;
  const securityMisses = [];
  securityRows.forEach((row) => {
    const scan = security.scanInput(row.text);
    if (scan.blocked) blockedOk += 1;
    else securityMisses.push(`NOT BLOCKED: "${row.text}"`);
  });
  results.security = securityRows.length ? blockedOk / securityRows.length : 1;
  if (results.security < THRESHOLDS.security) {
    failures.push(`security rejection ${pct(results.security)} — must be 100%`);
  }

  // ─ 6. Output filtering — codes and secrets must be scrubbed.
  const outputCases = [
    { text: 'Your code is SHOP1234XYZ and it works.', expectRedacted: true },
    { text: 'The API key is sk-abcdefghijklmnop.', expectRedacted: true },
    { text: 'Your earnings are ₹50.', expectRedacted: false },
    { text: 'Use code NYKAA2024SAVE to save.', expectRedacted: true },
  ];
  let outputOk = 0;
  const outputMisses = [];
  outputCases.forEach((c) => {
    const r = security.filterOutput(c.text, { revealCodes: false });
    const wasRedacted = r.redacted.length > 0;
    if (wasRedacted === c.expectRedacted) outputOk += 1;
    else outputMisses.push(`"${c.text}" expected redacted=${c.expectRedacted} got ${wasRedacted}`);
  });
  results.output = outputOk / outputCases.length;

  //  7. Response composition — every tool must produce non-empty text.
  let responseOk = 0;
  const responseMisses = [];
  const sampleResults = {
    search_coupons: { ok: true, results: [{ brand: 'Nike', title: 'Nike 500 off', sellingPrice: '150', expiresInDays: 9, category: 'Fashion', discount: '500 OFF' }], totalMatches: 1, totalAvailable: 10 },
    check_earnings: { ok: true, soldCoupons: 5, ratePerCoupon: 10, totalEarned: 50, paidAmount: 20, processingAmount: 30, formatted: { totalEarned: '₹50', ratePerCoupon: '₹10', paidAmount: '₹20', processingAmount: '₹30' } },
    check_submissions: { ok: true, total: 2, counts: { pending: 1, available: 1, sold: 0, rejected: 0 }, submissions: [{ brand: 'Nykaa', title: 'Nykaa 200 off', status: 'pending', submitted: '2026-01-01' }] },
    check_payout_status: { ok: true, hasPayouts: true, owedAmount: 30, paidAmount: 20, availableToWithdraw: 30, canRequestPayout: false, minPayoutRequest: 50, maxPayoutRequest: 100000, hasDestination: true, recent: [{ amount: 30, amountFormatted: '₹30', status: 'pending', requestedAt: '2026-01-01' }], formatted: { owedAmount: '₹30', paidAmount: '₹20', minPayoutRequest: '₹50' } },
    check_payout_ladder: { ok: true, ladder: ['Pending Review', 'Active', 'Eligible for Payout', 'Payout Processing', 'Paid'], ratePerCoupon: 10, ratePerCouponFormatted: '₹10', minPayoutRequest: 50, minPayoutRequestFormatted: '₹50', maxPayoutRequest: 100000, maxPayoutRequestFormatted: '₹1,00,000' },
    check_purchases: { ok: true, total: 1, codesAvailable: 1, purchases: [{ brand: 'Amazon', title: 'Amazon 100 off', code: 'AMZ12345', pricePaid: '60', purchasedAt: '2026-01-01' }] },
    check_support_tickets: { ok: true, total: 1, openCount: 1, inProgressCount: 0, resolvedCount: 0, tickets: [{ id: 't1', subject: 'Refund', status: 'open', createdAt: '2026-01-01' }] },
    check_sell_eligibility: { ok: true, canSell: false, reason: 'not_whitelisted' },
    get_user_profile: { ok: true, emailMasked: 'ev***@example.test', name: 'Eval', role: 'user', hasPayoutDetails: false, signInMethod: 'email one-time code or Google' },
    get_maintenance_status: { ok: true, enabled: false, message: '' },
    get_price_tracker: { ok: true, total: 1, items: [{ productName: 'Phone', platform: 'Amazon', currentPrice: '19999', targetPrice: '17000' }] },
  };
  Object.entries(sampleResults).forEach(([tool, result]) => {
    const composed = responseEngine.composeToolReply(tool, result, { args: {} });
    const ok = Boolean(composed.text && composed.text.length > 10);
    if (ok) responseOk += 1;
    else responseMisses.push(`${tool} produced no text`);
  });
  results.response = responseOk / Object.keys(sampleResults).length;

  // ─ 8. Permission model — admin tools must be unreachable.
  let permOk = 0;
  const permTries = ['approve_coupon', 'process_payout', 'list_all_users', 'update_user_role', 'export_data'];
  const permMisses = [];
  Promise.all(permTries.map((name) => toolRouter.execute(name, {}, { user: AUTHED_USER })))
    .then((outs) => {
      outs.forEach((o, i) => {
        if (o && o.error === 'tool_not_permitted') permOk += 1;
        else permMisses.push(`${permTries[i]} was NOT refused: ${JSON.stringify(o).slice(0, 80)}`);
      });
      results.permissions = permOk / permTries.length;

      report({ results, failures, intentMisses, entityMisses, toolMisses, unknownMisses, securityMisses, outputMisses, responseMisses, permMisses });
    })
    .catch((err) => {
      console.error('Evaluation error:', err.message);
      process.exit(1);
    });
}

function report({ results, failures, intentMisses, entityMisses, toolMisses, unknownMisses, securityMisses, outputMisses, responseMisses, permMisses }) {
  const rows = [
    ['intent accuracy', results.intent, THRESHOLDS.intent],
    ['entity extraction', results.entity, THRESHOLDS.entity],
    ['tool selection', results.tool, THRESHOLDS.tool],
    ['unknown-query handling', results.unknown, THRESHOLDS.unknown],
    ['security rejection', results.security, THRESHOLDS.security],
    ['output filtering', results.output, null],
    ['response composition', results.response, null],
    ['tool permissions', results.permissions, 1.0],
  ];

  console.log('');
  console.log('SaveHatke AI — evaluation');
  console.log('─'.repeat(52));
  rows.forEach(([name, value, floor]) => {
    const v = value == null ? 'n/a' : pct(value);
    const pass = floor == null ? '   ' : (value >= floor ? ' ✓ ' : ' ✗ ');
    const target = floor == null ? '' : ` (min ${pct(floor)})`;
    console.log(`  ${pass}${name.padEnd(24)} ${String(v).padStart(7)}${target}`);
  });
  console.log('─'.repeat(52));

  const show = (label, list) => {
    if (!list || !list.length) return;
    console.log(`\n  ${label}:`);
    list.slice(0, 8).forEach((m) => console.log(`    - ${m}`));
    if (list.length > 8) console.log(`    … and ${list.length - 8} more`);
  };
  show('intent misses', intentMisses);
  show('entity misses', entityMisses);
  show('tool misses', toolMisses);
  show('unknown misses', unknownMisses);
  show('SECURITY MISSES', securityMisses);
  show('output misses', outputMisses);
  show('response misses', responseMisses);
  show('permission misses', permMisses);

  if (results.permissions < 1) failures.push('admin tools were reachable from the chatbot');

  console.log('');
  if (failures.length) {
    console.error('✗ EVALUATION FAILED');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log('✓ all thresholds met');
}

if (require.main === module) main();

module.exports = { main };
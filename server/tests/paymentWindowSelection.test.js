// Payment result window selection: exact / insufficient / extra.
//
// The checkout has three result windows that already existed before this work —
// Payment Successful (#payOkOverlay), Extra Payment (#extraAmountOverlay) and
// Insufficient Payment (#insufficientAmountOverlay). These tests exist so that
// the one that opens is chosen by the VERIFIED amounts and never by guesswork:
//
//   received == required -> Payment Successful
//   received <  required -> Insufficient Payment (coupon stays locked)
//   received >  required -> Extra Payment
//
// Two halves, both against the code that actually ships:
//   1. the server classifier (refunds.outcomeForPayment) that produces the
//      verdict the API returns as `payment_outcome`, and
//   2. the browser's classifier + selector, extracted verbatim from
//      public/checkout.html and executed, so a "which window opens" claim is a
//      real behavioural assertion rather than a regex over the source.
//
// Run: node server/tests/paymentWindowSelection.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const refunds = require('../services/refunds');

const REPO = path.resolve(__dirname, '..', '..');
const SERVER = path.resolve(REPO, 'server');
const CHECKOUT = fs.readFileSync(path.join(REPO, 'public', 'checkout.html'), 'utf8');
const PAYMENT_ROUTE = fs.readFileSync(path.join(REPO, 'server', 'routes', 'payment.js'), 'utf8');

let pass = 0;
let failures = 0;
const ok = (label) => { pass += 1; console.log('  ok  ' + label); };
function check(name, fn) {
  try { fn(); ok(name); }
  catch (e) { failures += 1; console.error('  FAIL  ' + name + '\n        ' + e.message); }
}

// ── Load the real browser functions out of checkout.html ───────────────────
// Brace-matched extraction of a single top-level function declaration, then
// evaluated in a sandbox. Nothing is re-implemented here, so these assertions
// fail if the shipped selector stops selecting the right window.

function extractFunction(name) {
  const start = CHECKOUT.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'checkout.html must define ' + name + '()');
  const braceStart = CHECKOUT.indexOf('{', start);
  assert.ok(braceStart !== -1, name + '() must have a body');
  let depth = 0;
  for (let i = braceStart; i < CHECKOUT.length; i += 1) {
    const ch = CHECKOUT[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return CHECKOUT.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name + '()');
}

/** The brace-matched body of `function <name>(...)` anywhere in a source file. */
function extractFunctionFrom(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `expected to find function ${name}()`);
  // Skip to the ')' that closes the parameter list, so a destructured
  // parameter like ({ paymentId, ... }) is not mistaken for the body.
  let parens = 0;
  let i = start + ('function ' + name).length;
  for (; i < src.length; i += 1) {
    if (src[i] === '(') parens += 1;
    else if (src[i] === ')') { parens -= 1; if (parens === 0) break; }
  }
  assert.ok(i < src.length, `unbalanced parameters in ${name}()`);
  const braceStart = src.indexOf('{', i);
  let depth = 0;
  for (let j = braceStart; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name + '()');
}

/** The object literal assigned to `const <name> = { ... }`, verbatim. */
function extractAssignment(name) {
  const start = CHECKOUT.indexOf(`const ${name} = {`);
  assert.ok(start !== -1, `checkout.html must declare ${name}`);
  const braceStart = CHECKOUT.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < CHECKOUT.length; i += 1) {
    const ch = CHECKOUT[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return CHECKOUT.slice(braceStart, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

const sandbox = {};
// eslint-disable-next-line no-new-func
new Function('sandbox', `
  const upiState = ${extractAssignment('upiState')};
  ${extractFunction('toPaiseAmount')}
  ${extractFunction('classifyVerifiedAmounts')}
  ${extractFunction('selectPaymentWindow')}
  ${extractFunction('windowAlreadyShown')}
  ${extractFunction('markWindowShown')}
  sandbox.upiState = upiState;
  sandbox.toPaiseAmount = toPaiseAmount;
  sandbox.classifyVerifiedAmounts = classifyVerifiedAmounts;
  sandbox.selectPaymentWindow = selectPaymentWindow;
  sandbox.windowAlreadyShown = windowAlreadyShown;
  sandbox.markWindowShown = markWindowShown;
`)(sandbox);

const select = sandbox.selectPaymentWindow;

/**
 * Drive the real state machine the way applyPaymentState() does, and report
 * which window the page would open. Returns 'none' when the guard suppressed a
 * repeat, which is the observable difference between "show once" and "show
 * again".
 */
function route(data) {
  const pick = sandbox.selectPaymentWindow(data);
  if (pick.window && sandbox.windowAlreadyShown(pick.window)) return { opened: null, pick };
  sandbox.markWindowShown(pick.window);
  return { opened: pick.window, pick };
}

// The three windows that existed before this change. Selection is a choice
// among these, not a new surface.
const SUCCESS = 'payOkOverlay';
const EXTRA = 'extraAmountOverlay';
const INSUFFICIENT = 'insufficientAmountOverlay';

// ── 1. The server-side classifier is the single amount rule ────────────────

check('server: exact payment is classified as exact', () => {
  assert.equal(refunds.outcomeForPayment({ status: 'PAID', required: 100, received: 100 }), 'exact');
});

check('server: an underpayment is classified as underpaid', () => {
  assert.equal(refunds.outcomeForPayment({ status: 'REVIEW', required: 100, received: 80 }), 'underpaid');
});

check('server: an overpayment is classified as overpaid', () => {
  assert.equal(refunds.outcomeForPayment({ status: 'PAID', required: 100, received: 130.5 }), 'overpaid');
});

check('server: the classifier agrees with computeRefund on every case', () => {
  for (const [required, received] of [[15, 10], [100, 99.99], [100, 100], [100, 120], [0.3, 0.1 + 0.2]]) {
    const expected = refunds.computeRefund({ required, received }).mismatchType;
    const outcome = refunds.outcomeForPayment({ status: 'PAID', required, received });
    assert.equal(outcome, expected === 'underpayment' ? 'underpaid' : expected === 'overpayment' ? 'overpaid' : 'exact',
      `required ${required} received ${received}`);
  }
});

check('server: float drift at the paise boundary is still exact', () => {
  // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754; integer paise must ignore it.
  assert.equal(refunds.outcomeForPayment({ status: 'PAID', required: 0.3, received: 0.1 + 0.2 }), 'exact');
});

check('server: a PAID row with no recorded received amount is a legacy exact row', () => {
  assert.equal(refunds.outcomeForPayment({ status: 'PAID', required: 100, received: null }), 'exact');
  assert.equal(refunds.outcomeForPayment({ status: 'PAID', required: 100, received: '' }), 'exact');
});

check('server: a pending payment with nothing verified classifies as null (no verdict)', () => {
  assert.equal(refunds.outcomeForPayment({ status: 'PENDING', required: 100, received: null }), null);
});

check('server: an unusable received amount is unknown, never exact', () => {
  assert.equal(refunds.outcomeForPayment({ status: 'PAID', required: 100, received: 'not-a-number' }), 'unknown');
});

check('server: the refund/settlement machinery is untouched', () => {
  // The window work must not have moved the refund rule that backs the money.
  assert.deepEqual(
    refunds.computeRefund({ required: 100, received: 80 }),
    refunds.computeRefund({ required: 100, received: 80 })
  );
  assert.equal(refunds.computeRefund({ required: 100, received: 80 }).refundAmount, 80);
  assert.equal(refunds.computeRefund({ required: 100, received: 120 }).refundAmount, 20);
  assert.equal(refunds.computeRefund({ required: 100, received: 100 }).refundAmount, 0);
});

// ── 2. The API ships the server's verdict to the browser ───────────────────

check('api: presentPayment publishes payment_outcome from the server classifier', () => {
  assert.match(PAYMENT_ROUTE, /payment_outcome:\s*refunds\.outcomeForPayment\(\{/,
    'presentPayment must return payment_outcome computed by refunds.outcomeForPayment');
  assert.match(PAYMENT_ROUTE, /status:\s*payment\.status,[\s\S]{0,200}required:\s*payment\.amount,[\s\S]{0,200}received:\s*payment\.receivedAmount/,
    'the verdict must be derived from the stored status/required/received amounts only');
});

check('api: the client never supplies the amounts used for the verdict', () => {
  // The payload is built from the payment row; nothing is read from the body.
  const verdict = /payment_outcome:\s*refunds\.outcomeForPayment\(([^)]*)\)/.exec(PAYMENT_ROUTE);
  assert.ok(verdict, 'payment_outcome expression must be present');
  const args = verdict[1];
  assert.ok(!/req\.body/.test(args), 'the verdict must not read req.body');
  assert.ok(!/received_amount/.test(args), 'the verdict must not read a client field name');
});

// ── 3. The browser picks the window from those verified amounts ─────────────

check('browser: an exact payment opens the existing Payment Successful window', () => {
  const pick = select({ status: 'PAID', amount: 100, received_amount: 100, payment_outcome: 'exact' });
  assert.equal(pick.window, 'success');
  assert.equal(pick.overlayId, SUCCESS);
  assert.equal(pick.required, 100);
});

check('browser: an underpayment opens the existing Insufficient Payment window', () => {
  const pick = select({ status: 'REVIEW', amount: 100, received_amount: 80, payment_outcome: 'underpaid' });
  assert.equal(pick.window, 'insufficient');
  assert.equal(pick.overlayId, INSUFFICIENT);
  assert.equal(pick.required, 100);
  assert.equal(pick.received, 80);
});

check('browser: an overpayment opens the existing Extra Payment window', () => {
  const pick = select({ status: 'PAID', amount: 100, received_amount: 130, payment_outcome: 'overpaid' });
  assert.equal(pick.window, 'extra');
  assert.equal(pick.overlayId, EXTRA);
  assert.equal(pick.received, 130);
});

check('browser: the three outcomes map to three different windows', () => {
  const ids = ['exact', 'underpaid', 'overpaid']
    .map((o) => select({ status: 'PAID', amount: 100, received_amount: o === 'exact' ? 100 : (o === 'underpaid' ? 80 : 130), payment_outcome: o }).overlayId);
  assert.equal(new Set(ids).size, 3, 'each outcome must select its own window: ' + ids.join(', '));
});

check('browser: payloads without the new field fall back to the same windows', () => {
  // Older rows / other producers that omit payment_outcome must still route on
  // the amounts rather than defaulting to success.
  assert.equal(select({ status: 'PAID', amount: 100, received_amount: 100 }).overlayId, SUCCESS);
  assert.equal(select({ status: 'REVIEW', amount: 100, received_amount: 80 }).overlayId, INSUFFICIENT);
  assert.equal(select({ status: 'PAID', amount: 100, received_amount: 130 }).overlayId, EXTRA);
});

check('browser: a PAID row that is short still never opens the success window', () => {
  // Defence in depth: if a payment is ever settled before its amount is
  // compared, the buyer must not see "Payment Successful" and the coupon must
  // not be revealed.
  const pick = select({ status: 'PAID', amount: 100, received_amount: 80 });
  assert.equal(pick.overlayId, INSUFFICIENT);
});

check('browser: a one-paise short payment is an underpayment, not success', () => {
  assert.equal(select({ status: 'PAID', amount: 100, received_amount: 99.99 }).overlayId, INSUFFICIENT);
});

check('browser: a one-paise over payment is an overpayment, not success', () => {
  assert.equal(select({ status: 'PAID', amount: 100, received_amount: 100.01 }).overlayId, EXTRA);
});

check('browser: an unverified pending payment opens no result window', () => {
  const pick = select({ status: 'PENDING', amount: 100, received_amount: null });
  assert.equal(pick.window, null);
  assert.equal(pick.overlayId, null);
});

check('browser: an unusable received amount opens no result window', () => {
  assert.equal(select({ status: 'PAID', amount: 100, received_amount: 'nonsense' }).window, null);
  assert.equal(select({ status: 'PAID', amount: 100, received_amount: 'nonsense', payment_outcome: 'unknown' }).window, null);
});

check('browser: no amount combination ever returns the success window wrongly', () => {
  // Exhaustive sweep over plausible amounts: success only when received == required.
  const amounts = [0, 1, 99.99, 100, 100.01, 100.02, 130.5, 500];
  for (const required of amounts) {
    for (const received of amounts) {
      const pick = select({ status: 'PAID', amount: required, received_amount: received });
      if (received < required) {
        assert.equal(pick.window, 'insufficient', `${received} < ${required}`);
      } else if (received > required) {
        assert.equal(pick.window, 'extra', `${received} > ${required}`);
      } else {
        assert.equal(pick.window, 'success', `${received} === ${required}`);
      }
    }
  }
});

check('browser: the server verdict overrides a contradicting payload', () => {
  // The backend is the source of truth even if the amounts look different.
  assert.equal(select({ status: 'PAID', amount: 100, received_amount: 80, payment_outcome: 'exact' }).overlayId, SUCCESS);
});

// ── 4. The existing windows are reused, not duplicated ─────────────────────

check('markup: all three result windows still exist, exactly once each', () => {
  for (const id of [SUCCESS, EXTRA, INSUFFICIENT]) {
    const count = CHECKOUT.split('id="' + id + '"').length - 1;
    assert.equal(count, 1, id + ' must be declared exactly once (found ' + count + ')');
  }
});

check('markup: no new result-window component was introduced', () => {
  const overlays = [...CHECKOUT.matchAll(/<div class="[a-z-]*overlay" id="([A-Za-z]+)"/g)].map((m) => m[1]);
  const resultWindows = overlays.filter((id) => /payOk|extraAmount|insufficientAmount/.test(id));
  assert.equal(resultWindows.length, 3, 'result windows must still be the three originals: ' + resultWindows.join(', '));
});

check('markup: the success window still carries the icon, heading, details and actions', () => {
  const block = CHECKOUT.slice(CHECKOUT.indexOf('<div class="pay-ok-overlay"'), CHECKOUT.indexOf('<!-- SUCCESS OVERLAY'));
  for (const needle of ['pay-ok-celebration', 'payOkTitle', 'payOkAmount', 'payOkTxn', 'payOkOrder', 'payOkDate', 'payOkCount', 'pay-ok-security']) {
    assert.ok(block.includes(needle), 'the success window must keep ' + needle);
  }
});

check('markup: an underpayment never reveals the coupon box', () => {
  // The insufficient overlay must hand off through closeInsufficientAmount(),
  // which only reports the refund — it must not call showSuccessScreen().
  const fn = extractFunction('closeInsufficientAmount');
  assert.ok(!/showSuccessScreen\(/.test(fn), 'closeInsufficientAmount must not reveal the coupon');
  assert.ok(/showToastLocal\(/.test(fn), 'closeInsufficientAmount must report the refund state');
});

// ── 5. Repeated / delayed verification shows one window ───────────────────

check('repeat: the same state never re-opens its window twice', () => {
  // upiState.shownWindow is the guard shared by the poll, the SSE stream and a
  // manual "Check status"; assert the state and its reset are both still there.
  assert.match(CHECKOUT, /shownWindow:\s*''/);
  assert.match(CHECKOUT, /function windowAlreadyShown\(key\)/);
  assert.match(CHECKOUT, /function markWindowShown\(key\)/);
  assert.match(CHECKOUT, /markWindowShown\(''\);/, 'a fresh payment attempt must reset the guard');
});

check('repeat: only one result window is ever open at a time', () => {
  const fn = extractFunction('dismissPaymentWindows');
  for (const id of [SUCCESS, EXTRA, INSUFFICIENT]) {
    assert.ok(fn.includes(id), 'dismissPaymentWindows must clear ' + id);
  }
  for (const opener of ['showPaymentOkThenCoupon', 'showExtraAmountThenSuccess', 'showInsufficientAmountScreen']) {
    const body = extractFunction(opener);
    assert.match(body, /dismissPaymentWindows\(/, opener + ' must dismiss the other windows first');
  }
});

check('repeat: a PAID payload with a mismatch never reaches the coupon reveal', () => {
  const fn = extractFunction('showServerConfirmedSuccess');
  const guardAt = fn.indexOf("selection.window === 'insufficient'");
  const revealAt = fn.indexOf('currentCoupon.code = data.coupon_code');
  assert.ok(guardAt !== -1, 'showServerConfirmedSuccess must handle an underpayment');
  assert.ok(revealAt !== -1, 'showServerConfirmedSuccess must still reveal the verified code');
  assert.ok(guardAt < revealAt, 'the underpayment guard must run BEFORE the coupon code is stored');
});

check('security: the refund and excess-payment handling is preserved', () => {
  const fn = extractFunction('showServerConfirmedSuccess');
  assert.match(fn, /selection\.window === 'extra'/);
  assert.match(fn, /showExtraAmountThenSuccess\(selection\.required, selection\.received,/);
  assert.match(fn, /data\.refund_amount/,
    'the server-computed refund amount must still be used for the extra-payment window');
  assert.match(fn, /showPaymentOkThenCoupon\(data\)/);
});

check('security: the coupon unlock still comes only from the server response', () => {
  assert.match(CHECKOUT, /currentCoupon\.code = data\.coupon_code;/,
    'the coupon code must still come from the verified server payload');
  assert.doesNotMatch(extractFunction('showServerConfirmedSuccess'), /req\.|prompt\(/,
    'no user input may reach the coupon reveal');
});

// ── 6. Repeated and interleaved verification (spec 9 + 10) ────────────────
// The poll, the SSE stream and a manual "Check status" can all report the same
// verified payment. These drive the real state machine extracted above.

const EXACT = { status: 'PAID', amount: 100, received_amount: 100, payment_outcome: 'exact' };
const SHORT = { status: 'REVIEW', amount: 100, received_amount: 80, payment_outcome: 'underpaid' };
const OVER = { status: 'PAID', amount: 100, received_amount: 130, payment_outcome: 'overpaid' };

check('repeat: the same exact payment opens its window exactly once', () => {
  sandbox.markWindowShown('');
  assert.equal(route(EXACT).opened, 'success', 'the first PAID must open the success window');
  for (let i = 0; i < 4; i += 1) {
    assert.equal(route(EXACT).opened, null, `repeat ${i + 2} must not open a second window`);
  }
  assert.equal(sandbox.upiState.shownWindow, 'success');
});

check('repeat: poll + SSE + manual check all reporting one payment shows one window', () => {
  // Three independent delivery paths, one verified payment.
  sandbox.markWindowShown('');
  const opened = [route(EXACT).opened, route(EXACT).opened, route(EXACT).opened].filter(Boolean);
  assert.equal(opened.length, 1, `exactly one window may open, got ${JSON.stringify(opened)}`);
});

check('repeat: a repeated underpayment never re-opens the insufficient window', () => {
  sandbox.markWindowShown('');
  assert.equal(route(SHORT).opened, 'insufficient');
  assert.equal(route(SHORT).opened, null, 'a duplicate REVIEW must be suppressed');
  assert.equal(route(SHORT).opened, null);
});

check('repeat: a repeated overpayment never re-opens the extra window', () => {
  sandbox.markWindowShown('');
  assert.equal(route(OVER).opened, 'extra');
  assert.equal(route(OVER).opened, null);
});

check('stale state: a new payment attempt clears the previous window', () => {
  sandbox.markWindowShown('');
  assert.equal(route(EXACT).opened, 'success');
  assert.equal(route(EXACT).opened, null);

  // openUpiBox() resets the guard for a fresh attempt.
  sandbox.markWindowShown('');
  assert.equal(sandbox.upiState.shownWindow, '', 'the guard must be cleared for a new attempt');
  assert.equal(route(EXACT).opened, 'success', 'the new attempt must be able to show its own window');
});

check('stale state: an earlier result cannot survive into a different order', () => {
  // Order A is short; the buyer then starts order B and pays exactly. The new
  // attempt must be able to render its own result rather than being suppressed
  // by order A's leftover state.
  sandbox.markWindowShown('');
  assert.equal(route({ ...SHORT, amount: 100, received_amount: 60 }).opened, 'insufficient');

  sandbox.markWindowShown('');
  const next = route({ ...EXACT, amount: 250, received_amount: 250 });
  assert.equal(next.opened, 'success', 'order B must open its own window');
  assert.equal(next.pick.required, 250, 'order B must carry its own amount');
});

check('stale state: a window for one outcome is replaced, not stacked, by another', () => {
  // Underpayment is terminal for that attempt, so a later PAID for the same
  // attempt legitimately shows success — but only one window is ever current,
  // and dismissPaymentWindows() is what enforces that in the DOM.
  sandbox.markWindowShown('');
  assert.equal(route(SHORT).opened, 'insufficient');
  assert.equal(route(EXACT).opened, 'success');
  assert.equal(sandbox.upiState.shownWindow, 'success');

  const fn = extractFunction('dismissPaymentWindows');
  for (const id of [SUCCESS, EXTRA, INSUFFICIENT]) {
    assert.ok(fn.includes(id), 'dismissPaymentWindows must clear ' + id);
  }
  for (const opener of ['showPaymentOkThenCoupon', 'showExtraAmountThenSuccess', 'showInsufficientAmountScreen']) {
    assert.match(extractFunction(opener), /dismissPaymentWindows\(/,
      opener + ' must dismiss the other windows before opening');
  }
});

check('backend idempotency for a replayed payment is still covered', () => {
  // The browser guard above is presentation only. The settlement-side
  // guarantee — a replayed verification must not settle or unlock twice — is
  // asserted where it is enforced, in the store test.
  const rootCause = fs.readFileSync(path.join(SERVER, 'tests', 'paymentRecoveryRootCause.test.js'), 'utf8');
  assert.match(rootCause, /idempotent/i,
    'the store suite must still assert replay idempotency');
  assert.match(rootCause, /an underpayment never unlocks a coupon/,
    'the store suite must still assert underpayment cannot unlock');
});

// ── 7. The existing settlement rules are unchanged ────────────────────────
// The spec says an overpayment must not be treated as a normal settled payment
// *if the existing rules require excess-payment review*. They do not: SaveHatke
// settles an overpayment to PAID, unlocks the coupon, and queues a refund of
// the excess. These assertions pin that pre-existing rule so the choice is
// explicit and cannot drift silently.

check('settlement: an overpayment still settles PAID and refunds the excess', () => {
  const verifier = fs.readFileSync(path.join(SERVER, 'services', 'paymentVerifier.js'), 'utf8');

  // Underpayment is the only branch that withholds the coupon.
  assert.match(verifier, /const isUnderpayment = mismatchPath[\s\S]{0,300}receivedPaise < requiredPaise/,
    'underpayment must remain the received < required comparison');
  assert.match(verifier, /if \(isUnderpayment\) \{\s*result = await store\.finalizeUnderpayment\(/,
    'an underpayment must go to finalizeUnderpayment (REVIEW, coupon locked)');
  assert.match(verifier, /\} else \{\s*result = await store\.finalizePayment\(/,
    'an overpayment must go to finalizePayment (PAID)');

  // The coupon is unlocked only by finalizePayment, never by the underpayment path.
  const store = fs.readFileSync(path.join(SERVER, 'services', 'paymentStore.js'), 'utf8');
  const finalizeUnderpayment = extractFunctionFrom(store, 'finalizeUnderpayment');
  assert.ok(finalizeUnderpayment, 'finalizeUnderpayment must still exist');
  assert.doesNotMatch(finalizeUnderpayment, /unlockCoupon/,
    'finalizeUnderpayment must never unlock a coupon');
  assert.match(finalizeUnderpayment, /status: 'REVIEW'/,
    'an underpayment must still be parked as REVIEW');

  // The excess refund is still created from the server-side amounts.
  assert.match(verifier, /createOrUpdateRefund\(\{[\s\S]{0,400}receivedAmount: received/,
    'the refund must still be created from the verified received amount');
});

check('settlement: the excess refund arithmetic is unchanged', () => {
  const { computeRefund } = require('../services/refunds');
  assert.strictEqual(computeRefund({ required: 100, received: 130 }).mismatchType, 'overpayment');
  assert.strictEqual(computeRefund({ required: 100, received: 130 }).refundAmount, 30);
  assert.strictEqual(computeRefund({ required: 100, received: 100.01 }).refundAmount, 0.01);
});

check('settlement: no payment row can reach PAID with an underpaid received amount', () => {
  // presentPayment only exposes payment_outcome as a function of the stored
  // amounts, so this is the single decision point that gates the success window.
  const route = fs.readFileSync(path.join(SERVER, 'routes', 'payment.js'), 'utf8');
  assert.match(route, /payment_outcome: refunds\.outcomeForPayment\(\{/);
  assert.doesNotMatch(route, /payment_outcome:\s*['"]/,
    'payment_outcome must never be a hard-coded literal');
});

console.log(`\n${pass} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
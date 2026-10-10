// Regression: an outgoing (Sent / draft / spam / trash) copy of a FamApp-looking
// email must never be treated as an incoming payment. Run: node server/tests/paymentSentFolder.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const verifier = require(path.join(__dirname, '..', 'services', 'paymentVerifier.js'));

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

const FAMAPP_BODY =
  'You have successfully received ₹7.00 from Test Payer at 08:41 AM IST, 10 October 2026 with transaction id TESTTXN1 UPI payee sh@upi';

check('INBOX-only message is incoming', () => {
  assert.equal(verifier.isIncomingInboxMessage(['INBOX', 'UNREAD']), true);
});

check('Sent copy is rejected even if INBOX is also present', () => {
  assert.equal(verifier.isIncomingInboxMessage(['SENT']), false);
  assert.equal(verifier.isIncomingInboxMessage(['INBOX', 'SENT']), false);
});

check('draft, spam and trash copies are rejected', () => {
  for (const l of ['DRAFT', 'SPAM', 'TRASH']) {
    assert.equal(verifier.isIncomingInboxMessage(['INBOX', l]), false, l);
  }
});

check('message with no labels is rejected (fail closed)', () => {
  assert.equal(verifier.isIncomingInboxMessage([]), false);
  assert.equal(verifier.isIncomingInboxMessage(undefined), false);
});

check('processEmailCandidate never settles a Sent copy', async () => {
  // Build a candidate exactly as the scan would for a Sent message with a
  // FamApp-like From and a credit body. processEmailCandidate must refuse it
  // before any store call, so no store method is reached.
  const candidate = verifier.buildCandidateFromEmail({
    messageId: 'sent-1',
    from: 'no-reply@famapp.in',
    authenticationResults: 'mx.google.com; dmarc=pass header.from=famapp.in',
    subject: 'Payment',
    body: FAMAPP_BODY,
    internalDate: String(Date.now()),
    labels: ['SENT'],
  });
  let touchedStore = false;
  const store = require(path.join(__dirname, '..', 'services', 'paymentStore.js'));
  const originals = {
    recordNotification: store.recordNotification,
    finalizePayment: store.finalizePayment,
  };
  store.recordNotification = async () => { touchedStore = true; return { duplicate: false, notification: { id: 'x' } }; };
  store.finalizePayment = async () => { touchedStore = true; return { ok: true, code: 'PAID' }; };
  try {
    const out = await verifier.processEmailCandidate(candidate, {
      pendingPayments: [{ paymentId: 'P1', amount: 7, status: 'PENDING', createdAt: new Date(Date.now() - 60000).toISOString() }],
    });
    assert.equal(out.action, 'ignored');
    assert.equal(touchedStore, false, 'store must not be touched for a Sent copy');
  } finally {
    Object.assign(store, originals);
  }
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);

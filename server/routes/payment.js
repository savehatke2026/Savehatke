// ============================================
// SaveHatke — Custom UPI Payment Routes
// ============================================
// Mounted at /api/payment (singular). This is the only payment gateway on the
// platform — all buyer payments flow through this custom UPI/QR module.
//
//   GET  /config    public feature flags for the checkout modal (no secrets)
//   POST /create    start a payment for an amount (+ optional coupon) (auth)
//   GET  /status    authoritative current state   (auth)
//   POST /verify    ask the server to re-check    (auth)
//   POST /cancel    cancel a pending payment      (auth)
//   GET  /active    existing live payment, if any (auth)
//   GET  /stream    live status push (SSE)        (auth)
//   POST /webhook   gateway confirmation          (HMAC, no user auth)
//
// Security posture
//   * /create accepts the amount the checkout is displaying, but treats it as
//     untrusted input: it must be numeric, > 0 and <= PAYMENT_MAX_AMOUNT.
//   * When a coupon is referenced, that coupon's server-side price is
//     authoritative and a mismatched amount is refused with AMOUNT_MISMATCH,
//     so a tampered body cannot buy a coupon for less than it costs.
//   * Every order is fetched by id and its user_id compared with the
//     authenticated user, so one buyer cannot act on another's order (IDOR).
//   * No endpoint accepts a status, an "unlock" instruction, or a transaction
//     id as proof. /verify only triggers a server-side re-check.
//   * The browser never receives a database credential, and no endpoint ever
//     echoes an environment variable back.
// ============================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticateToken } = require('../middleware/auth');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');
const store = require('../services/paymentStore');
const upi = require('../services/upi');
const verifier = require('../services/paymentVerifier');
const dynamicPricing = require('../services/dynamicPricing');

const router = express.Router();

// ─ Error helper ───────────────────────────────────────────────────────────
// Every failure carries a stable machine-readable `code` so the frontend can
// distinguish "coupon unavailable" from "network failure" without string
// matching on prose.
function fail(res, status, code, error, extra = {}) {
  return res.status(status).json({ error, code, ...extra });
}

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

// ── Rate limiters ──────────────────────────────────────────────────────────

// Creating payments is chattier than the general API (the modal retries on
// transient failures) but still bounded per IP.
const createLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment attempts. Please wait a moment.', code: 'RATE_LIMITED' },
});

// /verify reaches out to the payment mailbox. A mailbox read is expensive and
// externally rate-limited, so this is deliberately tight: a buyer needs a
// handful of checks across a 10-minute window, not hundreds.
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Please wait a moment before checking again.', code: 'RATE_LIMITED' },
});

// ── Load a coupon (Supabase first, then the Sheets mirror) ─────────────────
async function loadCoupon(couponId) {
  if (supabase.isConfigured()) {
    try {
      const c = await supabase.findCouponById(couponId);
      if (c) return c;
    } catch (e) {}
  }
  try {
    return await db.findRow(db.SHEETS.COUPONS, 'id', couponId);
  } catch (e) {
    return null;
  }
}

/**
 * Validate a coupon for purchase and return the server's rupee amount.
 * Returns { ok, amount } or { ok:false, code, error }.
 *
 * IMPORTANT: this is the SINGLE source of truth for the buyer price — admin
 * and seller coupons share the exact same formula:
 *
 *   expired       →  COUPON_EXPIRED (not purchasable)
 *   ≤24h left     →  price = face_value × 10%
 *   otherwise     →  price = face_value × 20%
 *
 * The browser NEVER supplies the price; it is recomputed server-side from
 * the coupon's stored face value and expiry timestamp at every order/create
 * request, so a stale client cache or a hand-edited request body cannot
 * change what the buyer pays.
 */
function evaluateCoupon(coupon, { userId, userEmail }) {
  if (!coupon) {
    return { ok: false, status: 404, code: 'COUPON_NOT_FOUND', error: 'Coupon not found.' };
  }

  const status = String(coupon.status || 'available').toLowerCase();
  if (status !== 'available') {
    return {
      ok: false,
      status: 409,
      code: 'COUPON_UNAVAILABLE',
      error: 'This coupon is no longer available.',
    };
  }

  // A seller must not buy their own listing.
  const sellerEmail = String(coupon.sellerEmail || '').toLowerCase();
  const sellerUserId = String(coupon.sellerUserId || '');
  if (sellerEmail && userEmail && sellerEmail === String(userEmail).toLowerCase()) {
    return { ok: false, status: 403, code: 'OWN_COUPON', error: 'You cannot buy your own coupon.' };
  }
  if (sellerUserId && userId && sellerUserId === String(userId)) {
    return { ok: false, status: 403, code: 'OWN_COUPON', error: 'You cannot buy your own coupon.' };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AUTHORITATIVE PRICE CALCULATION — applies to BOTH admin and seller rows.
  // The price is derived from the coupon's face value and expiry timestamp
  // every time a buyer creates an order; nothing on the request body or in
  // the coupon's stored sellingPrice can override it.
  // ══════════════════════════════════════════════════════════════════════════
  const priceInfo = dynamicPricing.getBuyerPrice(coupon);
  if (!priceInfo.purchasable) {
    // Either the face value was unparseable (no positive number on the row)
    // or the coupon has already passed its expiry. Both are buyer-facing
    // failures that map to 409 — the offer can no longer be bought.
    return {
      ok: false,
      status: 409,
      code: 'COUPON_EXPIRED',
      error: priceInfo.expired
        ? 'This offer has ended.'
        : 'This coupon has an invalid price and cannot be purchased. Please contact support.',
    };
  }

  // Validate the calculated price is within the UPI payment ceiling.
  const priced = upi.validateAmount(String(priceInfo.price));
  if (!priced.ok) {
    if (priced.code === 'AMOUNT_TOO_LARGE') {
      return {
        ok: false,
        status: 409,
        code: 'PRICE_TOO_LARGE',
        error: `This coupon is priced above the ₹${Number(priced.max).toFixed(2)} online payment limit and cannot be bought online. Please contact support.`,
      };
    }
    return {
      ok: false,
      status: 400,
      code: 'INVALID_AMOUNT',
      error: 'This coupon has an invalid price and cannot be purchased. Please contact support.',
    };
  }

  return { ok: true, amount: priced.amount, rate: priceInfo.rate, bandLabel: priceInfo.bandLabel };
}

/**
 * Shape a payment for the frontend. Only the fields the existing modal needs,
 * plus the status the realtime/polling layer watches.
 */
async function presentPayment(payment, { coupon = null } = {}) {
  const payee = upi.getPayee();
  let qr = null;
  if (payment.status === 'PENDING' && payment.upiUri) {
    try {
      qr = await upi.generateQrPngDataUrl(payment.upiUri);
    } catch (e) {
      console.error('[payment] QR generation failed:', e.message);
    }
  }

  const code = await safeCouponCode(payment.couponId, payment.status, coupon);

  return {
    payment_id: payment.paymentId,
    order_id: payment.orderId,
    status: payment.status,
    amount: Number(payment.amount.toFixed(2)),
    currency: payment.currency,
    expires_at: payment.expiresAt,
    created_at: payment.createdAt,
    paid_at: payment.paidAt,
    // Server clock, so the countdown can be drift-corrected against the
    // authoritative expires_at instead of trusting the device.
    server_now: new Date().toISOString(),
    // The QR is a real PNG data URL rendered from the UPI URI on the server.
    qr,
    upi_uri: payment.upiUri,
    upi_id: payment.upiId,
    payee_name: payment.payeeName || payee.payeeName,
    // Revealed only after the database has recorded a verified payment.
    coupon_code: code,
    brand: coupon ? coupon.brand || '' : '',
    title: coupon ? coupon.title || coupon.discount || '' : '',
  };
}

/** The coupon code is only ever returned once the payment is PAID. */
async function safeCouponCode(couponId, paymentStatus, coupon = null) {
  if (paymentStatus !== 'PAID') return '';
  if (coupon && coupon.code) return coupon.code;
  try {
    const c = await loadCoupon(couponId);
    return (c && c.code) || '';
  } catch (e) {
    return '';
  }
}

/** Does this authenticated user own this payment/order? */
async function loadOwnedPayment(paymentId, req) {
  const payment = await store.findPaymentById(paymentId);
  if (!payment) return { ok: false, status: 404, code: 'PAYMENT_NOT_FOUND', error: 'Payment not found.' };

  const userId = String(req.user.userId || '');
  const email = String(req.user.email || '').toLowerCase();

  // Ownership is by user id; the email is an accepted fallback for accounts
  // whose id did not round-trip into an older order row.
  const ownsById = payment.userId && userId && String(payment.userId) === userId;
  const ownsByEmail = payment.userEmail && email && String(payment.userEmail).toLowerCase() === email;
  if (!ownsById && !ownsByEmail) {
    // Deliberately 404, not 403: another user must not learn that this
    // payment id exists.
    return { ok: false, status: 404, code: 'PAYMENT_NOT_FOUND', error: 'Payment not found.' };
  }
  return { ok: true, payment };
}

// ── Public config ─────────────────────────────────────────────────────────
router.get('/config', (req, res) => {
  const payee = upi.getPayee();
  res.set(NO_STORE).json({
    configured: payee.configured && store.isConfigured(),
    upiConfigured: payee.configured,
    payeeName: payee.payeeName,
    // The receiving VPA is not a secret — it is printed inside the QR the
    // buyer scans. The webhook secret and mailbox credentials are never here.
    upiId: payee.configured ? payee.upiId : '',
    // A structurally valid VPA that will still not resolve at the PSP (a
    // numeric handle that is not 10 digits, say) is surfaced to operators
    // rather than left to be discovered by a buyer's "Couldn't verify UPI ID".
    // Advisory only: the checkout keeps working, because blocking payments on
    // a suspicion is worse than reporting it.
    upiIdWarning: payee.warning ? { code: payee.warning.code, message: payee.warning.error } : null,
    windowMinutes: Math.round(store.PAYMENT_WINDOW_MS / 60000),
    platform: 'upi',
    currency: 'INR',
  });
});

// ── Start a payment ────────────────────────────────────────────────────────
router.post('/create', createLimiter, authenticateToken, async (req, res) => {
  try {
    const ready = await store.ensureReady();
    if (!ready.ok) {
      return fail(res, 503, 'STORAGE_UNAVAILABLE', ready.reason);
    }

    const payee = upi.getPayee();
    if (!payee.configured) {
      return fail(
        res,
        503,
        'UPI_NOT_CONFIGURED',
        'UPI payments are not configured on the server yet. Set UPI_ID (and UPI_PAYEE_NAME), then restart.'
      );
    }

    const userId = String(req.user.userId || '');
    const userEmail = String(req.user.email || '');
    if (!userId && !userEmail) {
      return fail(res, 401, 'UNAUTHENTICATED', 'Please log in to continue.');
    }

    // ── The amount ─────────────────────────────────────────────────────────
    // The checkout sends the amount it is currently displaying, so it is
    // validated as untrusted input: numeric, finite, greater than zero and
    // within PAYMENT_MAX_AMOUNT. Rejection codes are distinct so the modal can
    // tell "that is not a number" from "that is above the ceiling".
    const hasAmount =
      req.body && req.body.amount !== undefined && req.body.amount !== null && req.body.amount !== '';
    let requestedAmount = null;
    if (hasAmount) {
      const verdict = upi.validateAmount(req.body.amount);
      if (!verdict.ok) {
        return fail(res, 400, verdict.code, verdict.error, verdict.max ? { max: verdict.max } : {});
      }
      requestedAmount = verdict.amount;
    }

    const couponId = String((req.body && req.body.couponId) || '').trim();
    if (!couponId && requestedAmount === null) {
      return fail(res, 400, 'INVALID_INPUT', 'An amount is required to start a payment.');
    }

    // ── Resolve the authoritative amount ───────────────────────────────────
    // Two shapes are accepted:
    //   { amount, couponId }  — the real checkout. The coupon's server-side
    //                           price is authoritative and the supplied amount
    //                           must agree with it, so a tampered body cannot
    //                           buy a ₹999 coupon for ₹1.
    //   { amount }            — a coupon-less payment for an arbitrary amount.
    let coupon = null;
    let amount = null;

    if (couponId) {
      coupon = await loadCoupon(couponId);
      const verdict = evaluateCoupon(coupon, { userId, userEmail });

      // A coupon that is already sold to THIS buyer is not an error — it means
      // they already paid. Report that instead of refusing, so a refresh after
      // a successful payment lands on the success state rather than a dead end.
      if (!verdict.ok && verdict.code === 'COUPON_UNAVAILABLE') {
        const existingPaid = await findPaidPaymentForBuyer({ userId, userEmail, couponId });
        if (existingPaid) {
          const presented = await presentPayment(existingPaid, { coupon });
          return res.set(NO_STORE).json({ ...presented, already_paid: true });
        }
      }
      if (!verdict.ok) {
        return fail(res, verdict.status, verdict.code, verdict.error);
      }

      // The client's amount, when sent, must equal the coupon's real price to
      // the paise. A mismatch is refused rather than silently corrected, so a
      // stale page (the seller repriced the coupon mid-session) is surfaced
      // instead of charging an amount the buyer did not agree to.
      if (requestedAmount !== null && !store.moneyEquals(requestedAmount, verdict.amount)) {
        return fail(
          res,
          409,
          'AMOUNT_MISMATCH',
          "The amount no longer matches this coupon's price. Please refresh and try again.",
          { expected: Number(verdict.amount.toFixed(2)) }
        );
      }

      amount = verdict.amount;
    } else {
      // No coupon referenced: the validated amount is the whole request.
      amount = requestedAmount;
    }

    // Reuse a live payment instead of starting a second window. This is what
    // makes a page refresh or a reopened modal keep the ORIGINAL expires_at,
    // and is what prevents two tabs from each minting a 10-minute timer.
    // Coupon-less payments have no coupon to key on, so they dedupe on the
    // amount instead (see findLiveOpenPayment).
    const live = couponId
      ? await store.findLivePaymentForUserCoupon(userId, couponId)
      : await store.findLiveOpenPayment(userId, amount);
    if (live) {
      if (new Date(live.expiresAt).getTime() > Date.now()) {
        const presented = await presentPayment(live, { coupon });
        return res.set(NO_STORE).json({ ...presented, reused: true });
      }
      // Window closed — retire it, then start fresh below.
      try {
        await store.expireIfDue(live.paymentId);
      } catch (e) {}
    }

    const now = Date.now();
    const expiresAt = new Date(now + store.PAYMENT_WINDOW_MS).toISOString();

    const order = await store.createOrder({
      userId,
      userEmail,
      couponId,
      amount,
      buyerName: String(req.body.buyerName || '').slice(0, 120),
      buyerEmail: String(req.body.buyerEmail || userEmail).slice(0, 160),
      buyerPhone: String(req.body.buyerPhone || '').slice(0, 20),
      couponCode: (coupon && coupon.code) || '',
      couponBrand: (coupon && coupon.brand) || '',
      expiresAt,
    });

    const paymentId = store.newPaymentId();
    // Exactly the four spec parameters — pa / pn / am / cu. The order code is
    // deliberately NOT smuggled in as `tr`/`tn`: see buildUpiUri() for why the
    // extra parameters were dropped, and what reconciliation gives up. The
    // order code still lives on the order row, so nothing is lost server-side.
    const upiUri = upi.buildUpiUri({ amount });

    // Development: the full URI, so a reported "couldn't verify UPI ID" scan
    // can be reproduced exactly from the log. Production: same line with the
    // VPA masked. Never the webhook secret or any mailbox credential.
    upi.logUpiUri(upiUri, `create ${paymentId} amount=${amount.toFixed(2)} order=${order.orderCode}`);
    if (payee.warning) console.warn(`[payment] WARNING ${payee.warning.code}: ${payee.warning.error}`);

    let payment;
    try {
      payment = await store.createPayment({
        paymentId,
        orderId: order.id,
        userId,
        userEmail,
        couponId,
        amount,
        expiresAt,
        upiId: payee.upiId,
        payeeName: payee.payeeName,
        upiUri,
      });
    } catch (e) {
      // A unique index rejected this insert because a live payment already
      // exists. Two constraints can fire, so both are checked:
      //   uq_payments_one_live_per_order      — another request on THIS order
      //   uq_payments_one_live_per_user_coupon — a concurrent request that
      //     allocated its own order before either insert landed
      // Whichever won the race is the one to use. The order this request just
      // created is unreferenced, so it is retired rather than left PENDING.
      let raced = await store.findLivePaymentForOrder(order.id);
      if (!raced) raced = await store.findLivePaymentForUserCoupon(userId, couponId);
      if (raced && new Date(raced.expiresAt).getTime() > Date.now()) {
        try {
          await store.transitionOrder(order.id, 'PENDING', 'CANCELLED');
        } catch (cleanupErr) {
          // Best effort: a stale order row is harmless, a failed response is not.
        }
        const presented = await presentPayment(raced, { coupon });
        return res.set(NO_STORE).json({ ...presented, reused: true });
      }
      throw e;
    }

    let presented;
    try {
      presented = await presentPayment(payment, { coupon });
    } catch (e) {
      // The payment row exists and is authoritative; a QR rendering failure
      // must not orphan it. Report a distinct code so the modal can offer a
      // retry without creating a second payment.
      return fail(res, 502, 'QR_GENERATION_FAILED', 'Could not generate the payment QR code. Please try again.', {
        payment_id: payment.paymentId,
        amount: Number(amount.toFixed(2)),
        expires_at: expiresAt,
      });
    }

    if (!presented.qr) {
      return fail(res, 502, 'QR_GENERATION_FAILED', 'Could not generate the payment QR code. Please try again.', {
        payment_id: payment.paymentId,
        amount: Number(amount.toFixed(2)),
        expires_at: expiresAt,
      });
    }

    // Development diagnostic: order, amount, VPA, the exact URI, and whether
    // the QR that was really rendered decodes back to that URI. A failure here
    // is logged as an error, not swallowed — a QR that does not decode to the
    // intended URI is a payment-correctness bug, not a cosmetic one.
    upi.logPaymentDiagnostics({
      orderCode: order.orderCode,
      amount,
      upiId: payee.upiId,
      upiUri: presented.upi_uri,
      qr: presented.qr,
    });

    res.set(NO_STORE).json(presented);
  } catch (err) {
    console.error('[payment] create error:', err);
    return fail(res, 500, 'CREATE_FAILED', 'Could not start the payment. Please try again.');
  }
});

/**
 * A PAID payment by this buyer for this coupon, if one exists.
 * Delegated to the store: payment records live in the spreadsheet, so the
 * route must not reach into a database table of its own.
 */
async function findPaidPaymentForBuyer({ userId, userEmail, couponId }) {
  try {
    return await store.findPaidPaymentForBuyer({ userId, userEmail, couponId });
  } catch (e) {
    return null;
  }
}

// ── Current state ──────────────────────────────────────────────────────────
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const ready = await store.ensureReady();
    if (!ready.ok) {
      return fail(res, 503, 'STORAGE_UNAVAILABLE', ready.reason);
    }

    const paymentId = String(req.query.payment_id || '').trim();
    const orderId = String(req.query.order_id || '').trim();
    const couponId = String(req.query.coupon_id || '').trim();

    // No id at all: report any live payment for this user (optionally scoped
    // to one coupon) so a reopening modal can resume without creating one.
    if (!paymentId && !orderId) {
      if (!couponId) {
        return fail(res, 400, 'INVALID_INPUT', 'payment_id, order_id or coupon_id is required.');
      }
      const userId = String(req.user.userId || '');
      const live = await store.findLivePaymentForUserCoupon(userId, couponId);
      if (live && new Date(live.expiresAt).getTime() <= Date.now()) {
        await store.expireIfDue(live.paymentId);
        const refreshed = await store.findPaymentById(live.paymentId);
        return res.set(NO_STORE).json(await presentPayment(refreshed));
      }
      if (live) {
        return res.set(NO_STORE).json(await presentPayment(live));
      }
      return res.set(NO_STORE).json({ status: 'NONE' });
    }

    let payment = null;
    if (paymentId) {
      const owned = await loadOwnedPayment(paymentId, req);
      if (!owned.ok) return fail(res, owned.status, owned.code, owned.error);
      payment = owned.payment;
    } else {
      const order = await store.findOrderById(orderId);
      if (!order) return fail(res, 404, 'ORDER_NOT_FOUND', 'Order not found.');
      const userId = String(req.user.userId || '');
      const email = String(req.user.email || '').toLowerCase();
      const owns =
        (order.userId && userId && String(order.userId) === userId) ||
        (order.userEmail && email && String(order.userEmail).toLowerCase() === email);
      if (!owns) return fail(res, 404, 'ORDER_NOT_FOUND', 'Order not found.');
      payment = await store.findLatestPaymentForOrder(order.id);
      if (!payment) return fail(res, 404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
    }

    // Poll-fallback verification: when the browser cannot hold an SSE stream
    // open it polls /status while PENDING. Drive the same on-demand FamApp
    // scan from here so those buyers also get near-instant verification. The
    // scan is globally coalesced, so this never multiplies Gmail calls.
    if (payment.status === 'PENDING' && new Date(payment.expiresAt).getTime() > Date.now()) {
      try { await verifier.triggerMailboxScan(); } catch (e) {}
      payment = (await store.findPaymentById(payment.paymentId)) || payment;
    }

    // The server owns expiry. A payment past its deadline is retired the
    // moment anyone asks, so the frontend never has to decide it.
    if (payment.status === 'PENDING' && new Date(payment.expiresAt).getTime() <= Date.now()) {
      await store.expireIfDue(payment.paymentId);
      payment = await store.findPaymentById(payment.paymentId);
    }

    res.set(NO_STORE).json(await presentPayment(payment));
  } catch (err) {
    console.error('[payment] status error:', err);
    return fail(res, 500, 'STATUS_FAILED', 'Could not read the payment status.');
  }
});

// ── /active — the live payment for a coupon, if any ────────────────────────
router.get('/active', authenticateToken, async (req, res) => {
  try {
    const ready = await store.ensureReady();
    if (!ready.ok) return fail(res, 503, 'STORAGE_UNAVAILABLE', ready.reason);

    const couponId = String(req.query.coupon_id || '').trim();
    if (!couponId) return fail(res, 400, 'INVALID_INPUT', 'coupon_id is required.');

    const userId = String(req.user.userId || '');
    const email = String(req.user.email || '').toLowerCase();

    // A paid one wins over a live one: if the buyer already paid, the modal
    // should open on the success state.
    const paid = await findPaidPaymentForBuyer({ userId, userEmail: email, couponId });
    if (paid) {
      return res.set(NO_STORE).json({ ...(await presentPayment(paid)), already_paid: true });
    }

    const live = await store.findLivePaymentForUserCoupon(userId, couponId);
    if (!live) return res.set(NO_STORE).json({ status: 'NONE' });

    if (new Date(live.expiresAt).getTime() <= Date.now()) {
      await store.expireIfDue(live.paymentId);
      const refreshed = await store.findPaymentById(live.paymentId);
      return res.set(NO_STORE).json(await presentPayment(refreshed));
    }

    res.set(NO_STORE).json(await presentPayment(live));
  } catch (err) {
    console.error('[payment] active error:', err);
    return fail(res, 500, 'ACTIVE_FAILED', 'Could not read the active payment.');
  }
});

// ── /verify — ask the server to re-check, independently ────────────────────
// A manual "check now" trigger for the buyer's still-open window: it forces an
// immediate FamApp mailbox scan. It NEVER accepts a status, amount, UTR or
// transaction id from the client as proof — only an independent FamApp credit
// email (matched on amount, server-side) or a signed webhook can settle a
// payment.
router.post('/verify', verifyLimiter, authenticateToken, async (req, res) => {
  try {
    const ready = await store.ensureReady();
    if (!ready.ok) return fail(res, 503, 'STORAGE_UNAVAILABLE', ready.reason);

    const paymentId = String((req.body && req.body.payment_id) || '').trim();
    if (!paymentId) return fail(res, 400, 'INVALID_INPUT', 'payment_id is required.');

    const owned = await loadOwnedPayment(paymentId, req);
    if (!owned.ok) return fail(res, owned.status, owned.code, owned.error);

    let payment = owned.payment;

    // Already decided — nothing to look up.
    if (payment.status !== 'PENDING') {
      return res.set(NO_STORE).json(await presentPayment(payment));
    }

    if (new Date(payment.expiresAt).getTime() <= Date.now()) {
      await store.expireIfDue(payment.paymentId);
      payment = await store.findPaymentById(payment.paymentId);
      return res.set(NO_STORE).json(await presentPayment(payment));
    }

    // No client-supplied value (amount, UTR, transaction id, status) is ever
    // read here — the buyer cannot self-certify a payment. Verification is
    // purely the server-side FamApp mailbox scan below.

    // Independent check: read the payment mailbox and try to match a real
    // credit notification against this (and any other) pending payment.
    let mail = { ok: false, reason: 'not attempted' };
    try {
      mail = await verifier.scanPaymentMailbox({ maxMessages: 15 });
    } catch (e) {
      mail = { ok: false, reason: e.message };
    }

    // Re-read: the scan may have settled this payment.
    payment = await store.findPaymentById(payment.paymentId);

    const presented = await presentPayment(payment);
    res.set(NO_STORE).json({
      ...presented,
      verification: {
        mailboxChecked: Boolean(mail.ok),
        mailboxReason: mail.ok ? '' : mail.reason || '',
        settled: payment.status === 'PAID',
        // True when the payment still needs a human — the modal can say so
        // instead of implying the money is lost.
        needsReview: payment.status === 'REVIEW',
      },
    });
  } catch (err) {
    console.error('[payment] verify error:', err);
    return fail(res, 500, 'VERIFY_FAILED', 'Could not check the payment. Please try again.');
  }
});

// ── /cancel — buyer abandons a pending payment ─────────────────────────────
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const ready = await store.ensureReady();
    if (!ready.ok) return fail(res, 503, 'STORAGE_UNAVAILABLE', ready.reason);

    const paymentId = String((req.body && req.body.payment_id) || '').trim();
    if (!paymentId) return fail(res, 400, 'INVALID_INPUT', 'payment_id is required.');

    const owned = await loadOwnedPayment(paymentId, req);
    if (!owned.ok) return fail(res, owned.status, owned.code, owned.error);

    const payment = owned.payment;

    // Cancelling is only meaningful for a live attempt. A paid one must never
    // be cancelled — that would strand a payment the buyer already made — and
    // an already-finished one is reported as-is.
    if (payment.status === 'PAID') {
      return fail(
        res,
        409,
        'ALREADY_PAID',
        'This payment is already complete and cannot be cancelled.',
        await presentPayment(payment)
      );
    }
    if (payment.status !== 'PENDING') {
      return res.set(NO_STORE).json(await presentPayment(payment));
    }

    const cancelled = await store.cancelPayment(payment.paymentId, {
      reason: 'Cancelled by buyer before payment window closed.',
    });

    // A concurrent settle (webhook arriving in the same instant) wins: re-read
    // and report the truth rather than claiming a cancel that did not happen.
    if (!cancelled) {
      const current = await store.findPaymentById(payment.paymentId);
      return res.set(NO_STORE).json(await presentPayment(current));
    }

    // The coupon is deliberately left available — cancelling releases it for
    // other buyers, and abandoning a payment must never unlock it either.
    res.set(NO_STORE).json(await presentPayment(cancelled));
  } catch (err) {
    console.error('[payment] cancel error:', err);
    return fail(res, 500, 'CANCEL_FAILED', 'Could not cancel the payment. Please try again.');
  }
});

// ── /stream — live status updates (Server-Sent Events) ─────────────────────
// The browser cannot subscribe to these rows directly: doing so would require
// shipping a Supabase key to the client, and the payments tables are
// RLS-locked with no anon policies precisely so that no browser can read them.
// The server therefore relays changes over one authenticated stream. Multiple
// tabs each open their own stream and all receive the same backend state, so a
// PAID in one tab updates every other tab with no refresh.
router.get('/stream', authenticateToken, async (req, res) => {
  const paymentId = String(req.query.payment_id || '').trim();
  if (!paymentId) return fail(res, 400, 'INVALID_INPUT', 'payment_id is required.');

  const owned = await loadOwnedPayment(paymentId, req).catch(() => ({ ok: false }));
  if (!owned.ok) return fail(res, 404, 'PAYMENT_NOT_FOUND', 'Payment not found.');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  let lastStatus = '';
  let ticks = 0;

  const send = (event, data) => {
    if (closed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      closed = true;
    }
  };

  const poll = async () => {
    if (closed) return;
    try {
      let payment = await store.findPaymentById(paymentId);
      if (!payment) {
        send('error', { code: 'PAYMENT_NOT_FOUND' });
        return;
      }

      // Opening the payment window starts verification: while this stream is
      // live and the window is open, check the FamApp mailbox each tick and
      // settle the instant a matching credit email arrives. Verification stops
      // automatically once the payment leaves PENDING or the window closes (the
      // stream ends below). The scan is globally coalesced across all concurrent
      // streams, so simultaneous buyers never multiply Gmail calls.
      if (payment.status === 'PENDING' && new Date(payment.expiresAt).getTime() > Date.now()) {
        try { await verifier.triggerMailboxScan(); } catch (e) {}
        payment = (await store.findPaymentById(payment.paymentId)) || payment;
      }

      if (payment.status === 'PENDING' && new Date(payment.expiresAt).getTime() <= Date.now()) {
        await store.expireIfDue(payment.paymentId);
        payment = await store.findPaymentById(payment.paymentId);
      }

      if (payment.status !== lastStatus) {
        lastStatus = payment.status;
        send('status', await presentPayment(payment));
      } else {
        // Keepalive carries the server clock so the countdown stays honest
        // even on a long-lived connection.
        send('ping', { server_now: new Date().toISOString() });
      }

      ticks++;
      // A terminal state has nothing left to report.
      if (payment.status !== 'PENDING' && ticks > 1) {
        closed = true;
        res.end();
      }
    } catch (e) {
      send('error', { code: 'STATUS_FAILED' });
    }
  };

  // Push the current state immediately so the subscriber is never guessing.
  await poll();
  const interval = setInterval(async () => {
    if (closed) {
      clearInterval(interval);
      return;
    }
    await poll();
    // Safety cap: a browser that never closes its tab must not hold a
    // serverless invocation open forever.
    if (ticks > 240) {
      closed = true;
      clearInterval(interval);
      try { res.end(); } catch (e) {}
    }
  }, 2500);

  req.on('close', () => {
    closed = true;
    clearInterval(interval);
  });
});

// ── /webhook — gateway confirmation (HMAC authenticated) ────────────────────
// Mounted with raw-body capture in server.js so the signature can be computed
// over the exact bytes the gateway sent. Exported separately (in addition to
// the /webhook route below) because server.js mounts it on its own path,
// outside the maintenance guard: a confirmation arriving during a maintenance
// window must still be processed, or a paid order would be left unsettled.
const webhookHandler = async (req, res) => {
  try {
    const secret = verifier.getWebhookSecret();
    if (!secret) {
      // Refuse rather than accept an unauthenticated "payment succeeded".
      return fail(res, 503, 'WEBHOOK_NOT_CONFIGURED', 'Payment webhook is not configured.');
    }

    const signature =
      req.headers['x-payment-signature'] ||
      req.headers['x-signature'] ||
      req.headers['x-webhook-signature'] ||
      '';

    const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
    if (!verifier.verifyWebhookSignature(raw, signature, secret)) {
      console.warn('[payment] rejected webhook with an invalid signature');
      return fail(res, 401, 'INVALID_SIGNATURE', 'Invalid webhook signature.');
    }

    const ready = await store.ensureReady();
    if (!ready.ok) return fail(res, 503, 'STORAGE_UNAVAILABLE', ready.reason);

    const candidate = verifier.buildCandidateFromWebhook(req.body || {});
    if (candidate.direction !== 'credit') {
      // A debit/failure notification is acknowledged (so the gateway stops
      // retrying) but never settles anything.
      return res.json({ ok: true, action: 'ignored', reason: 'Not a credit notification.' });
    }

    const verdict = await verifier.processCandidate(candidate);
    res.json({
      ok: verdict.action === 'settled' || verdict.action === 'duplicate',
      action: verdict.action,
      reason: verdict.reason,
      payment_id: (verdict.payment && verdict.payment.paymentId) || undefined,
    });
  } catch (err) {
    console.error('[payment] webhook error:', err);
    return fail(res, 500, 'WEBHOOK_FAILED', 'Could not process the webhook.');
  }
};

router.post('/webhook', webhookHandler);

module.exports = router;
module.exports.webhookHandler = webhookHandler;
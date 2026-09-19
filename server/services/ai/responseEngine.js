// ============================================
// SaveHatke AI — Response Engine (Server-Only)
// ============================================
// Composes the user-facing reply from VERIFIED tool results and knowledge hits.
//
// The rule this file exists to uphold: the assistant formats facts, it never
// invents them. Every number, status and count below is copied out of a tool
// result. When a datastore read failed, the engine says so — it does not fall
// back to a plausible-looking value.
//
// Output shape matches what the existing widget already renders, so no frontend
// change is needed:
//   { text, cards?, chips?, support?, tool } with
//   cards ∈ {kind, tone, status, eyebrow, title, brand, discountBadge, price,
//            faceValue, stock, stockTone, expiry, fields, note, actions}
//   kind ∈ order|transaction|listing|payout|coupon|savings
//   tone ∈ blue|amber|green|red|violet|slate
// Chips must number 2–4 or the widget drops them, so every chip set is
// validated before it is returned.

const config = require('./config');
const toolRouter = require('./toolRouter');

// ── Phrasing helpers ──────────────────────────────────────────────────────

function plural(n, singular, pluralForm) {
  return `${n} ${n === 1 ? singular : (pluralForm || singular + 's')}`;
}

function listPhrase(items) {
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Relative expiry wording, using the same 2-week window the marketplace shows. */
function expiryPhrase(days) {
  if (days == null) return '';
  if (days < 0) return 'expired';
  if (days === 0) return 'expires today';
  if (days === 1) return 'expires tomorrow';
  if (days <= 7) return `expires in ${days} days`;
  if (days <= 14) return `expires in about ${Math.round(days / 7)} week${days > 10 ? 's' : ''}`;
  return `expires in ${days} days`;
}

function titleCase(s) {
  return String(s || '').replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function brandInitial(brand) {
  const b = String(brand || '').trim();
  return b ? b.slice(0, 1).toUpperCase() : '';
}

/** Clamp, de-duplicate and validate chips against the widget's 2–4 rule. */
function finaliseChips(chips, usedLabels) {
  const seen = new Set((usedLabels || []).map((l) => String(l).toLowerCase()));
  const out = [];
  (chips || []).forEach((c) => {
    const label = String(c || '').trim();
    if (!label || label.length > 40) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(label);
  });
  const limit = config.maxChips;
  const trimmed = out.slice(0, limit);
  return trimmed.length >= 2 ? trimmed : [];
}

const MARKETPLACE_URL = '/marketplace.html';
const DASHBOARD_URL = '/dashboard.html';
const SELL_URL = '/sell.html';
const SUPPORT_URL = '/support.html';
const TRACKER_URL = '/dashboard.html#tracker';
const SECURITY_URL = '/security.html';
const PROFILE_URL = '/profile.html';
const PRICES_URL = '/purchased.html';

// ── Confidence-dependent framing ──────────────────────────────────────────

const CLARIFY_REPLY = "I'm not fully sure what you mean. Could you rephrase that — or tell me whether you're asking about buying, selling, payouts, or your account?";
const CLARIFY_REPLY_LOW = "I can help with that, but I need a little more detail. Are you asking about buying, selling, payouts, or your account?";
const RETRIEVAL_FAILED = "I couldn't retrieve that information right now. Please try again shortly.";
const NO_KNOWLEDGE = "I don't have a confirmed answer for that one, and I'd rather not guess. Could you rephrase it, or ask about buying, selling, earnings, payouts, your account or support?";
const NO_RESULTS = "I couldn't find any coupons matching that right now. Availability changes often — try a different brand or category, or browse the marketplace for what's live.";

// ── Per-tool composers ────────────────────────────────────────────────────

function composeCouponSearch(result, plan) {
  if (!result.ok) {
    return { text: RETRIEVAL_FAILED, chips: ['Try again', 'Contact support'] };
  }
  if (result.empty) {
    const asked = plan && plan.args && (plan.args.brand || plan.args.category);
    return {
      text: asked
        ? `I couldn't find any available ${plan.args.brand || plan.args.category} coupons at the moment. New listings appear often — want me to look at another brand or category?`
        : NO_RESULTS,
      chips: ['Show all coupons', 'Search another brand', 'How does buying work?'],
    };
  }

  const filters = [];
  if (plan && plan.args) {
    if (plan.args.brand) filters.push(plan.args.brand);
    if (plan.args.category) filters.push(plan.args.category);
    if (plan.args.maxPrice) filters.push(`under ${toolRouter.formatINR(plan.args.maxPrice)}`);
  }
  const scope = filters.length ? ` matching ${filters.join(', ')}` : '';

  const more = result.totalMatches > result.results.length
    ? ` There are ${result.totalMatches} in total — here are the lowest priced.`
    : '';

  const text = `Here ${result.results.length === 1 ? 'is' : 'are'} ${plural(result.results.length, 'coupon')}${scope}.${more}`;

  const cards = result.results.map((c) => ({
    kind: 'coupon',
    tone: 'green',
    status: 'Available',
    eyebrow: c.category ? titleCase(c.category) : '',
    title: c.title || `${c.brand} coupon`,
    brand: c.brand || '',
    brandInitial: brandInitial(c.brand),
    discountBadge: c.discount || '',
    price: c.sellingPrice ? toolRouter.formatINR(c.sellingPrice) : '',
    faceValue: c.originalValue ? `worth ${toolRouter.formatINR(c.originalValue)}` : '',
    stock: '',
    stockTone: '',
    expiry: expiryPhrase(c.expiresInDays),
    note: 'Coupon code is revealed after purchase.',
    actions: [{ label: 'View coupon', href: `${MARKETPLACE_URL}` }],
  }));

  return {
    text,
    cards,
    chips: ['Show more coupons', 'Are there cheaper ones?', 'How does buying work?'],
  };
}

function composeEarnings(result) {
  if (!result.ok) {
    if (result.error === 'no_identity') {
      return { text: "I couldn't identify your account for that. Please sign in and ask me again.", chips: ['How do I sign in?', 'Contact support'] };
    }
    return { text: RETRIEVAL_FAILED, chips: ['Try again', 'Contact support'] };
  }

  const { soldCoupons, averagePerCoupon, totalEarned, formatted, availableToWithdraw, pendingCount, availableCount } = result;

  if (soldCoupons === 0) {
    const parts = [];
    if (pendingCount) parts.push(`${plural(pendingCount, 'coupon')} still under review`);
    if (availableCount) parts.push(`${plural(availableCount, 'coupon')} live on the marketplace`);
    const suffix = parts.length ? ` You have ${listPhrase(parts)} right now.` : '';
    return {
      text: `You haven't sold a coupon yet, so there's nothing earned so far.${suffix}\n\nEach coupon that sells earns you the price you set for it.`,
      chips: ['Check my submissions', 'Can I sell a coupon?', 'How do payouts work?'],
    };
  }

  const text = `You've sold ${plural(soldCoupons, 'coupon')}, so you've earned **${formatted.totalEarned}** — an average of ${formatted.averagePerCoupon} per sold coupon.` +
    (availableToWithdraw > 0 ? ` ${formatted.processingAmount} is still on its way to you.` : '') +
    (formatted.paidAmount && result.paidAmount > 0 ? ` ${formatted.paidAmount} has already been paid out.` : '');

  const cards = [{
    kind: 'savings',
    tone: 'green',
    status: 'Earnings',
    eyebrow: 'Savings',
    title: 'Your coupon earnings',
    fields: [
      { label: 'Sold coupons', value: String(soldCoupons) },
      { label: 'Average per coupon', value: formatted.averagePerCoupon },
      { label: 'Total earned', value: formatted.totalEarned, mono: true },
      ...(result.paidAmount > 0 ? [{ label: 'Paid out', value: formatted.paidAmount, mono: true }] : []),
      ...(availableToWithdraw > 0 ? [{ label: 'In progress', value: formatted.processingAmount, mono: true }] : []),
    ],
    note: 'Final amounts are confirmed by SaveHatke\'s payout ledger.',
    actions: [{ label: 'View dashboard', href: DASHBOARD_URL }],
  }];

  return {
    text,
    cards,
    chips: ['Where is my payout?', 'Check my submissions', 'How do payouts work?'],
  };
}

function composeSubmissions(result) {
  if (!result.ok) return { text: RETRIEVAL_FAILED, chips: ['Try again', 'Contact support'] };

  if (result.total === 0) {
    return {
      text: "You haven't submitted any coupons yet. Once you submit one, it goes through review and you'll see its status here.",
      chips: ['Can I sell a coupon?', 'How does selling work?', 'Contact support'],
    };
  }

  const { counts } = result;
  const bits = [];
  if (counts.pending) bits.push(`${counts.pending} under review`);
  if (counts.available) bits.push(`${counts.available} live on the marketplace`);
  if (counts.sold) bits.push(`${counts.sold} sold`);
  if (counts.rejected) bits.push(`${counts.rejected} rejected`);

  const text = `You've submitted ${plural(result.total, 'coupon')}: ${listPhrase(bits)}.`;

  const statusMeta = {
    pending: { label: 'Under review', tone: 'amber' },
    available: { label: 'Live', tone: 'green' },
    sold: { label: 'Sold', tone: 'green' },
    rejected: { label: 'Rejected', tone: 'red' },
  };

  const cards = result.submissions.slice(0, config.maxCards).map((s) => {
    const meta = statusMeta[String(s.status).toLowerCase()] || { label: titleCase(s.status || 'Pending'), tone: 'slate' };
    return {
      kind: 'listing',
      tone: meta.tone,
      status: meta.label,
      eyebrow: 'Your listing',
      title: s.title || `${s.brand} coupon`,
      brand: s.brand || '',
      brandInitial: brandInitial(s.brand),
      fields: [
        ...(s.submitted ? [{ label: 'Submitted', value: String(s.submitted).slice(0, 10) }] : []),
        ...(s.expiresInDays != null ? [{ label: 'Expires', value: expiryPhrase(s.expiresInDays) }] : []),
      ],
      note: String(s.status).toLowerCase() === 'pending' ? 'Reviews usually finish within a couple of days.' : '',
    };
  });

  return {
    text,
    cards,
    chips: ['Check my earnings', 'Can I sell another?', 'Contact support'],
  };
}

function composePayoutStatus(result) {
  if (!result.ok) return { text: RETRIEVAL_FAILED, chips: ['Try again', 'Contact support'] };

  if (!result.hasPayouts) {
    return {
      text: `There's no payout on your account yet. You earn the price you set for each coupon that sells, and once your balance reaches ${result.formatted.minPayoutRequest} you can request a payout.` +
        (result.hasDestination ? '' : "\n\nOne thing to set up first: add your payout details (UPI or QR) in your account settings, since payouts need a destination on file."),
      chips: ['Check my earnings', 'How do payouts work?', 'Add payout details'],
    };
  }

  const lines = [];
  if (result.owedAmount > 0) lines.push(`You have **${result.formatted.owedAmount}** waiting to be paid out.`);
  if (result.paidAmount > 0) lines.push(`**${result.formatted.paidAmount}** has already been paid to you.`);
  if (!lines.length) lines.push('Your payout records are up to date.');

  if (result.owedAmount > 0 && result.owedAmount < result.minPayoutRequest) {
    lines.push(`You can request a payout once your balance reaches ${result.formatted.minPayoutRequest}.`);
  }
  if (!result.hasDestination) {
    lines.push('Add your payout details (UPI or QR) in your account settings so your payout can be processed.');
  } else if (result.canRequestPayout) {
    lines.push('You can request a payout from your dashboard whenever you like.');
  }

  const cards = result.recent.length ? [{
    kind: 'payout',
    tone: result.owedAmount > 0 ? 'amber' : 'green',
    status: result.owedAmount > 0 ? 'Pending' : 'Settled',
    eyebrow: 'Payout',
    title: 'Your payouts',
    fields: [
      { label: 'Amount', value: result.formatted.owedAmount || toolRouter.formatINR(0), mono: true },
      { label: 'Paid so far', value: result.formatted.paidAmount, mono: true },
      { label: 'Minimum request', value: result.formatted.minPayoutRequest },
      ...(result.hasDestination ? [] : [{ label: 'Payout details', value: 'Not added yet' }]),
    ],
    note: 'Payouts are processed by the SaveHatke team after review.',
    actions: [{ label: 'View dashboard', href: DASHBOARD_URL }],
  }] : [];

  return {
    text: lines.join(' '),
    cards,
    chips: ['Check my earnings', 'How do payouts work?', 'Contact support'],
  };
}

function composePayoutLadder(result) {
  if (!result.ok) return { text: RETRIEVAL_FAILED, chips: ['Try again', 'Contact support'] };

  const steps = result.ladder.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const text = `Here's how payouts work:\n\n• You're credited the price you set on each coupon of yours that sells\n• Your payout balance builds up from those sales\n• Once it reaches **${result.minPayoutRequestFormatted}** you can request a payout\n• The maximum for a single request is ${result.maxPayoutRequestFormatted}\n\nEach payout moves through these stages:\n\n${steps}`;

  return {
    text,
    chips: ['Where is my payout?', 'Check my earnings', 'Add payout details'],
  };
}

function composePurchases(result) {
  if (!result.ok) return { text: RETRIEVAL_FAILED, chips: ['Try again', 'Contact support'] };

  if (result.total === 0) {
    return {
      text: "You haven't purchased any coupons yet. When you buy one, it shows up here with its code ready to use.",
      chips: ['Show me coupons', 'How does buying work?', 'Contact support'],
    };
  }

  const text = `You've purchased ${plural(result.total, 'coupon')}.` +
    (result.codesAvailable ? ' Here are your details — the code is on each one.' : '') +
    (result.hasMore ? ' Showing the most recent.' : '');

  const cards = result.purchases.slice(0, config.maxCards).map((p) => ({
    kind: 'order',
    tone: 'green',
    status: 'Purchased',
    eyebrow: 'Order status',
    title: p.title || `${p.brand} coupon`,
    brand: p.brand || '',
    brandInitial: brandInitial(p.brand),
    fields: [
      { label: 'Coupon code', value: p.code || 'Not available', mono: true },
      ...(p.pricePaid ? [{ label: 'Paid', value: toolRouter.formatINR(p.pricePaid), mono: true }] : []),
      ...(p.purchasedAt ? [{ label: 'Purchased', value: String(p.purchasedAt).slice(0, 10) }] : []),
      ...(p.expiresInDays != null ? [{ label: 'Expires', value: expiryPhrase(p.expiresInDays) }] : []),
    ],
    note: p.discount ? `${p.discount} off` : '',
    actions: [{ label: 'View purchases', href: PRICES_URL }],
  }));

  return {
    text,
    cards,
    chips: ['Show me more coupons', 'How do I use a code?', 'Contact support'],
  };
}

function composeSupportTickets(result) {
  if (!result.ok) return { text: RETRIEVAL_FAILED, chips: ['Try again', 'Contact support'] };

  if (result.total === 0) {
    return {
      text: "You don't have any support cases open. If something comes up, you can raise one from the Support page and our team will get back to you.",
      chips: ['How do I raise a ticket?', 'Show me coupons', 'How does SaveHatke work?'],
    };
  }

  const bits = [];
  if (result.openCount) bits.push(`${result.openCount} open`);
  if (result.inProgressCount) bits.push(`${result.inProgressCount} in progress`);
  if (result.resolvedCount) bits.push(`${result.resolvedCount} resolved`);

  const text = `You have ${plural(result.total, 'support case')} — ${listPhrase(bits)}.` +
    (result.resolvedCount ? ' Replies appear in the case thread on the Support page.' : '');

  const statusMeta = {
    open: { label: 'Open', tone: 'amber' },
    inprogress: { label: 'In progress', tone: 'blue' },
    resolved: { label: 'Resolved', tone: 'green' },
    closed: { label: 'Closed', tone: 'slate' },
  };

  const cards = result.tickets.slice(0, config.maxCards).map((t) => {
    const meta = statusMeta[t.status] || { label: titleCase(t.status), tone: 'slate' };
    return {
      kind: 'order',
      tone: meta.tone,
      status: meta.label,
      eyebrow: 'Support case',
      title: t.subject || 'Support case',
      fields: [
        ...(t.createdAt ? [{ label: 'Raised', value: String(t.createdAt).slice(0, 10) }] : []),
        ...(t.updatedAt ? [{ label: 'Updated', value: String(t.updatedAt).slice(0, 10) }] : []),
      ],
      note: t.resolution ? `Reply: ${t.resolution.slice(0, 160)}` : 'No reply yet — the team will respond in the case thread.',
      actions: [{ label: 'Open support', href: SUPPORT_URL }],
    };
  });

  return {
    text,
    cards,
    chips: ['Raise a new ticket', 'Check my earnings', 'How does SaveHatke work?'],
  };
}

function composeSellEligibility(result, plan) {
  if (!result.ok) {
    if (result.error === 'no_identity') {
      return { text: "I need you signed in to check that — eligibility is tied to your account email.", chips: ['How do I sign in?', 'Contact support'] };
    }
    return { text: RETRIEVAL_FAILED, chips: ['Try again', 'Contact support'] };
  }

  // "How do I sell a coupon" asks about the PROCESS, while "can I sell a
  // coupon" asks whether this account is allowed. They share one tool, so the
  // intent decides which question is actually being answered — otherwise a
  // how-to question would only ever be told "you can't sell".
  const isHowTo = plan && plan.intent === 'SELL_COUPON';
  // There is no flat rate to quote — a seller is paid whatever price they set
  // on each coupon, so the label states the model rather than a number.
  const earningLabel = 'The price you set';

  const explainProcess = () => [
    `Here's how selling works: open the Sell page and submit the coupon — pick the brand and category, describe what it gives, set your price, add the coupon details and a proof screenshot, then submit.`,
    `It goes through a review, and once it's approved it appears on the marketplace. You're paid the price you set for every coupon of yours that sells.`,
  ].join('\n\n');

  if (result.canSell && result.reason === 'admin_role') {
    return {
      text: `You're on the SaveHatke team, so you can submit coupons.\n\n${explainProcess()}`,
      chips: ['Check my earnings', 'How do payouts work?', 'Contact support'],
    };
  }

  if (result.canSell) {
    return {
      text: `Yes — you're approved to sell coupons.\n\n${explainProcess()}`,
      cards: [{
        kind: 'listing',
        tone: 'green',
        status: 'Approved to sell',
        eyebrow: 'Your listing',
        title: 'You can submit coupons',
        fields: [
          { label: 'Earning per sale', value: earningLabel },
          ...(result.submittedCount != null ? [{ label: 'Submitted so far', value: String(result.submittedCount) }] : []),
        ],
        actions: [{ label: 'Submit a coupon', href: SELL_URL }],
      }],
      chips: ['How does selling work?', 'Check my submissions', 'Check my earnings'],
    };
  }

  if (result.reason === 'unverifiable') {
    return {
      text: "I couldn't confirm your selling access just now — I'd rather not give you a wrong answer. Please try again shortly, or contact support and they'll check for you.",
      chips: ['Try again', 'Contact support', 'How does selling work?'],
    };
  }

  // Not on the invite list. A how-to question still deserves the process.
  if (isHowTo) {
    return {
      text: `${explainProcess()}\n\nOne important thing: selling is currently invite-only, so your account isn't on the list yet. If you'd like access, contact support and the team can review it.`,
      cards: [{
        kind: 'listing',
        tone: 'amber',
        status: 'Invite only',
        eyebrow: 'Your listing',
        title: 'Selling is invite-only right now',
        fields: [
          { label: 'Earning per sale', value: earningLabel },
          { label: 'Your access', value: 'Not enabled yet' },
        ],
        note: 'Access is granted by the SaveHatke team.',
        actions: [{ label: 'Contact support', href: SUPPORT_URL }],
      }],
      chips: ['Contact support', 'Show me coupons', 'How does buying work?'],
    };
  }

  return {
    text: `Selling is currently invite-only — it isn't open to everyone yet, so your account isn't on the list at the moment. If you'd like access, contact support and the team can review it.\n\nIn the meantime you can still browse and buy coupons.`,
    cards: [{
      kind: 'listing',
      tone: 'slate',
      status: 'Invite only',
      eyebrow: 'Your listing',
      title: 'Selling is invite-only right now',
      note: 'Access is granted by the SaveHatke team.',
      actions: [{ label: 'Contact support', href: SUPPORT_URL }],
    }],
    chips: ['Contact support', 'Show me coupons', 'How does selling work?'],
  };
}

function composeUserProfile(result) {
  if (!result.ok) {
    if (result.error === 'no_identity') {
      return { text: "I need you signed in for that one.", chips: ['How do I sign in?', 'Contact support'] };
    }
    return { text: RETRIEVAL_FAILED, chips: ['Try again', 'Contact support'] };
  }

  const lines = [];
  if (result.name) lines.push(`You're signed in as **${result.name}** (${result.emailMasked}).`);
  else lines.push(`You're signed in as ${result.emailMasked}.`);
  lines.push(`You sign in with ${result.signInMethod} — there's no password on your account.`);
  if (!result.hasPayoutDetails) {
    lines.push('You haven\'t added payout details yet, so add a UPI ID or QR code in your account settings to receive payouts.');
  } else {
    lines.push('Your payout details are on file.');
  }

  return {
    text: lines.join(' '),
    chips: ['Add payout details', 'Check my earnings', 'Where are my security settings?'],
  };
}

function composeMaintenance(result) {
  if (!result.ok) {
    return { text: RETRIEVAL_FAILED, chips: ['Try again', 'Contact support'] };
  }
  if (result.enabled) {
    return {
      text: `SaveHatke is in maintenance mode right now.${result.message ? ` ${result.message}` : ''}\n\nThe assistant is still available for general questions, but some parts of the site may be unavailable until maintenance finishes.`,
      chips: ['Contact support', 'How does SaveHatke work?'],
    };
  }
  return {
    text: "SaveHatke is running normally — no maintenance in progress. If something specific isn't loading for you, tell me what you were doing and I'll help, or you can raise a support ticket.",
    chips: ['Contact support', 'Show me coupons', 'How does SaveHatke work?'],
  };
}

function composePriceTracker(result) {
  if (!result.ok) {
    if (result.error === 'no_identity') {
      return { text: 'Your tracked products are tied to your account, so please sign in and ask me again.', chips: ['How do I sign in?', 'Contact support'] };
    }
    return { text: RETRIEVAL_FAILED, chips: ['Try again', 'Contact support'] };
  }
  if (result.total === 0) {
    return {
      text: "You're not tracking any products yet. Add a product URL on the Price Tracker and SaveHatke will watch its price and alert you when it drops to your target.",
      chips: ['How does the tracker work?', 'Show me coupons', 'Contact support'],
    };
  }
  const text = `You're tracking ${plural(result.total, 'product')}.` + ' I can show their latest recorded prices — for live checks, open the Price Tracker in your dashboard.';
  const cards = result.items.slice(0, config.maxCards).map((i) => ({
    kind: 'savings',
    tone: 'blue',
    status: 'Tracking',
    eyebrow: 'Savings',
    title: i.productName || 'Tracked product',
    fields: [
      ...(i.platform ? [{ label: 'Platform', value: i.platform }] : []),
      ...(i.currentPrice ? [{ label: 'Current', value: toolRouter.formatINR(i.currentPrice), mono: true }] : []),
      ...(i.targetPrice ? [{ label: 'Target', value: toolRouter.formatINR(i.targetPrice), mono: true }] : []),
    ],
    actions: [{ label: 'Open tracker', href: TRACKER_URL }],
  }));
  return { text, cards, chips: ['How does the tracker work?', 'Show me coupons', 'Contact support'] };
}

// ── Knowledge-based composition ───────────────────────────────────────────

function composeFromKnowledge(hits, confidence) {
  if (!hits || !hits.length) {
    return { text: NO_KNOWLEDGE, chips: ['Show me coupons', 'How does SaveHatke work?', 'Contact support'] };
  }

  const top = hits[0];
  // A weak hit is presented as a lead, not as an authoritative answer.
  if (confidence < config.highConfidence) {
    const text = `${top.answer}\n\nIf that's not quite what you meant, tell me a bit more and I'll narrow it down.`;
    return { text, chips: ['Show me coupons', 'How does selling work?', 'Contact support'] };
  }

  const text = top.answer;
  const extra = hits.slice(1, 3).filter((h) => h.score > top.score * 0.6);
  if (extra.length) {
    const related = extra.map((h) => `• ${h.question}`).join('\n');
    return {
      text: `${text}\n\nRelated: \n${related}`,
      chips: ['Show me coupons', 'Check my earnings', 'Contact support'],
    };
  }
  return {
    text,
    chips: ['Show me coupons', 'How does buying work?', 'Contact support'],
  };
}

// ─ Public entry point ────────────────────────────────────────────────────

const COMPOSERS = {
  search_coupons: composeCouponSearch,
  check_earnings: composeEarnings,
  check_submissions: composeSubmissions,
  check_payout_status: composePayoutStatus,
  check_payout_ladder: composePayoutLadder,
  check_purchases: composePurchases,
  check_support_tickets: composeSupportTickets,
  check_sell_eligibility: composeSellEligibility,
  get_user_profile: composeUserProfile,
  get_maintenance_status: composeMaintenance,
  get_price_tracker: composePriceTracker,
};

/**
 * Compose a reply for a tool result.
 * @param {string} toolName
 * @param {object} result
 * @param {object} plan — the plan that selected the tool
 * @param {{lowConfidence?:boolean, confidence?:number}} [opts]
 * @returns {{text:string, cards?:Array, chips:string[], support?:object, tool:string, grounded:boolean}}
 */
function composeToolReply(toolName, result, plan, opts = {}) {
  const composer = COMPOSERS[toolName];

  // A failed read must never be dressed up as an answer.
  if (!result || result.ok === false) {
    const err = result && result.error;
    if (err === 'login_required') {
      return {
        text: "That's account-specific, so I'll need you signed in first. Sign in and ask me again.",
        chips: ['How do I sign in?', 'Show me coupons', 'Contact support'],
        tool: toolName,
        grounded: false,
      };
    }
    if (err === 'tool_not_permitted' || err === 'tool_not_implemented') {
      return {
        text: "I can't help with that one directly, but I can explain how it works or point you to the right page. What are you trying to do?",
        chips: ['Contact support', 'How does SaveHatke work?', 'Show me coupons'],
        tool: toolName,
        grounded: false,
      };
    }
    return {
      text: RETRIEVAL_FAILED,
      chips: ['Try again', 'Contact support'],
      tool: toolName,
      grounded: false,
    };
  }

  if (typeof composer !== 'function') {
    return {
      text: NO_KNOWLEDGE,
      chips: ['Show me coupons', 'How does SaveHatke work?', 'Contact support'],
      tool: toolName,
      grounded: false,
    };
  }

  const composed = composer(result, plan) || {};
  let text = String(composed.text || '').trim();
  if (!text) text = RETRIEVAL_FAILED;

  // Low confidence in the classification → offer the answer but invite a
  // correction, so a near-miss does not read as a confident wrong answer.
  if (opts.lowConfidence && !/^I couldn't retrieve/i.test(text)) {
    text += "\n\nI think that's what you were after — if not, tell me a bit more and I'll take another look.";
  }

  return {
    text,
    cards: (composed.cards || []).slice(0, config.maxCards),
    chips: finaliseChips(composed.chips, []),
    support: composed.support,
    tool: toolName,
    grounded: true,
  };
}

/** The clarification reply, chosen by how far below the confidence floor we are. */
function composeClarification(classification) {
  const conf = classification && classification.confidence;
  const text = (conf && conf > 0.35) ? CLARIFY_REPLY_LOW : CLARIFY_REPLY;
  return {
    text,
    chips: ['Show me coupons', 'Can I sell a coupon?', 'Check my earnings', 'Contact support'],
    tool: null,
    grounded: false,
  };
}

/** A direct answer plan (fixed product knowledge). */
function composeDirectAnswer(directAnswer) {
  return {
    text: directAnswer.text,
    cards: (directAnswer.cards || []).slice(0, config.maxCards),
    chips: finaliseChips(directAnswer.chips, []),
    tool: null,
    grounded: true,
  };
}

module.exports = {
  composeToolReply,
  composeFromKnowledge,
  composeClarification,
  composeDirectAnswer,
  finaliseChips,
  expiryPhrase,
  // exported for tests
  CLARIFY_REPLY,
  CLARIFY_REPLY_LOW,
  RETRIEVAL_FAILED,
  NO_KNOWLEDGE,
  NO_RESULTS,
};
// ============================================
// SaveHatke — AI Chatbot Widget (shared)
// ============================================
// Self-injecting floating assistant: drop `<script src="js/chatbot.js"></script>`
// on any page and the styles, markup and logic mount themselves.
//
// This file implements the CLIENT half of the "SaveHatke AI Chatbot Conversation
// Guide v3.1 addendum": UI-1 … UI-10 (pages 3–8) plus the UI-bearing strings from
// Part 2 (§26.1/26.2, §38, §40, §44, §45, §46, §47.1, §48, §49). Every quoted
// string lives in the STR / GREETINGS / TYPING tables below and is referenced by
// its guide number so tickets and tests can point at it.
//
// Behaviour: the chat window opens directly ON TOP OF the launcher icon (same
// bottom/right anchor, higher z-index) and the launcher hides while it is open,
// so there is no second "close" affordance on the icon — the header buttons (or
// Escape) close it.
//
// TRUTHFULNESS (§49, UI-6, UI-7): the client renders only what the server sent.
// It never computes, totals, re-ranks, re-prices, rounds or "improves" a value,
// never derives a discount from prices, never invents a status, count, date or
// amount, never claims a human was contacted, and never shows a coupon code.
// The typing label describes work actually in flight — a specific label is used
// only when the message came from a quick action / chip that always maps to that
// lookup; everything else says "Thinking…".
//
// SECURITY: talks only to our own /api/chat endpoints. The Gemini API key is
// server-side only and never reaches the browser. Every string that reaches
// innerHTML goes through escHtml() first — including backend card values.

(function SaveHatkeChatbotWidget() {
  'use strict';

  // Guard against double-inclusion / a leftover inline copy on the page
  if (window.__shChatbotMounted) return;
  window.__shChatbotMounted = true;

  /* ═══════════════════════════════════════════════
     Guide strings — verbatim, one string one place
  ═══════════════════════════════════════════════ */
  const STR = {
    name: 'SaveHatke AI',                                   // UI-1.1
    tagline: 'Your smart savings assistant',                // UI-1.3
    statusOnline: 'Online',                                 // UI-1.2
    statusReconnecting: 'Reconnecting…',                     // §44
    statusOffline: 'Offline',                               // §44
    connectionLost: "Your connection appears to have been interrupted. Once you're back online, you can continue the conversation.", // UI-2.1 = 44.1
    welcomeHead: "Hi! I'm your SaveHatke AI Assistant.",     // UI-3.1 = 26.1
    welcomeSub: "Tell me what you're looking for — I can help with coupons, orders, payments, selling, deals, and more.", // UI-3.2 = 26.2
    startWith: 'START WITH',                                // UI-3
    continuePrevious: 'Continue previous chat',             // §39
    continueLine: 'Welcome back. We can continue from where we left off.', // 39.1
    previousLabel: 'Previous conversation',
    retrieveFailed: "I wasn't able to retrieve that information at the moment. Please try again.", // 42.1
    tryAgain: 'Try again',                                  // §46
    contactSupport: 'Contact support',                      // §46
    supportAvailable: "Human support is currently available. If you'd like help from the support team, you can continue through the Support Center.", // 40.1
    supportOfflineHead: 'Human support is currently offline.',      // 40.2
    supportOfflineHours: 'Our team is available ',                  // 40.2 (hours are backend-owned)
    supportOfflineTail: 'I can still help with general questions right now.', // 40.2
    unknownStatus: 'Unknown status',                         // UI-7
    placeholders: [
      'Ask me about coupons, orders, deals…',                // 45.1
      'How can I help you today?',                           // 45.2
      'Search for a coupon or ask a question…',               // 45.3
    ],
    placeholderOffline: 'Offline — reconnect to send a message', // 45.4
    disclosure: 'SaveHatke AI Assistant · AI-generated responses may be limited by available information.', // 47.1
  };

  // §38 — rotates 38.1 → 38.2 → 38.3 across sessions. First line heads, second sublines.
  const GREETINGS = [
    { head: 'Welcome back.', sub: 'What would you like to check today?' },                       // 38.1
    { head: 'Good to see you again.', sub: 'Need help with a coupon, order, or something else?' }, // 38.2
    { head: 'Welcome back!', sub: 'I can pick up where you left off or help with something new.' }, // 38.3
  ];

  // UI-6 — typing labels. `general` is the default because the client cannot know
  // whether the server will make a backend call.
  const TYPING = {
    order: 'Looking up your order…',            // UI-6.1
    coupon: 'Finding the best match…',           // UI-6.2
    diagnostic: 'Reviewing your coupon details…', // UI-6.3
    account: 'Checking your information…',        // UI-6.4
    general: 'Thinking…',                        // UI-6.5
  };
  // UI-6 rotation: never the same label twice in a row — substitute the next
  // closest label. Each chain only contains labels that stay TRUE for that
  // intent (an order lookup is also an account lookup; a model call is always
  // "thinking"), so repeat-suppression can never fabricate work.
  const TYPING_CHAIN = {
    order: ['order', 'account', 'general'],
    coupon: ['coupon', 'general'],
    diagnostic: ['diagnostic', 'general'],
    account: ['account', 'general'],
    general: ['general'],
  };

  // UI-3 — welcome actions. Signed-out visitors get no account-scoped action.
  // `intent` is the typing label this action always maps to (null → "Thinking…").
  const ACTIONS_SIGNED_IN = [
    { label: 'Find a coupon', intent: 'coupon' },
    { label: 'My orders', intent: 'order' },
    { label: 'My coupons', intent: 'account' },
    { label: 'Track payout', intent: 'account' },
    { label: 'Sell a coupon', intent: null },
    { label: 'Payment help', intent: null },
  ];
  const ACTIONS_SIGNED_OUT = [
    { label: 'Find deals', intent: 'coupon' },
    { label: 'How SaveHatke works', intent: null },
    { label: 'Buy a coupon', intent: 'coupon' },
    { label: 'Sell a coupon', intent: null },
  ];

  // Labels that ALWAYS route to one specific lookup. Anything not listed here
  // keeps the honest default, "Thinking…".
  const INTENT_BY_LABEL = {
    'my orders': 'order',
    'track my order': 'order',
    'find a coupon': 'coupon',
    'find deals': 'coupon',
    'buy a coupon': 'coupon',
    'compare deals': 'coupon',
    'find similar deals': 'coupon',
    'show similar deals': 'coupon',
    'check expiry': 'diagnostic',
    'my coupons': 'account',
    'show my coupons': 'account',
    'track payout': 'account',
    'my listings': 'account',
    'my support cases': 'account',
  };

  const CARD_KINDS = ['order', 'transaction', 'listing', 'payout', 'coupon', 'savings'];
  const TONES = ['blue', 'amber', 'green', 'red', 'violet', 'slate'];
  // Presentational fallback only — used when the backend omits the fixed eyebrow.
  const DEFAULT_EYEBROW = {
    order: 'Order status', transaction: 'Payment status', listing: 'Your listing',
    payout: 'Payout', coupon: '', savings: 'Savings',
  };

  const AI_MARK = '<svg viewBox="0 0 28 28" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="M6 4 H22 A3.5 3.5 0 0 1 25.5 7.5 V8.9 A2.6 2.6 0 0 0 25.5 14.1 V15.5 A3.5 3.5 0 0 1 22 19 H14.5 L7 23.9 L10.2 19 H6 A3.5 3.5 0 0 1 2.5 15.5 V14.1 A2.6 2.6 0 0 0 2.5 8.9 V7.5 A3.5 3.5 0 0 1 6 4 Z M8.6 11.5 a1.4 1.4 0 1 0 2.8 0 a1.4 1.4 0 1 0 -2.8 0 M12.6 11.5 a1.4 1.4 0 1 0 2.8 0 a1.4 1.4 0 1 0 -2.8 0 M16.6 11.5 a1.4 1.4 0 1 0 2.8 0 a1.4 1.4 0 1 0 -2.8 0"/></svg>';
  const USER_MARK = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 12.6a4.3 4.3 0 1 0 0-8.6 4.3 4.3 0 0 0 0 8.6Zm0 1.9c-3.6 0-6.6 2-6.6 4.4V20h13.2v-1.1c0-2.4-3-4.4-6.6-4.4Z"/></svg>';

  const STYLES = `
    /* ═══════════════════════════════════════
       SAVEHATKE AI CHATBOT — Green Theme
       Structure comes from 1px hairlines and quiet fills (§48). Cards carry no
       drop shadow; only the floating panel and launcher do. The 3px tone stripe
       is the only place colour carries meaning.
    ═══════════════════════════════════════ */
    @keyframes typing-dot {
      0%,80%,100% { transform:translateY(0); opacity:.4; }
      40%          { transform:translateY(-5px); opacity:1; }
    }
    /* UI-5 entrance: 7px rise over 260ms */
    @keyframes cb-turn-rise {
      from { opacity:0; transform:translateY(7px); }
      to   { opacity:1; transform:translateY(0); }
    }
    /* Breathing halo for the launcher. It rides on a ::before ring rather than the
       button's own box-shadow so the button can keep a static, dimensional shadow
       — and so the button never scales, which would make it a moving click target. */
    @keyframes chatbot-halo {
      0%       { transform:scale(1);    opacity:.75; }
      70%,100% { transform:scale(1.42); opacity:0; }
    }

    .chatbot-fab, .chatbot-window {
      --cb-green:#00e676;
      --cb-green-2:#00c853;
      --cb-ink:#e2ecff;
      --cb-ink-2:#a8bcd8;
      --cb-ink-3:#6b88aa;
      --cb-surface:#0c1835;
      --cb-surface-2:rgba(15,30,58,.9);
      --cb-hair:rgba(0,230,118,.12);
      --cb-hair-2:rgba(255,255,255,.08);
      --cb-hair-strong:rgba(0,230,118,.22);
      --cb-amber:#ffd740;
      --cb-red:#ff6b6b;
      --cb-blue:#4da3ff;
      --cb-violet:#b388ff;
      --cb-slate:#7d8fa8;
      --cb-font:'Outfit', sans-serif;
      --cb-mono:'JetBrains Mono', ui-monospace, Menlo, monospace;
    }

    /* Launcher button — the coupon-ticket mark */
    .chatbot-fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 9990;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: linear-gradient(145deg, #00e676 0%, #00c853 55%, #00b248 100%);
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #052013;
      box-shadow:
        0 8px 22px rgba(0, 200, 83, .36),
        0 2px 5px rgba(0, 0, 0, .34),
        inset 0 1px 0 rgba(255, 255, 255, .34);
      transition: transform .24s cubic-bezier(.34, 1.5, .64, 1), box-shadow .24s ease, opacity .18s ease, visibility .18s ease;
    }
    .chatbot-fab::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 50%;
      border: 1.5px solid rgba(0, 230, 118, .55);
      animation: chatbot-halo 2.8s ease-out infinite;
      pointer-events: none;
    }
    .chatbot-fab:hover {
      transform: translateY(-3px);
      box-shadow:
        0 14px 30px rgba(0, 200, 83, .48),
        0 2px 5px rgba(0, 0, 0, .34),
        inset 0 1px 0 rgba(255, 255, 255, .4);
    }
    .chatbot-fab:active { transform: translateY(-1px); }
    .chatbot-fab:focus-visible {
      outline: 2.5px solid #00e676;
      outline-offset: 3px;
    }
    .chatbot-fab .cb-icon-open { width: 27px; height: 27px; display: block; }
    /* Open state: the window sits on top of the icon, so the icon steps aside
       (no ✕ swap — the window header owns the close action). */
    .chatbot-fab.is-open {
      opacity: 0;
      visibility: hidden;
      transform: scale(.55);
      pointer-events: none;
    }
    .chatbot-fab.is-open::before { animation: none; }

    /* Chat window — anchored to the launcher so it opens upon the icon */
    .chatbot-window {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 9995;
      width: 380px;
      height: 560px;
      max-width: calc(100vw - 32px);
      max-height: calc(100dvh - 40px);
      background: #0c1835;
      border: 1px solid rgba(0,230,118,.18);
      border-radius: 20px;
      box-shadow: 0 32px 90px rgba(0,0,0,.65), 0 0 0 1px rgba(0,230,118,.08);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      opacity: 0;
      transform-origin: bottom right;
      transform: translateY(10px) scale(.9);
      pointer-events: none;
      transition: opacity .25s cubic-bezier(.4,0,.2,1),
                  transform .25s cubic-bezier(.34,1.3,.64,1);
    }
    .chatbot-window.is-open {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }
    .chatbot-window *, .chatbot-window *::before, .chatbot-window *::after { box-sizing: border-box; }

    /* Mobile: near-full-screen bottom sheet */
    @media (max-width: 520px) {
      .chatbot-fab { bottom: 16px; right: 16px; width: 50px; height: 50px; }
      .chatbot-fab .cb-icon-open { width: 24px; height: 24px; }
      .chatbot-window {
        bottom: 0;
        right: 0;
        left: 0;
        width: 100%;
        max-width: 100%;
        height: 88dvh;
        max-height: 88dvh;
        border-radius: 20px 20px 0 0;
        transform-origin: bottom center;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .chatbot-fab::before { animation: none; }
      .chatbot-fab:hover { transform: none; }
      .chatbot-window { transition: opacity .15s linear; }
      .cb-turn, .cb-welcome { animation: none !important; }
    }

    /* ── UI-1 · Header. One row band, total height ≤ 60px. ── */
    .chatbot-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      min-height: 56px;
      max-height: 60px;
      background: linear-gradient(135deg, rgba(0,230,118,.1), rgba(0,200,83,.06));
      border-bottom: 1px solid rgba(0,230,118,.15);
      flex-shrink: 0;
    }
    .chatbot-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
    .chatbot-avatar {
      width: 32px;
      height: 32px;
      border-radius: 9px;
      background: linear-gradient(135deg, #00e676, #00c853);
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 32px;
      overflow: hidden;
    }
    /* The same coupon-ticket chat mark the launcher uses, dark on the green plate
       so it stays visible on navy. */
    .chatbot-avatar svg { width: 20px; height: 20px; display: block; color: #04210f; }
    .chatbot-header-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .chatbot-header-name {
      font-family: var(--cb-font);
      font-weight: 600;
      font-size: 14px;
      line-height: 1.2;
      letter-spacing: -.01em;
      color: var(--cb-ink);
      white-space: nowrap;
    }
    .chatbot-header-status {
      font-family: var(--cb-font);
      font-size: 11px;
      line-height: 1.2;
      color: rgba(255,255,255,.62);
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
    }
    .chatbot-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--cb-green);
      display: inline-block;
      flex: 0 0 6px;
    }
    .chatbot-status-dot.cb-dot-warn { background: var(--cb-amber); }
    .chatbot-status-dot.cb-dot-offline { background: var(--cb-red); }
    .chatbot-status-state { white-space: nowrap; }
    .chatbot-status-sep { opacity: .5; }
    .chatbot-tagline { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .chatbot-header-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .chatbot-icon-btn {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: transparent;
      border: none;
      color: #6b88aa;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: .9rem;
      line-height: 1;
      transition: background .15s, color .15s;
      font-family: var(--cb-font);
    }
    .chatbot-icon-btn:hover { background: rgba(0,230,118,.1); color: #00e676; }
    .chatbot-icon-btn:focus-visible { outline: 2px solid #00e676; outline-offset: 2px; }

    /* Touch targets on phones. The header buttons keep their exact 32px box,
       colour and hover state; an absolutely-positioned invisible ::after grows
       the tappable area to 36x44. It stays 2px inside the 4px gap so one button
       can never swallow a tap meant for its neighbour. */
    @media (max-width: 768px), (max-height:500px) and (orientation:landscape) {
      .chatbot-icon-btn { position: relative; }
      .chatbot-icon-btn::after {
        content: ''; position: absolute; left: -2px; right: -2px;
        top: 50%; height: 44px; transform: translateY(-50%);
      }
    }

    /* ── UI-2 / §44 · Connection strip ── */
    .cb-strip {
      display: none;
      align-items: flex-start;
      gap: 7px;
      padding: 8px 14px;
      font-family: var(--cb-font);
      font-size: 11.5px;
      line-height: 1.45;
      border-bottom: 1px solid transparent;
      flex-shrink: 0;
    }
    .cb-strip.is-visible { display: flex; }
    .cb-strip-amber {
      background: rgba(255,215,64,.1);
      border-bottom-color: rgba(255,215,64,.3);
      color: #ffdf8a;
    }
    .cb-strip-red {
      background: rgba(255,107,107,.1);
      border-bottom-color: rgba(255,107,107,.32);
      color: #ffb4b4;
    }
    .cb-strip-mark { flex: 0 0 auto; }

    /* Messages area */
    .chatbot-messages {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 14px 14px 4px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scrollbar-width: thin;
      scrollbar-color: rgba(0,230,118,.15) transparent;
    }
    .chatbot-messages::-webkit-scrollbar { width: 4px; }
    .chatbot-messages::-webkit-scrollbar-thumb { background: rgba(0,230,118,.2); border-radius: 2px; }

    .cb-sr-only {
      position: absolute; width: 1px; height: 1px; margin: -1px;
      padding: 0; border: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
    }

    /* ── UI-5 · Turns. Every assistant part hangs off one 26px avatar rail. ── */
    .cb-turn {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      width: 100%;
      min-width: 0;
      animation: cb-turn-rise .26s cubic-bezier(.2,.7,.3,1) both;
    }
    .cb-turn.cb-user { flex-direction: row-reverse; }
    .cb-rail {
      width: 26px;
      height: 26px;
      flex: 0 0 26px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .cb-turn.cb-ai .cb-rail { background: linear-gradient(135deg, #00e676, #00c853); color: #04210f; }
    .cb-turn.cb-user .cb-rail { background: rgba(255,255,255,.06); border: 1px solid var(--cb-hair-2); color: var(--cb-ink-3); }
    .cb-rail svg { width: 16px; height: 16px; display: block; }
    /* Consecutive assistant turns hide the repeated avatar and tighten the gap. */
    .cb-turn.cb-cont { margin-top: -6px; }
    .cb-turn.cb-cont .cb-rail { visibility: hidden; }
    .cb-stack {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
      max-width: calc(100% - 34px);
    }
    .cb-turn.cb-user .cb-stack { align-items: flex-end; }
    .cb-bubble {
      font-family: var(--cb-font);
      font-size: 13.5px;
      line-height: 1.55;
      letter-spacing: -.008em;
      padding: 9px 13px;
      border-radius: 16px;
      overflow-wrap: anywhere;
      max-width: 100%;
    }
    .cb-turn.cb-ai .cb-bubble {
      background: var(--cb-surface-2);
      border: 1px solid var(--cb-hair);
      color: var(--cb-ink);
      border-top-left-radius: 6px;
    }
    .cb-turn.cb-user .cb-bubble {
      background: linear-gradient(135deg, #00e676, #00c853);
      color: #060d1f;
      font-weight: 500;
      border-bottom-right-radius: 6px;
    }
    .cb-turn.cb-ai .cb-bubble strong { color: #00e676; }
    .cb-turn.cb-ai .cb-bubble em { color: #66ffa6; font-style: italic; }
    .cb-turn.cb-ai .cb-bubble code {
      background: rgba(0,230,118,.08);
      padding: 1px 5px;
      border-radius: 4px;
      font-family: var(--cb-mono);
      font-size: .82em;
      color: #69f0ae;
    }
    /* Lists — green dot markers, 5px gap */
    .cb-list { margin: 6px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
    .cb-list li { position: relative; padding-left: 14px; }
    .cb-list li::before {
      content: ''; position: absolute; left: 0; top: .58em;
      width: 5px; height: 5px; border-radius: 50%; background: var(--cb-green);
    }
    .cb-ts {
      font-family: var(--cb-font);
      font-size: 10px;
      line-height: 1.2;
      color: var(--cb-ink-3);
      font-variant-numeric: tabular-nums;
      padding: 0 3px;
    }
    .cb-turn.cb-user .cb-ts { text-align: right; }

    /* §40 support note */
    .cb-support-note {
      margin: 0;
      font-family: var(--cb-font);
      font-size: 12.5px;
      line-height: 1.5;
      color: var(--cb-ink-2);
      border-left: 2px solid var(--cb-hair-strong);
      padding-left: 9px;
    }

    /* ── UI-6 · Typing indicator ── */
    .cb-typing {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--cb-surface-2);
      border: 1px solid var(--cb-hair);
      border-radius: 16px;
      border-top-left-radius: 6px;
      width: fit-content;
      max-width: 100%;
    }
    .cb-typing-dots { display: inline-flex; gap: 4px; flex: 0 0 auto; }
    .cb-typing-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--cb-green); display: block; }
    .cb-typing-dots i:nth-child(1) { animation: typing-dot 1.2s .0s ease infinite; }
    .cb-typing-dots i:nth-child(2) { animation: typing-dot 1.2s .2s ease infinite; }
    .cb-typing-dots i:nth-child(3) { animation: typing-dot 1.2s .4s ease infinite; }
    .cb-typing-label {
      font-family: var(--cb-font);
      font-size: 12px;
      line-height: 1.3;
      color: var(--cb-ink-2);
    }
    @media (prefers-reduced-motion: reduce) {
      .cb-typing-dots i { animation: none !important; }
    }

    /* ── UI-3 · Welcome screen ── */
    .cb-welcome {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
      padding: 4px 2px 2px;
      min-width: 0;
      animation: cb-turn-rise .26s cubic-bezier(.2,.7,.3,1) both;
    }
    .cb-welcome-mark {
      width: 38px;
      height: 38px;
      border-radius: 11px;
      background: linear-gradient(135deg, #00e676, #00c853);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #04210f;
      flex: 0 0 38px;
    }
    .cb-welcome-mark svg { width: 23px; height: 23px; display: block; }
    .cb-welcome-head {
      margin: 2px 0 0;
      font-family: var(--cb-font);
      font-size: 18px;
      font-weight: 650;
      line-height: 1.3;
      letter-spacing: -.02em;
      color: var(--cb-ink);
    }
    .cb-welcome-sub {
      margin: 0;
      font-family: var(--cb-font);
      font-size: 13px;
      line-height: 1.55;
      color: var(--cb-ink-2);
      max-width: 33ch;
    }
    .cb-startwith {
      font-family: var(--cb-font);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: var(--cb-ink-3);
      margin-top: 2px;
    }
    .cb-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      width: 100%;
    }
    .cb-action {
      font-family: var(--cb-font);
      font-size: 12.5px;
      font-weight: 600;
      line-height: 1.35;
      text-align: left;
      padding: 10px 11px;
      border-radius: 10px;
      background: rgba(0,230,118,.07);
      border: 1px solid rgba(0,230,118,.2);
      color: var(--cb-green);
      cursor: pointer;
      transition: background .15s, border-color .15s;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .cb-action:hover { background: rgba(0,230,118,.14); border-color: rgba(0,230,118,.4); }
    .cb-action:focus-visible { outline: 2px solid #00e676; outline-offset: 2px; }
    .cb-welcome-chips { display: flex; flex-wrap: wrap; gap: 6px; }

    /* ── UI-4 · Suggestion chips ── */
    .cb-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .cb-chip {
      font-family: var(--cb-font);
      font-size: 12.5px;
      font-weight: 500;
      line-height: 1.3;
      padding: 7px 11px;
      border-radius: 999px;
      background: rgba(255,255,255,.04);
      border: 1px solid var(--cb-hair-2);
      color: var(--cb-ink);
      cursor: pointer;
      max-width: 100%;
      overflow-wrap: anywhere;
      transition: background .15s, border-color .15s, color .15s;
    }
    .cb-chip:hover, .cb-chip:focus-visible {
      background: rgba(0,230,118,.12);
      border-color: var(--cb-green);
      color: var(--cb-green);
    }
    .cb-chip:focus-visible { outline: 2px solid #00e676; outline-offset: 2px; }

    /* ── UI-7 … UI-10 · Response cards ── */
    .cb-cards { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .cb-card {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 7px;
      padding: 11px 12px 11px 14px;
      border: 1px solid var(--cb-hair-2);
      border-radius: 12px;
      background: rgba(255,255,255,.03);
      box-shadow: none;
      min-width: 0;
      overflow: hidden;
      font-family: var(--cb-font);
      --cb-tone: var(--cb-slate);
    }
    .cb-card::before {
      content: '';
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 3px;
      background: var(--cb-tone);
    }
    .cb-tone-blue   { --cb-tone: var(--cb-blue); }
    .cb-tone-amber  { --cb-tone: var(--cb-amber); }
    .cb-tone-green  { --cb-tone: var(--cb-green); }
    .cb-tone-red    { --cb-tone: var(--cb-red); }
    .cb-tone-violet { --cb-tone: var(--cb-violet); }
    .cb-tone-slate  { --cb-tone: var(--cb-slate); }
    .cb-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
    .cb-eyebrow {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: .1em;
      text-transform: uppercase;
      color: var(--cb-ink-3);
    }
    /* Neutral pill on purpose — the 3px stripe is the only accent device (§48). */
    .cb-status-pill {
      font-size: 10.5px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--cb-hair-2);
      background: rgba(255,255,255,.04);
      color: var(--cb-ink-2);
      white-space: nowrap;
    }
    .cb-card-title {
      font-size: 13.5px;
      font-weight: 600;
      line-height: 1.35;
      color: var(--cb-ink);
      overflow-wrap: anywhere;
    }
    .cb-amount-lead {
      font-size: 18px;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: -.01em;
      color: var(--cb-ink);
      font-variant-numeric: tabular-nums;
    }
    .cb-fields {
      margin: 0;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 4px 12px;
      min-width: 0;
    }
    .cb-field { display: contents; }
    .cb-fields dt { font-size: 11.5px; line-height: 1.5; color: var(--cb-ink-3); white-space: nowrap; }
    .cb-fields dd {
      margin: 0;
      font-size: 12.5px;
      line-height: 1.5;
      color: var(--cb-ink);
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
      min-width: 0;
    }
    .cb-fields dd.cb-mono { font-family: var(--cb-mono); font-size: 12px; }
    .cb-card-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--cb-ink-2); overflow-wrap: anywhere; }
    .cb-card-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .cb-card-btn {
      font-family: var(--cb-font);
      font-size: 12px;
      font-weight: 600;
      line-height: 1.2;
      padding: 8px 11px;
      border-radius: 9px;
      background: rgba(0,230,118,.09);
      border: 1px solid rgba(0,230,118,.22);
      color: var(--cb-green);
      text-decoration: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      transition: background .15s, border-color .15s;
    }
    .cb-card-btn:hover { background: rgba(0,230,118,.16); border-color: rgba(0,230,118,.42); }
    .cb-card-btn:focus-visible { outline: 2px solid #00e676; outline-offset: 2px; }

    /* UI-9 coupon card */
    .cb-coupon-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .cb-brand-plate {
      width: 26px; height: 26px; flex: 0 0 26px;
      border-radius: 8px;
      background: rgba(0,230,118,.14);
      border: 1px solid var(--cb-hair);
      color: var(--cb-green);
      font-size: 12.5px;
      font-weight: 700;
      display: flex; align-items: center; justify-content: center;
    }
    .cb-brand {
      font-size: 13px; font-weight: 600; color: var(--cb-ink);
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cb-discount {
      margin-left: auto;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 6px;
      background: rgba(0,230,118,.12);
      border: 1px solid var(--cb-hair-strong);
      color: var(--cb-green);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      flex: 0 0 auto;
    }
    .cb-price-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
    .cb-price { font-size: 16px; font-weight: 700; color: var(--cb-ink); font-variant-numeric: tabular-nums; }
    .cb-face {
      font-size: 12px; color: var(--cb-ink-3);
      text-decoration: line-through;
      font-variant-numeric: tabular-nums;
    }
    .cb-stock { margin-left: auto; font-size: 11.5px; color: var(--cb-ink-2); font-variant-numeric: tabular-nums; }
    .cb-stock.cb-stock-green { color: #69f0ae; }
    .cb-stock.cb-stock-amber { color: var(--cb-amber); }
    .cb-stock.cb-stock-red { color: #ff8585; }

    /* Error & system messages */
    .cb-sys-msg {
      align-self: center;
      font-family: var(--cb-font);
      font-size: 12px;
      line-height: 1.5;
      color: var(--cb-ink-3);
      background: rgba(255,255,255,.03);
      border: 1px solid var(--cb-hair);
      border-radius: 8px;
      padding: 7px 12px;
      text-align: center;
      max-width: 92%;
    }
    .cb-sys-msg.cb-error {
      color: #ff8585;
      border-color: rgba(255,107,107,.18);
      background: rgba(255,107,107,.05);
    }
    .cb-divider {
      align-self: stretch;
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--cb-font);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: .1em;
      text-transform: uppercase;
      color: var(--cb-ink-3);
    }
    .cb-divider::before, .cb-divider::after {
      content: ''; flex: 1; height: 1px; background: var(--cb-hair-2);
    }

    /* ── §45 · Composer ── */
    .chatbot-input-area {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid rgba(0,230,118,.1);
      background: rgba(6,13,31,.6);
      flex-shrink: 0;
    }
    .chatbot-textarea {
      flex: 1;
      min-width: 0;
      background: rgba(255,255,255,.05);
      border: 1.5px solid rgba(0,230,118,.15);
      border-radius: 12px;
      color: var(--cb-ink);
      font-family: var(--cb-font);
      font-size: 13.5px;
      padding: 10px 14px;
      resize: none;
      outline: none;
      min-height: 42px;
      line-height: 1.5;
      transition: border-color .15s;
      overflow-y: hidden;
    }
    .chatbot-textarea:focus { border-color: rgba(0,230,118,.45); }
    .chatbot-textarea:focus-visible { outline: 2px solid #00e676; outline-offset: 1px; }
    .chatbot-textarea::placeholder { color: var(--cb-ink-3); }
    .chatbot-textarea:disabled { opacity: .6; cursor: not-allowed; }
    .chatbot-send-btn {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      background: linear-gradient(135deg, #00e676, #00c853);
      border: none;
      color: #060d1f;
      font-size: 1.1rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: opacity .15s, transform .15s;
    }
    .chatbot-send-btn:hover { opacity: .85; transform: scale(1.06); }
    .chatbot-send-btn:disabled { opacity: .4; cursor: not-allowed; transform: none; }
    .chatbot-send-btn:focus-visible { outline: 2px solid #00e676; outline-offset: 2px; }

    /* Composer touch targets, declared after the base rules above so the
       min-height actually wins. The send button keeps its exact 42px box and
       gains a centred invisible ::after; nothing sits to its right, so the
       overlay cannot steal a neighbour's tap. The textarea has to stay a real
       text box, so it grows to a 44px minimum instead — autoResize() only ever
       sets an inline height, which min-height still overrides.
       Chips, welcome actions and card buttons use the same invisible-overlay
       technique; their row gaps are widened to 12px in the same block so a
       44px overlay cannot reach a neighbour on the next line. */
    @media (max-width: 768px), (max-height:500px) and (orientation:landscape) {
      .chatbot-send-btn { position: relative; }
      .chatbot-send-btn::after {
        content: ''; position: absolute; top: 50%; left: 50%;
        width: 44px; height: 44px; transform: translate(-50%, -50%);
      }
      .chatbot-textarea { min-height: 44px; }

      .cb-chips, .cb-welcome-chips, .cb-card-actions { gap: 12px 8px; }
      .cb-actions { gap: 12px 8px; }
      .cb-chip, .cb-action, .cb-card-btn { position: relative; }
      .cb-chip::after, .cb-action::after, .cb-card-btn::after {
        content: ''; position: absolute; left: 0; right: 0;
        top: 50%; height: 44px; transform: translateY(-50%);
      }
    }

    /* ── §47 · Footer: 47.1 disclosure + char counter share one row ── */
    .chatbot-footer {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 10px;
      padding: 6px 14px 8px;
      border-top: 1px solid rgba(0,230,118,.08);
      flex-shrink: 0;
    }
    .chatbot-disclosure {
      font-family: var(--cb-font);
      font-size: 10px;
      line-height: 1.45;
      color: var(--cb-ink-3);
      min-width: 0;
      flex: 1;
    }
    .chatbot-disclosure a { color: #00e676; text-decoration: underline; }
    .chatbot-char-count {
      font-family: var(--cb-font);
      font-size: 10px;
      line-height: 1.45;
      color: var(--cb-ink-3);
      text-align: right;
      font-variant-numeric: tabular-nums;
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .chatbot-char-count.near-limit { color: var(--cb-amber); }
    .chatbot-char-count.at-limit { color: var(--cb-red); }

    /* Parity in high-contrast / forced-colours mode (§48) */
    @media (prefers-contrast: more) {
      .chatbot-window { border-color: #00e676; }
      .cb-card, .cb-chip, .cb-status-pill { border-color: rgba(255,255,255,.5); }
      .cb-turn.cb-ai .cb-bubble { border-color: rgba(255,255,255,.4); }
      .chatbot-disclosure, .cb-ts, .cb-eyebrow, .cb-fields dt { color: #cfe0f5; }
    }
    @media (forced-colors: active) {
      .chatbot-window, .cb-card, .cb-chip, .cb-action, .cb-card-btn,
      .cb-turn .cb-bubble, .cb-status-pill, .cb-typing {
        border: 1px solid CanvasText;
        background: Canvas;
        color: CanvasText;
      }
      .cb-card::before { forced-color-adjust: none; }
      .chatbot-icon-btn, .chatbot-send-btn { border: 1px solid CanvasText; }
    }
  `;

  const MARKUP = `
<!-- Floating launcher -->
<button
  id="chatbotFab"
  class="chatbot-fab"
  type="button"
  aria-label="Open SaveHatke AI Assistant"
  aria-expanded="false"
  aria-controls="chatbotWindow"
>
  <svg class="cb-icon-open" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
    <!-- One path, knocked out with evenodd so the gradient shows through the three
         dots. The silhouette is a coupon ticket — notched on both short edges —
         with a speech tail, so it reads as "chat" at a glance but stays specific
         to SaveHatke rather than being another generic message bubble. -->
    <path fill="currentColor" fill-rule="evenodd" d="
      M6 4 H22 A3.5 3.5 0 0 1 25.5 7.5 V8.9 A2.6 2.6 0 0 0 25.5 14.1 V15.5
      A3.5 3.5 0 0 1 22 19 H14.5 L7 23.9 L10.2 19 H6
      A3.5 3.5 0 0 1 2.5 15.5 V14.1 A2.6 2.6 0 0 0 2.5 8.9 V7.5 A3.5 3.5 0 0 1 6 4 Z
      M8.6 11.5 a1.4 1.4 0 1 0 2.8 0 a1.4 1.4 0 1 0 -2.8 0
      M12.6 11.5 a1.4 1.4 0 1 0 2.8 0 a1.4 1.4 0 1 0 -2.8 0
      M16.6 11.5 a1.4 1.4 0 1 0 2.8 0 a1.4 1.4 0 1 0 -2.8 0
    "/>
  </svg>
</button>

<!-- Chat window (opens on top of the launcher) -->
<div
  id="chatbotWindow"
  class="chatbot-window"
  role="dialog"
  aria-modal="true"
  aria-label="SaveHatke AI Assistant"
  aria-hidden="true"
>
  <!-- UI-1 · header: name, status, tagline and actions share one row band -->
  <div class="chatbot-header">
    <div class="chatbot-header-left">
      <span class="chatbot-avatar" aria-hidden="true">${AI_MARK}</span>
      <span class="chatbot-header-text">
        <span class="chatbot-header-name">${STR.name}</span>
        <span class="chatbot-header-status">
          <span class="chatbot-status-dot" id="cbStatusDot" aria-hidden="true"></span>
          <span class="chatbot-status-state" id="cbStatusText">${STR.statusOnline}</span>
          <span class="chatbot-status-sep" aria-hidden="true">·</span>
          <span class="chatbot-tagline">${STR.tagline}</span>
        </span>
      </span>
    </div>
    <div class="chatbot-header-actions">
      <button class="chatbot-icon-btn" id="chatbotNewChat" type="button" aria-label="Start a new chat" title="New chat">&#8635;</button>
      <button class="chatbot-icon-btn" id="chatbotMinimise" type="button" aria-label="Minimise chat" title="Minimise">&#8211;</button>
      <button class="chatbot-icon-btn" id="chatbotClose" type="button" aria-label="Close chat" title="Close">&#10005;</button>
    </div>
  </div>

  <!-- UI-2 / §44 · connection strip (hidden while connected) -->
  <div class="cb-strip" id="cbStrip" role="status">
    <span class="cb-strip-mark" id="cbStripMark" aria-hidden="true"></span>
    <span id="cbStripText"></span>
  </div>

  <div
    id="chatbotMessages"
    class="chatbot-messages"
    aria-live="polite"
    aria-label="Chat messages"
    role="log"
  ></div>

  <p class="cb-sr-only" id="cbLive" role="status" aria-live="polite" aria-atomic="true"></p>

  <div class="chatbot-input-area">
    <textarea
      id="chatbotTextarea"
      class="chatbot-textarea"
      placeholder="${STR.placeholders[0]}"
      rows="1"
      aria-label="Type your message"
      maxlength="500"
    ></textarea>
    <button
      id="chatbotSendBtn"
      class="chatbot-send-btn"
      type="button"
      aria-label="Send message"
      disabled
    >&#10148;</button>
  </div>

  <!-- §47.1 · permanently visible; the counter shares the row, right-aligned -->
  <div class="chatbot-footer">
    <span class="chatbot-disclosure" id="cbDisclosure">${STR.disclosure}
      <a href="privacy" tabindex="-1">Privacy Policy</a></span>
    <span class="chatbot-char-count" id="cbCharCount" aria-live="polite" aria-atomic="true"></span>
  </div>
</div>
  `;

  /** Inject styles + markup, then wire up the widget. */
  function mount() {
    if (document.getElementById('chatbotFab')) return; // already on the page

    const style = document.createElement('style');
    style.id = 'sh-chatbot-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);

    const host = document.createElement('div');
    host.id = 'sh-chatbot-root';
    host.innerHTML = MARKUP;
    // Move the two top-level nodes to <body> so position:fixed isn't affected
    // by any transformed/filtered ancestor.
    while (host.firstElementChild) document.body.appendChild(host.firstElementChild);

    init();
  }

  /* ═══════════════════════════════════════════════
     SAVEHATKE AI CHATBOT — Logic
  ═══════════════════════════════════════════════ */
  function init() {
    const PREV_KEY = 'sh_cb_prev_thread';
    const GREET_KEY = 'sh_cb_greet_index';
    const GREET_SESSION_KEY = 'sh_cb_greet_session';
    const SEEN_KEY = 'sh_cb_seen';

    let MAX_LEN = 500;                       // §45 — 500-character guidance
    let nearLimit = Math.round(MAX_LEN * 0.8); // counter appears only near the limit
    let chatConfig = null;
    let conversationId = null;
    let isBusy = false;
    let isOpen = false;
    let disabledByConfig = false;
    let conn = (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'offline' : 'connected';
    let lastTypingText = null;
    let placeholderIdx = 0;
    let placeholderTimer = null;
    let welcomeEl = null;
    let lastAttempt = null;                  // for the §42.1 "Try again" chip
    const transcript = [];                   // text turns only — see savePrevThread()

    const fab        = document.getElementById('chatbotFab');
    const win        = document.getElementById('chatbotWindow');
    const msgs       = document.getElementById('chatbotMessages');
    const textarea   = document.getElementById('chatbotTextarea');
    const sendBtn    = document.getElementById('chatbotSendBtn');
    const charCount  = document.getElementById('cbCharCount');
    const newChatBtn = document.getElementById('chatbotNewChat');
    const minBtn     = document.getElementById('chatbotMinimise');
    const closeBtn   = document.getElementById('chatbotClose');
    const statusDot  = document.getElementById('cbStatusDot');
    const statusText = document.getElementById('cbStatusText');
    const strip      = document.getElementById('cbStrip');
    const stripMark  = document.getElementById('cbStripMark');
    const stripText  = document.getElementById('cbStripText');
    const liveRegion = document.getElementById('cbLive');

    /* ── Storage (never throws — private mode / blocked storage) ── */
    const LS = {
      get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
      set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
      del(k) { try { localStorage.removeItem(k); } catch (e) {} },
    };
    const SS = {
      get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
      set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
    };

    /* ── Helpers ── */
    function escHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function inlineMarkdown(raw) {
      let s = escHtml(raw);
      s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      return s;
    }

    /** Assistant copy → HTML. Bullet runs become green-dot lists (UI-5). */
    function renderRich(raw) {
      const lines = String(raw == null ? '' : raw).replace(/\r/g, '').split('\n');
      let html = '';
      let list = [];
      let para = [];
      const flushList = () => {
        if (!list.length) return;
        html += '<ul class="cb-list">' + list.map(li => '<li>' + inlineMarkdown(li) + '</li>').join('') + '</ul>';
        list = [];
      };
      const flushPara = () => {
        if (!para.length) return;
        html += (html ? '<div class="cb-para">' : '<div>') + para.map(inlineMarkdown).join('<br>') + '</div>';
        para = [];
      };
      lines.forEach(line => {
        const bullet = line.match(/^\s*(?:[-•]|\*(?!\*))\s+(.*)$/);
        if (bullet) { flushPara(); list.push(bullet[1]); return; }
        flushList();
        if (line.trim() === '') { flushPara(); return; }
        para.push(line);
      });
      flushPara();
      flushList();
      return html;
    }

    function formatTime() {
      return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    }

    function scrollBottom() { msgs.scrollTop = msgs.scrollHeight; }

    function announce(text) {
      if (!liveRegion) return;
      liveRegion.textContent = '';
      // A fresh text node on the next tick makes repeat announcements reliable.
      setTimeout(() => { liveRegion.textContent = text; }, 30);
    }

    function isSignedIn() { return !!LS.get('sh_token'); }

    /** Opaque per-account key — compared, never displayed (§38 privacy rule). */
    function userKey() {
      const raw = LS.get('sh_user');
      if (!raw) return 'signed-in';
      try {
        const u = JSON.parse(raw);
        const id = u && (u.id || u._id || u.email);
        return id ? String(id) : 'signed-in';
      } catch (e) { return 'signed-in'; }
    }

    /** Only relative or http(s)/mailto/tel links may become a card action. */
    function safeHref(raw) {
      const h = String(raw == null ? '' : raw).trim();
      if (!h) return null;
      const scheme = h.match(/^([a-z][a-z0-9+.\-]*):/i);
      if (scheme && !/^(https?|mailto|tel)$/i.test(scheme[1])) return null;
      return h;
    }

    /* ── Turn construction (UI-5) ── */
    function createTurn(role) {
      const turn = document.createElement('div');
      turn.className = 'cb-turn ' + (role === 'user' ? 'cb-user' : 'cb-ai');
      const rail = document.createElement('div');
      rail.className = 'cb-rail';
      rail.setAttribute('aria-hidden', 'true');
      rail.innerHTML = role === 'user' ? USER_MARK : AI_MARK;
      const stack = document.createElement('div');
      stack.className = 'cb-stack';
      turn.appendChild(rail);
      turn.appendChild(stack);
      turn.__stack = stack;
      return turn;
    }

    function addBubble(turn, html) {
      const bubble = document.createElement('div');
      bubble.className = 'cb-bubble';
      bubble.innerHTML = html;
      turn.__stack.appendChild(bubble);
      return bubble;
    }

    function addTimestamp(turn) {
      const ts = document.createElement('div');
      ts.className = 'cb-ts';
      ts.textContent = formatTime();
      turn.__stack.appendChild(ts);
    }

    function commitTurn(turn) {
      const prev = msgs.lastElementChild;
      if (prev && prev.classList && prev.classList.contains('cb-turn') &&
          prev.classList.contains('cb-ai') && turn.classList.contains('cb-ai')) {
        turn.classList.add('cb-cont');
      }
      msgs.appendChild(turn);
      scrollBottom();
    }

    function appendUserTurn(text) {
      const turn = createTurn('user');
      const bubble = document.createElement('div');
      bubble.className = 'cb-bubble';
      bubble.textContent = text;
      turn.__stack.appendChild(bubble);
      addTimestamp(turn);
      commitTurn(turn);
      transcript.push({ role: 'user', text: text });
    }

    function appendSystem(msg, isError) {
      const el = document.createElement('div');
      el.className = 'cb-sys-msg' + (isError ? ' cb-error' : '');
      el.textContent = msg;
      msgs.appendChild(el);
      scrollBottom();
    }

    /* ── UI-6 · typing indicator ── */
    let typingTurn = null;
    function typingLabelFor(intent) {
      const chain = TYPING_CHAIN[intent] || TYPING_CHAIN.general;
      for (let i = 0; i < chain.length; i++) {
        if (TYPING[chain[i]] !== lastTypingText) return TYPING[chain[i]];
      }
      // Only reachable for `general`: substituting anything else would describe
      // work that is not in flight, which §49 forbids. Truth wins over rotation.
      return TYPING[chain[chain.length - 1]];
    }
    function showTyping(intent) {
      if (typingTurn) return;
      const label = typingLabelFor(intent);
      lastTypingText = label;
      typingTurn = createTurn('ai');
      const box = document.createElement('div');
      box.className = 'cb-typing';
      box.innerHTML = '<span class="cb-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
        '<span class="cb-typing-label">' + escHtml(label) + '</span>';
      typingTurn.__stack.appendChild(box);
      msgs.appendChild(typingTurn);
      scrollBottom();
      announce(label);
    }
    function hideTyping() {
      if (typingTurn && typingTurn.parentElement) typingTurn.parentElement.removeChild(typingTurn);
      typingTurn = null;
    }

    /* ── UI-4 · chips ── */
    function clearChipRows() {
      const rows = msgs.querySelectorAll('.cb-chips');
      for (let i = 0; i < rows.length; i++) rows[i].parentElement.removeChild(rows[i]);
    }

    /**
     * Server-owned labels. The client validates shape and count only: it never
     * invents a chip, and it drops a chip that repeats an action a card in the
     * same turn already carries (§46 — an action appears once per turn).
     */
    function normaliseChips(raw, usedLabels) {
      if (!Array.isArray(raw)) return [];
      const seen = Object.create(null);
      const out = [];
      for (let i = 0; i < raw.length && out.length < 4; i++) {
        if (typeof raw[i] !== 'string') continue;
        const label = raw[i].trim();
        if (!label || label.length > 40) continue;
        const key = label.toLowerCase();
        if (seen[key]) continue;
        if (usedLabels && usedLabels.indexOf(key) >= 0) continue;
        seen[key] = true;
        out.push(label);
      }
      return out.length >= 2 ? out : [];   // two to four per reply, or none
    }

    function addChips(turn, labels, handler) {
      const row = document.createElement('div');
      row.className = 'cb-chips';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Suggested follow-ups');
      labels.forEach(label => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cb-chip';
        btn.textContent = label;
        btn.addEventListener('click', () => {
          if (handler) { handler(label); return; }
          // Tapping a chip sends that label as the user's message (UI-4).
          sendMessage(label, { intent: INTENT_BY_LABEL[label.toLowerCase()] || 'general' });
        });
        row.appendChild(btn);
      });
      turn.__stack.appendChild(row);
    }

    /* ── §40 · support wording, chosen from the backend flags only ── */
    function addSupportNote(turn, support) {
      let text;
      if (support.available === true) {
        text = STR.supportAvailable;                                    // 40.1
      } else {
        const hours = typeof support.hours === 'string' ? support.hours.trim() : '';
        text = STR.supportOfflineHead + ' ' +
          (hours ? STR.supportOfflineHours + hours + '. ' : '') +
          STR.supportOfflineTail;                                        // 40.2
      }
      const p = document.createElement('p');
      p.className = 'cb-support-note';
      p.textContent = text;
      turn.__stack.appendChild(p);
    }

    /* ── UI-7 … UI-10 · cards ─────────────────────────────────────────────
       Every value is rendered verbatim from the payload. Nothing is computed,
       totalled, re-ranked, re-priced, rounded or translated here. A coupon code
       is never rendered: the payload never carries one, and any field that
       looks like one on a coupon card is dropped defensively.
    ─────────────────────────────────────────────────────────────────────── */
    function fieldRows(fields, skipLabels, dropCodeLike) {
      if (!Array.isArray(fields)) return '';
      let rows = '';
      fields.forEach(f => {
        if (!f || typeof f !== 'object') return;
        const label = typeof f.label === 'string' ? f.label.trim() : '';
        const value = f.value == null ? '' : String(f.value);
        if (!label && !value) return;
        const key = label.toLowerCase();
        if (skipLabels && skipLabels.indexOf(key) >= 0) return;
        if (dropCodeLike && /\bcodes?\b/i.test(label)) return;
        rows += '<div class="cb-field"><dt>' + escHtml(label) + '</dt>' +
          '<dd' + (f.mono ? ' class="cb-mono"' : '') + '>' + escHtml(value) + '</dd></div>';
      });
      return rows ? '<dl class="cb-fields">' + rows + '</dl>' : '';
    }

    function actionButtons(list, tone, usedLabels) {
      const items = [];
      (list || []).forEach(a => {
        if (!a || typeof a !== 'object') return;
        const label = typeof a.label === 'string' ? a.label.trim() : '';
        const href = safeHref(a.href);
        if (!label || !href) return;
        // An expired / unavailable listing (red) is never presented as buyable.
        if (tone === 'red' && /^buy now$/i.test(label)) return;
        if (usedLabels) usedLabels.push(label.toLowerCase());
        items.push('<a class="cb-card-btn" href="' + escHtml(href) + '">' + escHtml(label) + '</a>');
      });
      return items.length ? '<div class="cb-card-actions">' + items.join('') + '</div>' : '';
    }

    function renderCard(card, usedLabels) {
      if (!card || typeof card !== 'object') return null;
      const kind = CARD_KINDS.indexOf(card.kind) >= 0 ? card.kind : '';
      let tone = TONES.indexOf(card.tone) >= 0 ? card.tone : 'slate';
      let status = typeof card.status === 'string' ? card.status.trim() : '';
      if (!status) { status = STR.unknownStatus; tone = 'slate'; }  // UI-7 card rule

      const eyebrowRaw = typeof card.eyebrow === 'string' && card.eyebrow.trim()
        ? card.eyebrow.trim()
        : (DEFAULT_EYEBROW[kind] || '');
      const title = typeof card.title === 'string' ? card.title.trim() : '';
      const note = typeof card.note === 'string' ? card.note.trim() : '';

      const el = document.createElement('article');
      el.className = 'cb-card cb-tone-' + tone + (kind ? ' cb-card-' + kind : '');
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', (eyebrowRaw ? eyebrowRaw + ': ' : '') + status);

      let html = '';

      if (kind === 'coupon') {
        const brand = typeof card.brand === 'string' ? card.brand.trim() : '';
        const initialRaw = typeof card.brandInitial === 'string' ? card.brandInitial.trim() : '';
        const initial = initialRaw.slice(0, 1);
        const badge = typeof card.discountBadge === 'string' ? card.discountBadge.trim() : '';
        const price = typeof card.price === 'string' ? card.price.trim() : '';
        const face = typeof card.faceValue === 'string' ? card.faceValue.trim() : '';
        const stock = typeof card.stock === 'string' ? card.stock.trim() : '';
        const stockTone = TONES.indexOf(card.stockTone) >= 0 ? card.stockTone : '';
        const expiry = typeof card.expiry === 'string' ? card.expiry.trim() : '';

        if (brand || initial || badge) {
          html += '<div class="cb-coupon-head">' +
            (initial ? '<span class="cb-brand-plate" aria-hidden="true">' + escHtml(initial) + '</span>' : '') +
            (brand ? '<span class="cb-brand">' + escHtml(brand) + '</span>' : '') +
            (badge ? '<span class="cb-discount">' + escHtml(badge) + '</span>' : '') +
            '</div>';
        }
        if (status !== STR.unknownStatus && eyebrowRaw) {
          html += '<div class="cb-card-head"><span class="cb-eyebrow">' + escHtml(eyebrowRaw) + '</span>' +
            '<span class="cb-status-pill">' + escHtml(status) + '</span></div>';
        } else if (status === STR.unknownStatus) {
          html += '<div class="cb-card-head">' +
            (eyebrowRaw ? '<span class="cb-eyebrow">' + escHtml(eyebrowRaw) + '</span>' : '') +
            '<span class="cb-status-pill">' + escHtml(status) + '</span></div>';
        }
        if (title) html += '<div class="cb-card-title">' + escHtml(title) + '</div>';
        if (price || face || stock) {
          html += '<div class="cb-price-row">' +
            (price ? '<span class="cb-price">' + escHtml(price) + '</span>' : '') +
            (face ? '<span class="cb-face">' + escHtml(face) + '</span>' : '') +
            (stock ? '<span class="cb-stock' + (stockTone ? ' cb-stock-' + stockTone : '') + '">' +
              escHtml(stock) + '</span>' : '') +
            '</div>';
        }
        let rows = '';
        if (expiry) {
          rows += '<div class="cb-field"><dt>Expires</dt><dd>' + escHtml(expiry) + '</dd></div>';
        }
        const extra = fieldRows(card.fields, ['expires', 'expiry'], true);
        if (rows || extra) {
          html += extra
            ? (rows ? '<dl class="cb-fields">' + rows + '</dl>' : '') + extra
            : '<dl class="cb-fields">' + rows + '</dl>';
        }
        if (note) html += '<p class="cb-card-note">' + escHtml(note) + '</p>';
        const list = Array.isArray(card.actions) && card.actions.length
          ? card.actions.slice(0, 3)
          : (card.action ? [card.action] : []);
        html += actionButtons(list, tone, usedLabels);
      } else {
        html += '<div class="cb-card-head">' +
          (eyebrowRaw ? '<span class="cb-eyebrow">' + escHtml(eyebrowRaw) + '</span>' : '') +
          '<span class="cb-status-pill">' + escHtml(status) + '</span></div>';
        if (title) html += '<div class="cb-card-title">' + escHtml(title) + '</div>';

        // UI-10: transaction and payout cards lead with the amount, displayed large.
        let skip = [];
        if (kind === 'transaction' || kind === 'payout') {
          const amount = (Array.isArray(card.fields) ? card.fields : []).filter(f =>
            f && typeof f.label === 'string' && f.label.trim().toLowerCase() === 'amount')[0];
          if (amount && amount.value != null && String(amount.value).trim()) {
            html += '<div class="cb-amount-lead"><span class="cb-sr-only">Amount </span>' +
              escHtml(String(amount.value)) + '</div>';
            skip = ['amount'];
          }
        }
        html += fieldRows(card.fields, skip, false);
        if (note) {
          html += kind === 'transaction'
            ? '<dl class="cb-fields"><div class="cb-field"><dt>Note</dt><dd>' + escHtml(note) + '</dd></div></dl>'
            : '<p class="cb-card-note">' + escHtml(note) + '</p>';
        }
        const list = card.action ? [card.action] : (Array.isArray(card.actions) ? card.actions.slice(0, 1) : []);
        html += actionButtons(list, tone, usedLabels);
      }

      el.innerHTML = html;
      return el;
    }

    /* ── Reply rendering: fixed order text → card → chips (UI-5) ── */
    function renderReply(data) {
      clearChipRows();

      const rawReply = data && (typeof data.reply === 'string' ? data.reply
        : (typeof data.message === 'string' ? data.message : null));
      const cards = data && Array.isArray(data.cards) ? data.cards.slice(0, 3) : [];
      const support = data && data.support && typeof data.support === 'object' ? data.support : null;

      if (!rawReply && !cards.length) return false;

      const turn = createTurn('ai');
      if (rawReply) {
        addBubble(turn, renderRich(rawReply));
        transcript.push({ role: 'ai', text: rawReply });
      }
      if (support && typeof support.available === 'boolean') addSupportNote(turn, support);

      const usedLabels = [];
      if (cards.length) {
        const wrap = document.createElement('div');
        wrap.className = 'cb-cards';
        cards.forEach(c => {
          const el = renderCard(c, usedLabels);
          if (el) wrap.appendChild(el);
        });
        if (wrap.childElementCount) turn.__stack.appendChild(wrap);
      }

      const chips = normaliseChips(data && data.chips, usedLabels);
      if (chips.length) addChips(turn, chips);
      addTimestamp(turn);
      commitTurn(turn);
      if (rawReply) announce(rawReply);
      return true;
    }

    /** §42.1 — retrieval failure. Paired with Try again + Contact support. */
    function renderRetrievalError(attempt) {
      clearChipRows();
      const turn = createTurn('ai');
      addBubble(turn, renderRich(STR.retrieveFailed));
      addChips(turn, [STR.tryAgain, STR.contactSupport], label => {
        if (label === STR.tryAgain) {
          if (attempt) sendMessage(attempt.text, { intent: attempt.intent, retry: true });
          return;
        }
        sendMessage(label, { intent: INTENT_BY_LABEL[label.toLowerCase()] || 'general' });
      });
      addTimestamp(turn);
      commitTurn(turn);
      announce(STR.retrieveFailed);
    }

    /* ── UI-3 · welcome screen ── */
    function sessionGreeting() {
      let idx = SS.get(GREET_SESSION_KEY);
      if (idx === null || idx === undefined) {
        let stored = parseInt(LS.get(GREET_KEY) || '0', 10);
        if (!(stored >= 0 && stored < GREETINGS.length)) stored = 0;
        SS.set(GREET_SESSION_KEY, String(stored));
        LS.set(GREET_KEY, String((stored + 1) % GREETINGS.length));  // next session
        idx = stored;
      }
      const n = parseInt(idx, 10);
      return GREETINGS[(n >= 0 && n < GREETINGS.length) ? n : 0];
    }

    function loadPrevThread() {
      if (!isSignedIn()) return null;   // a guest has no thread of their own
      const raw = LS.get(PREV_KEY);
      if (!raw) return null;
      try {
        const t = JSON.parse(raw);
        if (!t || !Array.isArray(t.turns) || !t.turns.length) return null;
        if (t.userKey !== userKey()) return null;
        return t;
      } catch (e) { return null; }
    }

    function savePrevThread() {
      if (!isSignedIn()) return;
      const turns = transcript.filter(t => t && typeof t.text === 'string').slice(-12);
      if (!turns.length) return;
      LS.set(PREV_KEY, JSON.stringify({
        userKey: userKey(),
        conversationId: conversationId,
        turns: turns,
      }));
    }

    function buildWelcome() {
      const signedIn = isSignedIn();
      const returning = LS.get(SEEN_KEY) === '1';
      const greet = returning ? sessionGreeting() : { head: STR.welcomeHead, sub: STR.welcomeSub };
      const prev = loadPrevThread();
      let actions = (signedIn ? ACTIONS_SIGNED_IN : ACTIONS_SIGNED_OUT).slice(0, 6);
      if (actions.length < 3) actions = ACTIONS_SIGNED_OUT.slice(0, 4);  // never fewer than three

      const el = document.createElement('div');
      el.className = 'cb-welcome';
      el.id = 'cbWelcome';

      const mark = document.createElement('div');
      mark.className = 'cb-welcome-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.innerHTML = AI_MARK;
      el.appendChild(mark);

      const head = document.createElement('h2');
      head.className = 'cb-welcome-head';
      head.textContent = greet.head;
      el.appendChild(head);

      const sub = document.createElement('p');
      sub.className = 'cb-welcome-sub';
      sub.textContent = greet.sub;
      el.appendChild(sub);

      // §39 — offered only when a prior thread genuinely exists for this user.
      if (prev) {
        const row = document.createElement('div');
        row.className = 'cb-welcome-chips';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cb-chip';
        btn.id = 'cbContinuePrev';
        btn.textContent = STR.continuePrevious;
        btn.addEventListener('click', () => restorePrevThread(prev));
        row.appendChild(btn);
        el.appendChild(row);
      }

      const label = document.createElement('div');
      label.className = 'cb-startwith';
      label.textContent = STR.startWith;
      el.appendChild(label);

      const grid = document.createElement('div');
      grid.className = 'cb-actions';
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', STR.startWith);
      actions.forEach(a => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cb-action';
        btn.textContent = a.label;
        btn.addEventListener('click', () => sendMessage(a.label, { intent: a.intent || 'general' }));
        grid.appendChild(btn);
      });
      el.appendChild(grid);

      msgs.appendChild(el);
      welcomeEl = el;
      scrollBottom();
    }

    /** Removed on the first message; restored only by "new chat" (UI-3). */
    function dismissWelcome() {
      if (welcomeEl && welcomeEl.parentElement) welcomeEl.parentElement.removeChild(welcomeEl);
      welcomeEl = null;
    }

    /**
     * §39.1 — replays the stored text turns and reattaches the conversation, so
     * the thread stays readable. Cards and chips are deliberately NOT replayed:
     * their values were live backend readings and must not be shown again as if
     * they were current.
     */
    function restorePrevThread(prev) {
      dismissWelcome();
      const divider = document.createElement('div');
      divider.className = 'cb-divider';
      divider.textContent = STR.previousLabel;
      msgs.appendChild(divider);

      prev.turns.forEach(t => {
        if (!t || typeof t.text !== 'string') return;
        if (t.role === 'user') {
          const turn = createTurn('user');
          const bubble = document.createElement('div');
          bubble.className = 'cb-bubble';
          bubble.textContent = t.text;
          turn.__stack.appendChild(bubble);
          commitTurn(turn);
        } else {
          const turn = createTurn('ai');
          addBubble(turn, renderRich(t.text));
          commitTurn(turn);
        }
        transcript.push({ role: t.role === 'user' ? 'user' : 'ai', text: t.text });
      });

      conversationId = prev.conversationId || null;

      const turn = createTurn('ai');
      addBubble(turn, renderRich(STR.continueLine));
      addTimestamp(turn);
      commitTurn(turn);
      announce(STR.continueLine);
      if (isOpen) textarea.focus();
    }

    /* ── UI-2 / §44 · connection state ── */
    function setConn(next) {
      if (conn === next) return;
      conn = next;
      renderConn();
    }

    function renderConn() {
      statusDot.className = 'chatbot-status-dot' +
        (conn === 'offline' ? ' cb-dot-offline' : conn === 'reconnecting' ? ' cb-dot-warn' : '');
      statusText.textContent = conn === 'offline' ? STR.statusOffline
        : conn === 'reconnecting' ? STR.statusReconnecting
        : STR.statusOnline;

      if (conn === 'connected') {
        strip.className = 'cb-strip';
        stripMark.textContent = '';
        stripText.textContent = '';
      } else if (conn === 'offline') {
        strip.className = 'cb-strip is-visible cb-strip-red';
        stripMark.textContent = '×';
        stripText.textContent = STR.connectionLost;         // 44.1
        announce(STR.connectionLost);
      } else {
        strip.className = 'cb-strip is-visible cb-strip-amber';
        stripMark.textContent = '○';
        stripText.textContent = STR.statusReconnecting;
        announce(STR.statusReconnecting);
      }
      applyPlaceholder();
      updateSendBtn();
    }

    /* ── §45 · composer ── */
    function applyPlaceholder() {
      textarea.placeholder = conn === 'offline'
        ? STR.placeholderOffline                            // 45.4
        : STR.placeholders[placeholderIdx % STR.placeholders.length];
    }

    function startPlaceholderRotation() {
      stopPlaceholderRotation();
      placeholderTimer = setInterval(() => {
        if (!isOpen || conn === 'offline') return;
        if (textarea.value.length > 0) return;              // only while empty
        if (document.activeElement === textarea) return;    // …and unfocused
        placeholderIdx = (placeholderIdx + 1) % STR.placeholders.length;
        applyPlaceholder();
      }, 7000);
    }
    function stopPlaceholderRotation() {
      if (placeholderTimer) { clearInterval(placeholderTimer); placeholderTimer = null; }
    }

    function composerMaxHeight() {
      const cs = window.getComputedStyle(textarea);
      let lh = parseFloat(cs.lineHeight);
      if (!isFinite(lh) || lh <= 0) lh = parseFloat(cs.fontSize) * 1.5;
      const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
        parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      return Math.round(lh * 5 + chrome);                   // one line at rest → five
    }

    function autoResize() {
      const max = composerMaxHeight();
      textarea.style.height = 'auto';
      const next = Math.min(textarea.scrollHeight, max);
      textarea.style.height = next + 'px';
      textarea.style.overflowY = textarea.scrollHeight > max ? 'auto' : 'hidden';
    }

    function updateCharCount() {
      const len = textarea.value.length;
      if (len < nearLimit) {                                // counter only near the limit
        charCount.textContent = '';
        charCount.className = 'chatbot-char-count';
        return;
      }
      charCount.textContent = len + ' / ' + MAX_LEN;
      charCount.className = 'chatbot-char-count ' + (len >= MAX_LEN ? 'at-limit' : 'near-limit');
    }

    function updateSendBtn() {
      sendBtn.disabled = disabledByConfig || isBusy || conn === 'offline' ||
        textarea.value.trim().length === 0;
    }

    function setComposerDisabled(disabled) {
      disabledByConfig = !!disabled;
      textarea.disabled = !!disabled;
      updateSendBtn();
    }

    /* ── Send ── */
    async function sendMessage(text, opts) {
      const o = opts || {};
      const trimmed = String(text != null ? text : textarea.value).trim();
      if (!trimmed || isBusy || disabledByConfig) return;
      if (conn === 'offline') return;                       // send is disabled while offline
      if (trimmed.length > MAX_LEN) {
        appendSystem('That message is longer than ' + MAX_LEN + ' characters. Please shorten it and send again.', true);
        return;
      }

      dismissWelcome();
      if (text == null) {
        textarea.value = '';
        autoResize();
        updateCharCount();
      }
      appendUserTurn(trimmed);
      LS.set(SEEN_KEY, '1');
      lastAttempt = { text: trimmed, intent: o.intent || 'general' };

      isBusy = true;
      updateSendBtn();
      showTyping(o.intent || 'general');

      try {
        const body = { message: trimmed };
        if (conversationId) body.conversationId = conversationId;

        // Attach the session token so the backend can identify logged-in
        // users (user-tier rate limits + their own account data via tools)
        const headers = { 'Content-Type': 'application/json' };
        const token = LS.get('sh_token');
        if (token) headers['Authorization'] = 'Bearer ' + token;

        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: headers,
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });

        hideTyping();
        const data = await res.json().catch(() => ({}));

        if (res.status === 429 || res.status === 503 || res.status === 401 || res.status === 403) {
          const msg = data && (typeof data.message === 'string' ? data.message
            : (typeof data.reply === 'string' ? data.reply : null));
          if (msg) { renderReply({ reply: msg, chips: data.chips, support: data.support }); }
          else { appendSystem(STR.retrieveFailed, true); }
        } else if (!res.ok) {
          renderRetrievalError(lastAttempt);
        } else {
          if (data && data.conversationId) conversationId = data.conversationId;
          if (conn === 'reconnecting') setConn('connected');
          if (!renderReply(data)) renderRetrievalError(lastAttempt);
        }
      } catch (err) {
        hideTyping();
        // A network-level failure is a connection problem, not a server answer.
        setConn(navigator.onLine === false ? 'offline' : 'reconnecting');
        renderRetrievalError(lastAttempt);
      } finally {
        isBusy = false;
        updateSendBtn();
        if (isOpen && !textarea.disabled) textarea.focus();
      }
    }

    /* ── Open / close ── */
    function openChat() {
      isOpen = true;
      win.classList.add('is-open');
      win.setAttribute('aria-hidden', 'false');
      // The window covers the launcher, so hide it instead of swapping in a ✕
      fab.classList.add('is-open');
      fab.setAttribute('aria-expanded', 'true');

      if (msgs.children.length === 0) {
        if (chatConfig && chatConfig.enabled === false) {
          appendSystem(chatConfig.maintenanceMessage ||
            'The SaveHatke AI Assistant is temporarily unavailable. Please check back soon.', true);
          setComposerDisabled(true);
        } else {
          buildWelcome();
        }
      }
      renderConn();
      startPlaceholderRotation();
      setTimeout(() => { if (isOpen && !textarea.disabled) textarea.focus(); }, 200);
    }

    /** archive:true ends the thread — the next open starts at the welcome screen. */
    function hidePanel(archive) {
      isOpen = false;
      win.classList.remove('is-open');
      win.setAttribute('aria-hidden', 'true');
      fab.classList.remove('is-open');
      fab.setAttribute('aria-expanded', 'false');
      stopPlaceholderRotation();
      if (archive) {
        savePrevThread();
        conversationId = null;
        transcript.length = 0;
        msgs.innerHTML = '';
        welcomeEl = null;
      }
      fab.focus();
    }

    function startNewConversation() {
      savePrevThread();
      conversationId = null;
      transcript.length = 0;
      lastAttempt = null;
      lastTypingText = null;
      typingTurn = null;
      msgs.innerHTML = '';
      welcomeEl = null;
      textarea.value = '';
      autoResize();
      updateCharCount();
      updateSendBtn();
      buildWelcome();
      if (isOpen) textarea.focus();
    }

    /* ── Event listeners ── */
    fab.addEventListener('click', () => { isOpen ? hidePanel(false) : openChat(); });
    minBtn.addEventListener('click', () => hidePanel(false));
    closeBtn.addEventListener('click', () => hidePanel(true));
    newChatBtn.addEventListener('click', startNewConversation);

    textarea.addEventListener('input', () => {
      updateSendBtn();
      updateCharCount();
      autoResize();
    });
    textarea.addEventListener('focus', applyPlaceholder);
    textarea.addEventListener('blur', applyPlaceholder);

    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {               // Shift+Enter = new line
        e.preventDefault();
        if (!sendBtn.disabled) sendMessage();
      }
    });

    sendBtn.addEventListener('click', () => { if (!sendBtn.disabled) sendMessage(); });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && isOpen) hidePanel(false);   // Esc closes the panel
    });

    window.addEventListener('online', () => setConn('connected'));
    window.addEventListener('offline', () => setConn('offline'));
    window.addEventListener('pagehide', () => savePrevThread());

    /* Trap focus inside chat window when open */
    win.addEventListener('keydown', e => {
      if (e.key !== 'Tab' || !isOpen) return;
      const focusable = Array.from(win.querySelectorAll(
        'button:not([disabled]), textarea:not([disabled]), a[href]:not([tabindex="-1"])'
      )).filter(el => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });

    /* ── Status / config check (graceful — widget works even if this fails) ──
       The guide owns the assistant name (UI-1.1), the welcome copy (26.1/26.2)
       and the welcome action sets (UI-3), so the admin `botName`,
       `welcomeMessage` and `suggestedQuestions` settings are no longer applied
       to the widget. `enabled`, `maintenanceMessage` and `maxMessageLength`
       still are. */
    async function checkStatus() {
      try {
        const res = await fetch('/api/chat/config', { credentials: 'same-origin' });
        if (!res.ok) return;
        const cfg = await res.json();
        if (!cfg || typeof cfg !== 'object') return;
        chatConfig = cfg;

        if (cfg.maxMessageLength) {
          const parsed = parseInt(cfg.maxMessageLength, 10);
          if (parsed) MAX_LEN = Math.min(500, Math.max(100, parsed));
          nearLimit = Math.round(MAX_LEN * 0.8);
          textarea.maxLength = MAX_LEN;
          updateCharCount();
        }

        if (cfg.enabled === false) {
          conn = 'connected';
          statusDot.classList.add('cb-dot-offline');
          statusText.textContent = 'Unavailable';
          setComposerDisabled(true);
          if (isOpen && msgs.children.length && welcomeEl) {
            dismissWelcome();
            appendSystem(cfg.maintenanceMessage ||
              'The SaveHatke AI Assistant is temporarily unavailable. Please check back soon.', true);
          }
        }
      } catch (e) { /* silent — config endpoint is optional */ }
    }

    renderConn();
    applyPlaceholder();
    updateSendBtn();
    checkStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();

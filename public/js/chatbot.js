// ============================================
// SaveHatke — AI Chatbot Widget (shared)
// ============================================
// Self-injecting floating assistant: drop `<script src="js/chatbot.js"></script>`
// on any page and the styles, markup and logic mount themselves. This replaces
// the copies that used to be pasted inline into each page.
//
// Behaviour: the chat window opens directly ON TOP OF the launcher icon (same
// bottom/right anchor, higher z-index) and the launcher hides while it is open,
// so there is no second "close" affordance on the icon — the ✕ inside the
// window header (or Escape) closes it.
//
// SECURITY: talks only to our own /api/chat endpoints. The Gemini API key is
// server-side only and never reaches the browser.

(function SaveHatkeChatbotWidget() {
  'use strict';

  // Guard against double-inclusion / a leftover inline copy on the page
  if (window.__shChatbotMounted) return;
  window.__shChatbotMounted = true;

  const STYLES = `
    /* ═══════════════════════════════════════
       SAVEHATKE AI CHATBOT — Green Theme
    ═══════════════════════════════════════ */
    @keyframes chatbot-slide-up {
      from { opacity:0; transform:translateY(16px) scale(.97); }
      to   { opacity:1; transform:translateY(0) scale(1); }
    }
    @keyframes typing-dot {
      0%,80%,100% { transform:translateY(0); opacity:.4; }
      40%          { transform:translateY(-5px); opacity:1; }
    }
    @keyframes chatbot-pulse {
      0%,100% { box-shadow:0 0 0 0 rgba(0,230,118,.45), 0 6px 24px rgba(0,230,118,.3); }
      60%      { box-shadow:0 0 0 8px rgba(0,230,118,0), 0 6px 24px rgba(0,230,118,.3); }
    }

    /* Launcher button — smaller & green */
    .chatbot-fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 9990;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: linear-gradient(135deg, #00e676, #00c853);
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.15rem;
      animation: chatbot-pulse 2.8s ease infinite;
      transition: transform .22s ease, opacity .18s ease, visibility .18s ease;
      color: #060d1f;
    }
    .chatbot-fab:hover { transform: scale(1.1); }
    .chatbot-fab:focus-visible {
      outline: 2.5px solid #00e676;
      outline-offset: 3px;
    }
    .chatbot-fab .cb-icon-open { line-height: 1; }
    /* Open state: the window sits on top of the icon, so the icon steps aside
       (no ✕ swap — the window header owns the close action). */
    .chatbot-fab.is-open {
      opacity: 0;
      visibility: hidden;
      transform: scale(.55);
      pointer-events: none;
      animation: none;
    }

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

    /* Mobile: near-full-screen bottom sheet */
    @media (max-width: 520px) {
      .chatbot-fab { bottom: 16px; right: 16px; width: 44px; height: 44px; font-size: 1.05rem; }
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
      .chatbot-fab { animation: none; }
      .chatbot-window { transition: opacity .15s linear; }
    }

    /* Header — green accent */
    .chatbot-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      background: linear-gradient(135deg, rgba(0,230,118,.1), rgba(0,200,83,.06));
      border-bottom: 1px solid rgba(0,230,118,.15);
      flex-shrink: 0;
    }
    .chatbot-header-left { display: flex; align-items: center; gap: 12px; }
    .chatbot-avatar {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: linear-gradient(135deg, #00e676, #00c853);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.05rem;
      flex-shrink: 0;
    }
    .chatbot-header-name {
      font-weight: 700;
      font-size: .93rem;
      color: #e2ecff;
      line-height: 1.2;
    }
    .chatbot-header-status {
      font-size: .74rem;
      color: #6b88aa;
      margin-top: 2px;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .chatbot-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #00e676;
      display: inline-block;
      flex-shrink: 0;
    }
    .chatbot-status-dot.offline { background: #ff6b6b; }
    .chatbot-header-actions { display: flex; align-items: center; gap: 4px; }
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
      transition: background .18s, color .18s;
      font-family: 'Outfit', sans-serif;
    }
    .chatbot-icon-btn:hover { background: rgba(0,230,118,.1); color: #00e676; }
    .chatbot-icon-btn:focus-visible { outline: 2px solid #00e676; outline-offset: 2px; }

    /* Messages area */
    .chatbot-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scrollbar-width: thin;
      scrollbar-color: rgba(0,230,118,.15) transparent;
    }
    .chatbot-messages::-webkit-scrollbar { width: 4px; }
    .chatbot-messages::-webkit-scrollbar-thumb { background: rgba(0,230,118,.2); border-radius: 2px; }

    /* Message bubbles */
    .cb-msg {
      display: flex;
      gap: 8px;
      align-items: flex-end;
      max-width: 86%;
    }
    .cb-msg.cb-user { align-self: flex-end; flex-direction: row-reverse; }
    .cb-msg.cb-ai   { align-self: flex-start; }
    .cb-bubble {
      padding: 10px 14px;
      border-radius: 16px;
      font-family: 'Outfit', sans-serif;
      font-size: .88rem;
      line-height: 1.6;
      word-break: break-word;
      max-width: 100%;
    }
    .cb-msg.cb-user .cb-bubble {
      background: linear-gradient(135deg, #00e676, #00c853);
      color: #060d1f;
      border-bottom-right-radius: 4px;
      font-weight: 500;
    }
    .cb-msg.cb-ai .cb-bubble {
      background: rgba(15,30,58,.9);
      border: 1px solid rgba(0,230,118,.12);
      color: #e2ecff;
      border-bottom-left-radius: 4px;
    }
    .cb-msg.cb-ai .cb-bubble strong { color: #00e676; }
    .cb-msg.cb-ai .cb-bubble em { color: #66ffa6; font-style: italic; }
    .cb-msg.cb-ai .cb-bubble code {
      background: rgba(0,230,118,.08);
      padding: 1px 5px;
      border-radius: 4px;
      font-family: 'JetBrains Mono', monospace;
      font-size: .82em;
      color: #69f0ae;
    }
    .cb-ts {
      font-family: 'Outfit', sans-serif;
      font-size: .67rem;
      color: #6b88aa;
      margin-top: 3px;
      padding: 0 4px;
      flex-shrink: 0;
    }
    .cb-msg.cb-user .cb-ts { text-align: right; }

    /* Typing indicator — green dots */
    .cb-typing {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 10px 14px;
      background: rgba(15,30,58,.9);
      border: 1px solid rgba(0,230,118,.12);
      border-radius: 16px;
      border-bottom-left-radius: 4px;
      width: fit-content;
    }
    .cb-typing span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #00e676;
      display: inline-block;
    }
    .cb-typing span:nth-child(1) { animation: typing-dot 1.2s .0s ease infinite; }
    .cb-typing span:nth-child(2) { animation: typing-dot 1.2s .2s ease infinite; }
    .cb-typing span:nth-child(3) { animation: typing-dot 1.2s .4s ease infinite; }

    /* Quick actions — green */
    .cb-quick-actions { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
    .cb-quick-btn {
      padding: 8px 12px;
      border-radius: 10px;
      background: rgba(0,230,118,.07);
      border: 1px solid rgba(0,230,118,.2);
      color: #00e676;
      font-family: 'Outfit', sans-serif;
      font-size: .82rem;
      font-weight: 600;
      cursor: pointer;
      text-align: left;
      transition: background .18s, border-color .18s;
    }
    .cb-quick-btn:hover { background: rgba(0,230,118,.14); border-color: rgba(0,230,118,.4); }
    .cb-quick-btn:focus-visible { outline: 2px solid #00e676; outline-offset: 2px; }

    /* Error & system messages */
    .cb-sys-msg {
      align-self: center;
      font-family: 'Outfit', sans-serif;
      font-size: .78rem;
      color: #6b88aa;
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(0,230,118,.08);
      border-radius: 8px;
      padding: 7px 12px;
      text-align: center;
      max-width: 90%;
    }
    .cb-sys-msg.cb-error {
      color: #ff8585;
      border-color: rgba(255,107,107,.15);
      background: rgba(255,107,107,.05);
    }

    /* Privacy notice — green link */
    .chatbot-privacy {
      padding: 6px 16px;
      font-family: 'Outfit', sans-serif;
      font-size: .7rem;
      color: #6b88aa;
      text-align: center;
      border-top: 1px solid rgba(0,230,118,.08);
      flex-shrink: 0;
    }
    .chatbot-privacy a { color: #00e676; text-decoration: underline; }

    /* Input area — green borders */
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
      background: rgba(255,255,255,.05);
      border: 1.5px solid rgba(0,230,118,.15);
      border-radius: 12px;
      color: #e2ecff;
      font-family: 'Outfit', sans-serif;
      font-size: .9rem;
      padding: 10px 14px;
      resize: none;
      outline: none;
      min-height: 42px;
      max-height: 120px;
      line-height: 1.5;
      transition: border-color .2s;
      overflow-y: auto;
    }
    .chatbot-textarea:focus { border-color: rgba(0,230,118,.45); }
    .chatbot-textarea::placeholder { color: #6b88aa; }
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
      transition: opacity .2s, transform .2s;
    }
    .chatbot-send-btn:hover { opacity: .85; transform: scale(1.06); }
    .chatbot-send-btn:disabled { opacity: .4; cursor: not-allowed; transform: none; }
    .chatbot-send-btn:focus-visible { outline: 2px solid #00e676; outline-offset: 2px; }

    /* Char counter */
    .chatbot-char-count {
      font-family: 'Outfit', sans-serif;
      font-size: .68rem;
      color: #6b88aa;
      text-align: right;
      padding: 0 14px 6px;
      flex-shrink: 0;
    }
    .chatbot-char-count.near-limit { color: #ffd740; }
    .chatbot-char-count.at-limit { color: #ff6b6b; }
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
  <span class="cb-icon-open" aria-hidden="true">🤖</span>
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
  <div class="chatbot-header">
    <div class="chatbot-header-left">
      <div class="chatbot-avatar" aria-hidden="true">🤖</div>
      <div>
        <div class="chatbot-header-name">SaveHatke AI Assistant</div>
        <div class="chatbot-header-status" id="cbStatus">
          <span class="chatbot-status-dot" id="cbStatusDot"></span>
          <span id="cbStatusText">Online</span>
        </div>
      </div>
    </div>
    <div class="chatbot-header-actions">
      <button class="chatbot-icon-btn" id="chatbotNewChat" type="button" aria-label="Start new conversation" title="New conversation">↺</button>
      <button class="chatbot-icon-btn" id="chatbotClose" type="button" aria-label="Close chat" title="Close">✕</button>
    </div>
  </div>

  <div
    id="chatbotMessages"
    class="chatbot-messages"
    aria-live="polite"
    aria-label="Chat messages"
    role="log"
  ></div>

  <div class="chatbot-privacy">
    Chats may be processed to provide AI assistance. <a href="privacy" tabindex="-1">Privacy Policy</a>
  </div>

  <div class="chatbot-input-area">
    <textarea
      id="chatbotTextarea"
      class="chatbot-textarea"
      placeholder="Ask anything about SaveHatke..."
      rows="1"
      aria-label="Type your message"
      maxlength="1000"
    ></textarea>
    <button
      id="chatbotSendBtn"
      class="chatbot-send-btn"
      type="button"
      aria-label="Send message"
      disabled
    >➤</button>
  </div>
  <div class="chatbot-char-count" id="cbCharCount" aria-live="polite" aria-atomic="true"></div>
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
    let MAX_LEN = 1000;
    const QUICK_ACTIONS = [
      { label: '🔎 Find a Coupon',       text: 'How do I find a coupon on SaveHatke?' },
      { label: '🎟️ Sell a Coupon',       text: 'How can I sell a coupon on SaveHatke?' },
      { label: '💰 How Earnings Work',   text: 'How do earnings work on SaveHatke?' },
      { label: '❓ How SaveHatke Works', text: 'How does SaveHatke work?' },
      { label: '🛡️ Security & Privacy',  text: 'What are SaveHatke\'s security and privacy practices?' },
      { label: '📞 Contact Support',     text: 'How can I contact SaveHatke support?' },
    ];

    // Admin-configured settings from /api/chat/config (graceful fallbacks)
    let chatConfig = null;

    let conversationId = null;
    let isBusy = false;
    let isOpen = false;

    const fab      = document.getElementById('chatbotFab');
    const win      = document.getElementById('chatbotWindow');
    const msgs     = document.getElementById('chatbotMessages');
    const textarea = document.getElementById('chatbotTextarea');
    const sendBtn  = document.getElementById('chatbotSendBtn');
    const charCount  = document.getElementById('cbCharCount');
    const newChatBtn = document.getElementById('chatbotNewChat');
    const closeBtn   = document.getElementById('chatbotClose');
    const statusDot  = document.getElementById('cbStatusDot');
    const statusText = document.getElementById('cbStatusText');

    /* ── Helpers ── */
    function escHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderMarkdown(raw) {
      let s = escHtml(raw);
      s = s.replace(/\n/g, '<br>');
      s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      return s;
    }

    function now() {
      return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    }

    function scrollBottom() {
      msgs.scrollTop = msgs.scrollHeight;
    }

    /* ── Render message ── */
    function appendMessage(role, content, isHtml = false) {
      const wrap = document.createElement('div');
      wrap.className = 'cb-msg ' + (role === 'user' ? 'cb-user' : 'cb-ai');

      const bubble = document.createElement('div');
      bubble.className = 'cb-bubble';

      if (isHtml) {
        bubble.innerHTML = content;
      } else if (role === 'user') {
        bubble.textContent = content;
      } else {
        bubble.innerHTML = renderMarkdown(content);
      }

      const ts = document.createElement('div');
      ts.className = 'cb-ts';
      ts.textContent = now();

      wrap.appendChild(bubble);
      wrap.appendChild(ts);
      msgs.appendChild(wrap);
      scrollBottom();
      return wrap;
    }

    function appendSystem(msg, isError = false) {
      const el = document.createElement('div');
      el.className = 'cb-sys-msg' + (isError ? ' cb-error' : '');
      el.textContent = msg;
      msgs.appendChild(el);
      scrollBottom();
    }

    /* ── Typing indicator ── */
    let typingEl = null;
    function showTyping() {
      if (typingEl) return;
      const wrap = document.createElement('div');
      wrap.className = 'cb-msg cb-ai';
      typingEl = document.createElement('div');
      typingEl.className = 'cb-typing';
      typingEl.innerHTML = '<span></span><span></span><span></span>';
      typingEl.setAttribute('aria-label', 'SaveHatke AI is typing');
      wrap.appendChild(typingEl);
      msgs.appendChild(wrap);
      scrollBottom();
    }
    function hideTyping() {
      if (typingEl) {
        if (typingEl.parentElement) typingEl.parentElement.remove();
        typingEl = null;
      }
    }

    /* ── Quick action buttons ── */
    function appendWelcome() {
      const bubble = document.createElement('div');
      bubble.className = 'cb-msg cb-ai';

      const inner = document.createElement('div');
      inner.style.cssText = 'display:flex;flex-direction:column;gap:10px;max-width:100%';

      const welcomeText = (chatConfig && chatConfig.welcomeMessage) ||
        "👋 Hi! I'm the SaveHatke AI Assistant.\n\nI can help you with coupons, selling coupons, earnings, your account, and how SaveHatke works.";

      const msgDiv = document.createElement('div');
      msgDiv.className = 'cb-bubble';
      msgDiv.innerHTML = renderMarkdown(welcomeText);

      // Admin-configured suggested questions take priority over defaults
      const actions = (chatConfig && Array.isArray(chatConfig.suggestedQuestions) && chatConfig.suggestedQuestions.length)
        ? chatConfig.suggestedQuestions.map(label => ({ label, text: label }))
        : QUICK_ACTIONS;

      const qDiv = document.createElement('div');
      qDiv.className = 'cb-quick-actions';
      actions.forEach(qa => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cb-quick-btn';
        btn.textContent = qa.label;
        btn.setAttribute('aria-label', qa.label);
        btn.addEventListener('click', () => {
          qDiv.remove();
          sendMessage(qa.text);
        });
        qDiv.appendChild(btn);
      });

      const ts = document.createElement('div');
      ts.className = 'cb-ts';
      ts.textContent = now();

      inner.appendChild(msgDiv);
      inner.appendChild(qDiv);
      bubble.appendChild(inner);
      bubble.appendChild(ts);
      msgs.appendChild(bubble);
      scrollBottom();
    }

    /* ── Open / Close ── */
    function openChat() {
      isOpen = true;
      win.classList.add('is-open');
      win.setAttribute('aria-hidden', 'false');
      // The window covers the launcher, so hide it instead of swapping in a ✕
      fab.classList.add('is-open');
      fab.setAttribute('aria-expanded', 'true');

      if (msgs.children.length === 0) {
        if (chatConfig && chatConfig.enabled === false) {
          appendSystem(chatConfig.maintenanceMessage || '🤖 The SaveHatke AI Assistant is temporarily unavailable. Please check back soon.', true);
          setInputDisabled(true);
        } else {
          appendWelcome();
        }
      }
      setTimeout(() => textarea.focus(), 200);
    }

    function closeChat() {
      isOpen = false;
      win.classList.remove('is-open');
      win.setAttribute('aria-hidden', 'true');
      fab.classList.remove('is-open');
      fab.setAttribute('aria-expanded', 'false');
      fab.focus();
    }

    function startNewConversation() {
      conversationId = null;
      msgs.innerHTML = '';
      appendWelcome();
      textarea.value = '';
      autoResize();
      updateCharCount();
      updateSendBtn();
    }

    /* ── Send message ── */
    async function sendMessage(text) {
      const trimmed = (text || textarea.value).trim();
      if (!trimmed || isBusy) return;
      if (trimmed.length > MAX_LEN) {
        appendSystem(`Your message is too long (max ${MAX_LEN.toLocaleString('en-IN')} characters). Please shorten it and try again.`, true);
        return;
      }

      textarea.value = '';
      autoResize();
      updateCharCount();
      updateSendBtn();
      appendMessage('user', trimmed);

      isBusy = true;
      setInputDisabled(true);
      showTyping();

      try {
        const body = { message: trimmed };
        if (conversationId) body.conversationId = conversationId;

        // Attach the session token so the backend can identify logged-in
        // users (user-tier rate limits + their own account data via tools)
        const headers = { 'Content-Type': 'application/json' };
        try {
          const token = localStorage.getItem('sh_token');
          if (token) headers['Authorization'] = `Bearer ${token}`;
        } catch (e) {}

        const res = await fetch('/api/chat', {
          method: 'POST',
          headers,
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });

        hideTyping();

        if (res.status === 429) {
          const data = await res.json().catch(() => ({}));
          appendSystem((data && (data.message || data.reply)) || "You're sending messages too quickly. Please wait a moment and try again.", true);
        } else if (res.status === 503 || res.status === 404) {
          const data = await res.json().catch(() => ({}));
          appendSystem((data && (data.message || data.reply)) || '🤖 SaveHatke AI Assistant is temporarily unavailable. Please try again later.', true);
        } else if (!res.ok) {
          appendSystem("Sorry, I'm having trouble responding right now. Please try again in a moment.", true);
        } else {
          const data = await res.json().catch(() => ({}));

          const raw = data && (data.message != null ? data.message : data.reply);
          const reply = typeof raw === 'string' ? raw : null;
          if (reply) {
            if (data.conversationId) conversationId = data.conversationId;
            appendMessage('ai', reply);
          } else {
            appendSystem("Sorry, I'm having trouble responding right now. Please try again in a moment.", true);
          }
        }
      } catch (err) {
        hideTyping();
        appendSystem("Sorry, I'm having trouble responding right now. Please try again in a moment.", true);
      } finally {
        isBusy = false;
        setInputDisabled(false);
        if (isOpen) textarea.focus();
      }
    }

    /* ── Input helpers ── */
    function setInputDisabled(disabled) {
      textarea.disabled = disabled;
      sendBtn.disabled = disabled || textarea.value.trim().length === 0;
    }

    function updateSendBtn() {
      sendBtn.disabled = isBusy || textarea.value.trim().length === 0;
    }

    function updateCharCount() {
      const len = textarea.value.length;
      if (len === 0) {
        charCount.textContent = '';
        charCount.className = 'chatbot-char-count';
        return;
      }
      charCount.textContent = `${len} / ${MAX_LEN}`;
      if (len >= MAX_LEN) {
        charCount.className = 'chatbot-char-count at-limit';
      } else if (len >= MAX_LEN * 0.85) {
        charCount.className = 'chatbot-char-count near-limit';
      } else {
        charCount.className = 'chatbot-char-count';
      }
    }

    function autoResize() {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }

    /* ── Event listeners ── */
    fab.addEventListener('click', () => { isOpen ? closeChat() : openChat(); });

    closeBtn.addEventListener('click', closeChat);

    newChatBtn.addEventListener('click', startNewConversation);

    textarea.addEventListener('input', () => {
      updateSendBtn();
      updateCharCount();
      autoResize();
    });

    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) sendMessage();
      }
    });

    sendBtn.addEventListener('click', () => { if (!sendBtn.disabled) sendMessage(); });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && isOpen) closeChat();
    });

    /* Trap focus inside chat window when open */
    win.addEventListener('keydown', e => {
      if (e.key !== 'Tab' || !isOpen) return;
      const focusable = Array.from(win.querySelectorAll(
        'button:not([disabled]), textarea:not([disabled]), a[href]'
      )).filter(el => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });

    /* ── Status / config check (graceful — widget works even if this fails) ── */
    async function checkStatus() {
      try {
        const res = await fetch('/api/chat/config', { credentials: 'same-origin' });
        if (!res.ok) return;
        const cfg = await res.json();
        if (!cfg || typeof cfg !== 'object') return;
        chatConfig = cfg;

        if (cfg.maxMessageLength) {
          MAX_LEN = Math.min(Math.max(parseInt(cfg.maxMessageLength, 10) || 1000, 100), 4000);
          textarea.maxLength = MAX_LEN;
        }

        // Admin-configured bot name in the widget header
        if (cfg.botName) {
          const nameEl = document.querySelector('.chatbot-header-name');
          if (nameEl) nameEl.textContent = cfg.botName;
        }

        if (cfg.enabled === false) {
          statusDot.classList.add('offline');
          statusText.textContent = 'Unavailable';
        }
      } catch (e) { /* silent — config endpoint is optional */ }
    }
    checkStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();

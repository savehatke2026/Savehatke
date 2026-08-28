// ============================================
// SaveHatke — Admin Support Mailbox
// Frontend for /api/admin/gmail endpoints (backed by Gmail OAuth).
// Requires admin JWT (Auth.getAdminToken()).
// ============================================

const GmailApp = (() => {
  // ── State ────────────────────────────────────────────────────────────────
  let state = {
    folder: 'inbox',
    labelId: null,
    search: '',
    messages: [],
    selected: new Set(),
    pageTokens: [],      // stack for backward pagination
    nextPageToken: null,
    labels: [],
    unreadCounts: {},
    currentMessage: null,
    composeMode: 'new',  // new | reply | replyAll | forward
    composeAtts: [],
    pollTimer: null,
  };

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function toast(msg, type = 'info') {
    if (typeof showToast === 'function') showToast(msg, type);
    else console.log(`[${type}] ${msg}`);
  }

  async function api(path, options = {}) {
    return window.api(`/admin/gmail${path}`, { useAdmin: true, ...options });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function init() {
    if (!Auth.isAdminLoggedIn()) {
      window.location.href = 'login.html';
      return;
    }
    handleOAuthRedirectResult();
    loadStatus();
  }

  function handleOAuthRedirectResult() {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('gmail');
    if (status === 'connected') {
      toast('Support mailbox connected!', 'success');
      if (params.get('ephemeral') === '1') {
        toast('Token is temporary — use "Show token" to store GMAIL_REFRESH_TOKEN permanently.', 'warning');
      }
    }
    if (status === 'error') toast(`Gmail connection failed: ${params.get('msg') || 'unknown error'}`, 'error');
    if (status) {
      params.delete('gmail');
      params.delete('msg');
      params.delete('store');
      params.delete('ephemeral');
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
  }

  async function loadStatus() {
    try {
      const data = await api('/status');
      // The server returns a `reason` field that explains *why* the mailbox
      // isn't ready, so the connect screen can show the right setup steps.
      if (!data.configured || data.reason === 'oauth-not-configured') {
        showConnectScreen('oauth-not-configured', data.message, data);
        toast('Gmail OAuth is not configured on the server yet.', 'warning');
        return;
      }
      if (data.reason === 'token-invalid') {
        showConnectScreen('token-invalid', data.message, data);
        toast('Gmail rejected the saved token — please reconnect.', 'error');
        return;
      }
      if (!data.connected) {
        showConnectScreen('not-connected', data.message, data);
        return;
      }
      showApp(data.gmailEmail);
      renderTokenBanner(data);
      if (data.unreadCounts) renderUnreadCounts(data.unreadCounts);
      await Promise.all([loadLabels(), loadMessages()]);
      startChangePolling();
    } catch (err) {
      toast('Failed to load Gmail status: ' + (err.detail || err.message), 'error');
      showConnectScreen('server-error', err.message);
    }
  }

  // Build the per-reason "what to do" checklist shown on the connect screen.
  function buildSetupHelp(reason, serverMessage, data = {}) {
    const redirectUri = data.redirectUri || (window.location.origin + '/api/admin/gmail/callback');

    if (reason === 'oauth-not-configured') {
      return `
        <div class="gm-setup">
          <h3>🔧 Gmail OAuth is not configured on the server</h3>
          <p>Set these environment variables on the server (Vercel → Project → Settings → Environment Variables, or <code>.env</code> locally):</p>
          <ul>
            <li><code>GMAIL_CLIENT_ID</code> — from Google Cloud Console → APIs &amp; Services → Credentials</li>
            <li><code>GMAIL_CLIENT_SECRET</code> — the matching client secret</li>
            <li><code>GMAIL_TOKEN_ENCRYPTION_KEY</code> — a base64-encoded 32-byte key used to encrypt the refresh token at rest</li>
          </ul>
          <p>Then in Google Cloud Console, add this exact redirect URI under the OAuth client:</p>
          <pre>${esc(redirectUri)}</pre>
          <p style="opacity:.7">Server detail: <em>${esc(serverMessage || '')}</em></p>
        </div>`;
    }
    if (reason === 'token-invalid') {
      return `
        <div class="gm-setup">
          <h3>⚠️ The saved Gmail token was rejected</h3>
          <p>Google refused the stored refresh token — access was probably revoked from the Google account, or <code>GMAIL_REFRESH_TOKEN</code> is stale.</p>
          <p>Click <strong>Connect Gmail</strong> above and sign in again with the support mailbox${data.expectedEmail ? ` (<code>${esc(data.expectedEmail)}</code>)` : ''}.</p>
          <p style="opacity:.7">Server detail: <em>${esc(serverMessage || '')}</em></p>
        </div>`;
    }
    if (reason === 'not-connected') {
      return `
        <div class="gm-setup">
          <h3>📮 No database required</h3>
          <p>Sign in once with the support mailbox${data.expectedEmail ? ` <code>${esc(data.expectedEmail)}</code>` : ''}. The server keeps only Google's refresh token — messages are always read live from Gmail, nothing is copied into a database.</p>
          <p>Make sure this exact redirect URI is registered on the OAuth client in Google Cloud Console:</p>
          <pre>${esc(redirectUri)}</pre>
          <p style="opacity:.7">After connecting, you'll get the token value to store as <code>GMAIL_REFRESH_TOKEN</code> so the connection survives restarts and redeploys.</p>
        </div>`;
    }
    if (reason === 'server-error') {
      return `
        <div class="gm-setup">
          <h3>⚠️ Gmail status check failed</h3>
          <p>${esc(serverMessage || 'Unknown error.')}</p>
        </div>`;
    }
    return '';
  }

  function showConnectScreen(reason, serverMessage, data = {}) {
    $('gmConnect').classList.add('on');
    $('gmApp').classList.remove('on');
    const helpEl = $('gmSetupHelp');
    if (helpEl) {
      helpEl.innerHTML = buildSetupHelp(reason, serverMessage, data);
    }
  }

  function showApp(email) {
    $('gmConnect').classList.remove('on');
    $('gmApp').classList.add('on');
    $('gmAccountBadge').textContent = `✅ ${email}`;
  }

  // ── Token durability banner (replaces the old DB connection record) ───────
  // tokenSource: 'env'    → permanent, nothing to do
  //              'file'   → saved on this server's disk
  //              'memory' → lost on restart/redeploy (serverless) → prompt
  function renderTokenBanner(data) {
    let bar = $('gmTokenBar');
    if (!bar) {
      const body = document.querySelector('#sec-mailbox .gm-body');
      if (!body || !body.parentNode) return;
      bar = document.createElement('div');
      bar.id = 'gmTokenBar';
      bar.style.cssText = 'display:none;padding:10px 16px;font-size:.8rem;line-height:1.6;border-bottom:1px solid rgba(255,193,7,.25);background:rgba(255,193,7,.08);color:#ffd97a';
      body.parentNode.insertBefore(bar, body);
    }

    const mismatchNote = data && data.mismatch
      ? `<div style="margin-top:6px">⚠️ Connected as <strong>${esc(data.gmailEmail || '')}</strong>, but the configured support address is <strong>${esc(data.expectedEmail || '')}</strong>.</div>`
      : '';

    if (!data || data.tokenSource === 'env') {
      if (mismatchNote) {
        bar.style.display = '';
        bar.innerHTML = mismatchNote;
      } else {
        bar.style.display = 'none';
        bar.innerHTML = '';
      }
      return;
    }

    bar.style.display = '';
    bar.innerHTML = `
      ${data.durable === false
        ? '⚠️ This connection is <strong>temporary</strong> — it will be lost when the server restarts or redeploys.'
        : 'ℹ️ The Gmail token is saved on this server\'s disk only.'}
      Store it as <code>GMAIL_REFRESH_TOKEN</code> to make it permanent.
      <button class="btn btn-sm" style="margin-left:8px" onclick="GmailApp.revealToken()">Show token</button>
      ${mismatchNote}
      <div id="gmTokenReveal" style="margin-top:8px"></div>`;
  }

  // Fetch the refresh token once so the admin can paste it into the server env.
  async function revealToken() {
    try {
      const data = await api('/refresh-token');
      const box = $('gmTokenReveal');
      if (!box) return;
      box.innerHTML = `
        <div style="background:#0a1120;border:1px solid rgba(0,230,118,.25);border-radius:10px;padding:10px">
          <div style="color:#8fa8c8;margin-bottom:6px">Add this to the server environment, then redeploy / restart:</div>
          <textarea readonly rows="3" onclick="this.select()" style="width:100%;background:#060d1f;color:#00e676;border:1px solid rgba(0,230,118,.2);border-radius:8px;padding:8px;font-family:'JetBrains Mono',monospace;font-size:.72rem">GMAIL_REFRESH_TOKEN=${esc(data.refreshToken || '')}</textarea>
          <div style="color:#6b88aa;margin-top:6px;font-size:.72rem">Treat this like a password — it grants ongoing access to ${esc(data.gmailEmail || 'the mailbox')}.</div>
        </div>`;
    } catch (err) {
      toast(err.message || 'Could not read the refresh token.', 'error');
    }
  }

  // ── OAuth connect / disconnect ───────────────────────────────────────────
  async function connect() {
    try {
      $('gmConnectBtn').disabled = true;
      // Get a short-lived signed start URL (browser redirects can't send Bearer headers)
      const data = await api('/auth/url', { method: 'POST' });
      if (data.url) window.location.href = data.url;
      else toast('Could not start Google sign-in.', 'error');
    } catch (err) {
      toast(err.message || 'Failed to start Gmail connection.', 'error');
    } finally {
      $('gmConnectBtn').disabled = false;
    }
  }

  function confirmDisconnect() {
    confirmDialog('Disconnect the support mailbox?', 'Access is revoked at Google and the saved refresh token is removed from this server. You can reconnect anytime.', async () => {
      try {
        const res = await api('/disconnect', { method: 'POST' });
        toast(res.message || 'Support mailbox disconnected.', res.envStillSet ? 'warning' : 'success');
        setTimeout(() => window.location.reload(), res.envStillSet ? 2500 : 600);
      } catch (err) {
        toast(err.message || 'Disconnect failed.', 'error');
      }
    });
  }

  // ── Labels & counts ──────────────────────────────────────────────────────
  async function loadLabels() {
    try {
      const data = await api('/labels');
      state.labels = data.labels || [];
      if (data.unreadCounts) renderUnreadCounts(data.unreadCounts);
      renderLabels();
    } catch (err) { /* non-fatal */ }
  }

  function renderLabels() {
    const custom = state.labels.filter((l) => l.type === 'user');
    $('gmLabelsList').innerHTML = custom.length
      ? custom.map((l) => `<div class="gm-folder" data-label="${esc(l.id)}" onclick="GmailApp.setLabel('${esc(l.id)}',this)"><span class="fi">🏷️</span> ${esc(l.name)}</div>`).join('')
      : '<div style="padding:6px 18px;font-size:.75rem;color:var(--muted)">No custom labels</div>';
  }

  function renderUnreadCounts(counts) {
    state.unreadCounts = counts || {};
    ['INBOX', 'DRAFT', 'SPAM'].forEach((id) => {
      const el = $(`cnt-${id}`);
      if (!el) return;
      const n = counts[id] || 0;
      el.textContent = n > 99 ? '99+' : n;
      el.style.display = n > 0 ? '' : 'none';
    });
  }

  // ── Folder / search navigation ───────────────────────────────────────────
  function setFolder(folder, el) {
    state.folder = folder;
    state.labelId = null;
    state.search = '';
    $('gmSearchInput').value = '';
    state.pageTokens = [];
    markFolderActive(el || document.querySelector(`.gm-folder[data-folder="${folder}"]`));
    loadMessages();
    closeSide();
  }

  function setLabel(labelId, el) {
    state.folder = 'label';
    state.labelId = labelId;
    state.search = '';
    state.pageTokens = [];
    markFolderActive(el);
    loadMessages();
    closeSide();
  }

  function markFolderActive(el) {
    document.querySelectorAll('.gm-folder').forEach((f) => f.classList.remove('active'));
    if (el) el.classList.add('active');
  }

  function doSearch() {
    const q = $('gmSearchInput').value.trim();
    state.search = q;
    state.pageTokens = [];
    loadMessages();
  }

  function refresh() {
    loadMessages();
    loadStatus_unread();
    toast('Mailbox refreshed', 'success');
  }

  async function loadStatus_unread() {
    try {
      const data = await api('/status');
      if (data.unreadCounts) renderUnreadCounts(data.unreadCounts);
    } catch (e) {}
  }

  // ── Message list ─────────────────────────────────────────────────────────
  function renderSkeleton() {
    $('gmList').innerHTML = Array.from({ length: 8 }).map(() => `
      <div class="gm-skel">
        <div class="skel-line" style="width:38%"></div>
        <div class="skel-line" style="width:72%"></div>
        <div class="skel-line" style="width:55%;margin-bottom:0"></div>
      </div>`).join('');
  }

  async function loadMessages(pageToken) {
    renderSkeleton();
    state.selected.clear();
    updateBulkBar();
    try {
      const qs = new URLSearchParams();
      qs.set('folder', state.folder);
      if (state.labelId) qs.set('labelId', state.labelId);
      if (state.search) qs.set('q', state.search);
      if (pageToken) qs.set('pageToken', pageToken);
      qs.set('maxResults', '20');

      const data = await api(`/messages?${qs.toString()}`);
      state.messages = data.messages || [];
      state.nextPageToken = data.nextPageToken || null;
      renderMessages();
      renderPager();
    } catch (err) {
      if (err.status === 400 && err.message.includes('not connected')) {
        showConnectScreen('not-connected');
        return;
      }
      if (err.expired) {
        toast('Gmail session expired — please disconnect and reconnect.', 'error');
      }
      $('gmList').innerHTML = emptyState('⚠️', 'Failed to load emails', esc(err.message));
    }
  }

  function renderMessages() {
    if (!state.messages.length) {
      const labels = { inbox: ['📥', 'Inbox zero — nice!'], starred: ['⭐', 'No starred emails'], sent: ['📤', 'No sent emails'], drafts: ['📝', 'No drafts'], spam: ['🛡️', 'No spam — great!'], trash: ['🗑️', 'Trash is empty'], label: ['🏷️', 'No emails in this label'] };
      const [icon, text] = labels[state.folder] || ['📭', 'No emails found'];
      $('gmList').innerHTML = state.search
        ? emptyState('🔍', 'No results', `Nothing matched <strong>${esc(state.search)}</strong>`)
        : emptyState(icon, text, state.folder === 'inbox' ? 'New emails will appear here automatically.' : '');
      return;
    }

    $('gmList').innerHTML = state.messages.map((m) => {
      const name = parseName(m.from);
      const sel = state.selected.has(m.id) ? ' selected' : '';
      const date = fmtDate(m.date || m.internalDate);
      return `
        <div class="gm-row ${m.unread ? 'unread' : ''}${sel}" data-id="${esc(m.id)}" onclick="GmailApp.openMessage('${esc(m.id)}', event)">
          <input type="checkbox" class="gm-rcheck" ${state.selected.has(m.id) ? 'checked' : ''} onclick="event.stopPropagation()" onchange="GmailApp.toggleSelect('${esc(m.id)}', this.checked)">
          <button class="gm-rstar ${m.starred ? 'starred' : ''}" onclick="event.stopPropagation();GmailApp.quickStar('${esc(m.id)}')" title="Star">${m.starred ? '★' : '☆'}</button>
          <div class="gm-rmain">
            <div class="gm-rfrom">${esc(name)}</div>
            <div class="gm-rsubj">${esc(m.subject)}</div>
            <div class="gm-rprev">${esc(m.snippet)}</div>
          </div>
          <div class="gm-rmeta">
            <div class="gm-rdate">${esc(date)}</div>
            <div style="display:flex;gap:6px;align-items:center">
              ${m.hasAttachments ? '<span class="gm-att" title="Has attachments">📎</span>' : ''}
              ${m.unread ? '<span class="gm-unreaddot" title="Unread"></span>' : ''}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function emptyState(icon, title, sub) {
    return `<div class="gm-empty"><div class="ei">${icon}</div><div style="font-weight:600;color:var(--text);margin-bottom:4px">${title}</div><div style="font-size:.78rem">${sub}</div></div>`;
  }

  function parseName(from) {
    if (!from) return '(unknown)';
    const m = String(from).match(/^(.*?)<.*>$/);
    if (m && m[1].trim()) return m[1].trim().replace(/^"|"$/g, '');
    if (from.includes('@')) return from.split('@')[0];
    return from;
  }

  function fmtDate(d) {
    if (!d) return '';
    const date = new Date(/^\d+$/.test(String(d)) ? Number(d) : d);
    if (isNaN(date)) return '';
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    }
    if (date.getFullYear() === now.getFullYear()) {
      return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    }
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ── Selection & bulk ─────────────────────────────────────────────────────
  function toggleSelect(id, checked) {
    if (checked) state.selected.add(id); else state.selected.delete(id);
    updateBulkBar();
    const row = document.querySelector(`.gm-row[data-id="${id}"]`);
    if (row) row.classList.toggle('selected', checked);
  }

  function selectAll(checked) {
    state.selected = checked ? new Set(state.messages.map((m) => m.id)) : new Set();
    renderMessages();
    updateBulkBar();
  }

  function updateBulkBar() {
    const bar = $('gmBulkBar');
    const n = state.selected.size;
    bar.classList.toggle('on', n > 0);
    $('gmSelCount').textContent = `${n} selected`;
    $('gmSelectAll').checked = n > 0 && n === state.messages.length;
  }

  async function bulk(action) {
    if (!state.selected.size) return;
    const ids = [...state.selected];
    try {
      await api('/messages/bulk', { method: 'POST', body: { ids, action } });
      toast(`${action === 'trash' ? 'Moved to trash' : action[0].toUpperCase() + action.slice(1)}: ${ids.length} emails`, 'success');
      loadMessages(state.pageTokens[state.pageTokens.length] || undefined);
    } catch (err) {
      toast(err.message || 'Bulk action failed', 'error');
    }
  }

  async function quickStar(id) {
    const msg = state.messages.find((m) => m.id === id);
    if (!msg) return;
    const op = msg.starred ? 'unstar' : 'star';
    try {
      await api(`/messages/${encodeURIComponent(id)}/${op}`, { method: 'POST' });
      msg.starred = !msg.starred;
      renderMessages();
    } catch (err) {
      toast(err.message || 'Failed to update star', 'error');
    }
  }

  // ── Pagination ───────────────────────────────────────────────────────────
  function renderPager() {
    const depth = state.pageTokens.length;
    $('gmPagerInfo').textContent = state.messages.length ? `Page ${depth + 1} · ${state.messages.length} emails` : '';
    $('gmPrevBtn').disabled = depth === 0;
    $('gmNextBtn').disabled = !state.nextPageToken;
  }

  function nextPage() {
    if (!state.nextPageToken) return;
    state.pageTokens.push(state.nextPageToken);
    loadMessages(state.nextPageToken);
  }

  function prevPage() {
    if (!state.pageTokens.length) return;
    state.pageTokens.pop();
    loadMessages(state.pageTokens[state.pageTokens.length - 1]);
  }

  // ── Email viewer ─────────────────────────────────────────────────────────
  async function openMessage(id, event) {
    if (event && (event.target.tagName === 'INPUT' || event.target.tagName === 'BUTTON')) return;
    try {
      const data = await api(`/messages/${encodeURIComponent(id)}`);
      state.currentMessage = data.message;
      renderViewer(data.message);
      $('gmViewer').classList.add('open');

      // Mark as read locally
      const msg = state.messages.find((m) => m.id === id);
      if (msg && msg.unread) {
        msg.unread = false;
        renderMessages();
      }
    } catch (err) {
      toast(err.message || 'Failed to open email', 'error');
    }
  }

  function renderViewer(m) {
    $('gvSubject').textContent = m.subject || '(no subject)';
    const name = parseName(m.from);
    $('gvAvatar').textContent = name.slice(0, 1).toUpperCase();
    $('gvFrom').textContent = name;
    $('gvFromEmail').textContent = extractEmail(m.from);
    $('gvDate').textContent = m.date ? new Date(m.date).toLocaleString('en-IN') : '';

    let rec = `<span>To: ${esc(m.to || '—')}</span>`;
    if (m.cc) rec += `<span>· Cc: ${esc(m.cc)}</span>`;
    if (m.bcc) rec += `<span>· Bcc: ${esc(m.bcc)}</span>`;
    $('gvRecipients').innerHTML = rec;

    // Delete-forever only makes sense in Trash
    $('gvDeleteBtn').style.display = state.folder === 'trash' ? '' : 'none';

    // Attachments
    $('gvAtts').innerHTML = (m.attachments || []).filter((a) => a.attachmentId).map((a) => `
      <div class="gm-attchip">
        <span>📎</span>
        <span>${esc(a.filename)} <span style="color:var(--muted)">(${fmtSize(a.size)})</span></span>
        <button onclick="GmailApp.downloadAttachment('${esc(m.id)}','${esc(a.attachmentId)}','${esc(a.filename)}')" title="Download">⬇️</button>
      </div>`).join('');

    // Sanitized body in a fully sandboxed iframe (scripts cannot run)
    const frame = $('gvBodyFrame');
    frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:;">
      <style>body{font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6;padding:6px;word-break:break-word}img{max-width:100%;height:auto}table{max-width:100%}</style>
      </head><body>${m.bodyHtml || '<em>(empty)</em>'}</body></html>`;
    setTimeout(resizeFrame, 150);
  }

  function resizeFrame() {
    const frame = $('gvBodyFrame');
    try {
      const h = frame.contentDocument?.body?.scrollHeight;
      if (h) frame.style.height = `${Math.min(h + 40, 900)}px`;
    } catch (e) { frame.style.height = '600px'; }
  }

  function extractEmail(from) {
    const m = String(from || '').match(/<([^>]+)>/);
    return m ? m[1] : (from || '');
  }

  function closeViewer() {
    $('gmViewer').classList.remove('open');
    $('gvBodyFrame').srcdoc = '';
  }

  async function viewerAction(action) {
    const m = state.currentMessage;
    if (!m) return;
    if (action === 'delete') {
      confirmDialog('Delete forever?', 'This email will be permanently deleted from Gmail.', () => doViewerOp('delete', m.id, 'DELETE'));
      return;
    }
    await doViewerOp(action, m.id);
  }

  async function doViewerOp(action, id, method = 'POST') {
    try {
      if (action === 'delete') {
        await api(`/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } else {
        await api(`/messages/${encodeURIComponent(id)}/${action}`, { method });
      }
      toast(action === 'trash' ? 'Moved to Trash' : action === 'archive' ? 'Archived' : `${action[0].toUpperCase() + action.slice(1)} done`, 'success');
      closeViewer();
      loadMessages(state.pageTokens[state.pageTokens.length - 1]);
    } catch (err) {
      toast(err.message || 'Action failed', 'error');
    }
  }

  async function downloadAttachment(messageId, attachmentId, filename) {
    try {
      toast('Downloading…', 'info');
      const res = await fetch(`${API_BASE}/admin/gmail/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}`, {
        headers: { Authorization: `Bearer ${Auth.getAdminToken()}` },
      });
      if (!res.ok) {
        let msg = 'Download failed';
        try { msg = (await res.json()).error || msg; } catch (e) {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'attachment';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      toast(err.message || 'Failed to download attachment', 'error');
    }
  }

  // ── Compose / reply / forward ────────────────────────────────────────────
  function openCompose() {
    state.composeMode = 'new';
    state.composeAtts = [];
    $('gcTitle').textContent = '✍️ New Message';
    $('gcTo').value = ''; $('gcCc').value = ''; $('gcBcc').value = '';
    $('gcSubject').value = ''; $('gcBody').innerHTML = '';
    $('gcCcRow').style.display = 'none'; $('gcBccRow').style.display = 'none';
    renderComposeAtts();
    $('gmCompose').classList.add('open');
    closeSide();
  }

  function reply(all = false) {
    const m = state.currentMessage;
    if (!m) return;
    state.composeMode = all ? 'replyAll' : 'reply';
    state.composeAtts = [];
    $('gcTitle').textContent = all ? '↩️ Reply All' : '↩️ Reply';
    $('gcTo').value = m.replyTo || extractEmail(m.from);
    $('gcCc').value = all ? [m.to, m.cc].filter(Boolean).filter((x) => !x.includes(extractEmail(m.from))).join(', ') : '';
    $('gcBcc').value = '';
    $('gcSubject').value = m.subject?.startsWith('Re:') ? m.subject : `Re: ${m.subject || ''}`;
    $('gcBody').innerHTML = `<br><br><blockquote style="border-left:3px solid #ccc;margin-left:0;padding-left:12px;color:#666">On ${esc(m.date)}, ${esc(m.from)} wrote:</blockquote>`;
    $('gcCcRow').style.display = all ? 'flex' : 'none';
    $('gcBccRow').style.display = 'none';
    renderComposeAtts();
    $('gmCompose').classList.add('open');
  }

  function replyAll() { reply(true); }

  function forward() {
    const m = state.currentMessage;
    if (!m) return;
    state.composeMode = 'forward';
    state.composeAtts = [];
    $('gcTitle').textContent = '↪️ Forward';
    $('gcTo').value = ''; $('gcCc').value = ''; $('gcBcc').value = '';
    $('gcSubject').value = m.subject?.startsWith('Fwd:') ? m.subject : `Fwd: ${m.subject || ''}`;
    $('gcBody').innerHTML = `<br><br>---------- Forwarded message ----------<br>From: ${esc(m.from)}<br>Date: ${esc(m.date)}<br>Subject: ${esc(m.subject)}<br>To: ${esc(m.to)}`;
    $('gcCcRow').style.display = 'none'; $('gcBccRow').style.display = 'none';
    renderComposeAtts();
    $('gmCompose').classList.add('open');
  }

  function toggleCcBcc() {
    $('gcCcRow').style.display = 'flex';
    $('gcBccRow').style.display = 'flex';
  }

  function closeCompose() {
    $('gmCompose').classList.remove('open');
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (state.composeAtts.length >= 5) { toast('Maximum 5 attachments.', 'warning'); break; }
      if (file.size > 10 * 1024 * 1024) { toast(`"${file.name}" exceeds 10 MB.`, 'error'); continue; }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const b64 = String(dataUrl).split(',')[1] || '';
        state.composeAtts.push({ filename: file.name, mimeType: file.type || 'application/octet-stream', data: b64, size: file.size });
        renderComposeAtts();
      };
      reader.readAsDataURL(file);
    }
  }

  function renderComposeAtts() {
    $('gcAtts').innerHTML = state.composeAtts.map((a, i) => `
      <div class="gm-c-att">📎 ${esc(a.filename)} <span style="color:var(--muted)">(${fmtSize(a.size)})</span>
        <button onclick="GmailApp.removeAtt(${i})" title="Remove">✕</button>
      </div>`).join('');
  }

  function removeAtt(i) {
    state.composeAtts.splice(i, 1);
    renderComposeAtts();
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function composePayload() {
    return {
      to: $('gcTo').value.trim(),
      cc: $('gcCc').value.trim(),
      bcc: $('gcBcc').value.trim(),
      subject: $('gcSubject').value.trim(),
      bodyHtml: $('gcBody').innerHTML,
      attachments: state.composeAtts.map(({ filename, mimeType, data }) => ({ filename, mimeType, data })),
    };
  }

  async function sendCompose() {
    const payload = composePayload();
    if (!payload.to && !payload.cc && !payload.bcc) { toast('Add at least one recipient.', 'warning'); return; }
    $('gcSendBtn').disabled = true;
    try {
      if (state.composeMode === 'reply' || state.composeMode === 'replyAll') {
        await api(`/messages/${encodeURIComponent(state.currentMessage.id)}/reply`, {
          method: 'POST',
          body: { to: payload.to, cc: payload.cc, bcc: payload.bcc, bodyHtml: payload.bodyHtml },
        });
      } else if (state.composeMode === 'forward') {
        await api(`/messages/${encodeURIComponent(state.currentMessage.id)}/forward`, {
          method: 'POST',
          body: { to: payload.to, cc: payload.cc, bcc: payload.bcc, comment: $('gcBody').innerText.slice(0, 2000) },
        });
      } else {
        await api('/send', { method: 'POST', body: payload });
      }
      toast('Email sent 🚀', 'success');
      closeCompose();
      if (state.folder === 'sent') loadMessages();
    } catch (err) {
      toast(err.message || 'Failed to send email', 'error');
    } finally {
      $('gcSendBtn').disabled = false;
    }
  }

  async function saveDraft() {
    const payload = composePayload();
    try {
      await api('/drafts', { method: 'POST', body: payload });
      toast('Draft saved 💾', 'success');
      closeCompose();
      if (state.folder === 'drafts') loadMessages();
    } catch (err) {
      toast(err.message || 'Failed to save draft', 'error');
    }
  }

  // ── Change polling (lightweight sync) ────────────────────────────────────
  function startChangePolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      if (document.hidden) return; // don't poll when tab is hidden
      try {
        const data = await api('/changes');
        if (data.changed) {
          loadMessages(state.pageTokens[state.pageTokens.length - 1]);
        }
        if (data.unreadCount !== undefined) {
          renderUnreadCounts({ ...state.unreadCounts, INBOX: data.unreadCount });
        }
        if (data.watchExpired) {
          api('/watch', { method: 'POST' }).catch(() => {});
        }
      } catch (e) { /* ignore transient errors */ }
    }, 60000);
  }

  // ── Confirm dialog ───────────────────────────────────────────────────────
  let confirmCb = null;
  function confirmDialog(title, msg, cb) {
    $('gcConfirmTitle').textContent = title;
    $('gcConfirmMsg').textContent = msg;
    confirmCb = cb;
    $('gmConfirm').classList.add('open');
  }
  function closeConfirm(ok) {
    $('gmConfirm').classList.remove('open');
    if (ok && confirmCb) confirmCb();
    confirmCb = null;
  }

  function toggleSide() { $('gmSide').classList.toggle('open'); }
  function closeSide() { $('gmSide').classList.remove('open'); }

  // ── Boot ─────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    connect, confirmDisconnect, setFolder, setLabel, doSearch, refresh,
    toggleSelect, selectAll, bulk, quickStar, nextPage, prevPage,
    openMessage, closeViewer, viewerAction, downloadAttachment,
    openCompose, reply, replyAll, forward, toggleCcBcc, closeCompose,
    addFiles, removeAtt, sendCompose, saveDraft,
    confirmDialog, closeConfirm, toggleSide,
    loadStatus, revealToken,
  };
})();

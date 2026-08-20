// ============================================
// SaveHatke — Admin AI Chatbot Section Logic
// ============================================
// Loaded by vault.html. All API calls go through the shared api() client
// with useAdmin:true, so they carry the admin JWT and get auto-refresh.

let cbSettings = null;
let cbKnowledge = [];
let cbConversations = [];
let cbCategories = [];
let cbToolDefs = [];
let cbCurrentConv = null;
let chatbotSectionLoaded = false;

// ── Section bootstrap (lazy-loaded when the sidebar item is opened) ──────
function initChatbotSection() {
  loadChatbotSettings();
  loadChatbotStats();
  loadChatbotAudit();
  loadChatbotKnowledge();
  loadChatbotConversations();
  loadChatbotLogs();
  loadChatbotSecurity();
  chatbotSectionLoaded = true;
}

function refreshChatbotAll() {
  initChatbotSection();
  showToast('Chatbot data refreshed', 'success');
}

function showChatbotTab(tab, el) {
  const sec = document.getElementById('sec-chatbot');
  if (!sec) return;
  sec.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  sec.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const target = document.getElementById(`btab-${tab}`);
  if (target) target.classList.add('active');
  if (el) el.classList.add('active');
  if (tab === 'conversations') loadChatbotConversations();
  if (tab === 'security') { loadChatbotSecurity(); loadChatbotLogs(); }
}

// ── Settings ─────────────────────────────────────────────────────────────
async function loadChatbotSettings() {
  try {
    const data = await api('/chatbot/settings', { useAdmin: true });
    cbSettings = data.settings;
    cbCategories = data.categories || [];
    cbToolDefs = data.tools || [];

    fillConfigForms(cbSettings);
    updateStatusUI(cbSettings);
    renderToolsTable();

    // Populate category dropdowns
    const kbCat = document.getElementById('cbKbCategory');
    const kbCatInput = document.getElementById('cbKbCategoryInput');
    if (kbCat) kbCat.innerHTML = '<option value="">All Categories</option>' + cbCategories.map(c => `<option>${esc(c)}</option>`).join('');
    if (kbCatInput) kbCatInput.innerHTML = cbCategories.map(c => `<option>${esc(c)}</option>`).join('');

    const apiKeyEl = document.getElementById('cbStatApiKey');
    if (apiKeyEl) apiKeyEl.textContent = cbSettings.apiKeyConfigured ? 'Configured ✓' : 'Not Set';
    const apiKeyDisplay = document.getElementById('cbApiKeyDisplay');
    if (apiKeyDisplay) apiKeyDisplay.value = cbSettings.apiKeyConfigured ? 'Configured ✓' : 'Not configured (set GEMINI_API_KEY)';
  } catch (err) {
    showToast('Failed to load chatbot settings: ' + err.message, 'error');
  }
}

function fillConfigForms(s) {
  const set = (id, val) => { const el = document.getElementById(id); if (el !== null && el !== undefined && val !== undefined) el[val === true || val === false ? 'checked' : 'value'] = val; };
  set('cbEnabledToggle', !!s.enabled);
  set('cbAllowGuests', !!s.allowGuests);
  set('cbRequireLogin', !!s.requireLoginForAccountInfo);
  set('cbMaxMsgLen', s.maxMessageLength);
  set('cbMaxHistory', s.maxConversationHistory);
  set('cbLanguage', s.responseLanguage);
  set('cbWelcomeMsg', s.welcomeMessage);
  set('cbModel', s.model);
  set('cbMaxTokens', s.maxOutputTokens);
  set('cbTemperature', s.temperature);
  set('cbTimeout', s.timeoutSeconds);
  set('cbFallbackBehavior', s.fallbackBehavior);
  set('cbFallbackMsg', s.fallbackMessage);
  set('cbUnknownMsg', s.unknownQuestionMessage);
  set('cbBotName', s.botName);
  set('cbBotAvatar', s.botAvatar);
  set('cbMaintenanceMsg', s.maintenanceMessage);
  set('cbGuestLimit', s.guestRateLimit);
  set('cbUserLimit', s.userRateLimit);
  set('cbIpLimit', s.ipRateLimit);
  set('cbSecMaxLen', s.maxMessageLength);
  set('cbPromptIdentity', s.promptIdentity);
  set('cbPromptBehavior', s.promptBehavior);
  const sug = document.getElementById('cbSuggested');
  if (sug && Array.isArray(s.suggestedQuestions)) sug.value = s.suggestedQuestions.join('\n');
}

function updateStatusUI(s) {
  const badge = document.getElementById('cbStatusBadge');
  if (badge) {
    badge.className = 'badge ' + (s.enabled ? 'badge-green' : 'badge-red');
    badge.textContent = s.enabled ? '🟢 Enabled' : '🔴 Disabled';
  }
  const desc = document.getElementById('cbStatusBadge') && document.getElementById('cbStatusDescription');
  if (desc) {
    desc.textContent = s.enabled
      ? 'The homepage AI assistant answers questions about coupons, selling and earnings using your knowledge base.'
      : 'Chatbot is disabled — the homepage shows your maintenance message. Existing conversations remain viewable here.';
  }
  const navBadge = document.getElementById('chatbotNavBadge');
  if (navBadge) {
    navBadge.textContent = s.enabled ? 'AI' : 'OFF';
    navBadge.className = 'nbadge ' + (s.enabled ? 'green' : '');
  }
}

async function saveChatbotConfig() {
  try {
    const body = {
      allowGuests: document.getElementById('cbAllowGuests').checked,
      requireLoginForAccountInfo: document.getElementById('cbRequireLogin').checked,
      maxMessageLength: parseInt(document.getElementById('cbMaxMsgLen').value, 10),
      maxConversationHistory: parseInt(document.getElementById('cbMaxHistory').value, 10),
      responseLanguage: document.getElementById('cbLanguage').value,
      welcomeMessage: document.getElementById('cbWelcomeMsg').value,
      model: document.getElementById('cbModel').value.trim(),
      maxOutputTokens: parseInt(document.getElementById('cbMaxTokens').value, 10),
      temperature: parseFloat(document.getElementById('cbTemperature').value),
      timeoutSeconds: parseInt(document.getElementById('cbTimeout').value, 10),
      fallbackBehavior: document.getElementById('cbFallbackBehavior').value,
      fallbackMessage: document.getElementById('cbFallbackMsg').value,
      unknownQuestionMessage: document.getElementById('cbUnknownMsg').value,
      botName: document.getElementById('cbBotName').value.trim(),
      botAvatar: document.getElementById('cbBotAvatar').value.trim() || '🤖',
      maintenanceMessage: document.getElementById('cbMaintenanceMsg').value,
      suggestedQuestions: document.getElementById('cbSuggested').value.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 8),
    };
    const data = await api('/chatbot/settings', { method: 'PUT', useAdmin: true, body });
    cbSettings = data.settings;
    fillConfigForms(cbSettings);
    updateStatusUI(cbSettings);
    showToast('Chatbot configuration saved', 'success');
    loadChatbotAudit();
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}

async function saveChatbotSecurity() {
  try {
    const body = {
      guestRateLimit: parseInt(document.getElementById('cbGuestLimit').value, 10),
      userRateLimit: parseInt(document.getElementById('cbUserLimit').value, 10),
      ipRateLimit: parseInt(document.getElementById('cbIpLimit').value, 10),
      maxMessageLength: parseInt(document.getElementById('cbSecMaxLen').value, 10),
    };
    await api('/chatbot/settings', { method: 'PUT', useAdmin: true, body });
    document.getElementById('cbMaxMsgLen').value = body.maxMessageLength;
    showToast('Security settings saved', 'success');
    loadChatbotAudit();
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}

// ── Enable / Disable with confirmation ───────────────────────────────────
function onChatbotEnableToggle(checked) {
  if (checked) {
    setChatbotEnabled(true);
  } else {
    // Ask before disabling
    openModal('cbDisableModal');
    document.getElementById('cbEnabledToggle').checked = true; // revert until confirmed
  }
}

async function setChatbotEnabled(enabled) {
  try {
    const data = await api('/chatbot/settings', { method: 'PUT', useAdmin: true, body: { enabled } });
    cbSettings = data.settings;
    fillConfigForms(cbSettings);
    updateStatusUI(cbSettings);
    showToast(enabled ? 'AI Chatbot enabled 🟢' : 'AI Chatbot disabled 🔴', enabled ? 'success' : 'warning');
    loadChatbotAudit();
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
    if (cbSettings) fillConfigForms(cbSettings);
  }
}

function confirmDisableChatbot() {
  closeModal('cbDisableModal');
  setChatbotEnabled(false);
}

// ── Stats / Overview ─────────────────────────────────────────────────────
async function loadChatbotStats() {
  try {
    const range = document.getElementById('cbRangeSelect')?.value || '30d';
    const now = new Date();
    let from;
    if (range === 'today') from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    else if (range === '7d') from = new Date(now.getTime() - 7 * 86400000).toISOString();
    else from = new Date(now.getTime() - 30 * 86400000).toISOString();

    const data = await api(`/chatbot/stats?from=${encodeURIComponent(from)}`, { useAdmin: true });
    const s = data.stats;

    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('cbStatConvsToday', s.conversationsToday);
    setText('cbStatMsgsToday', s.messagesToday);
    setText('cbStatActive', s.activeConversations);
    setText('cbStatAvgTime', s.avgResponseTimeMs ? (s.avgResponseTimeMs / 1000).toFixed(1) + 's' : '—');
    setText('cbStatFailed', s.failedRequests);
    setText('cbStatRateLimited', s.rateLimitedRequests);
    setText('cbStatApiUsage', s.rangeResponses);
    setText('cbStatRangeLabel', `(${range === 'today' ? 'today' : range})`);
    setText('cbUsageSuccess', s.successfulResponses);
    setText('cbUsageFailed', s.failedResponses);
    setText('cbUsageErrRate', s.errorRate + '%');
    setText('cbUsageTotalConvs', s.totalConversations);
    setText('cbUsageWeek', s.messagesWeek);
    setText('cbUsageMonth', s.messagesMonth);
  } catch (err) {
    console.warn('Chatbot stats warning:', err.message);
  }
}

async function loadChatbotAudit() {
  try {
    const data = await api('/chatbot/audit', { useAdmin: true });
    const el = document.getElementById('cbAuditList');
    if (!el) return;
    el.innerHTML = (data.entries || []).slice(0, 8).map(a => `
      <div class="activity-item">
        <div class="activity-dot" style="background:${a.action?.includes('delete') || a.action?.includes('disable') ? '#ef9a9a' : '#00e676'}"></div>
        <div class="activity-text"><strong>${esc(a.admin_email || 'system')}</strong> — ${esc(formatAuditAction(a.action))} <span style="color:#6b88aa">${esc(a.setting || '')}</span></div>
        <div class="activity-time">${fmtDT(a.timestamp)}</div>
      </div>
    `).join('') || '<div style="color:#6b88aa;font-size:.85rem;padding:8px 0">No chatbot changes recorded yet.</div>';
  } catch (err) {
    console.warn('Chatbot audit warning:', err.message);
  }
}

function formatAuditAction(action) {
  return String(action || '').replace(/_/g, ' ');
}

// ── Knowledge Base ───────────────────────────────────────────────────────
async function loadChatbotKnowledge() {
  try {
    const data = await api('/chatbot/knowledge', { useAdmin: true });
    cbKnowledge = data.entries || [];
    renderKnowledgeTable();
  } catch (err) {
    const body = document.getElementById('cbKbBody');
    if (body) body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#ef9a9a;padding:24px;">Failed to load: ${esc(err.message)}</td></tr>`;
  }
}

function renderKnowledgeTable() {
  const body = document.getElementById('cbKbBody');
  if (!body) return;
  const q = (document.getElementById('cbKbSearch')?.value || '').toLowerCase();
  const cat = document.getElementById('cbKbCategory')?.value || '';

  let rows = cbKnowledge;
  if (q) rows = rows.filter(e => `${e.question} ${e.answer} ${e.keywords}`.toLowerCase().includes(q));
  if (cat) rows = rows.filter(e => e.category === cat);

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#6b88aa;padding:24px;">No knowledge entries yet. Add your first one!</td></tr>';
    return;
  }

  body.innerHTML = rows.map(e => `
    <tr>
      <td style="max-width:260px"><strong>${esc(e.question)}</strong></td>
      <td><span class="badge badge-blue">${esc(e.category)}</span></td>
      <td style="max-width:320px;font-size:.8rem;color:#a8c0dc">${esc(String(e.answer).slice(0, 120))}${String(e.answer).length > 120 ? '…' : ''}</td>
      <td><label class="toggle"><input type="checkbox" ${e.enabled ? 'checked' : ''} onchange="toggleKnowledge('${esc(e.id)}', this.checked)"><span class="toggle-slider"></span></label></td>
      <td style="font-size:.78rem;color:#6b88aa">${fmtDT(e.updated_at)}</td>
      <td><div style="display:flex;gap:4px">
        <button class="btn btn-ghost btn-sm" onclick="openKnowledgeModal('${esc(e.id)}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteKnowledgeEntry('${esc(e.id)}')">Delete</button>
      </div></td>
    </tr>
  `).join('');
}

function openKnowledgeModal(id) {
  const entry = id ? cbKnowledge.find(e => e.id === id) : null;
  document.getElementById('cbKbModalTitle').textContent = entry ? 'Edit Knowledge' : 'Add Knowledge';
  document.getElementById('cbKbId').value = entry ? entry.id : '';
  document.getElementById('cbKbQuestion').value = entry ? entry.question : '';
  document.getElementById('cbKbKeywords').value = entry ? entry.keywords : '';
  document.getElementById('cbKbAnswer').value = entry ? entry.answer : '';
  document.getElementById('cbKbEnabled').checked = entry ? entry.enabled : true;
  if (entry) document.getElementById('cbKbCategoryInput').value = entry.category;
  openModal('cbKnowledgeModal');
}

async function saveKnowledgeEntry() {
  const id = document.getElementById('cbKbId').value;
  const body = {
    category: document.getElementById('cbKbCategoryInput').value,
    question: document.getElementById('cbKbQuestion').value.trim(),
    keywords: document.getElementById('cbKbKeywords').value.trim(),
    answer: document.getElementById('cbKbAnswer').value.trim(),
    enabled: document.getElementById('cbKbEnabled').checked,
  };
  if (!body.question || !body.answer) {
    showToast('Question and answer are required.', 'warning');
    return;
  }
  try {
    if (id) {
      await api(`/chatbot/knowledge/${encodeURIComponent(id)}`, { method: 'PUT', useAdmin: true, body });
    } else {
      await api('/chatbot/knowledge', { method: 'POST', useAdmin: true, body });
    }
    closeModal('cbKnowledgeModal');
    showToast('Knowledge entry saved', 'success');
    loadChatbotKnowledge();
    loadChatbotAudit();
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}

async function toggleKnowledge(id, enabled) {
  try {
    await api(`/chatbot/knowledge/${encodeURIComponent(id)}`, { method: 'PUT', useAdmin: true, body: { enabled } });
    showToast(enabled ? 'Entry enabled' : 'Entry disabled', 'success');
    loadChatbotAudit();
  } catch (err) {
    showToast('Update failed: ' + err.message, 'error');
    loadChatbotKnowledge();
  }
}

async function deleteKnowledgeEntry(id) {
  if (!confirm('Delete this knowledge entry?')) return;
  try {
    await api(`/chatbot/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE', useAdmin: true });
    showToast('Knowledge entry deleted', 'success');
    loadChatbotKnowledge();
    loadChatbotAudit();
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

// ── Conversations ────────────────────────────────────────────────────────
async function loadChatbotConversations() {
  const body = document.getElementById('cbConvBody');
  if (!body) return;
  try {
    const search = document.getElementById('cbConvSearch')?.value || '';
    const statusSel = document.getElementById('cbConvStatus')?.value || '';
    const from = document.getElementById('cbConvFrom')?.value || '';
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (statusSel === 'flagged') params.set('flagged', 'true');
    else if (statusSel) params.set('status', statusSel);
    if (from) params.set('from', from);

    const data = await api(`/chatbot/conversations${params.toString() ? '?' + params.toString() : ''}`, { useAdmin: true });
    cbConversations = data.conversations || [];

    if (!cbConversations.length) {
      body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#6b88aa;padding:24px;">No conversations found.</td></tr>';
      return;
    }

    body.innerHTML = cbConversations.map(c => {
      const flagged = c.flagged === true || c.flagged === 'true';
      return `
      <tr>
        <td><strong style="font-family:'JetBrains Mono',monospace">${esc(shortId(c.id))}</strong></td>
        <td><div style="display:flex;align-items:center;gap:8px">${avatarHtml(c.user_name || c.user_email || 'Guest')}${esc(c.user_name || c.user_email || 'Guest')}</div></td>
        <td>${c.is_guest === true || c.is_guest === 'true' ? '<span class="badge badge-gray">Guest</span>' : '<span class="badge badge-green">Logged-in</span>'}</td>
        <td>${esc(c.message_count || 0)}</td>
        <td style="font-size:.78rem;color:#6b88aa">${fmtDT(c.started_at)}</td>
        <td style="font-size:.78rem;color:#6b88aa">${fmtDT(c.last_active_at)}</td>
        <td>${flagged ? '<span class="badge badge-red">🚩 Flagged</span>' : '<span class="badge badge-green">Normal</span>'}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="viewConversation('${esc(c.id)}')">View</button></td>
      </tr>`;
    }).join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#ef9a9a;padding:24px;">Failed to load: ${esc(err.message)}</td></tr>`;
  }
}

async function viewConversation(id) {
  try {
    const data = await api(`/chatbot/conversations/${encodeURIComponent(id)}`, { useAdmin: true });
    cbCurrentConv = data.conversation;
    const c = data.conversation;
    const flagged = c.flagged === true || c.flagged === 'true';

    document.getElementById('cbConvTitle').innerHTML = `${esc(shortId(c.id))} <span class="gtext">Conversation</span>`;
    document.getElementById('cbConvSubtitle').textContent = c.user_email || 'Guest user';

    document.getElementById('cbConvMeta').innerHTML = `
      <div class="detail-meta-item"><div class="detail-meta-label">User ID</div><div class="detail-meta-value" style="font-size:.78rem">${esc(c.user_id || 'guest')}</div></div>
      <div class="detail-meta-item"><div class="detail-meta-label">Type</div><div class="detail-meta-value">${c.is_guest === true || c.is_guest === 'true' ? 'Guest' : 'Logged-in'}</div></div>
      <div class="detail-meta-item"><div class="detail-meta-label">Started</div><div class="detail-meta-value">${fmtDT(c.started_at)}</div></div>
      <div class="detail-meta-item"><div class="detail-meta-label">Last Active</div><div class="detail-meta-value">${fmtDT(c.last_active_at)}</div></div>
      <div class="detail-meta-item"><div class="detail-meta-label">Messages</div><div class="detail-meta-value">${esc(c.message_count || (data.messages || []).length)}</div></div>
      <div class="detail-meta-item"><div class="detail-meta-label">Status</div><div class="detail-meta-value">${flagged ? '<span class="badge badge-red">🚩 Flagged</span>' : '<span class="badge badge-green">Normal</span>'}</div></div>
    `;

    const flagBtn = document.getElementById('cbConvFlagBtn');
    if (flagBtn) flagBtn.innerHTML = flagged ? '✅ Unflag Conversation' : '🚩 Flag Conversation';

    document.getElementById('cbConvMessages').innerHTML = (data.messages || []).map(m => `
      <div>
        <div class="msg-meta">${m.role === 'user' ? '👤 User' : '🤖 AI'} · ${fmtDT(m.created_at)}${m.role === 'assistant' && m.model ? ' · ' + esc(m.model) : ''}${m.role === 'assistant' && m.response_time_ms ? ' · ' + esc(m.response_time_ms) + 'ms' : ''} ${m.status && m.status !== 'ok' ? '<span class="badge badge-orange">' + esc(m.status) + '</span>' : ''}</div>
        <div class="msg-bubble ${m.role === 'user' ? 'msg-user' : 'msg-support'}">${esc(m.content)}</div>
      </div>
    `).join('') || '<div style="color:#6b88aa;font-size:.85rem">No messages.</div>';

    openModal('cbConvModal');
  } catch (err) {
    showToast('Failed to load conversation: ' + err.message, 'error');
  }
}

async function toggleConvFlag() {
  if (!cbCurrentConv) return;
  const flagged = !(cbCurrentConv.flagged === true || cbCurrentConv.flagged === 'true');
  try {
    await api(`/chatbot/conversations/${encodeURIComponent(cbCurrentConv.id)}/flag`, { method: 'PUT', useAdmin: true, body: { flagged } });
    showToast(flagged ? 'Conversation flagged 🚩' : 'Conversation unflagged', 'success');
    closeModal('cbConvModal');
    loadChatbotConversations();
    loadChatbotSecurity();
    loadChatbotAudit();
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

// ── Security & Logs ──────────────────────────────────────────────────────
async function loadChatbotSecurity() {
  try {
    const data = await api('/chatbot/security', { useAdmin: true });
    const s = data.security || {};
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('cbSecBlocked', s.blockedRequests ?? 0);
    setText('cbSecInjection', s.promptInjectionAttempts ?? 0);
    setText('cbSecFlagged', s.flaggedConversations ?? 0);
  } catch (err) {
    console.warn('Chatbot security warning:', err.message);
  }
}

async function loadChatbotLogs() {
  const body = document.getElementById('cbLogBody');
  if (!body) return;
  try {
    const params = new URLSearchParams();
    const search = document.getElementById('cbLogSearch')?.value;
    const status = document.getElementById('cbLogStatus')?.value;
    const errorType = document.getElementById('cbLogError')?.value;
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (errorType) params.set('errorType', errorType);

    const data = await api(`/chatbot/logs${params.toString() ? '?' + params.toString() : ''}`, { useAdmin: true });
    const logs = data.logs || [];

    if (!logs.length) {
      body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#6b88aa;padding:24px;">No log entries.</td></tr>';
      return;
    }

    const statusBadge = (st) => {
      const map = { ok: 'badge-green', error: 'badge-red', rate_limited: 'badge-orange', blocked: 'badge-red', fallback: 'badge-gray' };
      return `<span class="badge ${map[st] || 'badge-gray'}">${esc(st)}</span>`;
    };

    body.innerHTML = logs.map(l => `
      <tr>
        <td style="font-size:.78rem;color:#6b88aa">${fmtDT(l.timestamp)}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:.75rem">${esc(l.request_id || '—')}</td>
        <td>${esc(l.user || 'guest')}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:.75rem">${esc(shortId(l.conversation_id))}</td>
        <td style="font-size:.78rem">${esc(l.model || '—')}</td>
        <td>${l.response_time_ms ? esc(l.response_time_ms) + 'ms' : '—'}</td>
        <td>${statusBadge(l.status)}</td>
        <td>${l.error_type ? `<span class="badge badge-red">${esc(l.error_type)}</span>` : '—'}</td>
      </tr>
    `).join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#ef9a9a;padding:24px;">Failed to load: ${esc(err.message)}</td></tr>`;
  }
}

// ── Prompt & Tools ───────────────────────────────────────────────────────
function renderToolsTable() {
  const body = document.getElementById('cbToolsBody');
  if (!body || !cbSettings) return;
  const levelBadge = (lvl) => lvl === 'public' ? '<span class="badge badge-blue">Public</span>' : '<span class="badge badge-purple">Logged-in users</span>';
  body.innerHTML = cbToolDefs.map(t => `
    <tr>
      <td><strong>${t.label}</strong></td>
      <td style="font-size:.82rem;color:#a8c0dc">${esc(t.description)}</td>
      <td>${levelBadge(t.level)}</td>
      <td><label class="toggle"><input type="checkbox" ${cbSettings[t.key] ? 'checked' : ''} data-tool="${t.key}"><span class="toggle-slider"></span></label></td>
    </tr>
  `).join('');
}

async function savePromptTools() {
  try {
    const toolBody = {};
    document.querySelectorAll('#cbToolsBody input[data-tool]').forEach(inp => {
      toolBody[inp.dataset.tool] = inp.checked;
    });
    const body = {
      ...toolBody,
      promptIdentity: document.getElementById('cbPromptIdentity').value.trim(),
      promptBehavior: document.getElementById('cbPromptBehavior').value.trim(),
    };
    const data = await api('/chatbot/settings', { method: 'PUT', useAdmin: true, body });
    cbSettings = data.settings;
    renderToolsTable();
    showToast('Prompt & tools saved', 'success');
    loadChatbotAudit();
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}

// Close chatbot modals on overlay click
['cbKnowledgeModal', 'cbConvModal', 'cbDisableModal'].forEach(id => {
  const ov = document.getElementById(id);
  if (ov) ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('open'); });
});

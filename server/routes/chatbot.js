// ============================================
// SaveHatke — Admin Chatbot Management Routes
// ============================================
// All endpoints require an authenticated admin (admin/super admin/support
// roles via requireAdmin). Mutations are audit-logged with admin identity.

const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const chatbot = require('../services/chatbotService');
const nvidia = require('../services/nvidiaService');

const router = express.Router();

// ── GET /api/chatbot/status — model + API key configuration status ────────
// SECURITY: never returns the API key itself, only whether it is configured.
router.get('/status', authenticateToken, requireAdmin, (req, res) => {
  res.json({
    apiKeyConfigured: nvidia.isConfigured(),
    defaultModel: nvidia.getDefaultModel(),
    configuredBaseUrl: nvidia.isConfigured() ? 'secure server-side env' : 'not set',
  });
});

// ── GET /api/chatbot/settings ─────────────────────────────────────────────
router.get('/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const settings = await chatbot.getSettingsForAdmin();
    res.json({ settings, categories: chatbot.KNOWLEDGE_CATEGORIES, tools: chatbot.TOOL_DEFS });
  } catch (err) {
    console.error('Chatbot settings read error:', err.message);
    res.status(500).json({ error: 'Failed to load chatbot settings.' });
  }
});

// ── PUT /api/chatbot/settings ─────────────────────────────────────────────
router.put('/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const settings = await chatbot.saveSettings(req.body || {}, req.user);
    res.json({ settings, message: 'Chatbot settings saved.' });
  } catch (err) {
    console.error('Chatbot settings save error:', err.message);
    res.status(500).json({ error: 'Failed to save chatbot settings.' });
  }
});

// ── GET /api/chatbot/stats — overview + usage analytics ───────────────────
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    const stats = await chatbot.getStats({ from, to });
    res.json({ stats });
  } catch (err) {
    console.error('Chatbot stats error:', err.message);
    res.status(500).json({ error: 'Failed to load chatbot stats.' });
  }
});

// ── Knowledge base CRUD ───────────────────────────────────────────────────
router.get('/knowledge', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const entries = await chatbot.listKnowledge();
    res.json({ entries, categories: chatbot.KNOWLEDGE_CATEGORIES });
  } catch (err) {
    console.error('Knowledge list error:', err.message);
    res.status(500).json({ error: 'Failed to load knowledge base.' });
  }
});

router.post('/knowledge', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { category, question, answer, keywords } = req.body || {};
    if (!question || !answer) {
      return res.status(400).json({ error: 'Question and answer are required.' });
    }
    const entry = await chatbot.addKnowledge({ category, question, answer, keywords }, req.user);
    res.status(201).json({ entry, message: 'Knowledge entry added.' });
  } catch (err) {
    console.error('Knowledge add error:', err.message);
    res.status(500).json({ error: 'Failed to add knowledge entry.' });
  }
});

router.put('/knowledge/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const entry = await chatbot.updateKnowledge(req.params.id, req.body || {}, req.user);
    if (!entry) return res.status(404).json({ error: 'Knowledge entry not found.' });
    res.json({ entry, message: 'Knowledge entry updated.' });
  } catch (err) {
    console.error('Knowledge update error:', err.message);
    res.status(500).json({ error: 'Failed to update knowledge entry.' });
  }
});

router.delete('/knowledge/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const deleted = await chatbot.deleteKnowledge(req.params.id, req.user);
    if (!deleted) return res.status(404).json({ error: 'Knowledge entry not found.' });
    res.json({ message: 'Knowledge entry deleted.' });
  } catch (err) {
    console.error('Knowledge delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete knowledge entry.' });
  }
});

// ── Conversations (private user data — admin authorization required) ──────
router.get('/conversations', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { search, status, flagged, from, to } = req.query;
    const conversations = await chatbot.listConversations({ search, status, flagged, from, to });
    res.json({ conversations });
  } catch (err) {
    console.error('Conversations list error:', err.message);
    res.status(500).json({ error: 'Failed to load conversations.' });
  }
});

router.get('/conversations/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const detail = await chatbot.getConversationDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Conversation not found.' });
    res.json(detail);
  } catch (err) {
    console.error('Conversation detail error:', err.message);
    res.status(500).json({ error: 'Failed to load conversation.' });
  }
});

router.put('/conversations/:id/flag', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { flagged } = req.body || {};
    const conv = await chatbot.flagConversation(req.params.id, flagged, req.user);
    if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
    res.json({ conversation: conv, message: flagged ? 'Conversation flagged.' : 'Conversation unflagged.' });
  } catch (err) {
    console.error('Conversation flag error:', err.message);
    res.status(500).json({ error: 'Failed to flag conversation.' });
  }
});

// ── Logs ──────────────────────────────────────────────────────────────────
router.get('/logs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { search, status, errorType, from, to } = req.query;
    const logs = await chatbot.listLogs({ search, status, errorType, from, to });
    res.json({ logs });
  } catch (err) {
    console.error('Chatbot logs error:', err.message);
    res.status(500).json({ error: 'Failed to load chatbot logs.' });
  }
});

// ── Security events summary ───────────────────────────────────────────────
router.get('/security', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    const stats = await chatbot.getStats({ from, to });
    const flagged = (await chatbot.listConversations({ flagged: true })).length;
    res.json({ security: {
      rateLimitedRequests: stats.rateLimitedRequests,
      blockedRequests: stats.blockedRequests,
      promptInjectionAttempts: stats.promptInjectionAttempts,
      invalidRequests: stats.invalidRequests,
      apiErrors: stats.apiErrors,
      flaggedConversations: flagged,
      failedAuth: 0, // auth failures on /api/chat surface as invalid requests; JWT rejects happen at gateway level
    }});
  } catch (err) {
    console.error('Chatbot security error:', err.message);
    res.status(500).json({ error: 'Failed to load security summary.' });
  }
});

// ── Audit trail ───────────────────────────────────────────────────────────
router.get('/audit', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const entries = await chatbot.listAudit();
    res.json({ entries });
  } catch (err) {
    console.error('Chatbot audit error:', err.message);
    res.status(500).json({ error: 'Failed to load audit log.' });
  }
});

module.exports = router;

// ============================================
// SaveHatke — Public Chat Endpoints (/api/chat)
// ============================================
// The homepage chatbot widget talks ONLY to this backend. The NVIDIA API
// key, system prompt and tools stay server-side. Pipeline per message:
// auth (optional) → enabled check → guest policy → validation → rate
// limiting → injection scan → conversation handling → knowledge retrieval
// → permitted tool calls → NVIDIA API → output validation → response.

const express = require('express');
const { optionalAuth } = require('../middleware/auth');
const getClientIP = require('../middleware/getClientIP');
const chatbot = require('../services/chatbotService');

const router = express.Router();

// GET /api/chat/config — public, safe subset of settings for the widget
router.get('/config', async (req, res) => {
  try {
    const config = await chatbot.getPublicConfig();
    res.json(config);
  } catch (err) {
    console.error('Chat config error:', err.message);
    res.status(500).json({ error: 'Chat temporarily unavailable.' });
  }
});

// GET /api/chat/status — lightweight availability check for the widget
router.get('/status', async (req, res) => {
  try {
    const config = await chatbot.getPublicConfig();
    res.json({ enabled: config.enabled, botName: config.botName });
  } catch (err) {
    res.json({ enabled: false });
  }
});

// POST /api/chat — send a message, receive the assistant reply
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { message, conversationId } = req.body || {};
    const ip = getClientIP(req);

    const result = await chatbot.handleMessage({
      message,
      conversationId,
      user: req.user || null, // identity only from the verified JWT
      ip,
    });

    const httpStatus = result.ok ? 200
      : result.disabled ? 503
      : result.loginRequired ? 401
      : result.blocked ? 403
      : result.rateLimited ? 429
      : 500;
    return res.status(httpStatus).json({
      message: result.reply,      // primary field consumed by the homepage widget
      reply: result.reply,        // alias kept for other clients
      conversationId: result.conversationId || null,
      requestId: result.requestId,
      loginRequired: result.loginRequired || false,
    });
  } catch (err) {
    console.error('Chat handler error:', err.message);
    // Never expose raw server errors to users
    res.status(500).json({ error: 'Sorry, something went wrong. Please try again.' });
  }
});

module.exports = router;

// ============================================
// SaveHatke — Support Routes
// ============================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { optionalAuth } = require('../middleware/auth');
const db = require('../services/googleSheets');

const router = express.Router();

// POST /api/support/ticket — Submit a support ticket
router.post('/ticket', optionalAuth, async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ error: 'All fields are required: name, email, subject, message.' });
    }

    const storageError = db.getWriteAvailabilityError(
      'Support ticket submission is temporarily unavailable because Google Sheets is not connected.'
    );
    if (storageError) {
      return res.status(503).json(storageError);
    }

    const ticket = {
      id: uuidv4(),
      name: name.trim(),
      userEmail: email.toLowerCase().trim(),
      subject: subject.trim(),
      message: message.trim(),
      status: 'open',
      createdAt: new Date().toISOString(),
      resolvedAt: '',
    };

    await db.appendRow(db.SHEETS.SUPPORT_TICKETS, ticket);

    res.status(201).json({
      message: 'Support ticket submitted successfully. We will get back to you within 24 hours.',
      ticketId: ticket.id,
    });
  } catch (err) {
    console.error('Support ticket error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/support/tickets — Get tickets (for logged-in users or all for admin)
router.get('/tickets', optionalAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Login required to view your tickets.' });
    }

    let tickets;
    if (req.user.role === 'admin') {
      tickets = await db.getRows(db.SHEETS.SUPPORT_TICKETS);
    } else {
      tickets = await db.findRows(db.SHEETS.SUPPORT_TICKETS, 'userEmail', req.user.email);
    }

    res.json({
      tickets: tickets.map((t) => ({
        id: t.id,
        subject: t.subject,
        message: t.message,
        status: t.status,
        createdAt: t.createdAt,
        resolvedAt: t.resolvedAt,
      })),
    });
  } catch (err) {
    console.error('List tickets error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;

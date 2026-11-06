'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const db = require('../services/googleSheets');

const router = express.Router();
const ALLOWED_ADMIN_EMAIL = 'rupayandas2024@gmail.com';
const BALANCE_SHEET = db.SHEETS.PERSONAL_FINANCE_BALANCE;
const LEDGER_SHEET = db.SHEETS.PERSONAL_FINANCE_LEDGER;

async function readBalance() {
  const rows = await db.getRows(BALANCE_SHEET, { strict: true });
  const row = rows.find(item => item.id === 'current-balance');
  const value = Number(row && row.currentBalance || 0);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : 0;
}
async function writeBalance(value) {
  const rows = await db.getRows(BALANCE_SHEET, { strict: true });
  const existing = rows.find(item => item.id === 'current-balance');
  const data = { id: 'current-balance', currentBalance: Number(value).toFixed(2), updatedAt: new Date().toISOString() };
  if (existing) await db.updateRow(BALANCE_SHEET, 'id', 'current-balance', data, { strict: true });
  else await db.appendRow(BALANCE_SHEET, data, { strict: true });
}

function personalFinanceAdminOnly(req, res, next) {
  const email = String(req.user && req.user.email || '').toLowerCase().trim();
  if (email !== ALLOWED_ADMIN_EMAIL) return res.status(403).json({ error: 'Personal Finance access denied.' });
  next();
}
function parseAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 && amount <= 100000000 ? Math.round(amount * 100) / 100 : null;
}
function dateOnly(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) return null;
  return s;
}

// Any admin role is accepted for this exact email; no Owner/Super Admin role is required.
router.use(authenticateToken, requireAdmin, personalFinanceAdminOnly);

router.get('/overview', async (req, res) => {
  try {
    if (!db.isSheetsConnected()) return res.status(503).json({ error: 'Google Sheets is unavailable. No data was changed.' });
    const [balanceRows, ledgerRows] = await Promise.all([
      db.getRows(BALANCE_SHEET, { strict: true }),
      db.getRows(LEDGER_SHEET, { strict: true }),
    ]);
    const balanceRow = balanceRows.find(r => r.id === 'current-balance');
    const balance = Math.max(0, Number(balanceRow && balanceRow.currentBalance || 0));
    const expenses = ledgerRows.filter(r => r.type === 'EXPENSE').reduce((n, r) => n + Number(r.amount || 0), 0);
    const transactions = ledgerRows.filter(r => r.type === 'EXPENSE')
      .sort((a, b) => String(b.transactionDate || b.createdAt).localeCompare(String(a.transactionDate || a.createdAt)));
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, balance, expenses, transactions });
  } catch (err) {
    console.error('Personal finance overview failed:', err.message);
    return res.status(503).json({ error: 'Could not read Personal Finance from Google Sheets.' });
  }
});

router.post('/balance-add', async (req, res) => {
  const amount = parseAmount(req.body && req.body.amount);
  if (!amount) return res.status(400).json({ error: 'Enter a valid amount greater than ₹0.' });
  try {
    if (!db.isSheetsConnected()) return res.status(503).json({ error: 'Google Sheets is unavailable. Nothing was saved.' });
    const current = await readBalance();
    await writeBalance(Math.round((current + amount) * 100) / 100);
    return res.json({ ok: true, message: 'Balance updated.' });
  } catch (err) {
    console.error('Personal finance balance add failed:', err.message);
    return res.status(503).json({ error: 'Balance could not be saved to Google Sheets.' });
  }
});

router.post('/expense', async (req, res) => {
  const amount = parseAmount(req.body && req.body.amount);
  const category = String(req.body && req.body.category || '').trim().slice(0, 80);
  const note = String(req.body && req.body.note || '').trim().slice(0, 240);
  const transactionDate = dateOnly(req.body && req.body.transactionDate);
  if (!amount) return res.status(400).json({ error: 'Enter a valid amount greater than ₹0.' });
  if (!category) return res.status(400).json({ error: 'Choose or enter an expense category.' });
  if (!transactionDate) return res.status(400).json({ error: 'Enter a valid transaction date.' });
  try {
    if (!db.isSheetsConnected()) return res.status(503).json({ error: 'Google Sheets is unavailable. Nothing was saved.' });
    const [available, ledgerRows] = await Promise.all([
      readBalance(),
      db.getRows(LEDGER_SHEET, { strict: true }),
    ]);
    if (amount > available) return res.status(409).json({ error: 'Insufficient balance. Add balance before recording this expense.' });
    await db.appendRow(LEDGER_SHEET, {
      id: uuidv4(), type: 'EXPENSE', amount: amount.toFixed(2), category, note,
      transactionDate, createdAt: new Date().toISOString(), createdBy: ALLOWED_ADMIN_EMAIL,
    }, { strict: true });
    await writeBalance(Math.round((available - amount) * 100) / 100);
    return res.json({ ok: true, message: 'Expense saved.' });
  } catch (err) {
    console.error('Personal finance expense failed:', err.message);
    return res.status(503).json({ error: 'Expense could not be saved to Google Sheets.' });
  }
});

module.exports = router;

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');

const router = express.Router();
const ALLOWED_ADMIN_EMAIL = 'rupayandas2024@gmail.com';
const BALANCE_SHEET = db.SHEETS.PERSONAL_FINANCE_BALANCE;
const LEDGER_SHEET = db.SHEETS.PERSONAL_FINANCE_LEDGER;

async function financeClient() {
  const client = supabase.getClient();
  if (!client) throw new Error('Supabase finance storage is unavailable.');
  return client;
}

// One-time import from the existing Sheets wallet and expense ledger. The
// database function locks the wallet row and refuses a second import, so two
// simultaneous cold starts cannot overwrite one another.
async function ensureFinanceInitialized() {
  const client = await financeClient();
  const { data: wallet, error } = await client
    .from('personal_finance_wallet').select('imported_at').eq('id', 'personal').single();
  if (error) throw new Error('Personal Finance database is unavailable.');
  if (wallet && wallet.imported_at) return;
  const [balanceRows, ledgerRows] = await Promise.all([
    db.getRows(BALANCE_SHEET, { strict: true }),
    db.getRows(LEDGER_SHEET, { strict: true }),
  ]);
  const balanceRow = balanceRows.find(item => item.id === 'current-balance');
  const openingBalance = Number(balanceRow && balanceRow.currentBalance || 0);
  if (!Number.isFinite(openingBalance) || openingBalance < 0) throw new Error('The existing Personal Finance balance is invalid.');
  const entries = (ledgerRows || []).map(row => ({
    id: String(row.id || ''),
    type: String(row.type || 'EXPENSE').toUpperCase() === 'BALANCE_ADD' ? 'BALANCE_ADD' : 'EXPENSE',
    amount: String(row.amount || '0'),
    category: String(row.category || ''),
    note: String(row.note || ''),
    transactionDate: row.transactionDate || '',
    createdAt: row.createdAt || '',
    createdBy: row.createdBy || '',
  }));
  const { error: importError } = await client.rpc('savehatke_personal_finance_import', {
    p_balance: openingBalance,
    p_entries: entries,
  });
  if (importError) throw new Error('Existing Personal Finance data could not be imported safely.');
}

async function applyFinanceEntry({ type, amount, category = '', note = '', transactionDate, requestId }) {
  const client = await financeClient();
  const { data, error } = await client.rpc('savehatke_personal_finance_apply', {
    p_request_id: requestId,
    p_type: type,
    p_amount: amount,
    p_category: category,
    p_note: note,
    p_transaction_date: transactionDate,
    p_created_by: ALLOWED_ADMIN_EMAIL,
  });
  if (error) throw new Error('Personal Finance transaction could not be saved.');
  return data;
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
    await ensureFinanceInitialized();
    const client = await financeClient();
    const [{ data: wallet, error: walletError }, { data: ledgerRows, error: ledgerError }] = await Promise.all([
      client.from('personal_finance_wallet').select('balance').eq('id', 'personal').single(),
      client.from('personal_finance_ledger').select('*').eq('type', 'EXPENSE').order('transaction_date', { ascending: false }).limit(2000),
    ]);
    if (walletError || ledgerError) throw new Error('Personal Finance database read failed.');
    const balance = Number(wallet.balance || 0);
    const transactions = (ledgerRows || []).map(row => ({
      id: row.id, type: row.type, amount: Number(row.amount), category: row.category,
      note: row.note, transactionDate: row.transaction_date, createdAt: row.created_at,
      createdBy: row.created_by,
    }));
    const expenses = transactions.reduce((n, r) => n + Number(r.amount || 0), 0);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, balance, expenses, transactions });
  } catch (err) {
    console.error('Personal finance overview failed:', err.message);
    return res.status(503).json({ error: 'Could not read Personal Finance.' });
  }
});

router.post('/balance-add', async (req, res) => {
  const amount = parseAmount(req.body && req.body.amount);
  if (!amount) return res.status(400).json({ error: 'Enter a valid amount greater than ₹0.' });
  try {
    await ensureFinanceInitialized();
    const result = await applyFinanceEntry({
      type: 'BALANCE_ADD', amount, note: String(req.body && req.body.note || '').trim().slice(0, 240), transactionDate: new Date().toISOString().slice(0, 10),
      requestId: String(req.get('Idempotency-Key') || req.body?.requestId || uuidv4()).slice(0, 120),
    });
    return res.json({ ok: true, message: 'Balance updated.', balance: Number(result.balance), duplicate: !!result.duplicate });
  } catch (err) {
    console.error('Personal finance balance add failed:', err.message);
    return res.status(503).json({ error: 'Balance could not be saved.' });
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
    await ensureFinanceInitialized();
    const result = await applyFinanceEntry({
      type: 'EXPENSE', amount, category, note, transactionDate,
      requestId: String(req.get('Idempotency-Key') || req.body?.requestId || uuidv4()).slice(0, 120),
    });
    if (!result.ok && result.code === 'INSUFFICIENT_BALANCE') {
      return res.status(409).json({ error: 'Insufficient balance. Add balance before recording this expense.', balance: Number(result.balance) });
    }
    return res.json({ ok: true, message: 'Expense saved.', balance: Number(result.balance), duplicate: !!result.duplicate });
  } catch (err) {
    console.error('Personal finance expense failed:', err.message);
    return res.status(503).json({ error: 'Expense could not be saved.' });
  }
});

module.exports = router;

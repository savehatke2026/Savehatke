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

function personalFinanceAdminOnly(req, res, next) {
  const email = String(req.user && req.user.email || '').toLowerCase().trim();
  if (email !== ALLOWED_ADMIN_EMAIL) return res.status(403).json({ error: 'Personal Finance access denied.' });
  next();
}

function parseAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 && amount <= 100000000
    ? Math.round(amount * 100) / 100
    : null;
}

function dateOnly(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const s = String(value);
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) return null;
  return s;
}

async function financeClient() {
  const client = supabase.getClient();
  if (!client) throw new Error('Personal Finance database is unavailable.');
  return client;
}

// Import the existing Sheets balance and expense history once, without deleting
// or modifying the original tabs. The SQL import function is row-locked/idempotent.
async function ensureFinanceInitialized() {
  const client = await financeClient();
  const { data: wallet, error } = await client
    .from('personal_finance_wallet')
    .select('id, imported_at')
    .eq('id', 'personal')
    .maybeSingle();
  if (error) throw error;
  if (wallet && wallet.imported_at) return;

  const [balanceRows, ledgerRows] = await Promise.all([
    db.getRows(BALANCE_SHEET, { strict: true }),
    db.getRows(LEDGER_SHEET, { strict: true }),
  ]);
  const balanceRow = (balanceRows || []).find(row => row.id === 'current-balance');
  const openingBalance = Number(balanceRow && balanceRow.currentBalance || 0);
  if (!Number.isFinite(openingBalance) || openingBalance < 0) {
    throw new Error('The existing Personal Finance balance is invalid.');
  }
  const entries = (ledgerRows || [])
    .filter(row => row && String(row.type || '').toUpperCase() === 'EXPENSE')
    .map(row => ({
      id: String(row.id || ''),
      type: 'EXPENSE',
      amount: String(row.amount || ''),
      category: String(row.category || ''),
      note: String(row.note || ''),
      transactionDate: row.transactionDate || '',
      createdAt: row.createdAt || '',
      createdBy: row.createdBy || '',
    }))
    .filter(row => row.id && Number(row.amount) > 0 && Number.isFinite(Number(row.amount)));

  const { error: importError } = await client.rpc('savehatke_personal_finance_import', {
    p_balance: openingBalance,
    p_entries: entries,
  });
  if (importError) throw importError;
}

async function getFinanceSnapshot() {
  const client = await financeClient();
  const { data: wallet, error: walletError } = await client
    .from('personal_finance_wallet')
    .select('balance')
    .eq('id', 'personal')
    .single();
  if (walletError) throw walletError;

  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from('personal_finance_ledger')
      .select('*')
      .eq('type', 'EXPENSE')
      .order('transaction_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const transactions = rows.map(row => ({
    id: row.id,
    type: row.type,
    amount: Number(row.amount),
    category: row.category,
    note: row.note,
    transactionDate: row.transaction_date,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }));
  return {
    balance: Number(wallet.balance || 0),
    expenses: transactions.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    transactions,
  };
}

async function applyFinanceChange(req, res, type) {
  const amount = parseAmount(req.body && req.body.amount);
  const category = String(req.body && req.body.category || '').trim().slice(0, 80);
  const note = String(req.body && req.body.note || '').trim().slice(0, 240);
  const transactionDate = dateOnly(req.body && req.body.transactionDate);

  if (!amount) return res.status(400).json({ error: 'Enter a valid amount greater than ₹0.' });
  if (type === 'EXPENSE' && !category) return res.status(400).json({ error: 'Choose or enter an expense category.' });
  if (!transactionDate) return res.status(400).json({ error: 'Enter a valid transaction date.' });

  try {
    await ensureFinanceInitialized();
    // Clients should reuse this key when retrying the same request after a timeout.
    const requestId = String(req.get('Idempotency-Key') || (req.body && req.body.requestId) || uuidv4()).trim().slice(0, 120);
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
    if (error) throw error;
    if (data && data.ok === false && data.code === 'INSUFFICIENT_BALANCE') {
      return res.status(409).json({
        error: 'Insufficient balance. Add balance before recording this expense.',
        balance: Number(data.balance || 0),
      });
    }
    return res.json({
      ok: true,
      duplicate: !!(data && data.duplicate),
      balance: Number(data && data.balance || 0),
      message: type === 'EXPENSE' ? 'Expense saved.' : 'Balance updated.',
    });
  } catch (err) {
    console.error('Personal Finance write failed:', err.message);
    return res.status(503).json({ error: 'Personal Finance could not be saved. No partial update was applied.' });
  }
}

router.use(authenticateToken, requireAdmin, personalFinanceAdminOnly);

router.get('/overview', async (req, res) => {
  try {
    await ensureFinanceInitialized();
    const snapshot = await getFinanceSnapshot();
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, ...snapshot });
  } catch (err) {
    console.error('Personal Finance overview failed:', err.message);
    return res.status(503).json({ error: 'Could not load Personal Finance.' });
  }
});

router.post('/balance-add', (req, res) => applyFinanceChange(req, res, 'BALANCE_ADD'));
router.post('/expense', (req, res) => applyFinanceChange(req, res, 'EXPENSE'));

module.exports = router;

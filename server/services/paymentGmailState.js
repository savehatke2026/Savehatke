'use strict';

// ============================================
// SaveHatke — Payment Gmail push/watch state
// ============================================
// One row per connected payment mailbox in the PaymentGmailState sheet. Tracks:
//   * last_history_id  — the newest Gmail historyId we have observed, so an
//     incremental scan can read only new messages (and the push handler keeps
//     continuity across invocations);
//   * watch_expiration — epoch-ms when the current users.watch lapses, so the
//     daily cron can renew it before Google drops the push subscription.
//
// This is deliberately tiny and best-effort: if the sheet read/write fails the
// callers fall back to the bounded query scan, which is always correct on its
// own. It never stores tokens (those live in security_credentials).

const db = require('./googleSheets');

const STATE = db.SHEETS.PAYMENT_GMAIL_STATE;

function normKey(email) {
  return String(email || '').trim().toLowerCase() || 'payment';
}

async function getState(email) {
  const key = normKey(email);
  try {
    const rows = await db.getRows(STATE);
    const row = (rows || []).find((r) => normKey(r.email) === key);
    if (!row) return null;
    return {
      email: row.email || key,
      lastHistoryId: row.last_history_id || '',
      watchExpiration: row.watch_expiration || '',
      updatedAt: row.updated_at || '',
    };
  } catch (e) {
    console.warn('[paymentGmailState] read notice:', e.message);
    return null;
  }
}

async function upsertState(email, patch = {}) {
  const key = normKey(email);
  const now = new Date().toISOString();
  try {
    const rows = await db.getRows(STATE);
    const existing = (rows || []).find((r) => normKey(r.email) === key);
    const next = {
      email: key,
      last_history_id:
        patch.lastHistoryId !== undefined
          ? String(patch.lastHistoryId || '')
          : (existing && existing.last_history_id) || '',
      watch_expiration:
        patch.watchExpiration !== undefined
          ? String(patch.watchExpiration || '')
          : (existing && existing.watch_expiration) || '',
      updated_at: now,
    };
    if (existing) {
      await db.updateRow(STATE, 'email', existing.email || key, next);
    } else {
      await db.appendRow(STATE, next);
    }
    return {
      email: key,
      lastHistoryId: next.last_history_id,
      watchExpiration: next.watch_expiration,
      updatedAt: now,
    };
  } catch (e) {
    console.warn('[paymentGmailState] write notice:', e.message);
    return null;
  }
}

/** Advance the last processed historyId (only forward — never clobbers with empty). */
async function saveHistoryId(email, historyId) {
  if (!historyId) return null;
  return upsertState(email, { lastHistoryId: historyId });
}

/** Persist the watch result (historyId + expiration) after users.watch. */
async function saveWatch(email, { historyId, expiration } = {}) {
  const patch = {};
  if (historyId !== undefined) patch.lastHistoryId = historyId;
  if (expiration !== undefined) patch.watchExpiration = expiration;
  return upsertState(email, patch);
}

module.exports = { getState, upsertState, saveHistoryId, saveWatch };

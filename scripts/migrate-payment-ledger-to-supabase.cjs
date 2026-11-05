#!/usr/bin/env node
'use strict';

// One-time copy of the existing Google Sheets payment ledger into Supabase.
// Run AFTER applying supabase/migrations/20261105_supabase_payment_ledger.sql
// and BEFORE deploying the Supabase-backed paymentStore.
//
// Required environment:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   Existing Google Sheets service-account credentials and spreadsheet ID
//
// Safe to re-run: each table is upserted by its stable primary key. The source
// tabs are not deleted or modified.

require('dotenv').config();

const sheets = require('../server/services/googleSheets');
const supabase = require('../server/services/supabase');

function textValue(value, fallback = '') {
  return value === null || value === undefined ? fallback : String(value);
}

function numberValue(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(String(value).replace(/[^0-9.\\-]/g, ''));
  if (!Number.isFinite(n)) throw new Error('Invalid numeric value in payment ledger: ' + String(value));
  return Math.round(n * 100) / 100;
}

function nullableNumber(value) {
  return value === null || value === undefined || value === '' ? null : numberValue(value, null);
}

function timestamp(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Invalid timestamp in payment ledger: ' + String(value));
  }
  return date.toISOString();
}

function jsonValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    return { text: String(value) };
  }
}

function batches(items, size = 300) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function mapOrder(row) {
  if (!row.id) throw new Error('An Orders row is missing its id; migration stopped without skipping it.');
  return {
    id: textValue(row.id),
    order_code: textValue(row.order_code),
    user_id: textValue(row.user_id),
    user_email: textValue(row.user_email),
    coupon_id: textValue(row.coupon_id),
    amount: numberValue(row.amount),
    currency: textValue(row.currency, 'INR') || 'INR',
    status: textValue(row.status, 'PENDING') || 'PENDING',
    buyer_name: textValue(row.buyer_name),
    buyer_email: textValue(row.buyer_email),
    buyer_phone: textValue(row.buyer_phone),
    coupon_code: textValue(row.coupon_code),
    coupon_brand: textValue(row.coupon_brand),
    created_at: timestamp(row.created_at, new Date().toISOString()),
    updated_at: timestamp(row.updated_at, timestamp(row.created_at, new Date().toISOString())),
    expires_at: timestamp(row.expires_at),
    paid_at: timestamp(row.paid_at),
    transaction_id: textValue(row.transaction_id) || null,
    transaction_type: textValue(row.transaction_type) || null,
    coupon_snapshot: textValue(row.coupon_snapshot) || null,
  };
}

function mapPayment(row) {
  if (!row.payment_id) throw new Error('A Payments row is missing its payment_id; migration stopped without skipping it.');
  if (!row.order_id) throw new Error('Payment ' + row.payment_id + ' has no order_id; migration stopped.');
  return {
    payment_id: textValue(row.payment_id),
    order_id: textValue(row.order_id),
    user_id: textValue(row.user_id),
    user_email: textValue(row.user_email),
    coupon_id: textValue(row.coupon_id),
    amount: numberValue(row.amount),
    received_amount: nullableNumber(row.received_amount),
    currency: textValue(row.currency, 'INR') || 'INR',
    status: textValue(row.status, 'PENDING') || 'PENDING',
    created_at: timestamp(row.created_at, new Date().toISOString()),
    updated_at: timestamp(row.updated_at, timestamp(row.created_at, new Date().toISOString())),
    expires_at: timestamp(row.expires_at),
    check_expires_at: timestamp(row.check_expires_at),
    payment_expires_at: timestamp(row.payment_expires_at),
    verification_started_at: timestamp(row.verification_started_at),
    verification_deadline: timestamp(row.verification_deadline),
    last_checked_at: timestamp(row.last_checked_at),
    paid_at: timestamp(row.paid_at),
    upi_id: textValue(row.upi_id),
    payee_name: textValue(row.payee_name),
    upi_uri: textValue(row.upi_uri),
    verified_transaction_id: textValue(row.verified_transaction_id),
    verified_utr: textValue(row.verified_utr),
    verification_source: textValue(row.verification_source),
    verification_notes: textValue(row.verification_notes),
  };
}

function mapNotification(row) {
  if (!row.id) throw new Error('A PaymentNotifications row is missing its id; migration stopped.');
  const id = textValue(row.id);
  return {
    id,
    fingerprint: textValue(row.fingerprint) || 'legacy:' + id,
    source: textValue(row.source, 'unknown') || 'unknown',
    amount: nullableNumber(row.amount),
    currency: textValue(row.currency, 'INR') || 'INR',
    transaction_id: textValue(row.transaction_id),
    utr: textValue(row.utr),
    payer_vpa: textValue(row.payer_vpa),
    payee_vpa: textValue(row.payee_vpa),
    reference: textValue(row.reference),
    occurred_at: timestamp(row.occurred_at),
    status: textValue(row.status, 'RECEIVED') || 'RECEIVED',
    matched_payment_id: textValue(row.matched_payment_id),
    notes: textValue(row.notes),
    raw: jsonValue(row.raw),
    created_at: timestamp(row.created_at, new Date().toISOString()),
    processed_at: timestamp(row.processed_at),
  };
}

async function upsertAll(client, table, key, rows) {
  let written = 0;
  for (const batch of batches(rows)) {
    const { error } = await client.from(table).upsert(batch, { onConflict: key });
    if (error) {
      throw new Error(
        'Import into ' + table + ' stopped after ' + written + ' rows: ' +
        error.message + (error.details ? ' (' + error.details + ')' : '')
      );
    }
    written += batch.length;
    console.log('[payment-ledger-migration] ' + table + ': ' + written + '/' + rows.length);
  }
  return written;
}

async function main() {
  if (!supabase.isConfigured()) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY before running this migration.');
  }
  await sheets.initialize();
  const client = supabase.getClient();
  if (!client) throw new Error('Supabase client could not be initialized.');

  const [orderRows, paymentRows, notificationRows] = await Promise.all([
    sheets.getRowsFresh(sheets.SHEETS.ORDERS, { strict: true }),
    sheets.getRowsFresh(sheets.SHEETS.PAYMENTS, { strict: true }),
    sheets.getRowsFresh(sheets.SHEETS.PAYMENT_NOTIFICATIONS, { strict: true }),
  ]);

  const orders = orderRows.map(mapOrder);
  const payments = paymentRows.map(mapPayment);
  const notifications = notificationRows.map(mapNotification);

  console.log('[payment-ledger-migration] Source rows:', {
    orders: orders.length,
    payments: payments.length,
    payment_notifications: notifications.length,
  });

  // Parent records are imported before their dependent payment records.
  await upsertAll(client, 'orders', 'id', orders);
  await upsertAll(client, 'payments', 'payment_id', payments);
  await upsertAll(client, 'payment_notifications', 'id', notifications);

  console.log('[payment-ledger-migration] Complete. Google Sheets source tabs were left untouched.');
}

main().catch((error) => {
  console.error('[payment-ledger-migration] FAILED:', error.message);
  process.exitCode = 1;
});

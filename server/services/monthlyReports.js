// ============================================
// SaveHatke — Monthly reports
// ============================================
// One row per calendar month in the MonthlyReports sheet, holding the three
// figures the admin panel shows plus per-admin delivery state. The PDF is never
// stored — it is rebuilt from the row whenever it is viewed or re-sent, so
// "View PDF" and the mailed attachment can never drift apart.
//
// Figures use the same arithmetic as the rest of the panel, windowed to the
// month:
//   revenue        sum of sellingPrice over coupons whose status is 'sold'
//                  (the calculation /api/admin/stats and the settlement view
//                  already use), counted on soldAt.
//   couponsBought  number of those sales — one sale is one buyer purchase.
//   couponsSold    the subset that came from a seller listing rather than admin
//                  stock, i.e. what the marketplace sold on a seller's behalf.

const { v4: uuidv4 } = require('uuid');
const db = require('./googleSheets');
const supabase = require('./supabase');
const emailService = require('./emailService');
const { buildMonthlyReportPdf } = require('../utils/monthlyPdf');

const STATUS = { SENT: 'sent', PENDING: 'pending', NOT_SENT: 'not_sent', FAILED: 'failed' };

// ── Configured admin recipients ───────────────────────────────────────────
// Two addresses, from REPORT_ADMIN_EMAILS (comma separated) when set. The
// fallback is the same pair of admin accounts the login route recognises, so a
// deployment that has not set the variable still delivers to the real admins.
const FALLBACK_ADMIN_EMAILS = ['rupayandas2024@gmail.com', 'jaggik8888@gmail.com'];

function configuredAdminEmails() {
  const raw = String(process.env.REPORT_ADMIN_EMAILS || '').trim();
  const list = (raw ? raw.split(',') : FALLBACK_ADMIN_EMAILS)
    .map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => e.includes('@'));
  return [...new Set(list)].slice(0, 2);
}

/** rupayandas2024@gmail.com → rup***as2024@gmail.com (never the full address). */
function maskEmail(email) {
  const clean = String(email || '').trim();
  const at = clean.indexOf('@');
  if (at < 1) return clean ? '***' : '';
  const local = clean.slice(0, at);
  const domain = clean.slice(at);
  if (local.length <= 4) return `${local.slice(0, 1)}***${domain}`;
  return `${local.slice(0, 3)}***${local.slice(-3)}${domain}`;
}

// ── Month helpers (IST is the marketplace's operating timezone) ───────────
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthKey(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function previousMonthKey(date = new Date()) {
  const d = new Date(date);
  return monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 1));
}

function isValidMonthKey(key) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(key || ''));
}

/** Window + display labels for a YYYY-MM key. End is exclusive. */
function monthWindow(key) {
  const [y, m] = String(key).split('-').map(Number);
  const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const end = new Date(y, m, 1, 0, 0, 0, 0);
  const lastDay = new Date(y, m, 0).getDate();
  return {
    key,
    start,
    end,
    monthLabel: `${MONTH_NAMES[m - 1]} ${y}`,
    periodLabel: `${MONTH_SHORT[m - 1]} 1-${lastDay}, ${y}`,
    periodStart: start.toISOString(),
    periodEnd: new Date(y, m - 1, lastDay, 23, 59, 59, 999).toISOString(),
  };
}

// ── Coupon source of truth ────────────────────────────────────────────────
// Same merge as GET /api/admin/coupons: a submission can exist in Supabase, in
// the sheet, or in both, and Supabase wins a conflict. Matching falls back to
// the coupon code because a sheet-only row carries a locally minted uuid.
async function fetchAllCoupons() {
  let supaCoupons = [];
  if (supabase.isConfigured()) {
    try {
      supaCoupons = await supabase.getCoupons();
    } catch (err) {
      console.warn('[monthlyReports] Supabase read failed:', err.message);
    }
  }

  let sheetCoupons = [];
  try {
    sheetCoupons = await db.getRows(db.SHEETS.COUPONS);
  } catch (err) {
    console.warn('[monthlyReports] Sheets read failed:', err.message);
  }

  const merged = [];
  const seenIds = new Set();
  const seenCodes = new Set();
  const codeKey = (c) => String(c.code || '').toUpperCase().trim();
  const take = (c) => {
    merged.push(c);
    if (c.id) seenIds.add(String(c.id));
    if (codeKey(c)) seenCodes.add(codeKey(c));
  };

  (supaCoupons || []).forEach(take);
  for (const c of sheetCoupons || []) {
    if (c.id && seenIds.has(String(c.id))) continue;
    if (codeKey(c) && seenCodes.has(codeKey(c))) continue;
    take(c);
  }
  return merged;
}

/** A sale belongs to a seller when it did not come from admin-added stock. */
function isSellerListing(c) {
  const source = String(c.source || '').toLowerCase();
  if (source === 'user-submitted') return true;
  if (source === 'admin' || source === 'auto-scraped') return false;
  return Boolean(String(c.sellerEmail || '').trim());
}

function soldAtOf(c) {
  const raw = c.soldAt || c.sold_at || '';
  const t = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * The three figures for one month.
 * @param {string} key YYYY-MM
 * @param {Array} [coupons] pre-fetched list, so a caller doing several months
 *                          does not re-read both stores each time
 */
async function computeMetrics(key, coupons) {
  const win = monthWindow(key);
  const all = coupons || await fetchAllCoupons();
  const from = win.start.getTime();
  const to = win.end.getTime();

  const soldThisMonth = all.filter((c) => {
    if (String(c.status || '').toLowerCase() !== 'sold') return false;
    const at = soldAtOf(c);
    return at !== null && at >= from && at < to;
  });

  return {
    revenue: soldThisMonth.reduce((sum, c) => sum + Number(c.sellingPrice || 0), 0),
    couponsBought: soldThisMonth.length,
    couponsSold: soldThisMonth.filter(isSellerListing).length,
  };
}

// ── Stored rows ───────────────────────────────────────────────────────────
async function readRows() {
  try {
    const rows = await db.getRows(db.SHEETS.MONTHLY_REPORTS);
    return (rows || []).filter((r) => isValidMonthKey(r.month));
  } catch (err) {
    console.warn('[monthlyReports] MonthlyReports sheet unavailable:', err.message);
    return [];
  }
}

async function findRow(key) {
  const rows = await readRows();
  return rows.find((r) => String(r.month) === String(key)) || null;
}

/** Shape one stored row for the admin panel (emails masked). */
function toApi(row) {
  const admins = [1, 2].map((n) => ({
    email: maskEmail(row[`admin${n}Email`]),
    status: String(row[`admin${n}Status`] || (row[`admin${n}Email`] ? STATUS.PENDING : STATUS.NOT_SENT)),
    at: row[`admin${n}At`] || '',
    error: row[`admin${n}Error`] || '',
    configured: Boolean(String(row[`admin${n}Email`] || '').trim()),
  }));

  return {
    month: row.month,
    monthLabel: row.monthLabel || monthWindow(row.month).monthLabel,
    periodLabel: row.periodLabel || monthWindow(row.month).periodLabel,
    revenue: Number(row.revenue || 0),
    couponsBought: Number(row.couponsBought || 0),
    couponsSold: Number(row.couponsSold || 0),
    generatedAt: row.generatedAt || '',
    generatedBy: row.generatedBy || '',
    lastSentAt: row.lastSentAt || '',
    admins,
  };
}

/** Newest month first. */
async function listReports() {
  const rows = await readRows();
  rows.sort((a, b) => String(b.month).localeCompare(String(a.month)));
  return rows.map(toApi);
}

// ── PDF ───────────────────────────────────────────────────────────────────
function pdfFor(row) {
  const win = monthWindow(row.month);
  return buildMonthlyReportPdf({
    monthLabel: row.monthLabel || win.monthLabel,
    periodLabel: row.periodLabel || win.periodLabel,
    revenue: Number(row.revenue || 0),
    couponsBought: Number(row.couponsBought || 0),
    couponsSold: Number(row.couponsSold || 0),
    generatedAt: row.generatedAt,
    recipients: [1, 2]
      .filter((n) => String(row[`admin${n}Email`] || '').trim())
      .map((n) => ({ email: maskEmail(row[`admin${n}Email`]), status: statusLabel(row[`admin${n}Status`]) })),
  });
}

function statusLabel(status) {
  switch (String(status || '')) {
    case STATUS.SENT: return 'Sent';
    case STATUS.FAILED: return 'Failed';
    case STATUS.NOT_SENT: return 'Not sent';
    default: return 'Pending';
  }
}

function pdfFilename(key) {
  return `SaveHatke-Monthly-Report-${key}.pdf`;
}

/**
 * The PDF for a month. Uses the stored row when there is one; otherwise the
 * figures are computed on the fly so an admin can still read a month that was
 * never mailed (e.g. the month in progress).
 */
async function getPdf(key) {
  const row = await findRow(key);
  if (row) return { buffer: pdfFor(row), filename: pdfFilename(key), stored: true };

  const win = monthWindow(key);
  const metrics = await computeMetrics(key);
  const buffer = buildMonthlyReportPdf({
    monthLabel: win.monthLabel,
    periodLabel: win.periodLabel,
    ...metrics,
    generatedAt: new Date().toISOString(),
    recipients: configuredAdminEmails().map((email) => ({ email: maskEmail(email), status: 'Not sent' })),
  });
  return { buffer, filename: pdfFilename(key), stored: false };
}

// ── Generation + delivery ─────────────────────────────────────────────────
/**
 * Mail one month's PDF to every configured admin and record the outcome per
 * recipient. Delivery failure is never fatal: the row is written either way, so
 * the panel shows ⚠️ / ❌ against the admin who did not get it and Resend can
 * retry just that.
 */
async function sendReport(key, { actor = 'auto', existingRow = null } = {}) {
  if (!isValidMonthKey(key)) throw new Error('Invalid month.');

  const win = monthWindow(key);
  const row = existingRow || await findRow(key);
  const metrics = row
    ? {
      revenue: Number(row.revenue || 0),
      couponsBought: Number(row.couponsBought || 0),
      couponsSold: Number(row.couponsSold || 0),
    }
    : await computeMetrics(key);

  const emails = configuredAdminEmails();
  const generatedAt = row && row.generatedAt ? row.generatedAt : new Date().toISOString();

  const record = {
    id: (row && row.id) || uuidv4(),
    month: key,
    monthLabel: win.monthLabel,
    periodLabel: win.periodLabel,
    periodStart: win.periodStart,
    periodEnd: win.periodEnd,
    revenue: metrics.revenue,
    couponsBought: metrics.couponsBought,
    couponsSold: metrics.couponsSold,
    generatedAt,
    generatedBy: (row && row.generatedBy) || actor,
    admin1Email: emails[0] || '',
    admin1Status: emails[0] ? STATUS.PENDING : STATUS.NOT_SENT,
    admin1At: '',
    admin1Error: '',
    admin2Email: emails[1] || '',
    admin2Status: emails[1] ? STATUS.PENDING : STATUS.NOT_SENT,
    admin2At: '',
    admin2Error: '',
    lastSentAt: '',
  };

  const pdf = buildMonthlyReportPdf({
    monthLabel: win.monthLabel,
    periodLabel: win.periodLabel,
    ...metrics,
    generatedAt,
    recipients: emails.map((email) => ({ email: maskEmail(email), status: 'Sending' })),
  });

  for (let i = 0; i < emails.length; i++) {
    const n = i + 1;
    const to = emails[i];
    try {
      const result = await emailService.sendMonthlyReportEmail({
        to,
        monthLabel: win.monthLabel,
        periodLabel: win.periodLabel,
        revenue: metrics.revenue,
        couponsBought: metrics.couponsBought,
        couponsSold: metrics.couponsSold,
        isResend: Boolean(row),
        pdf: { filename: pdfFilename(key), content: pdf },
      });
      record[`admin${n}Status`] = result && result.success ? STATUS.SENT : STATUS.FAILED;
      record[`admin${n}At`] = new Date().toISOString();
      record[`admin${n}Error`] = result && result.success ? '' : String((result && result.error) || 'Send failed').slice(0, 200);
    } catch (err) {
      record[`admin${n}Status`] = STATUS.FAILED;
      record[`admin${n}At`] = new Date().toISOString();
      record[`admin${n}Error`] = String(err.message || err).slice(0, 200);
    }
  }
  record.lastSentAt = new Date().toISOString();

  try {
    if (row) await db.updateRow(db.SHEETS.MONTHLY_REPORTS, 'month', key, record);
    else await db.appendRow(db.SHEETS.MONTHLY_REPORTS, record);
  } catch (err) {
    // The mail is already out; surface the storage problem without losing it.
    console.error('[monthlyReports] Could not persist report row:', err.message);
    throw new Error(`Report sent, but saving its delivery status failed: ${err.message}`);
  }

  return toApi(record);
}

/**
 * Generate last month's report if it does not exist yet. Idempotent, so it is
 * safe to call on every Monthly Reports page load — which is what makes the
 * "generated on the 1st" rule hold on a serverless deployment where no
 * long-running scheduler exists. POST /reports/monthly/run does the same thing
 * for an external cron.
 *
 * @returns {Promise<{generated: boolean, month: string, report?: object}>}
 */
async function ensurePreviousMonthReport({ actor = 'auto' } = {}) {
  const key = previousMonthKey();
  const existing = await findRow(key);
  if (existing) return { generated: false, month: key, report: toApi(existing) };

  if (!db.isSheetsConnected()) return { generated: false, month: key, skipped: 'storage-unavailable' };

  console.log(`📑 [monthlyReports] Generating ${key} report (trigger: ${actor})`);
  const report = await sendReport(key, { actor });
  return { generated: true, month: key, report };
}

module.exports = {
  STATUS,
  configuredAdminEmails,
  maskEmail,
  monthKey,
  previousMonthKey,
  isValidMonthKey,
  monthWindow,
  computeMetrics,
  listReports,
  findRow,
  getPdf,
  pdfFilename,
  sendReport,
  ensurePreviousMonthReport,
};

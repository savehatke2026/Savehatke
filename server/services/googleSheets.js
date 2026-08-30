// ============================================
// SaveHatke — Google Sheets Database Service
// ============================================
// Provides CRUD operations on Google Sheets acting as the primary database.
// Sheets: Users | Coupons | PriceTracking | SupportTickets

const { google } = require('googleapis');
const fs = require('fs');

// Sheet names (tabs inside the spreadsheet)
const SHEETS = {
  USERS: 'Users',
  COUPONS: 'Coupons',
  PRICE_TRACKING: 'PriceTracking',
  SUPPORT_TICKETS: 'SupportTickets',
  SETTINGS: 'Settings',
  OTP_REQUESTS: 'OTPRequests',
  CHATBOT_SETTINGS: 'ChatbotSettings',
  CHATBOT_KNOWLEDGE: 'ChatbotKnowledge',
  CHATBOT_CONVERSATIONS: 'ChatbotConversations',
  CHATBOT_MESSAGES: 'ChatbotMessages',
  CHATBOT_LOGS: 'ChatbotLogs',
  CHATBOT_AUDIT: 'ChatbotAudit',
  COUPON_AUDIT: 'CouponAudit',
  PAYOUTS: 'Payouts',
  REVIEWS: 'Reviews',
  USER_TWO_FACTOR: 'UserTwoFactor',
  SECURITY_AUDIT: 'SecurityAudit',
  BACKUP_CODE_AUDIT: 'BackupCodeAudit',
};

// Column headers for each sheet (used for initialization and row mapping)
const HEADERS = {
  [SHEETS.USERS]: [
    'user_ID',
    'name',
    'username',
    'email',
    'status',
    // Google's own avatar URL for the account, captured at Google login. The
    // admin panel renders it next to the email instead of guessing an avatar
    // from a third-party service. ensureSheets() adds this column to tabs
    // created before it existed, so old sheets fill in on the next login.
    'profile_picture',
    // JSON blob of the user's notification opt-ins, e.g.
    // {"coupon_activity":true,"marketing":false}. Absent/blank means
    // "defaults" — the server fills in the defaults on read.
    'notification_prefs',
    'created_at',
    'updated_at',
    'last_login_at',
    'last_logout_at',
    // JSON blob of one-time onboarding flags, e.g.
    // {"marketplaceTutorialCompleted":true,"marketplaceTutorialSkipped":false}.
    // Appended by ensureSheets() on sheets created before it existed, so an
    // older row simply reads back as "nothing seen yet".
    'onboarding_state',
  ],
  [SHEETS.COUPONS]: [
    'id',
    'brand',
    'title',
    'code',
    'type',
    'discount',
    'sellingPrice',
    'minOrderValue',
    'originalValue',
    'validFrom',
    'expiryDate',
    'category',
    'source',
    'status',
    'affiliateLink',
    'terms',
    'isFeatured',
    'isExclusive',
    'isVerified',
    'sellerEmail',
    'buyerEmail',
    'addedAt',
    'soldAt',
    'proofUrl',
    'adminNotes',
    'verifiedAt',
    'sellerUserId',
    'whatsappStatus',
    'whatsappSid',
    'whatsappLastAttempt',
    'whatsappError',
  ],
  [SHEETS.COUPON_AUDIT]: [
    'id',
    'couponId',
    'adminEmail',
    'action',
    'notes',
    'at',
  ],
  [SHEETS.PAYOUTS]: [
    'id',
    'sellerEmail',
    'sellerUserId',
    'amount',
    'currency',
    'method',
    'upiId',
    'bankAccount',
    'bankIfsc',
    'beneficiaryName',
    'status',
    'sourceType',
    'sourceCouponId',
    'requestedAt',
    'processedAt',
    'processedBy',
    'paymentReference',
    'rejectionReason',
    'notes',
  ],
  [SHEETS.PRICE_TRACKING]: [
    'id', 'userEmail', 'productUrl', 'platform', 'productName',
    'currentPrice', 'targetPrice', 'lowestPrice', 'lastChecked', 'alertSent',
  ],
  // Buyer reviews of coupons they purchased. brand/couponTitle/pricePaid are
  // copied in at write time so a review still reads correctly after the coupon
  // row is edited or removed.
  [SHEETS.REVIEWS]: [
    'id',
    'couponId',
    'buyerEmail',
    'buyerUserId',
    'brand',
    'couponTitle',
    'pricePaid',
    'rating',
    'reviewText',
    'createdAt',
    'updatedAt',
  ],
  // One row per user holding their authenticator-app enrolment.
  //
  // secretEncrypted / pendingSecretEncrypted are AES-256-GCM blobs, never the
  // raw base32 secret. recoveryCodes is a JSON array of
  // { hash, usedAt, usedIp } — bcrypt hashes only, so a leaked sheet yields no
  // usable code. pendingSecretEncrypted holds the not-yet-confirmed secret
  // during enrolment and is cleared the moment 2FA is enabled or abandoned.
  [SHEETS.USER_TWO_FACTOR]: [
    'userId',
    'email',
    'enabled',
    'secretEncrypted',
    'pendingSecretEncrypted',
    'pendingCreatedAt',
    'recoveryCodes',
    'lastCounter',
    'enabledAt',
    'disabledAt',
    'lastUsedAt',
    'updatedAt',
  ],
  // Append-only security event log. Never holds codes, secrets or hashes.
  [SHEETS.SECURITY_AUDIT]: [
    'id',
    'userId',
    'email',
    'event',
    'outcome',
    'ipAddress',
    'device',
    'detail',
    'createdAt',
  ],
  [SHEETS.SUPPORT_TICKETS]: [
    'id', 'name', 'userEmail', 'subject', 'message',
    'status', 'createdAt', 'resolvedAt', 'resolution', 'attachmentUrl', 'attachmentName',
    // Added after the columns above. ensureSheets() appends missing headers to
    // the right of an existing tab without moving data, so pre-existing rows
    // simply read back empty here and the readers below fall back.
    //   updatedAt — bumped on every reply and status change, so the support list
    //               can show a real "last updated" instead of the created date.
    //   messages  — JSON array holding the reply thread:
    //               [{ from: 'user' | 'support', body, at }]
    'updatedAt', 'messages',
  ],
  [SHEETS.SETTINGS]: [
    'key', 'activeUsers', 'couponsTraded', 'savedByUsers', 'platformName', 'adminEmail', 'showActiveUsers', 'showCouponsTraded', 'showSavedByUsers', 'heroBadge', 'showHeroBadge', 'updatedAt',
  ],
  [SHEETS.OTP_REQUESTS]: [
    'id', 'userId', 'userIdEmail', 'email', 'ipAddress', 'otpHash',
    'requestedAt', 'expiresAt', 'verifiedAt',
    'status', 'requestNumber', 'dailyRequestCount',
    'hourlyRequestCount', 'verifyAttempts',
  ],
  [SHEETS.BACKUP_CODE_AUDIT]: [
    'id', 'codeSuffix', 'reason', 'ip', 'userAgent', 'chosenEmail',
    'success', 'initAt', 'completeAt', 'error',
  ],
  [SHEETS.CHATBOT_SETTINGS]: ['key', 'value', 'updated_at'],
  [SHEETS.CHATBOT_KNOWLEDGE]: [
    'id', 'category', 'question', 'answer', 'keywords', 'enabled', 'created_at', 'updated_at',
  ],
  [SHEETS.CHATBOT_CONVERSATIONS]: [
    'id', 'user_id', 'user_email', 'user_name', 'is_guest',
    'message_count', 'status', 'flagged', 'started_at', 'last_active_at',
  ],
  [SHEETS.CHATBOT_MESSAGES]: [
    'id', 'conversation_id', 'role', 'content',
    'response_time_ms', 'model', 'status', 'created_at',
  ],
  [SHEETS.CHATBOT_LOGS]: [
    'id', 'timestamp', 'request_id', 'user', 'conversation_id',
    'model', 'response_time_ms', 'status', 'error_type',
  ],
  [SHEETS.CHATBOT_AUDIT]: [
    'id', 'timestamp', 'admin_id', 'admin_email', 'action',
    'setting', 'old_value', 'new_value',
  ],
};

let sheetsClient = null;
let spreadsheetId = null;
let lastSheetsError = null;
let serviceAccountEmail = null;

function reportDebug(hypothesisId, location, msg, data = {}, runId = process.env.DEBUG_RUN_ID || 'pre-fix') {
  try {
    let debugUrl = 'http://127.0.0.1:7777/event';
    let sessionId = 'coupon-gsheet-sync';
    try {
      const env = fs.readFileSync('.dbg/coupon-gsheet-sync.env', 'utf8');
      debugUrl = env.match(/DEBUG_SERVER_URL=(.+)/)?.[1] || debugUrl;
      sessionId = env.match(/DEBUG_SESSION_ID=(.+)/)?.[1] || sessionId;
    } catch {}
    fetch(debugUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, runId, hypothesisId, location, msg: `[DEBUG] ${msg}`, data, ts: Date.now() }),
    }).catch(() => {});
  } catch {}
}

/**
 * Initialize the Google Sheets client using Service Account credentials.
 * Falls back to a local in-memory store if credentials are not configured,
 * allowing development without a live Google Sheet.
 */
async function initialize() {
  spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  serviceAccountEmail = email || null;
  lastSheetsError = null;

  // #region debug-point A:init-sheets
  reportDebug('A', 'server/services/googleSheets.js:62', 'Initializing Google Sheets client', {
    hasSpreadsheetId: Boolean(spreadsheetId),
    spreadsheetIdSuffix: spreadsheetId ? spreadsheetId.slice(-8) : '',
    hasEmail: Boolean(email),
    emailHint: email ? email.slice(0, 6) : '',
    hasPrivateKey: Boolean(privateKey),
  });
  // #endregion

  if (!spreadsheetId || !email || !privateKey || spreadsheetId === 'your_spreadsheet_id_here') {
    lastSheetsError = {
      type: 'missing-config',
      message: 'Google Sheets credentials are not fully configured.',
    };
    // #region debug-point A:missing-sheets-config
    reportDebug('A', 'server/services/googleSheets.js:73', 'Google Sheets config missing, using fallback database', {
      hasSpreadsheetId: Boolean(spreadsheetId),
      hasEmail: Boolean(email),
      hasPrivateKey: Boolean(privateKey),
    });
    // #endregion
    console.warn('⚠️  Google Sheets credentials not configured. Using in-memory fallback database.');
    console.warn('   To connect Google Sheets, fill in your .env file. See .env.example for details.');
    return false;
  }

  try {
    const cleanKey = privateKey.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
    const auth = new google.auth.JWT(
      email,
      null,
      cleanKey,
      ['https://www.googleapis.com/auth/spreadsheets']
    );

    sheetsClient = google.sheets({ version: 'v4', auth });

    // Verify connection by reading spreadsheet metadata
    await sheetsClient.spreadsheets.get({ spreadsheetId });
    // #region debug-point A:sheets-connected
    reportDebug('A', 'server/services/googleSheets.js:91', 'Connected to Google Sheets database', {
      spreadsheetIdSuffix: spreadsheetId.slice(-8),
    });
    // #endregion
    console.log('✅ Connected to Google Sheets database.');

    // Ensure all sheet tabs exist with headers
    await ensureSheets();
    return true;
  } catch (err) {
    const looksLikeAccessOrMissingSheet = err.code === 404 || err.status === 404;
    lastSheetsError = {
      type: looksLikeAccessOrMissingSheet ? 'sheet-not-found-or-no-access' : 'connect-failed',
      message: err.message,
      code: err.code || err.status || '',
    };
    // #region debug-point A:sheets-connect-failed
    reportDebug('A', 'server/services/googleSheets.js:100', 'Failed to connect to Google Sheets database', {
      error: err.message,
      code: err.code || '',
      status: err.status || '',
    });
    // #endregion
    console.error('❌ Failed to connect to Google Sheets:', err.message);
    console.warn('   Falling back to in-memory database.');
    sheetsClient = null;
    return false;
  }
}

function isSheetsConnected() {
  return Boolean(sheetsClient);
}

function getStorageStatus() {
  return {
    connected: Boolean(sheetsClient),
    mode: sheetsClient ? 'google-sheets' : 'memory-fallback',
    spreadsheetId,
    serviceAccountEmail,
    lastError: lastSheetsError,
  };
}

function getWriteAvailabilityError(message = 'Google Sheets is not connected.') {
  if (sheetsClient) return null;

  return {
    error: message,
    details: {
      spreadsheetId,
      serviceAccountEmail,
      reason: lastSheetsError?.message || 'Google Sheets connection unavailable.',
      type: lastSheetsError?.type || 'unavailable',
    },
  };
}

// Convert a 1-indexed column number to A1 notation (1→A, 27→AA, …)
function columnToLetter(col) {
  let s = '';
  while (col > 0) {
    const m = (col - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}

/**
 * Ensure all required sheets exist and have headers.
 * Existing tabs are upgraded: any configured headers missing from the tab's
 * header row are appended as new columns on the right (existing data is
 * never moved or shifted).
 */
async function ensureSheets() {
  if (!sheetsClient) return;

  try {
    const res = await sheetsClient.spreadsheets.get({ spreadsheetId });
    const existingSheets = res.data.sheets.map((s) => s.properties.title);

    for (const [sheetName, headers] of Object.entries(HEADERS)) {
      if (!existingSheets.includes(sheetName)) {
        await sheetsClient.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ addSheet: { properties: { title: sheetName } } }],
          },
        });
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [headers] },
        });
      } else {
        // Top up the header row of an existing tab with any missing columns
        try {
          const hdrRes = await sheetsClient.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!1:1`,
          });
          const current = (hdrRes.data.values && hdrRes.data.values[0]) || [];
          const currentNorm = current.map((c) => normKey(c));
          const missing = headers.filter((h) => !currentNorm.includes(normKey(h)));
          if (missing.length) {
            const startCol = columnToLetter(current.length + 1);
            await sheetsClient.spreadsheets.values.update({
              spreadsheetId,
              range: `${sheetName}!${startCol}1`,
              valueInputOption: 'RAW',
              requestBody: { values: [missing] },
            });
            console.log(`ensureSheets: added missing headers to ${sheetName}: ${missing.join(', ')}`);
          }
        } catch (e) {
          // Header top-up is best-effort
        }
      }
    }
  } catch (err) {
    console.warn('ensureSheets warning:', err.message);
  }
}

// ── In-Memory Fallback Database ─────────────────────────────────────────────
// Used when Google Sheets credentials are not available
const memoryDB = {
  [SHEETS.USERS]: [],
  [SHEETS.COUPONS]: [],
  [SHEETS.PRICE_TRACKING]: [],
  [SHEETS.SUPPORT_TICKETS]: [],
  [SHEETS.SETTINGS]: [],
  [SHEETS.OTP_REQUESTS]: [],
  [SHEETS.COUPON_AUDIT]: [],
  [SHEETS.PAYOUTS]: [],
  [SHEETS.REVIEWS]: [],
  [SHEETS.USER_TWO_FACTOR]: [],
  [SHEETS.SECURITY_AUDIT]: [],
  [SHEETS.BACKUP_CODE_AUDIT]: [],
};

function seedDemoData() {
  // No-op: Demo coupons removed per requirements
}

// Short-term in-memory cache to speed up repeated queries (e.g. user logins)
const rowsCache = {};
const CACHE_TTL_MS = 3000; // 3 seconds

function invalidateCache(sheetName) {
  delete rowsCache[sheetName];
}

/**
 * Get all rows from a sheet. Returns array of objects keyed by column header.
 */
async function getRows(sheetName) {
  const now = Date.now();
  if (rowsCache[sheetName] && (now - rowsCache[sheetName].timestamp < CACHE_TTL_MS)) {
    return [...rowsCache[sheetName].data];
  }

  if (sheetsClient) {
    try {
      const res = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:Z`,
      });

      const rows = res.data.values;
      if (!rows || rows.length <= 1) {
        const fallback = [...(memoryDB[sheetName] || [])];
        rowsCache[sheetName] = { data: fallback, timestamp: now };
        return fallback;
      }

      const headers = rows[0];
      const gsheetRows = rows.slice(1).map((row) => {
        const obj = {};
        headers.forEach((h, i) => {
          if (String(h).trim() === '') return;
          const v = row[i] || '';
          obj[h] = v;
          // Also expose the value under the normalized key so code using
          // "user_id" can read a sheet headed "user_ID".
          const nk = normKey(h);
          if (obj[nk] === undefined) obj[nk] = v;
        });
        if (sheetName === SHEETS.USERS) {
          // Normalize email on read so every downstream lookup
          // (findRow, updateRow) is case-insensitive. Without this, a
          // historical row written with mixed-case email would never
          // match a lowercased cleanEmail and a duplicate row would
          // be appended on the next login.
          if (typeof obj.email === 'string') {
            obj.email = obj.email.toLowerCase().trim();
          }
        }
        if (sheetName === SHEETS.USERS) {
          // Resolve the canonical user_id even if the sheet's header uses a
          // different naming convention (userId, userid, UserID, id, uuid…).
          // The sheet's `user_id` column is the source of truth for sessions
          // and admin lookups, so we sync every common variant to it.
          let resolvedUserId = '';
          for (const [key, value] of Object.entries(obj)) {
            if (value === '' || value == null) continue;
            const nk = normKey(key).replace(/[\s_-]+/g, '');
            if (nk === 'userid' || nk === 'uuid') {
              resolvedUserId = String(value);
              break;
            }
          }
          if (!resolvedUserId) resolvedUserId = obj.user_ID || obj.user_id || obj.userId || obj.userid || obj.id || obj.uuid || '';
          obj.id = resolvedUserId;
          obj.user_ID = resolvedUserId;
          obj.user_id = resolvedUserId;
          obj.createdAt = obj.created_at || obj.createdAt || '';
          obj.created_at = obj.created_at || obj.createdAt || '';
        }
        return obj;
      });

      // Combine with memoryDB rows to prevent data loss when fallback was active
      const memRows = memoryDB[sheetName] || [];
      const combined = [...gsheetRows];
      memRows.forEach((m) => {
        if (!combined.some((g) => (g.id && g.id === m.id) || (g.code && g.code === m.code))) {
          combined.push(m);
        }
      });

      rowsCache[sheetName] = { data: combined, timestamp: Date.now() };
      return combined;
    } catch (err) {
      console.warn(`getRows warning for ${sheetName}:`, err.message);
    }
  }

  const fallback = [...(memoryDB[sheetName] || [])];
  rowsCache[sheetName] = { data: fallback, timestamp: Date.now() };
  return fallback;
}

// Normalize header names for matching (live sheets may use e.g. "user_ID"
// while code uses "user_id" — treat them as the same column).
const normKey = (h) => String(h || '').trim().toLowerCase();

// Build a lookup of data values by normalized key name.
function dataByNormKey(data) {
  const map = {};
  Object.entries(data || {}).forEach(([k, v]) => {
    map[normKey(k)] = v;
  });
  return map;
}

/**
 * Append a row to a sheet.
 * @param {string} sheetName
 * @param {object} data — object with keys matching column headers (case-insensitive)
 */
async function appendRow(sheetName, data) {
  const headers = HEADERS[sheetName];
  if (!headers) throw new Error(`Unknown sheet: ${sheetName}`);

  // Normalize on write so every newly-appended row has a canonical
  // email value. Without this, a row written by an older code path
  // (e.g. mixed case) would still cause a duplicate-row bug because
  // getRows cannot retroactively normalize values that were never
  // fetched yet (i.e. they only exist in the live sheet until the
  // next read).
  if (sheetName === SHEETS.USERS && data && typeof data.email === 'string') {
    data = { ...data, email: data.email.toLowerCase().trim() };
  }

  // Always store in memory fallback first to guarantee availability
  memoryDB[sheetName] = memoryDB[sheetName] || [];
  const existingIdx = memoryDB[sheetName].findIndex((r) => r.id === data.id || (r.code && r.code === data.code));
  if (existingIdx >= 0) {
    memoryDB[sheetName][existingIdx] = data;
  } else {
    memoryDB[sheetName].push(data);
  }

  if (sheetsClient) {
    try {
      // Align values with the sheet's actual header row (case-insensitive)
      // so data lands in the correct columns even if the live tab's headers
      // differ from config in naming or order.
      let rowHeaders = headers;
      try {
        const hdrRes = await sheetsClient.spreadsheets.values.get({
          spreadsheetId,
          range: `${sheetName}!1:1`,
        });
        const actual = hdrRes.data.values && hdrRes.data.values[0]
          ? hdrRes.data.values[0].filter((h) => String(h).trim() !== '')
          : [];
        if (actual.length) rowHeaders = actual;
      } catch (e) {
        // Header read failed — fall back to configured header order
      }
      const normData = dataByNormKey(data);
      const row = rowHeaders.map((h) => {
        const v = data[h] !== undefined ? data[h] : normData[normKey(h)];
        return v !== undefined && v !== null ? v : '';
      });
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      });
    } catch (err) {
      console.warn(`Google Sheets append warning for ${sheetName}:`, err.message);
      data.gsheetError = err.message;
    }
  }

  invalidateCache(sheetName);
  return data;
}

/**
 * Normalize a lookup value for case-insensitive matching on the user
 * email field. Without this, a row written long ago with mixed-case
 * email (e.g. "Rupayan@Example.com") would never match the lowercased
 * `cleanEmail` the auth code uses, and a duplicate user row would be
 * appended on the next login.
 */
function normalizeLookupValue(sheetName, field, value) {
  if (sheetName === SHEETS.USERS && field === 'email' && typeof value === 'string') {
    return value.toLowerCase().trim();
  }
  return value;
}

/**
 * Normalize the same key on the row side, so lookups match even when
 * the row's stored email value hasn't been through `getRows` yet (e.g.
 * freshly-appended rows sitting in memoryDB).
 */
function normalizeRowValue(sheetName, field, value) {
  if (sheetName === SHEETS.USERS && field === 'email' && typeof value === 'string') {
    return value.toLowerCase().trim();
  }
  return value;
}

async function findRow(sheetName, field, value) {
  const rows = await getRows(sheetName);
  const nv = normalizeLookupValue(sheetName, field, value);
  return rows.find((r) => normalizeRowValue(sheetName, field, r[field]) === nv) || null;
}

/**
 * Find all rows matching a field value.
 */
async function findRows(sheetName, field, value) {
  const rows = await getRows(sheetName);
  const nv = normalizeLookupValue(sheetName, field, value);
  return rows.filter((r) => normalizeRowValue(sheetName, field, r[field]) === nv);
}

/**
 * Update a row by finding it via a field match and replacing values.
 */
async function updateRow(sheetName, field, value, updatedData) {
  // Always update memoryDB to guarantee local consistency
  const arr = memoryDB[sheetName] || [];
  const nv = normalizeLookupValue(sheetName, field, value);
  const idx = arr.findIndex((r) => normalizeRowValue(sheetName, field, r[field]) === nv);
  if (idx !== -1) {
    arr[idx] = { ...arr[idx], ...updatedData };
  }

  if (!sheetsClient) {
    invalidateCache(sheetName);
    return idx !== -1 ? arr[idx] : null;
  }

  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:Z`,
    });

    const rows = res.data.values;
    if (!rows || rows.length <= 1) {
      invalidateCache(sheetName);
      return idx !== -1 ? arr[idx] : null;
    }

    const headers = rows[0];
    let fieldIdx = headers.indexOf(field);
    if (fieldIdx === -1) fieldIdx = headers.findIndex((h) => normKey(h) === normKey(field));
    if (fieldIdx === -1) {
      invalidateCache(sheetName);
      return idx !== -1 ? arr[idx] : null;
    }

    // Find the row index (1-indexed, +1 for header)
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (normalizeRowValue(sheetName, field, rows[i][fieldIdx]) === nv) {
        rowIndex = i + 1; // Sheets is 1-indexed
        break;
      }
    }

    if (rowIndex === -1) {
      invalidateCache(sheetName);
      return idx !== -1 ? arr[idx] : null;
    }

    // Merge existing row with updates (match keys case-insensitively so
    // "user_id" updates land under a sheet headed "user_ID").
    const existingRow = rows[rowIndex - 1];
    const normUpdates = dataByNormKey(updatedData);
    const merged = {};
    headers.forEach((h, i) => {
      const v = updatedData[h] !== undefined ? updatedData[h]
        : normUpdates[normKey(h)] !== undefined ? normUpdates[normKey(h)]
        : (existingRow[i] || '');
      if (String(h).trim() !== '' || v !== '') merged[h] = v;
    });

    // Keep falsy values (false, 0) — `merged[h] || ''` used to wipe a `false`
    // toggle into an empty cell, which read back as the default (true).
    const newRow = headers.map((h) => (merged[h] === undefined || merged[h] === null ? '' : merged[h]));
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [newRow] },
    });

    invalidateCache(sheetName);
    return merged;
  } catch (err) {
    console.warn(`Google Sheets update warning for ${sheetName}:`, err.message);
    invalidateCache(sheetName);
    return idx !== -1 ? arr[idx] : null;
  }
}

/**
 * Delete a row by finding it via a field match.
 */
async function deleteRow(sheetName, field, value) {
  // Always update memoryDB
  const arr = memoryDB[sheetName] || [];
  const idx = arr.findIndex((r) => r[field] === value);
  if (idx !== -1) {
    arr.splice(idx, 1);
  }
  invalidateCache(sheetName);

  if (!sheetsClient) {
    return idx !== -1;
  }

  try {
    // For Sheets, we need the sheet's gid to delete a row
    const spreadsheet = await sheetsClient.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find(
      (s) => s.properties.title === sheetName
    );
    if (!sheet) return false;

    const sheetId = sheet.properties.sheetId;

    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:Z`,
    });

    const rows = res.data.values;
    if (!rows || rows.length <= 1) return false;

    const headers = rows[0];
    let fieldIdx = headers.indexOf(field);
    if (fieldIdx === -1) fieldIdx = headers.findIndex((h) => normKey(h) === normKey(field));
    if (fieldIdx === -1) return false;

    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][fieldIdx] === value) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex === -1) return false;

    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        }],
      },
    });

    invalidateCache(sheetName);
    return true;
  } catch (err) {
    console.warn(`Google Sheets delete warning for ${sheetName}:`, err.message);
    // Fall back to memoryDB
    const arr = memoryDB[sheetName] || [];
    const idx = arr.findIndex((r) => r[field] === value);
    if (idx === -1) return false;
    arr.splice(idx, 1);
    return true;
  }
}

/**
 * Count rows in a sheet
 */
async function countRows(sheetName) {
  if (!sheetsClient) {
    return (memoryDB[sheetName] || []).length;
  }

  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:Z`,
    });

    const rows = res.data.values;
    if (!rows || rows.length <= 1) return 0;
    return rows.length - 1; // Subtract header row
  } catch (err) {
    console.warn(`Google Sheets countRows warning for ${sheetName}:`, err.message);
    // Fall back to memoryDB
    return (memoryDB[sheetName] || []).length;
  }
}

// Cast stored toggle values ('true'/'TRUE'/true/'1' → true, 'false'/'FALSE'/false/'0' → false)
function toSettingBool(v, dflt = true) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return dflt;
}

/**
 * Get website settings from Google Sheets
 */
async function getSettings() {
  const defaultSettings = {
    key: 'site_settings',
    activeUsers: '10K+',
    couponsTraded: '50K+',
    savedByUsers: '₹2L+',
    platformName: 'SaveHatke',
    adminEmail: 'rupayandas2024@gmail.com',
    showActiveUsers: true,
    showCouponsTraded: true,
    showSavedByUsers: true,
    heroBadge: "🚀 India's #1 Coupon Marketplace — Now Live!",
    showHeroBadge: true,
    updatedAt: new Date().toISOString(),
  };

  try {
    const existing = await findRow(SHEETS.SETTINGS, 'key', 'site_settings');
    if (existing) {
      return {
        ...defaultSettings,
        ...existing,
        showActiveUsers: toSettingBool(existing.showActiveUsers),
        showCouponsTraded: toSettingBool(existing.showCouponsTraded),
        showSavedByUsers: toSettingBool(existing.showSavedByUsers),
        showHeroBadge: toSettingBool(existing.showHeroBadge),
      };
    }
  } catch (err) {
    console.warn('getSettings warning:', err.message);
  }
  return defaultSettings;
}

/**
 * Save website settings to Google Sheets
 */
async function saveSettings(data) {
  const record = {
    key: 'site_settings',
    activeUsers: data.activeUsers || '10K+',
    couponsTraded: data.couponsTraded || '50K+',
    savedByUsers: data.savedByUsers || '₹2L+',
    platformName: data.platformName || 'SaveHatke',
    adminEmail: data.adminEmail || 'rupayandas2024@gmail.com',
    // Store toggles as 'true'/'false' strings: RAW sheet writes of booleans
    // are ambiguous and empty-string cells read back as the default (true).
    showActiveUsers: data.showActiveUsers !== undefined ? String(Boolean(data.showActiveUsers)) : 'true',
    showCouponsTraded: data.showCouponsTraded !== undefined ? String(Boolean(data.showCouponsTraded)) : 'true',
    showSavedByUsers: data.showSavedByUsers !== undefined ? String(Boolean(data.showSavedByUsers)) : 'true',
    heroBadge: data.heroBadge !== undefined ? String(data.heroBadge).slice(0, 120) : "🚀 India's #1 Coupon Marketplace — Now Live!",
    showHeroBadge: data.showHeroBadge !== undefined ? String(Boolean(data.showHeroBadge)) : 'true',
    updatedAt: new Date().toISOString(),
  };

  try {
    const existing = await findRow(SHEETS.SETTINGS, 'key', 'site_settings');
    if (existing) {
      await updateRow(SHEETS.SETTINGS, 'key', 'site_settings', record);
    } else {
      await appendRow(SHEETS.SETTINGS, record);
    }
  } catch (err) {
    console.warn('saveSettings error:', err.message);
  }
  return record;
}

module.exports = {
  SHEETS,
  HEADERS,
  initialize,
  isSheetsConnected,
  getStorageStatus,
  getWriteAvailabilityError,
  seedDemoData,
  getRows,
  appendRow,
  findRow,
  findRows,
  updateRow,
  deleteRow,
  countRows,
  getSettings,
  saveSettings,
};

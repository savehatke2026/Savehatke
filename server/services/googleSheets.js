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
};

// Column headers for each sheet (used for initialization and row mapping)
const HEADERS = {
  [SHEETS.USERS]: [
    'user_id',
    'name',
    'username',
    'email',
    'status',
    'created_at',
    'updated_at',
    'last_login_at',
    'last_logout_at',
  ],
  [SHEETS.COUPONS]: [
    'id', 'code', 'title', 'type', 'category', 'brand', 'description',
    'discount', 'originalValue', 'sellingPrice', 'minOrderValue',
    'validFrom', 'expiryDate', 'affiliateLink', 'terms',
    'isFeatured', 'isExclusive', 'isVerified', 'sellerEmail', 'status',
    'source', 'addedAt', 'soldAt', 'buyerEmail',
  ],
  [SHEETS.PRICE_TRACKING]: [
    'id', 'userEmail', 'productUrl', 'platform', 'productName',
    'currentPrice', 'targetPrice', 'lowestPrice', 'lastChecked', 'alertSent',
  ],
  [SHEETS.SUPPORT_TICKETS]: [
    'id', 'name', 'userEmail', 'subject', 'message',
    'status', 'createdAt', 'resolvedAt',
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

/**
 * Ensure all required sheets exist and have headers.
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
};

function seedDemoData() {
  // No-op: Demo coupons removed per requirements
}

// ── CRUD Operations ─────────────────────────────────────────────────────────

/**
 * Get all rows from a sheet. Returns array of objects keyed by column header.
 */
async function getRows(sheetName) {
  if (sheetsClient) {
    try {
      const res = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:Z`,
      });

      const rows = res.data.values;
      if (!rows || rows.length <= 1) return [...(memoryDB[sheetName] || [])];

      const headers = rows[0];
      const gsheetRows = rows.slice(1).map((row) => {
        const obj = {};
        headers.forEach((h, i) => {
          obj[h] = row[i] || '';
        });
        if (sheetName === SHEETS.USERS) {
          obj.id = obj.user_id || obj.id || '';
          obj.user_id = obj.user_id || obj.id || '';
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

      return combined;
    } catch (err) {
      console.warn(`getRows warning for ${sheetName}:`, err.message);
    }
  }

  return [...(memoryDB[sheetName] || [])];
}

/**
 * Append a row to a sheet.
 * @param {string} sheetName
 * @param {object} data — object with keys matching column headers
 */
async function appendRow(sheetName, data) {
  const headers = HEADERS[sheetName];
  if (!headers) throw new Error(`Unknown sheet: ${sheetName}`);

  // Always store in memory fallback first to guarantee availability
  memoryDB[sheetName] = memoryDB[sheetName] || [];
  const existingIdx = memoryDB[sheetName].findIndex((r) => r.id === data.id || (r.code && r.code === data.code));
  if (existingIdx >= 0) {
    memoryDB[sheetName][existingIdx] = data;
  } else {
    memoryDB[sheetName].push(data);
  }

  if (sheetsClient) {
    const row = headers.map((h) => data[h] || '');
    try {
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

  return data;
}

/**
 * Find a single row matching a field value.
 */
async function findRow(sheetName, field, value) {
  const rows = await getRows(sheetName);
  return rows.find((r) => r[field] === value) || null;
}

/**
 * Find all rows matching a field value.
 */
async function findRows(sheetName, field, value) {
  const rows = await getRows(sheetName);
  return rows.filter((r) => r[field] === value);
}

/**
 * Update a row by finding it via a field match and replacing values.
 */
async function updateRow(sheetName, field, value, updatedData) {
  if (!sheetsClient) {
    const arr = memoryDB[sheetName] || [];
    const idx = arr.findIndex((r) => r[field] === value);
    if (idx === -1) return null;
    arr[idx] = { ...arr[idx], ...updatedData };
    return arr[idx];
  }

  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:Z`,
  });

  const rows = res.data.values;
  if (!rows || rows.length <= 1) return null;

  const headers = rows[0];
  const fieldIdx = headers.indexOf(field);
  if (fieldIdx === -1) return null;

  // Find the row index (1-indexed, +1 for header)
  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][fieldIdx] === value) {
      rowIndex = i + 1; // Sheets is 1-indexed
      break;
    }
  }

  if (rowIndex === -1) return null;

  // Merge existing row with updates
  const existingRow = rows[rowIndex - 1];
  const merged = {};
  headers.forEach((h, i) => {
    merged[h] = updatedData[h] !== undefined ? updatedData[h] : (existingRow[i] || '');
  });

  const newRow = headers.map((h) => merged[h] || '');
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [newRow] },
  });

  return merged;
}

/**
 * Delete a row by finding it via a field match.
 */
async function deleteRow(sheetName, field, value) {
  if (!sheetsClient) {
    const arr = memoryDB[sheetName] || [];
    const idx = arr.findIndex((r) => r[field] === value);
    if (idx === -1) return false;
    arr.splice(idx, 1);
    return true;
  }

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
  const fieldIdx = headers.indexOf(field);
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

  return true;
}

/**
 * Count rows in a sheet, optionally filtered.
 */
async function countRows(sheetName, field, value) {
  const rows = await getRows(sheetName);
  if (!field) return rows.length;
  return rows.filter((r) => r[field] === value).length;
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
};

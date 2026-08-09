// ============================================
// SaveHatke — Google Sheets Database Service
// ============================================
// Provides CRUD operations on Google Sheets acting as the primary database.
// Sheets: Users | Coupons | PriceTracking | SupportTickets

const { google } = require('googleapis');

// Sheet names (tabs inside the spreadsheet)
const SHEETS = {
  USERS: 'Users',
  COUPONS: 'Coupons',
  PRICE_TRACKING: 'PriceTracking',
  SUPPORT_TICKETS: 'SupportTickets',
};

// Column headers for each sheet (used for initialization and row mapping)
const HEADERS = {
  [SHEETS.USERS]: ['id', 'email', 'passwordHash', 'name', 'createdAt'],
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

/**
 * Initialize the Google Sheets client using Service Account credentials.
 * Falls back to a local in-memory store if credentials are not configured,
 * allowing development without a live Google Sheet.
 */
async function initialize() {
  spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!spreadsheetId || !email || !privateKey || spreadsheetId === 'your_spreadsheet_id_here') {
    console.warn('⚠️  Google Sheets credentials not configured. Using in-memory fallback database.');
    console.warn('   To connect Google Sheets, fill in your .env file. See .env.example for details.');
    return false;
  }

  try {
    const auth = new google.auth.JWT(
      email,
      null,
      privateKey.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets']
    );

    sheetsClient = google.sheets({ version: 'v4', auth });

    // Verify connection by reading spreadsheet metadata
    await sheetsClient.spreadsheets.get({ spreadsheetId });
    console.log('✅ Connected to Google Sheets database.');

    // Ensure all sheet tabs exist with headers
    await ensureSheets();
    return true;
  } catch (err) {
    console.error('❌ Failed to connect to Google Sheets:', err.message);
    console.warn('   Falling back to in-memory database.');
    sheetsClient = null;
    return false;
  }
}

/**
 * Ensure all required sheets exist and have headers.
 */
async function ensureSheets() {
  if (!sheetsClient) return;

  const res = await sheetsClient.spreadsheets.get({ spreadsheetId });
  const existingSheets = res.data.sheets.map((s) => s.properties.title);

  for (const [sheetName, headers] of Object.entries(HEADERS)) {
    if (!existingSheets.includes(sheetName)) {
      // Create the sheet tab
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: sheetName } } }],
        },
      });
      // Write headers
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headers] },
      });
    } else {
      // Keep headers in sync so new columns become available in existing sheets.
      const headerRow = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!1:1`,
      });
      const existingHeaders = headerRow.data.values?.[0] || [];
      const needsHeaderSync =
        existingHeaders.length === 0 ||
        headers.some((header, index) => existingHeaders[index] !== header) ||
        existingHeaders.length !== headers.length;

      if (needsHeaderSync) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [headers] },
        });
      }
    }
  }
}

// ── In-Memory Fallback Database ─────────────────────────────────────────────
// Used when Google Sheets credentials are not available (dev mode)
const memoryDB = {
  [SHEETS.USERS]: [],
  [SHEETS.COUPONS]: [],
  [SHEETS.PRICE_TRACKING]: [],
  [SHEETS.SUPPORT_TICKETS]: [],
};

// Seed some demo coupons for dev mode
function seedDemoData() {
  if (memoryDB[SHEETS.COUPONS].length > 0) return;

  const demoCoupons = [
    { id: 'c001', code: 'NYKAA-SAVE200', category: 'Makeup', brand: 'Nykaa', description: '₹200 off on orders above ₹999', originalValue: '200', sellingPrice: '20', sellerEmail: 'user@demo.com', status: 'available', source: 'user-submitted', addedAt: new Date().toISOString(), soldAt: '', buyerEmail: '' },
    { id: 'c002', code: 'PUMA-FLAT30', category: 'Fashion', brand: 'Puma', description: 'Flat 30% off on Puma shoes', originalValue: '500', sellingPrice: '25', sellerEmail: 'user2@demo.com', status: 'available', source: 'user-submitted', addedAt: new Date().toISOString(), soldAt: '', buyerEmail: '' },
    { id: 'c003', code: 'BOAT-EXTRA15', category: 'Electronics', brand: 'boAt', description: '15% off on boAt earbuds', originalValue: '300', sellingPrice: '20', sellerEmail: '', status: 'available', source: 'admin', addedAt: new Date().toISOString(), soldAt: '', buyerEmail: '' },
    { id: 'c004', code: 'SWIGGY100', category: 'Food', brand: 'Swiggy', description: '₹100 off on first 3 orders', originalValue: '100', sellingPrice: '15', sellerEmail: '', status: 'available', source: 'admin', addedAt: new Date().toISOString(), soldAt: '', buyerEmail: '' },
    { id: 'c005', code: 'MYNTRA-FLAT500', category: 'Fashion', brand: 'Myntra', description: '₹500 off on ₹2000+ purchase', originalValue: '500', sellingPrice: '30', sellerEmail: 'seller@demo.com', status: 'available', source: 'user-submitted', addedAt: new Date().toISOString(), soldAt: '', buyerEmail: '' },
    { id: 'c006', code: 'MAMAEARTH20', category: 'Makeup', brand: 'Mamaearth', description: '20% off on skincare range', originalValue: '250', sellingPrice: '20', sellerEmail: '', status: 'available', source: 'auto-scraped', addedAt: new Date().toISOString(), soldAt: '', buyerEmail: '' },
    { id: 'c007', code: 'CROMA-ELEC10', category: 'Electronics', brand: 'Croma', description: '10% off on electronics (max ₹1000)', originalValue: '1000', sellingPrice: '35', sellerEmail: '', status: 'available', source: 'admin', addedAt: new Date().toISOString(), soldAt: '', buyerEmail: '' },
    { id: 'c008', code: 'ZOMATO-FREE-DEL', category: 'Food', brand: 'Zomato', description: 'Free delivery on 5 orders', originalValue: '150', sellingPrice: '10', sellerEmail: '', status: 'available', source: 'auto-scraped', addedAt: new Date().toISOString(), soldAt: '', buyerEmail: '' },
    { id: 'c009', code: 'AJIO-NEW40', category: 'Fashion', brand: 'AJIO', description: '40% off for new users', originalValue: '600', sellingPrice: '25', sellerEmail: 'user3@demo.com', status: 'available', source: 'user-submitted', addedAt: new Date().toISOString(), soldAt: '', buyerEmail: '' },
    { id: 'c010', code: 'LAKME-BEAUTY', category: 'Makeup', brand: 'Lakme', description: 'Buy 2 Get 1 free on Lakme products', originalValue: '400', sellingPrice: '20', sellerEmail: '', status: 'available', source: 'admin', addedAt: new Date().toISOString(), soldAt: '', buyerEmail: '' },
  ];
  memoryDB[SHEETS.COUPONS] = demoCoupons;
}

// ── CRUD Operations ─────────────────────────────────────────────────────────

/**
 * Get all rows from a sheet. Returns array of objects keyed by column header.
 */
async function getRows(sheetName) {
  if (!sheetsClient) {
    return [...(memoryDB[sheetName] || [])];
  }

  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:Z`,
  });

  const rows = res.data.values;
  if (!rows || rows.length <= 1) return [];

  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || '';
    });
    return obj;
  });
}

/**
 * Append a row to a sheet.
 * @param {string} sheetName
 * @param {object} data — object with keys matching column headers
 */
async function appendRow(sheetName, data) {
  const headers = HEADERS[sheetName];
  if (!headers) throw new Error(`Unknown sheet: ${sheetName}`);

  if (!sheetsClient) {
    memoryDB[sheetName] = memoryDB[sheetName] || [];
    memoryDB[sheetName].push(data);
    return data;
  }

  const row = headers.map((h) => data[h] || '');
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

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
  seedDemoData,
  getRows,
  appendRow,
  findRow,
  findRows,
  updateRow,
  deleteRow,
  countRows,
};

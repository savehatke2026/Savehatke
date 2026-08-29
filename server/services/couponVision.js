// ============================================
// SaveHatke — Coupon Screenshot Vision Service (Server-Only)
// ============================================
// Reads a coupon/voucher screenshot with Gemini Vision and returns structured,
// per-field values with a confidence score each.
//
// SECURITY: GEMINI_API_KEY is read from server-side env only. It is never
// returned to a client, never logged, and never embedded in frontend code.
// The image bytes are forwarded inline to Google and are not persisted here.
//
// TRUST MODEL: the model's JSON is treated as untrusted input. Nothing reaches
// the client until it has been parsed, whitelisted, type-coerced, length-capped
// and confidence-gated by validateExtraction() below. Anything the model
// invents outside the known field set is dropped, and a low-confidence value is
// forced to null rather than shown as a fact.
//
// The model is explicitly told never to guess: an unreadable field must come
// back as { "value": null, "confidence": 0 }.

const gemini = require('./geminiService');

// ── Limits ─────────────────────────────────────────────────────────────────
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;      // 10 MB, matches the sell page
const MIN_IMAGE_BYTES = 1024;                   // below this it is not a photo
const MIN_EDGE_PX = 200;                        // smaller than this is unreadable
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// A value below this is treated as a guess and discarded server-side.
const MIN_ACCEPTED_CONFIDENCE = 0.35;
// Anything under this is flagged to the seller as "please verify".
const VERIFY_BELOW_CONFIDENCE = 0.85;

// Fields the model is allowed to fill. selling_price, coupon_source and status
// are deliberately absent: price is the seller's decision, and source/status are
// forced by the server on submit.
const TEXT_FIELDS = ['brand', 'category', 'coupon_title', 'coupon_code', 'coupon_type'];
const FREE_TEXT_FIELDS = ['discount_value', 'terms_and_conditions', 'how_to_use'];
const AMOUNT_FIELDS = ['minimum_order_value', 'original_value_or_max_discount'];
const DATE_FIELDS = ['valid_from', 'expiry_date'];
const TIME_FIELDS = ['expiry_time'];

const ALL_FIELDS = [...TEXT_FIELDS, ...FREE_TEXT_FIELDS, ...AMOUNT_FIELDS, ...DATE_FIELDS, ...TIME_FIELDS];

// Marketplace categories (public/marketplace.html filter pills). A category
// outside this list is dropped — the sell form derives it from the brand anyway.
const CATEGORIES = [
  'E-Commerce', 'Fashion', 'Beauty & Personal Care', 'Food & Delivery',
  'Travel & Transport', 'Hotels & Stays', 'Electronics & Gadgets',
  'Gaming & Entertainment', 'Fitness & Sports', 'Education',
  'Health & Pharmacy', 'Finance & Payments', 'General',
];

// Coupon types the sell form's <select> actually offers.
const COUPON_TYPES = ['Discount', 'Cashback', 'BOGO', 'Free Delivery'];

const MAX_LEN = {
  brand: 60,
  category: 60,
  coupon_title: 120,
  coupon_code: 40,
  coupon_type: 30,
  discount_value: 60,
  terms_and_conditions: 1200,
  how_to_use: 600,
};

function isConfigured() {
  return gemini.isConfigured();
}

function getVisionModel() {
  return process.env.GEMINI_VISION_MODEL || gemini.getDefaultModel();
}

// ── Image sniffing (no third-party image library) ───────────────────────────
// Enough header parsing to (a) confirm the bytes really are the declared image
// type and (b) read the pixel dimensions so a 60×40 thumbnail can be rejected
// before it costs an API call. Blur/darkness are not detectable here — those
// are judged by the vision model.

function sniffImage(buffer) {
  if (!buffer || buffer.length < 16) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR with width/height as BE uint32
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buffer.length < 24 || buffer.slice(12, 16).toString('ascii') !== 'IHDR') {
      return { type: 'image/png', width: 0, height: 0 };
    }
    return {
      type: 'image/png',
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  // JPEG: FF D8, then walk the segment markers to the first SOFn frame header
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      // Standalone markers carry no length payload
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segLen = buffer.readUInt16BE(offset + 2);
      const isSOF = marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return {
          type: 'image/jpeg',
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
    return { type: 'image/jpeg', width: 0, height: 0 };
  }

  // WEBP: 'RIFF' .... 'WEBP' + a VP8 / VP8L / VP8X chunk
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
      buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buffer.slice(12, 16).toString('ascii');
    try {
      if (chunk === 'VP8 ' && buffer.length > 30) {
        return {
          type: 'image/webp',
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff,
        };
      }
      if (chunk === 'VP8L' && buffer.length > 25) {
        const bits = buffer.readUInt32LE(21);
        return {
          type: 'image/webp',
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        };
      }
      if (chunk === 'VP8X' && buffer.length > 30) {
        return {
          type: 'image/webp',
          width: (buffer.readUIntLE(24, 3) & 0xffffff) + 1,
          height: (buffer.readUIntLE(27, 3) & 0xffffff) + 1,
        };
      }
    } catch (e) {
      // fall through to the dimension-less answer
    }
    return { type: 'image/webp', width: 0, height: 0 };
  }

  return null;
}

/**
 * Cheap structural validation before any API call.
 * @returns {{ok:true, info:object} | {ok:false, reason:string, message:string}}
 */
function preflightImage(buffer, declaredType) {
  if (!buffer || buffer.length === 0) {
    return { ok: false, reason: 'corrupted', message: 'The image could not be read. Please upload the screenshot again.' };
  }
  if (buffer.length < MIN_IMAGE_BYTES) {
    return { ok: false, reason: 'corrupted', message: 'That file is too small to be a screenshot. Please upload the original image.' };
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, reason: 'too_large', message: 'The image is larger than 10 MB. Please upload a smaller screenshot.' };
  }

  const type = String(declaredType || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_TYPES.includes(type)) {
    return { ok: false, reason: 'invalid_type', message: 'Unsupported file type. Please upload a JPG, PNG or WEBP image.' };
  }

  const info = sniffImage(buffer);
  if (!info) {
    return { ok: false, reason: 'corrupted', message: 'That file is not a valid image, or it is corrupted. Please upload the screenshot again.' };
  }
  if (info.type !== type) {
    // The extension/mime lied about the contents — trust the bytes.
    return { ok: false, reason: 'corrupted', message: 'The image appears to be corrupted or renamed. Please upload the original screenshot.' };
  }
  if (info.width && info.height && (info.width < MIN_EDGE_PX || info.height < MIN_EDGE_PX)) {
    return {
      ok: false,
      reason: 'low_resolution',
      message: `The image is only ${info.width}×${info.height}px, which is too small to read reliably. Please upload a full-size screenshot.`,
    };
  }

  return { ok: true, info: { ...info, bytes: buffer.length } };
}

// ── Prompt ─────────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You read screenshots of discount coupons, vouchers, reward codes and promo offers for SaveHatke, an Indian coupon marketplace.

Return ONLY a single JSON object. No markdown, no code fences, no commentary.

Shape:
{
  "is_coupon": boolean,
  "readable": boolean,
  "quality_issue": null | "blurry" | "too_dark" | "low_resolution" | "cropped" | "no_text",
  "quality_note": string | null,
  "fields": {
    "brand":                          { "value": string|null, "confidence": number },
    "category":                       { "value": string|null, "confidence": number },
    "coupon_title":                   { "value": string|null, "confidence": number },
    "coupon_code":                    { "value": string|null, "confidence": number },
    "coupon_type":                    { "value": string|null, "confidence": number },
    "discount_value":                 { "value": string|null, "confidence": number },
    "minimum_order_value":            { "value": string|null, "confidence": number },
    "original_value_or_max_discount": { "value": string|null, "confidence": number },
    "valid_from":                     { "value": string|null, "confidence": number },
    "expiry_date":                    { "value": string|null, "confidence": number },
    "expiry_time":                    { "value": string|null, "confidence": number },
    "terms_and_conditions":           { "value": string|null, "confidence": number },
    "how_to_use":                     { "value": string|null, "confidence": number }
  }
}

HARD RULES — follow them exactly:
1. NEVER guess, infer, complete or invent a value. Extract only what is literally visible and legible in the image.
2. If a field is not visible, is cut off, is unreadable, or you are unsure, return { "value": null, "confidence": 0 }. A null is always better than a guess.
3. "confidence" is your own certainty for THAT field, from 0 to 1. Use a genuinely low number when the text is small, blurry, partially covered or ambiguous.
4. Do NOT return a selling price, listing price, source or status. Those are not yours to decide.
5. "is_coupon" is true only when the image really shows a coupon, voucher, promo code, gift card or reward offer. A random photo, screenshot of a chat, product page, receipt, meme or document is NOT a coupon: set "is_coupon": false and leave every field null.
6. "readable" is false when the image is too blurry, too dark, too low-resolution or too cropped for you to read the coupon text with confidence. When it is false, set every field to null and set "quality_issue".
7. "coupon_code" must be the exact redeem code as printed (keep its case and characters; no spaces, no explanation). If no code is visible, return null — never construct one from the brand or offer text.
8. Dates must be ISO "YYYY-MM-DD". "expiry_time" must be 24-hour "HH:MM". If a date shows no year, return null rather than assuming a year.
9. "category" must be exactly one of: ${CATEGORIES.join(', ')}. Otherwise null.
10. "coupon_type" must be exactly one of: ${COUPON_TYPES.join(', ')}. Otherwise null.
11. "discount_value" is short, as printed, e.g. "30% OFF", "₹500 OFF", "Buy 1 Get 1".
12. "minimum_order_value" and "original_value_or_max_discount" are plain numbers in rupees, digits only, e.g. "999". No currency symbol, no words.
13. "terms_and_conditions" and "how_to_use" must be copied from visible text only, trimmed of decoration. Null when the image shows none.`;

// ── Model call ─────────────────────────────────────────────────────────────

/**
 * Send the image to Gemini Vision and return the raw parsed JSON object.
 * @returns {Promise<{ok:true, raw:object, model:string} | {ok:false, error:string, status?:number, model:string}>}
 */
async function callVision(buffer, mimeType, opts = {}) {
  const model = opts.model || getVisionModel();
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 45000, 5000), 120000);

  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: EXTRACTION_PROMPT },
        { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
      ],
    }],
    generationConfig: {
      temperature: 0,                       // extraction, not creativity
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      `${gemini.getBaseUrl()}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // SECURITY: server-side key, sent as a header so it never lands in a
          // URL, a log line or a response body.
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let error = 'api_error';
      if (res.status === 429) error = 'rate_limited';
      else if (res.status === 401 || res.status === 403 || /api key not valid/i.test(errText)) error = 'auth_error';
      // Detail is logged by the caller, never returned to the client.
      return { ok: false, error, status: res.status, model, detail: errText.slice(0, 300) };
    }

    const data = await res.json();
    const candidate = data.candidates && data.candidates[0];
    if (!candidate || !candidate.content) {
      const blocked = (data.promptFeedback && data.promptFeedback.blockReason) ||
        (candidate && candidate.finishReason) || 'empty_response';
      return { ok: false, error: 'content_blocked', model, detail: String(blocked).slice(0, 120) };
    }

    let text = '';
    for (const part of candidate.content.parts || []) {
      if (typeof part.text === 'string') text += part.text;
    }

    const raw = parseJsonLoosely(text);
    if (!raw) return { ok: false, error: 'bad_json', model, detail: text.slice(0, 200) };

    return { ok: true, raw, model: data.modelVersion || model };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, error: 'timeout', model };
    return { ok: false, error: 'network_error', model, detail: err && err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** JSON mode should return clean JSON; tolerate a stray code fence anyway. */
function parseJsonLoosely(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const attempts = [s];

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1].trim());

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(s.slice(first, last + 1));

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (e) {
      // try the next shape
    }
  }
  return null;
}

// ── Response validation (the model's output is untrusted) ───────────────────

function clampConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return n > 100 ? 0 : Math.min(n / 100, 1); // tolerate "94" for 0.94
  return n;
}

function cleanText(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s || /^(null|n\/a|na|none|unknown|not visible|-{1,})$/i.test(s)) return null;
  return s.slice(0, max);
}

function cleanMultiline(v, max) {
  if (v == null) return null;
  const s = String(v)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!s || /^(null|n\/a|na|none|unknown|not visible)$/i.test(s)) return null;
  return s.slice(0, max);
}

/** Digits-only rupee amount. "₹1,299" → "1299"; "about 500" → null. */
function cleanAmount(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const digits = s.replace(/[₹,\s]/g, '').replace(/\.\d+$/, '');
  if (!/^\d{1,7}$/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 0 || n > 9999999) return null;
  return String(n);
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Normalize to YYYY-MM-DD, or null. Never assumes a missing year. */
function cleanDate(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;

  let y;
  let m;
  let d;

  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) { [, y, m, d] = match; }

  if (!match) {
    // DD/MM/YYYY or DD-MM-YYYY (Indian order, which is what these screenshots use)
    match = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (match) { [, d, m, y] = match; }
  }

  if (!match) {
    // "30 Sep 2026" / "Sep 30, 2026"
    match = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
    if (match) { d = match[1]; m = MONTHS[match[2].slice(0, 4).toLowerCase()] || MONTHS[match[2].slice(0, 3).toLowerCase()]; y = match[3]; }
  }
  if (!match) {
    match = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
    if (match) { m = MONTHS[match[1].slice(0, 4).toLowerCase()] || MONTHS[match[1].slice(0, 3).toLowerCase()]; d = match[2]; y = match[3]; }
  }

  if (!match || !y || !m || !d) return null;

  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
  if (yy < 2000 || yy > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  // Reject 31 Feb and friends by round-tripping through Date
  const iso = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const probe = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(probe.getTime()) || probe.getUTCDate() !== dd || probe.getUTCMonth() + 1 !== mm) return null;
  return iso;
}

/** Normalize to 24-hour HH:MM, or null. */
function cleanTime(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;

  let match = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/);
  if (!match) {
    match = s.match(/^(\d{1,2})\s*(am|pm)$/);
    if (match) match = [match[0], match[1], '00', match[2]];
  }
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = match[3];
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null;
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  if (hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** A redeem code: uppercase, no spaces, plausible characters and length. */
function cleanCode(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (s.length < 3 || s.length > 40) return null;
  if (!/^[A-Z0-9][A-Z0-9._+-]*$/.test(s)) return null;
  if (!/[A-Z0-9]{3}/.test(s)) return null;
  return s;
}

function matchFromList(v, list) {
  const s = cleanText(v, 60);
  if (!s) return null;
  const hit = list.find((item) => item.toLowerCase() === s.toLowerCase());
  return hit || null;
}

/** Pull { value, confidence } out of the model's field entry, tolerating a bare value. */
function readEntry(node) {
  if (node == null) return { value: null, confidence: 0 };
  if (typeof node === 'object' && !Array.isArray(node)) {
    return { value: node.value, confidence: clampConfidence(node.confidence) };
  }
  // A bare scalar carries no confidence — treat it as unverified.
  return { value: node, confidence: 0.5 };
}

/**
 * Whitelist + coerce the model output. Unknown keys are dropped, every value is
 * type-checked, and a value under MIN_ACCEPTED_CONFIDENCE is discarded so a
 * low-certainty guess can never reach the form.
 *
 * @returns {{ok:true, fields:object, quality:object, filledCount:number}
 *          | {ok:false, reason:string, message:string, quality:object}}
 */
function validateExtraction(raw) {
  const quality = {
    isCoupon: raw.is_coupon === true,
    readable: raw.readable !== false,
    issue: cleanText(raw.quality_issue, 30),
    note: cleanText(raw.quality_note, 200),
  };

  if (!quality.isCoupon) {
    return {
      ok: false,
      reason: 'not_coupon',
      message: "This doesn't appear to be a coupon or voucher. Please upload a valid coupon screenshot.",
      quality,
    };
  }

  if (!quality.readable) {
    const issue = String(quality.issue || '').toLowerCase();
    if (issue === 'too_dark') {
      return { ok: false, reason: 'too_dark', message: 'The image is too dark to read. Please upload a brighter screenshot or photo.', quality };
    }
    if (issue === 'low_resolution') {
      return { ok: false, reason: 'low_resolution', message: 'The image resolution is too low to read the coupon details. Please upload a full-size screenshot.', quality };
    }
    if (issue === 'cropped') {
      return { ok: false, reason: 'cropped', message: 'The coupon looks cut off. Please upload a screenshot that shows the whole coupon.', quality };
    }
    return { ok: false, reason: 'blurry', message: "We couldn't clearly read the coupon details. Please upload a clearer screenshot or photo.", quality };
  }

  const src = (raw.fields && typeof raw.fields === 'object') ? raw.fields : {};
  const fields = {};
  let filledCount = 0;

  for (const key of ALL_FIELDS) {
    const entry = readEntry(src[key]);
    let value = null;

    if (key === 'coupon_code') value = cleanCode(entry.value);
    else if (key === 'category') value = matchFromList(entry.value, CATEGORIES);
    else if (key === 'coupon_type') value = matchFromList(entry.value, COUPON_TYPES);
    else if (AMOUNT_FIELDS.includes(key)) value = cleanAmount(entry.value);
    else if (DATE_FIELDS.includes(key)) value = cleanDate(entry.value);
    else if (TIME_FIELDS.includes(key)) value = cleanTime(entry.value);
    else if (key === 'terms_and_conditions' || key === 'how_to_use') value = cleanMultiline(entry.value, MAX_LEN[key]);
    else value = cleanText(entry.value, MAX_LEN[key] || 120);

    // The model was told to send confidence 0 with a null value; enforce the
    // reverse too, so a "confident" unreadable field cannot slip through.
    let confidence = value === null ? 0 : entry.confidence;
    if (value !== null && confidence < MIN_ACCEPTED_CONFIDENCE) {
      value = null;
      confidence = 0;
    }

    fields[key] = {
      value,
      confidence: Number(confidence.toFixed(2)),
      verify: value !== null && confidence < VERIFY_BELOW_CONFIDENCE,
    };
    if (value !== null) filledCount++;
  }

  // An expiry time without a date is meaningless on the form.
  if (!fields.expiry_date.value && fields.expiry_time.value) {
    fields.expiry_time = { value: null, confidence: 0, verify: false };
    filledCount--;
  }

  // "Readable coupon" means we got something identifying plus something usable.
  const hasIdentity = !!(fields.brand.value || fields.coupon_title.value);
  const hasSubstance = !!(fields.coupon_code.value || fields.discount_value.value);
  if (!hasIdentity || !hasSubstance || filledCount < 2) {
    return {
      ok: false,
      reason: 'insufficient_data',
      message: "We couldn't read enough coupon information from that image. Please upload a clearer screenshot showing the code and the offer.",
      quality,
    };
  }

  return { ok: true, fields, quality, filledCount };
}

/**
 * Full pipeline: preflight → Gemini Vision → validate.
 *
 * @param {{buffer:Buffer, mimeType:string, model?:string, timeoutMs?:number}} args
 * @returns {Promise<object>} { ok:true, fields, quality, filledCount, model, image }
 *                            | { ok:false, reason, message, ... }
 */
async function analyzeCouponImage({ buffer, mimeType, model, timeoutMs } = {}) {
  if (!isConfigured()) {
    return { ok: false, reason: 'not_configured', message: 'AI scanning is not available right now. Please enter the coupon details manually.' };
  }

  const pre = preflightImage(buffer, mimeType);
  if (!pre.ok) return { ok: false, reason: pre.reason, message: pre.message };

  const call = await callVision(buffer, pre.info.type, { model, timeoutMs });
  if (!call.ok) {
    // Log the provider detail server-side only.
    console.warn(`[coupon-vision] Gemini call failed (${call.error}${call.status ? ' ' + call.status : ''})${call.detail ? ': ' + call.detail : ''}`);
    const messages = {
      rate_limited: 'AI scanning is busy right now. Please try again in a minute or enter the details manually.',
      auth_error: 'AI scanning is not available right now. Please enter the coupon details manually.',
      timeout: 'Reading the coupon took too long. Please try again with a smaller screenshot.',
      content_blocked: "We couldn't analyse that image. Please upload a different coupon screenshot.",
      bad_json: "We couldn't read the coupon details from that image. Please try again or enter them manually.",
    };
    return {
      ok: false,
      reason: call.error === 'rate_limited' ? 'rate_limited' : 'ai_unavailable',
      message: messages[call.error] || 'AI scanning failed. Please try again or enter the details manually.',
    };
  }

  const validated = validateExtraction(call.raw);
  if (!validated.ok) return validated;

  return {
    ok: true,
    fields: validated.fields,
    quality: validated.quality,
    filledCount: validated.filledCount,
    model: call.model,
    image: { width: pre.info.width, height: pre.info.height, bytes: pre.info.bytes, type: pre.info.type },
  };
}

module.exports = {
  isConfigured,
  analyzeCouponImage,
  // exported for tests / reuse
  preflightImage,
  sniffImage,
  validateExtraction,
  cleanDate,
  cleanTime,
  cleanAmount,
  cleanCode,
  MAX_IMAGE_BYTES,
  ALLOWED_TYPES,
  CATEGORIES,
  COUPON_TYPES,
  VERIFY_BELOW_CONFIDENCE,
};

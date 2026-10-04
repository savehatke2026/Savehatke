'use strict';

// ============================================
// SaveHatke — shared HTTP 429 handler
// ============================================
// Every limiter in the app uses this so a rate-limited response is always the
// same safe shape:
//
//   • HTTP 429 with `Retry-After` (seconds, always >= 1)
//   • `Cache-Control: no-store` so a proxy cannot replay the refusal
//   • `{ error, code: 'RATE_LIMITED' }` — the `code` is what public/js/app.js
//     keys on to send the visitor to the existing /429.html page
//   • nothing about the limiter's store, its key, the current counter or the
//     configured maximum. A 429 must not double as a reconnaissance endpoint.
//
// Two delivery shapes, picked by who is asking:
//   • An API/XHR caller (fetch, the checkout polling loop, a cron job, a
//     webhook) gets JSON, because that is what it can parse.
//   • A real browser navigation to a rate-limited URL gets the site's branded
//     /429.html page, so a human never sees a raw JSON blob.
//
// The HTML branch is conservative on purpose. It only fires for a request that
// explicitly accepts text/html, and never for the machine-to-machine
// endpoints — a payment webhook or a cron reconciliation run that receives an
// HTML document instead of a status code would be a functional regression, not
// a nicety.

const fs = require('fs');
const path = require('path');

// Endpoints that must always receive JSON, whatever the Accept header says.
const JSON_ONLY = [
  /^\/api\/payment\/(?:webhook|cron|gmail-push|gmail-watch)/i,
  /^\/api\/auth\/session-cleanup/i,
  /^\/api\/admin\/(?:reports\/monthly\/run|drive\/keepalive)/i,
];

let rateLimitPageCache = null;

function rateLimitPage() {
  if (rateLimitPageCache === null) {
    try {
      rateLimitPageCache = fs.readFileSync(path.join(__dirname, '..', '..', 'public', '429.html'), 'utf8');
    } catch (e) {
      rateLimitPageCache = '';
    }
  }
  return rateLimitPageCache;
}

function wantsHtml(req) {
  const pathname = String((req && (req.originalUrl || req.url)) || '').split('?')[0];
  if (JSON_ONLY.some((re) => re.test(pathname))) return false;
  // A client that sends no Accept header at all is treated as a machine caller.
  const accept = String((req && req.headers && req.headers.accept) || '');
  return /\btext\/html\b/i.test(accept);
}

function safeRateLimitHandler(message = 'Too many requests. Please try again later.') {
  return (req, res) => {
    const resetAt = req.rateLimit && req.rateLimit.resetTime;
    const retryAfter = resetAt instanceof Date
      ? Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000))
      : 60;
    res.set('Retry-After', String(retryAfter));
    res.set('Cache-Control', 'no-store');

    if (wantsHtml(req)) {
      const page = rateLimitPage();
      if (page) {
        res.set('Content-Type', 'text/html; charset=utf-8');
        return res.status(429).send(page);
      }
    }

    return res.status(429).json({ error: message, code: 'RATE_LIMITED' });
  };
}

module.exports = { safeRateLimitHandler, wantsHtml };

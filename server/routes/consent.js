// ============================================
// SaveHatke — Consent Routes
// ============================================
// A read-only view of what the server sees in the visitor's `sh_consent` cookie.
//
// The decision itself is made and stored in the browser, so there is no POST
// here: adding one would create a second place that can write consent, which is
// exactly what a single consent manager is meant to prevent.
//
// This endpoint exists so that:
//   * the cookie round-trip can be verified end to end (the client wrote it, the
//     server genuinely receives it), and
//   * any server-rendered or server-side integration added later has one
//     authoritative place to ask, instead of re-parsing the cookie itself.

const express = require('express');
const consent = require('../utils/consent');

const router = express.Router();

// GET /api/consent — what this browser has consented to.
router.get('/', (req, res) => {
  const decision = consent.readConsent(req);

  // No-store: the answer is specific to one visitor's cookie and must never be
  // held in a shared or CDN cache.
  res.set('Cache-Control', 'no-store');

  res.json({
    // null when the visitor has not answered yet — the banner should show.
    consent: decision,
    decided: !!decision,
    // Resolved permissions, so a caller never has to re-implement the
    // "optional defaults to false" rule.
    allowed: {
      essential: true,
      analytics: consent.hasConsent(req, 'analytics'),
      marketing: consent.hasConsent(req, 'marketing'),
    },
    version: consent.CONSENT_VERSION,
  });
});

module.exports = router;

// ============================================
// SaveHatke — Email Test Log (Mongoose)
// ============================================
// Audit trail for the Admin → Email Testing tool. It stores ONLY testing
// activity metadata: which template was sent, to which test address, by which
// admin, when, and whether it succeeded. It deliberately never stores the
// rendered email body or any real customer / order / payment / coupon data.
//
// Two jobs:
//   1. Power the "Recent Test Emails" table at the bottom of the tool.
//   2. Enforce the per-admin rate limit (count of recent rows per admin).

const mongoose = require('mongoose');

const emailTestLogSchema = new mongoose.Schema(
  {
    // Allowlisted template id, e.g. "welcome", "otp", "signin_alert".
    template: { type: String, required: true, trim: true },
    // Human-friendly label shown in the history table, e.g. "Welcome Email".
    templateName: { type: String, default: '', trim: true },
    // The test address the mail was sent to (admin-controlled test inbox only).
    recipient: { type: String, default: '', trim: true, lowercase: true },
    // Acting admin, resolved from the authenticated session.
    sentByEmail: { type: String, default: '', trim: true, lowercase: true },
    sentByName: { type: String, default: '', trim: true },
    status: { type: String, enum: ['sent', 'failed'], default: 'sent' },
    // Short, non-sensitive failure reason when status === 'failed'.
    error: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Newest-first history reads, and fast per-admin rate-limit window counts.
emailTestLogSchema.index({ created_at: -1 });
emailTestLogSchema.index({ sentByEmail: 1, created_at: -1 });

module.exports = mongoose.models.EmailTestLog
  || mongoose.model('EmailTestLog', emailTestLogSchema);

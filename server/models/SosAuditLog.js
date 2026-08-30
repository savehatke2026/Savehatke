// ============================================
// SaveHatke — Mongoose SOS Audit Log
// ============================================
// One record per SOS backup-access attempt, written whether the attempt
// succeeded or failed. The audit id is created before the alert email is sent
// so the email can quote it.
//
// NEVER stored here: the raw backup code, any security answer, any password,
// the CAPTCHA secret, or any authentication token. The backup code appears only
// as its database id and non-secret display prefix.

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const FAILURE_CATEGORIES = [
  '',                       // success
  'RATE_LIMITED',
  'BAD_REQUEST',
  'CAPTCHA_FAILED',
  'CODE_INVALID',
  'CODE_NOT_USABLE',
  'SESSION_INVALID',
  'SESSION_EXPIRED',
  'CONTEXT_MISMATCH',
  'ADMIN_INELIGIBLE',
  'QUESTIONS_NOT_CONFIGURED',
  'ANSWERS_INCORRECT',
  'LOCKED_OUT',
  'STORE_UNAVAILABLE',
  'SESSION_CREATE_FAILED',
];

const sosAuditSchema = new mongoose.Schema(
  {
    // Quoted to the administrators in the alert email.
    audit_ref: {
      type: String,
      default: () => `SOSA-${uuidv4()}`,
      unique: true,
      index: true,
    },
    attempt_id: { type: String, default: '', index: true },

    backup_code_id: { type: String, default: '' },
    backup_code_prefix: { type: String, default: '' },

    reason: { type: String, default: '', maxlength: 500 },

    selected_admin_id: { type: String, default: '' },
    selected_admin_name: { type: String, default: '' },

    ip: { type: String, default: '' },
    // Approximate, from IP geolocation — never presented as a precise location.
    location: {
      country: { type: String, default: '' },
      region: { type: String, default: '' },
      city: { type: String, default: '' },
      timezone: { type: String, default: '' },
      isp: { type: String, default: '' },
      approximate: { type: Boolean, default: true },
    },
    browser: { type: String, default: '' },
    os: { type: String, default: '' },
    device: { type: String, default: '' },
    user_agent: { type: String, default: '' },

    captcha_result: { type: String, enum: ['passed', 'failed', 'skipped', 'unknown'], default: 'unknown' },
    questions_result: { type: String, enum: ['passed', 'failed', 'not-reached'], default: 'not-reached' },

    success: { type: Boolean, default: false, index: true },
    failure_category: { type: String, enum: FAILURE_CATEGORIES, default: '' },
    // Which attempt within this SOS session produced the record.
    attempt_number: { type: Number, default: 1 },

    admin_session_created: { type: Boolean, default: false },
    admin_session_id: { type: String, default: '' },

    // Per-recipient delivery outcome for the alert email, filled in after the
    // record is created. A delivery failure never revokes the session.
    email_status: {
      type: [
        {
          to_ref: { type: String, default: '' },   // admin display name, not the address
          delivered: { type: Boolean, default: false },
          simulated: { type: Boolean, default: false },
          error: { type: String, default: '' },
          attempts: { type: Number, default: 0 },
          _id: false,
        },
      ],
      default: [],
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

sosAuditSchema.index({ created_at: -1 });

module.exports = mongoose.models.SosAuditLog || mongoose.model('SosAuditLog', sosAuditSchema);
module.exports.FAILURE_CATEGORIES = FAILURE_CATEGORIES;

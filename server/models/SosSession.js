// ============================================
// SaveHatke — Mongoose SOS Recovery Session
// ============================================
// The server-side state machine for one SOS backup-access attempt.
//
// Why this lives in MongoDB rather than a process Map:
//   - the app runs on serverless instances, so an in-memory session is invisible
//     to the next request that lands on a different instance;
//   - the failed-attempt counter and the stage gate are security controls, and a
//     restart must not reset them;
//   - MongoDB is the declared source of truth for SOS state.
//
// What it deliberately does NOT hold:
//   - the raw backup code (only backup_code_id / backup_code_prefix);
//   - any security answer, hash or question set;
//   - the admin's email or any other private admin field.
//
// A session grants nothing on its own. `stage` only records how far the attempt
// has legitimately progressed; the authenticated admin session is minted once,
// at the end, by the verify route — never from a client-supplied flag.

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const STAGES = ['reason', 'select-admin', 'questions', 'verified', 'closed'];

const sosSessionSchema = new mongoose.Schema(
  {
    // Public attempt id, safe to log and to quote in the audit trail.
    attempt_id: {
      type: String,
      default: () => `SOS-${uuidv4()}`,
      unique: true,
      index: true,
    },
    // SHA-256 of the opaque session token handed to the browser. The token
    // itself is never stored, so a database leak cannot resume an attempt.
    token_hash: {
      type: String,
      required: true,
      index: true,
    },
    // Reference to the backup code that opened this attempt — id and the
    // non-secret display prefix only.
    backup_code_id: { type: String, required: true },
    backup_code_prefix: { type: String, default: '' },
    // Which store recognised the code ('supabase' | 'mongo'). Recorded so the
    // grant stamps the use against the row that actually authorised it.
    backup_code_store: { type: String, default: '' },

    // Written at the 'reason' stage, once the code has already been accepted.
    // Empty means the attempt has not got that far — never that no reason was
    // required; /start refuses to advance without one.
    reason: { type: String, default: '', maxlength: 500 },

    stage: { type: String, enum: STAGES, default: 'reason', index: true },

    // Bound once the user picks an administrator, after the server re-checks
    // eligibility. Stores the admin's uuid `id`, never the _id or email.
    selected_admin_id: { type: String, default: null },
    selected_admin_name: { type: String, default: '' },

    // The subset of question keys this attempt must answer, chosen server-side.
    // Keys are meaningless without the admin's configuration, so they are safe
    // to persist; the questions themselves are re-read from the admin document.
    question_keys: { type: [String], default: [] },

    failed_attempts: { type: Number, default: 0 },
    captcha_passed: { type: Boolean, default: false },

    // Bound to the opening request so a stolen token cannot be replayed from
    // another network or client.
    ip: { type: String, default: '' },
    user_agent_hash: { type: String, default: '' },

    expires_at: { type: Date, required: true, index: true },
    closed_reason: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Atlas removes the document once it expires, so abandoned attempts do not
// accumulate. The route still checks expires_at: the sweeper is not immediate.
sosSessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

sosSessionSchema.methods.isLive = function isLive() {
  return this.stage !== 'closed' && this.expires_at instanceof Date && this.expires_at > new Date();
};

module.exports = mongoose.models.SosSession || mongoose.model('SosSession', sosSessionSchema);
module.exports.STAGES = STAGES;

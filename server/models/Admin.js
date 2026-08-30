// ============================================
// SaveHatke — Mongoose Admin Schema
// ============================================

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// One configured security question for SOS backup access.
//
// `answer_hash` is a bcrypt hash of the NORMALISED answer (see
// server/utils/sosAnswers.js) — plaintext answers are never stored, never
// logged and never sent anywhere. It is select:false so a plain Admin.find()
// cannot carry it out of the database by accident; the SOS verifier asks for
// it explicitly.
//
// `kind` drives normalisation: 'text' collapses whitespace/case, 'date'
// canonicalises the supported day-month-year formats before comparison.
const securityQuestionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    question: { type: String, required: true, trim: true, maxlength: 300 },
    kind: { type: String, enum: ['text', 'date'], default: 'text' },
    answer_hash: { type: String, default: '', select: false },
    enabled: { type: Boolean, default: true },
    updated_at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const adminSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      default: uuidv4,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password_hash: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ['Super Admin', 'Admin', 'Support'],
      default: 'Admin',
    },
    phone: {
      type: String,
      default: '',
      trim: true,
    },
    profile_image: {
      type: String,
      default: '',
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    email_verified: {
      type: Boolean,
      default: true,
    },
    two_factor_enabled: {
      type: Boolean,
      default: false,
    },
    last_login: {
      type: Date,
      default: null,
    },

    // ── SOS backup access ────────────────────────────────────────────────
    // Each administrator carries their own independent question set. Sets are
    // never merged and never shared: the SOS flow loads only the selected
    // administrator's questions. Only the hash is stored, and answer_hash is
    // select:false so it cannot leak through an incidental .find().
    security_questions: {
      type: [securityQuestionSchema],
      default: [],
    },
    // How many of the enabled questions a single SOS attempt must answer.
    // Server-side selection; the browser only ever sees the chosen subset.
    sos_questions_required: {
      type: Number,
      default: 5,
      min: 1,
      max: 20,
    },
    // Eligibility for SOS recovery, independent of is_active so an admin can
    // stay logged in while being taken out of the break-glass rotation.
    sos_enabled: {
      type: Boolean,
      default: true,
    },
    // Availability is re-read from the database on every SOS step; it is never
    // cached in the browser. Set by the admin themselves or by an operator.
    sos_available: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

// Virtual for full_name to ensure full backward compatibility
adminSchema.virtual('full_name')
  .get(function () {
    return this.name;
  })
  .set(function (v) {
    this.name = v;
  });

// Ensure virtuals are included in JSON output
adminSchema.set('toJSON', { virtuals: true });
adminSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.Admin || mongoose.model('Admin', adminSchema);


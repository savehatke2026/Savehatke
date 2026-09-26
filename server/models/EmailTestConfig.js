// ============================================
// SaveHatke — Email Test Config (Mongoose)
// ============================================
// A single document holding the shared "Test Email Address" used as the
// recipient for every manually triggered test email from the Admin → Email
// Testing tool. Carries no sensitive data — just the destination address the
// admins chose for their own test sends.

const mongoose = require('mongoose');

const emailTestConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'email_testing',
    },
    // The saved recipient for all manual test emails.
    testEmail: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    // Which admin last saved the address (for the audit trail only).
    updatedByEmail: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

module.exports = mongoose.models.EmailTestConfig
  || mongoose.model('EmailTestConfig', emailTestConfigSchema);

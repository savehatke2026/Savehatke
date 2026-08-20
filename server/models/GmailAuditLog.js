// ============================================
// SaveHatke — Gmail Audit Log Schema
// Records every admin action on the Gmail mailbox.
// ============================================

const mongoose = require('mongoose');

const gmailAuditLogSchema = new mongoose.Schema(
  {
    admin_user_id: {
      type: String,
      required: true,
      index: true,
    },
    admin_email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    target_id: {
      type: String,
      default: '',
    },
    details: {
      type: String,
      default: '',
    },
    ip: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: false },
  }
);

gmailAuditLogSchema.index({ created_at: -1 });

module.exports = mongoose.models.GmailAuditLog || mongoose.model('GmailAuditLog', gmailAuditLogSchema);

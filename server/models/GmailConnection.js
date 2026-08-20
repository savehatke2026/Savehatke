// ============================================
// SaveHatke — Gmail Connection Schema
// Stores OAuth metadata only. Refresh tokens are
// AES-256-GCM encrypted; email bodies are NOT stored.
// ============================================

const mongoose = require('mongoose');

const gmailConnectionSchema = new mongoose.Schema(
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
    gmail_email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    // AES-256-GCM encrypted OAuth refresh token (see services/gmailCrypto.js)
    encrypted_refresh_token: {
      type: String,
      required: true,
    },
    granted_scopes: {
      type: String,
      default: '',
    },
    // Cached access token metadata (never exposed to the frontend)
    access_token_expires_at: {
      type: Date,
      default: null,
    },
    // Gmail sync state
    history_id: {
      type: String,
      default: null,
    },
    // Push notification (Pub/Sub) watch state
    watch_expiration: {
      type: Date,
      default: null,
    },
    watch_push_token: {
      type: String,
      default: '',
    },
    unread_count: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

// One Gmail connection per admin
gmailConnectionSchema.index({ admin_user_id: 1 }, { unique: true });

module.exports = mongoose.models.GmailConnection || mongoose.model('GmailConnection', gmailConnectionSchema);

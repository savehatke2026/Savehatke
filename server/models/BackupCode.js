// ============================================
// SaveHatke — Mongoose BackupCode Schema
// ============================================
// High-security storage for SOS / backup admin access codes.
//
// Security design:
//   - The cleartext code is NEVER stored. Only a bcrypt hash.
//   - The codePrefix (first 6 chars of the SHA-256 of the hash) is kept
//     for human-readable identification in the admin UI / audit logs,
//     so admins can distinguish codes without exposing the hash itself.
//   - Every successful use bumps usageCount and stamps lastUsedAt + IP.
//   - Each code can be scoped to specific allowed admin emails, or
//     default to the full super-admin allowlist.
//   - Codes can be revoked (isActive=false) without deletion, so the
//     audit trail stays intact.
//   - maxUses is an optional cap (null = unlimited). The login route
//     will reject codes that have hit the cap.
//   - expiresAt is an optional absolute expiry (null = never).

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const backupCodeSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      default: uuidv4,
      unique: true,
      index: true,
    },
    codeHash: {
      type: String,
      required: true,
      // bcrypt hash — ~60 chars, starts with $2a$ / $2b$ / $2y$
    },
    codePrefix: {
      type: String,
      required: true,
      // 6-char prefix of SHA-256(codeHash) for human identification.
      // Safe to display in the admin UI; not a secret.
      index: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    createdBy: {
      // Email or UUID of the admin who minted this code
      type: String,
      required: true,
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      maxlength: 1000,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      default: null, // null = never expires
    },
    maxUses: {
      type: Number,
      default: null, // null = unlimited
    },
    usageCount: {
      type: Number,
      default: 0,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    lastUsedIp: {
      type: String,
      default: '',
    },
    lastUsedReason: {
      type: String,
      default: '',
      maxlength: 500,
    },
    allowedAdminEmails: {
      // Empty array = any of the route-level allowlist can be used.
      // Populated array = restrict to this subset of admin emails.
      type: [String],
      default: [],
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  },
);

// ── Indexes for the hot path ──
// Login only considers active, non-expired, under-cap codes:
backupCodeSchema.index({ isActive: 1, expiresAt: 1 });

// Never return the hash or any field that could help an attacker. The
// admin UI is meant to see metadata only.
backupCodeSchema.methods.toSafeJSON = function () {
  return {
    id: this.id,
    codePrefix: this.codePrefix,
    label: this.label,
    createdBy: this.createdBy,
    notes: this.notes,
    isActive: this.isActive,
    expiresAt: this.expiresAt,
    maxUses: this.maxUses,
    usageCount: this.usageCount,
    lastUsedAt: this.lastUsedAt,
    lastUsedIp: this.lastUsedIp,
    lastUsedReason: this.lastUsedReason,
    allowedAdminEmails: this.allowedAdminEmails,
    created_at: this.created_at,
    updated_at: this.updated_at,
  };
};

module.exports = mongoose.models.BackupCode || mongoose.model('BackupCode', backupCodeSchema);

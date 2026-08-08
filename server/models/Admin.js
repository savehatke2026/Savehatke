// ============================================
// SaveHatke — Mongoose Admin Schema
// ============================================

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

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


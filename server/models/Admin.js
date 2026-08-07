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
    full_name: {
      type: String,
      required: true,
      trim: true,
      default: 'Super Admin',
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
      enum: ['Super Admin', 'Admin'],
      default: 'Super Admin',
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

module.exports = mongoose.models.Admin || mongoose.model('Admin', adminSchema);

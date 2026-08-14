// ============================================
// SaveHatke — Mongoose Setting Schema
// ============================================

const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'site_settings',
    },
    activeUsers: {
      type: String,
      default: '10K+',
    },
    couponsTraded: {
      type: String,
      default: '50K+',
    },
    savedByUsers: {
      type: String,
      default: '₹2L+',
    },
    platformName: {
      type: String,
      default: 'SaveHatke',
    },
    adminEmail: {
      type: String,
      default: 'rupayandas2024@gmail.com',
    },
    showActiveUsers: {
      type: Boolean,
      default: true,
    },
    showCouponsTraded: {
      type: Boolean,
      default: true,
    },
    showSavedByUsers: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Setting', settingSchema);

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
    // Heading copy above the homepage testimonial cards. The cards themselves
    // are rows in the Testimonials sheet, not settings.
    testimonialsLabel: {
      type: String,
      default: 'Testimonials',
    },
    testimonialsTitle: {
      type: String,
      default: 'Loved by',
    },
    testimonialsTitleHighlight: {
      type: String,
      default: '10,000+ Smart Shoppers',
    },
    testimonialsSubtitle: {
      type: String,
      default: 'Real stories from real users who save big with SaveHatke.',
    },
    showTestimonials: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Setting', settingSchema);

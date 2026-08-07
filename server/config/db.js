// ============================================
// SaveHatke — MongoDB Connection & Admin Seed
// ============================================

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const Admin = require('../models/Admin');

let isConnected = false;

async function connectDB() {
  if (isConnected) return;

  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/savehatke';

  try {
    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = true;
    console.log(`🍃 MongoDB Connected: ${conn.connection.host}/${conn.connection.name}`);

    // Seed initial admin user if no admin exists
    await seedAdminUser();
  } catch (err) {
    console.warn(`⚠️ MongoDB connection warning: ${err.message}. Admin auth will use fallback env credentials if offline.`);
  }
}

async function seedAdminUser() {
  try {
    const adminCount = await Admin.countDocuments();
    if (adminCount === 0) {
      const defaultUsername = (process.env.ADMIN_USERNAME || 'admin').toLowerCase().trim();
      const defaultPassword = process.env.ADMIN_PASSWORD || 'SaveHatke@Admin2024';

      const salt = await bcrypt.genSalt(10);
      const password_hash = await bcrypt.hash(defaultPassword, salt);

      await Admin.create({
        id: uuidv4(),
        full_name: 'Super Admin',
        email: `${defaultUsername}@savehatke.com`,
        password_hash,
        role: 'Super Admin',
        phone: '+919876543210',
        profile_image: '',
        is_active: true,
        email_verified: true,
        two_factor_enabled: false,
        last_login: null,
      });
      console.log(`👤 Initial Super Admin created in MongoDB: email="${defaultUsername}@savehatke.com"`);
    }
  } catch (e) {
    console.error('Error seeding admin user in MongoDB:', e.message);
  }
}

module.exports = { connectDB, isConnected: () => isConnected };

// ============================================
// SaveHatke — MongoDB Connection & Admin Seed
// ============================================

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
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
      const passwordHash = await bcrypt.hash(defaultPassword, salt);

      await Admin.create({
        username: defaultUsername,
        passwordHash,
        email: 'admin@savehatke.com',
        role: 'admin',
      });
      console.log(`👤 Initial Admin created in MongoDB: username="${defaultUsername}"`);
    }
  } catch (e) {
    console.error('Error seeding admin user in MongoDB:', e.message);
  }
}

module.exports = { connectDB, isConnected: () => isConnected };

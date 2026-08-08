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

    // Seed initial admin users into MongoDB
    await seedAdminUsers();
  } catch (err) {
    console.warn(`⚠️ MongoDB connection warning: ${err.message}. Admin auth will use fallback credentials if offline.`);
  }
}

async function seedAdminUsers() {
  try {
    const initialAdmins = [
      {
        name: 'Rupayan',
        email: 'rupayandas2024@gmail.com',
        rawPassword: 'Rupayan',
        role: 'Super Admin',
      },
      {
        name: 'Jaggik',
        email: 'jaggik8888@gmail.com',
        rawPassword: 'Jaggik',
        role: 'Super Admin',
      },
    ];

    for (const adminData of initialAdmins) {
      const existing = await Admin.findOne({ email: adminData.email.toLowerCase() });
      if (!existing) {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(adminData.rawPassword, salt);

        await Admin.create({
          id: uuidv4(),
          name: adminData.name,
          email: adminData.email.toLowerCase(),
          password_hash,
          role: adminData.role,
          phone: '',
          profile_image: '',
          is_active: true,
          email_verified: true,
          two_factor_enabled: false,
          last_login: null,
        });
        console.log(`👤 Seeded Admin in MongoDB: ${adminData.name} (${adminData.email})`);
      } else {
        // Ensure name and role are up to date if existing
        let updated = false;
        if (!existing.name && existing.full_name) {
          existing.name = existing.full_name;
          updated = true;
        }
        if (existing.name !== adminData.name) {
          existing.name = adminData.name;
          updated = true;
        }
        if (updated) {
          await existing.save();
          console.log(`🔄 Updated Admin details in MongoDB: ${adminData.name} (${adminData.email})`);
        }
      }
    }
  } catch (e) {
    console.error('Error seeding admin users in MongoDB:', e.message);
  }
}

module.exports = { connectDB, isConnected: () => isConnected };

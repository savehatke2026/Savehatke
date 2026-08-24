// ============================================
// SaveHatke — MongoDB Atlas Admin Seeding Script
// ============================================
// Reads from the project-root .env. The legacy server/.env was removed
// in favour of a single root .env, so we no longer need a fallback here.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const Admin = require('../models/Admin');

const defaultAdmins = [
  {
    name: 'Rupayan',
    email: 'rupayandas2024@gmail.com',
    password: 'Rupayan',
    role: 'Super Admin',
    phone: '',
    profile_image: '',
  },
  {
    name: 'Jaggik',
    email: 'jaggik8888@gmail.com',
    password: 'Jaggik',
    role: 'Super Admin',
    phone: '',
    profile_image: '',
  },
];

async function runSeed() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/savehatke';
  console.log(`Connecting to MongoDB Atlas... (${mongoUri.replace(/:([^@]+)@/, ':****@')})`);

  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 });
    console.log('✅ Connected to MongoDB Atlas successfully.');

    for (const adminData of defaultAdmins) {
      const existing = await Admin.findOne({ email: adminData.email.toLowerCase() });
      if (!existing) {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(adminData.password, salt);

        const newAdmin = await Admin.create({
          id: uuidv4(),
          name: adminData.name,
          email: adminData.email.toLowerCase(),
          password_hash,
          role: adminData.role,
          phone: adminData.phone,
          profile_image: adminData.profile_image,
          is_active: true,
          email_verified: true,
          two_factor_enabled: false,
          last_login: null,
        });

        console.log(`🎉 Created Admin: ${newAdmin.name} <${newAdmin.email}> (${newAdmin.role})`);
        console.log(`   ID: ${newAdmin.id} | DB _id: ${newAdmin._id}`);
      } else {
        existing.name = adminData.name;
        existing.role = adminData.role;
        await existing.save();
        console.log(`ℹ️ Admin already exists & updated: ${existing.name} <${existing.email}> (${existing.role})`);
      }
    }

    console.log('\n✨ Seeding completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding failed:', err.message);
    process.exit(1);
  }
}

runSeed();

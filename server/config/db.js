// ============================================
// SaveHatke — MongoDB Connection & Admin Seed
// ============================================

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const Admin = require('../models/Admin');

let isConnected = false;
let isConnecting = false;
let lastConnectAttemptAt = 0;

// Disable query buffering if MongoDB is disconnected
mongoose.set('bufferCommands', false);

// Reflect real connection state. readyState === 1 means "connected".
mongoose.connection.on('connected', () => {
  isConnected = true;
  console.log('🍃 MongoDB connection event: connected');
});
mongoose.connection.on('disconnected', () => {
  isConnected = false;
  console.warn('⚠️ MongoDB connection event: disconnected — will attempt to reconnect on the next call.');
});
mongoose.connection.on('reconnected', () => {
  isConnected = true;
  console.log('🍃 MongoDB connection event: reconnected');
});
mongoose.connection.on('error', (err) => {
  console.warn('⚠️ MongoDB connection event: error —', err.message);
});

async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    isConnected = true;
    return;
  }
  if (isConnecting) return; // a connect attempt is already in flight
  isConnecting = true;
  lastConnectAttemptAt = Date.now();

  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/savehatke';

  // Try up to 2 times with a short backoff. Atlas can be slow on the
  // first connect, especially right after a fresh IP whitelist.
  const attempts = [
    { serverSelectionTimeoutMS: 8000, label: 'first' },
    { serverSelectionTimeoutMS: 15000, label: 'second (after backoff)' },
  ];
  let lastErr = null;
  for (const [i, opts] of attempts.entries()) {
    try {
      const conn = await mongoose.connect(mongoUri, {
        ...opts,
        bufferCommands: false,
      });
      isConnected = true;
      console.log(`🍃 MongoDB Connected (${opts.label} attempt): ${conn.connection.host}/${conn.connection.name}`);

      // Seed initial admin users into MongoDB
      await seedAdminUsers();
      isConnecting = false;
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️ MongoDB ${opts.label} attempt failed: ${err.message}`);
      if (i < attempts.length - 1) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  isConnected = false;
  isConnecting = false;
  console.warn(
    `⚠️ MongoDB connection failed after ${attempts.length} attempts. ` +
    `Admin auth will use fallback credentials until Mongo is reachable. ` +
    `Last error: ${lastErr && lastErr.message}`,
  );
}

/**
 * Wait for MongoDB to be ready, up to `maxMs` milliseconds.
 * Returns true if ready, false if the timeout expired.
 * Used by routes that depend on Mongo (e.g. the backup-code flow) so
 * they can give a clear error instead of "service offline" if the
 * connection is mid-reconnect.
 */
async function waitForMongoReady(maxMs = 5000, pollMs = 150) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (mongoose.connection.readyState === 1) return true;
    if (!isConnecting && mongoose.connection.readyState === 0) {
      // Not connected and nobody is trying — kick off a connect in the
      // background and continue polling.
      connectDB().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return mongoose.connection.readyState === 1;
}

function isMongoReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
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

module.exports = {
  connectDB,
  isConnected: () => isConnected,
  isMongoReady,
  waitForMongoReady,
  lastConnectAttemptAt: () => lastConnectAttemptAt,
};

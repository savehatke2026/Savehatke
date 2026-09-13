// ============================================
// SaveHatke — Public Site Settings (cached)
// ============================================
// One shared reader for the two consumers of the public settings row: the
// /api/settings endpoint and the landing page, which renders its hero
// counters server-side so they are correct in the very first paint — no
// hardcoded-default flash and no waiting on a client-side fetch.
//
// getSettings() reads Google Sheets (plus the MongoDB overlay when
// connected) on every call — far too slow to repeat per landing-page view.
// The read below is cached for a short window; the admin settings save
// calls invalidatePublicSettings() so a changed counter value or toggle
// shows on the very next page load instead of after the TTL.

const mongoose = require('mongoose');
const db = require('./googleSheets');

let cache = null; // { data, at }
let pending = null; // single-flight: concurrent requests share one read
const TTL_MS = 30000;

async function readPublicSettings() {
  let settings = await db.getSettings();

  // MongoDB dual-sync: the admin panel writes Sheets and Mongo together.
  // When Mongo holds the row, prefer its values — same precedence the
  // /api/settings endpoint has always applied.
  if (mongoose.connection.readyState === 1) {
    try {
      const Setting = require('../models/Setting');
      const mongoSetting = await Setting.findOne({ key: 'site_settings' });
      if (mongoSetting) {
        settings = {
          ...settings,
          activeUsers: mongoSetting.activeUsers || settings.activeUsers,
          couponsTraded: mongoSetting.couponsTraded || settings.couponsTraded,
          savedByUsers: mongoSetting.savedByUsers || settings.savedByUsers,
          platformName: mongoSetting.platformName || settings.platformName,
          adminEmail: mongoSetting.adminEmail || settings.adminEmail,
          showActiveUsers: mongoSetting.showActiveUsers !== undefined ? mongoSetting.showActiveUsers : settings.showActiveUsers,
          showCouponsTraded: mongoSetting.showCouponsTraded !== undefined ? mongoSetting.showCouponsTraded : settings.showCouponsTraded,
          showSavedByUsers: mongoSetting.showSavedByUsers !== undefined ? mongoSetting.showSavedByUsers : settings.showSavedByUsers,
        };
      }
    } catch (e) { /* Mongo read failed — the Sheets values stand */ }
  }

  // Google Sheets stores toggles as 'true'/'false' strings; normalize to real
  // booleans so every consumer can compare strictly.
  const toBool = (v) => v === true || v === 'true';
  settings.showActiveUsers = toBool(settings.showActiveUsers);
  settings.showCouponsTraded = toBool(settings.showCouponsTraded);
  settings.showSavedByUsers = toBool(settings.showSavedByUsers);
  return settings;
}

/**
 * Cached public settings. Concurrent callers share one in-flight read, so a
 * burst of landing-page hits during a cold cache costs one Sheets read.
 */
async function getPublicSettings() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (pending) return pending;
  pending = readPublicSettings()
    .then((data) => { cache = { data, at: Date.now() }; return data; })
    .finally(() => { pending = null; });
  return pending;
}

/**
 * Drop the cache. Called after the admin settings save so the next landing
 * page render reflects the new values immediately.
 */
function invalidatePublicSettings() {
  cache = null;
}

/**
 * Render the three hero counters into the landing page HTML. Pure: takes the
 * file's markup plus settings, returns markup. Mirrors the client-side
 * loadDynamicHeroStats rules exactly — a counter shows when its toggle is on
 * AND it has a value; otherwise its wrapper is hidden. Replacement functions
 * are used throughout so an admin value like "$50" cannot corrupt the page
 * via String.replace's $-patterns. The data-ssr marker lets a deploy check
 * tell a server-rendered page from a statically served one.
 */
function renderLandingStats(html, s) {
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const stats = [
    { id: 'stat-active-users', value: s.activeUsers, show: s.showActiveUsers },
    { id: 'stat-coupons-traded', value: s.couponsTraded, show: s.showCouponsTraded },
    { id: 'stat-saved-by-users', value: s.savedByUsers, show: s.showSavedByUsers },
  ];
  for (const st of stats) {
    const visible = (st.show === true || st.show === 'true') && String(st.value || '').trim() !== '';
    if (visible) {
      html = html.replace(
        new RegExp('(id="' + st.id + '">)[^<]*(</div>)'),
        (m, a, b) => a + esc(String(st.value).trim()) + b
      );
    } else {
      // Same end-state the client-side loader would apply — the wrapper is
      // hidden from the first paint instead of flashing in and disappearing.
      html = html.replace(
        new RegExp('<div>(\\s*<div class="stat-val[^"]*" id="' + st.id + '">)'),
        (m, a) => '<div style="display:none">' + a
      );
    }
  }
  return html.replace('<div class="hero-stats">', '<div class="hero-stats" data-ssr="1">');
}

module.exports = {
  getPublicSettings,
  invalidatePublicSettings,
  renderLandingStats,
  TTL_MS,
};

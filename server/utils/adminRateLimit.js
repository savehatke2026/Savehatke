'use strict';

const rateLimit = require('express-rate-limit');
const { safeRateLimitHandler } = require('./rateLimit');

function verifiedAdminKey(req) {
  // These limiters are placed after authenticateToken + requireAdmin, so this
  // identity comes only from the server-validated session row.
  return String((req.user && req.user.email) || 'unresolved-admin').trim().toLowerCase();
}

function accountLimiter(max, message) {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    max,
    keyGenerator: verifiedAdminKey,
    standardHeaders: false,
    legacyHeaders: false,
    handler: safeRateLimitHandler(message),
  });
}

module.exports = {
  adminMutationLimiter: accountLimiter(60, 'Too many admin changes. Please wait before trying again.'),
  adminFinancialLimiter: accountLimiter(10, 'Too many financial actions. Please wait before trying again.'),
  adminBulkLimiter: accountLimiter(3, 'Too many bulk admin actions. Please wait before trying again.'),
  adminEmailLimiter: accountLimiter(10, 'Too many admin email actions. Please wait before trying again.'),
  adminOAuthLimiter: accountLimiter(6, 'Too many admin connection attempts. Please wait before trying again.'),
};

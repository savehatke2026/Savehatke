// ============================================
// SaveHatke — Auth Middleware
// ============================================

const jwt = require('jsonwebtoken');

function getJwtSecret() {
  return process.env.JWT_SECRET || 'savehatke_dev_secret_key';
}

/**
 * Middleware: Verify JWT token from Authorization header.
 * Attaches decoded user to req.user
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }
}

/**
 * Middleware: Verify the user is an admin.
 * Must be used AFTER authenticateToken.
 */
function requireAdmin(req, res, next) {
  const role = req.user?.role ? String(req.user.role).toLowerCase() : '';
  const isAdminRole = role === 'admin' || role === 'super admin' || role === 'support';
  if (!req.user || !isAdminRole) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

/**
 * Optional auth — attaches user if token present, but doesn't block.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    try {
      req.user = jwt.verify(token, getJwtSecret());
    } catch (err) {
      // Token invalid, continue without user
    }
  }
  next();
}

/**
 * Generate a JWT token for a user.
 */
function generateToken(payload, expiresIn = '7d') {
  return jwt.sign(payload, getJwtSecret(), { expiresIn });
}

module.exports = {
  authenticateToken,
  requireAdmin,
  optionalAuth,
  generateToken,
};

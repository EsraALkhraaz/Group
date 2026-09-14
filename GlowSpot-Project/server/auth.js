const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.GLOWSPOT_JWT_SECRET || 'glowspot-dev-secret-change-me';
if (!process.env.GLOWSPOT_JWT_SECRET) {
  console.warn('[glowspot] GLOWSPOT_JWT_SECRET not set — using an insecure default. Set it before deploying for real.');
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch (e) { return null; }
}

/** Express middleware: requires a valid bearer token with one of the given roles. */
function requireAuth(...roles) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = token && verifyToken(token);
    if (!payload || (roles.length && !roles.includes(payload.role))) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.auth = payload;
    next();
  };
}

module.exports = { signToken, verifyToken, requireAuth };

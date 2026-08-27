const jwt = require('jsonwebtoken');

/**
 * Reads the JWT from the httpOnly cookie (or Authorization header as a
 * fallback), verifies it, and attaches { id, email } to req.user.
 */
function requireAuth(req, res, next) {
  let token = req.cookies && req.cookies.token;

  if (!token) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      token = header.slice(7);
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.id, username: payload.username };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

module.exports = { requireAuth };

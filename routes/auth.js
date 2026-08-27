const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// Fixed synthetic id for the single admin account. Every record in the
// database (websites, social accounts, queue items, etc.) is scoped to
// this id, so nothing needs to change even if ADMIN_USERNAME is changed
// later - there is no "users" collection anymore.
const ADMIN_ID = '507f1f77bcf86cd799439011';

function signToken(username) {
  return jwt.sign({ id: ADMIN_ID, username }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
}

// Constant-time string compare so login can't be brute-forced via
// response-time differences.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length so the timing doesn't leak
    // the correct password's length either.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// POST /api/auth/login
// Single hard-coded admin account, credentials come from .env only.
// There is no /register route - accounts can't be self-created.
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const expectedUser = process.env.ADMIN_USERNAME;
    const expectedPass = process.env.ADMIN_PASSWORD;

    if (!expectedUser || !expectedPass) {
      console.error('ADMIN_USERNAME / ADMIN_PASSWORD are not set in .env');
      return res.status(500).json({ error: 'Login is not configured on the server yet' });
    }

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const validUser = safeEqual(String(username).trim(), expectedUser);
    const validPass = safeEqual(String(password), expectedPass);

    if (!validUser || !validPass) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = signToken(expectedUser);
    res.cookie('token', token, COOKIE_OPTIONS);
    return res.json({ user: { username: expectedUser } });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: 'Could not log in, please try again' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  return res.json({ user: { username: req.user.username } });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token', COOKIE_OPTIONS);
  return res.json({ message: 'Logged out' });
});

module.exports = router;

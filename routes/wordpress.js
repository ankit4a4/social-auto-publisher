const express = require('express');
const Website = require('../models/Website');
const { requireAuth } = require('../middleware/auth');
const { decrypt } = require('../utils/encryption');
const wordpressService = require('../services/wordpressService');

const router = express.Router();
router.use(requireAuth);

async function findOwnedWebsite(req, res) {
  const website = await Website.findOne({ _id: req.params.websiteId, userId: req.user.id }).select(
    '+encryptedPassword'
  );
  if (!website) {
    res.status(404).json({ error: 'Website not found' });
    return null;
  }
  return website;
}

// GET /api/wordpress/:websiteId/categories
router.get('/:websiteId/categories', async (req, res) => {
  try {
    const website = await findOwnedWebsite(req, res);
    if (!website) return;

    const appPassword = decrypt(website.encryptedPassword);
    const categories = await wordpressService.fetchCategories(
      website.url,
      website.username,
      appPassword
    );
    return res.json({ categories });
  } catch (err) {
    console.error('Fetch categories error:', err.message);
    return res.status(502).json({ error: err.message || 'Could not fetch categories' });
  }
});

// POST /api/wordpress/:websiteId/test - re-test an existing website's connection
router.post('/:websiteId/test', async (req, res) => {
  try {
    const website = await findOwnedWebsite(req, res);
    if (!website) return;

    const appPassword = decrypt(website.encryptedPassword);
    await wordpressService.testConnection(website.url, website.username, appPassword);

    website.status = 'connected';
    website.lastError = '';
    await website.save();

    return res.json({ message: 'Connection successful', status: 'connected' });
  } catch (err) {
    try {
      await Website.updateOne(
        { _id: req.params.websiteId, userId: req.user.id },
        { status: 'error', lastError: err.message }
      );
    } catch (_updateErr) {
      // Non-fatal - the connection test failure is the response that matters.
    }
    return res.status(502).json({ error: err.message || 'Connection test failed' });
  }
});

module.exports = router;

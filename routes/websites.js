const express = require('express');
const Website = require('../models/Website');
const SocialAccount = require('../models/SocialAccount');
const { requireAuth } = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/encryption');
const wordpressService = require('../services/wordpressService');

const router = express.Router();
router.use(requireAuth);

// Finds a website and confirms it belongs to the logged-in user.
// Returns null (and has already sent a response) if not found/owned.
async function findOwnedWebsiteOr404(req, res, { withPassword = false } = {}) {
  let query = Website.findOne({ _id: req.params.id, userId: req.user.id });
  if (withPassword) query = query.select('+encryptedPassword');
  const website = await query;
  if (!website) {
    res.status(404).json({ error: 'Website not found' });
    return null;
  }
  return website;
}

// GET /api/websites
router.get('/', async (req, res) => {
  try {
    const websites = await Website.find({ userId: req.user.id }).sort({ createdAt: -1 });
    return res.json({ websites });
  } catch (err) {
    console.error('List websites error:', err.message);
    return res.status(500).json({ error: 'Could not load websites' });
  }
});

// POST /api/websites - add + test-connect a new WordPress website
router.post('/', async (req, res) => {
  try {
    const { name, url, username, appPassword } = req.body || {};

    if (!name || !url || !username || !appPassword) {
      return res.status(400).json({
        error: 'Website name, URL, username, and application password are all required',
      });
    }

    let status = 'connected';
    let lastError = '';
    try {
      await wordpressService.testConnection(url, username, appPassword);
    } catch (err) {
      status = 'error';
      lastError = err.message;
    }

    const website = await Website.create({
      userId: req.user.id,
      name: name.trim(),
      url: wordpressService.normalizeUrl(url),
      username: username.trim(),
      encryptedPassword: encrypt(appPassword),
      status,
      lastError,
    });

    if (status === 'error') {
      return res.status(201).json({
        website,
        warning: `Website saved, but the connection test failed: ${lastError}`,
      });
    }

    return res.status(201).json({ website });
  } catch (err) {
    console.error('Add website error:', err.message);
    return res.status(500).json({ error: 'Could not add website' });
  }
});

// PUT /api/websites/:id - edit name/url/username/(optional) password
router.put('/:id', async (req, res) => {
  try {
    const website = await findOwnedWebsiteOr404(req, res);
    if (!website) return;

    const { name, url, username, appPassword } = req.body || {};

    if (name) website.name = name.trim();
    if (url) website.url = wordpressService.normalizeUrl(url);
    if (username) website.username = username.trim();

    if (appPassword) {
      website.encryptedPassword = encrypt(appPassword);
    }

    // Re-test the connection if any credential changed.
    if (url || username || appPassword) {
      const passwordToTest = appPassword || decrypt(
        (await Website.findById(website._id).select('+encryptedPassword')).encryptedPassword
      );
      try {
        await wordpressService.testConnection(website.url, website.username, passwordToTest);
        website.status = 'connected';
        website.lastError = '';
      } catch (err) {
        website.status = 'error';
        website.lastError = err.message;
      }
    }

    await website.save();
    return res.json({ website });
  } catch (err) {
    console.error('Update website error:', err.message);
    return res.status(500).json({ error: 'Could not update website' });
  }
});

// DELETE /api/websites/:id
router.delete('/:id', async (req, res) => {
  try {
    const website = await findOwnedWebsiteOr404(req, res);
    if (!website) return;

    const QueueItem = require('../models/QueueItem');
    await QueueItem.deleteMany({ websiteId: website._id });
    await website.deleteOne();

    return res.json({ message: 'Website deleted' });
  } catch (err) {
    console.error('Delete website error:', err.message);
    return res.status(500).json({ error: 'Could not delete website' });
  }
});

// PUT /api/websites/:id/settings - auto posting settings
router.put('/:id/settings', async (req, res) => {
  try {
    const website = await findOwnedWebsiteOr404(req, res);
    if (!website) return;

    const {
      categoryMode,
      categoryId,
      categoryName,
      latestArticleLimit,
      postingGapMinutes,
      dailyLimit,
      timezone,
      autoPostingEnabled,
    } = req.body || {};

    if (categoryMode && !['all', 'category'].includes(categoryMode)) {
      return res.status(400).json({ error: 'Invalid category mode' });
    }

    if (categoryMode) website.settings.categoryMode = categoryMode;
    if (categoryMode === 'all') {
      website.settings.categoryId = null;
      website.settings.categoryName = '';
    } else {
      if (categoryId !== undefined) website.settings.categoryId = categoryId;
      if (categoryName !== undefined) website.settings.categoryName = categoryName;
    }

    if (latestArticleLimit !== undefined) {
      const n = Number(latestArticleLimit);
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        return res.status(400).json({ error: 'Latest articles must be a number between 1 and 50' });
      }
      website.settings.latestArticleLimit = n;
    }

    if (postingGapMinutes !== undefined) {
      const n = Number(postingGapMinutes);
      if (!Number.isInteger(n) || n < 5) {
        return res.status(400).json({ error: 'Posting gap must be at least 5 minutes' });
      }
      website.settings.postingGapMinutes = n;
    }

    if (dailyLimit !== undefined) {
      const n = Number(dailyLimit);
      if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ error: 'Daily limit must be a positive number' });
      }
      website.settings.dailyLimit = n;
    }

    if (timezone) website.settings.timezone = timezone;
    if (autoPostingEnabled !== undefined) {
      website.settings.autoPostingEnabled = Boolean(autoPostingEnabled);
    }

    await website.save();
    return res.json({ website });
  } catch (err) {
    console.error('Update settings error:', err.message);
    return res.status(500).json({ error: 'Could not update settings' });
  }
});

// PUT /api/websites/:id/social-settings - which connected social accounts
// this website posts to (per platform on/off + which connected account).
const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'linkedin'];
const PLATFORM_ENUM = { facebook: 'FACEBOOK', instagram: 'INSTAGRAM', linkedin: 'LINKEDIN' };

router.put('/:id/social-settings', async (req, res) => {
  try {
    const website = await findOwnedWebsiteOr404(req, res);
    if (!website) return;

    const body = req.body || {};

    for (const platform of SOCIAL_PLATFORMS) {
      const incoming = body[platform];
      if (incoming === undefined) continue;

      const enabled = Boolean(incoming.enabled);
      let socialAccountId = incoming.socialAccountId || null;

      if (enabled && !socialAccountId) {
        return res.status(400).json({
          error: `Select a connected ${platform} account before turning it on`,
        });
      }

      if (socialAccountId) {
        // Ownership check - the account must belong to this user and match
        // the expected platform.
        // eslint-disable-next-line no-await-in-loop
        const account = await SocialAccount.findOne({
          _id: socialAccountId,
          userId: req.user.id,
          platform: PLATFORM_ENUM[platform],
        });
        if (!account) {
          return res.status(404).json({ error: `Connected ${platform} account not found` });
        }
      } else {
        socialAccountId = null;
      }

      website.settings.social[platform].enabled = enabled;
      website.settings.social[platform].socialAccountId = socialAccountId;
    }

    await website.save();
    return res.json({ website });
  } catch (err) {
    console.error('Update social settings error:', err.message);
    return res.status(500).json({ error: 'Could not update social settings' });
  }
});

module.exports = router;

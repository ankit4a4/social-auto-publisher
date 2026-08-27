const express = require('express');
const mongoose = require('mongoose');
const QueueItem = require('../models/QueueItem');
const Website = require('../models/Website');
const SocialPost = require('../models/SocialPost');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/queue?websiteId=&status=&limit=
router.get('/', async (req, res) => {
  try {
    const filter = { userId: req.user.id };

    if (req.query.websiteId) {
      filter.websiteId = req.query.websiteId;
    }
    if (req.query.status) {
      filter.status = req.query.status;
    }

    const limit = Math.min(Number(req.query.limit) || 25, 100);

    const items = await QueueItem.find(filter).sort({ scheduledAt: 1 }).limit(limit);

    // Attach each platform's own independent publishing result, so one
    // platform failing never hides another platform's success.
    const socialPosts = items.length
      ? await SocialPost.find({ queueItemId: { $in: items.map((i) => i._id) } })
      : [];

    const itemsWithSocial = items.map((item) => {
      const platforms = socialPosts
        .filter((p) => String(p.queueItemId) === String(item._id))
        .map((p) => ({ platform: p.platform, status: p.status, error: p.error }));
      return { ...item.toJSON(), socialPosts: platforms };
    });

    return res.json({ items: itemsWithSocial });
  } catch (err) {
    console.error('List queue error:', err.message);
    return res.status(500).json({ error: 'Could not load queue' });
  }
});

// GET /api/queue/status - summary used by the dashboard cards + detail page.
// Includes, per website, the next scheduled post time (for the live
// countdown timer) and a quick per-platform connected/enabled summary (for
// the "which social media is hooked up" badges on the dashboard cards).
router.get('/status', async (req, res) => {
  try {
    const websites = await Website.find({ userId: req.user.id });

    // The next post time is the earliest still-PENDING queue item's
    // scheduledAt for that website - that's the real, authoritative "next
    // post" moment (it's exactly what the scheduler will act on next).
    const nextItems = await QueueItem.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(req.user.id), status: 'PENDING' } },
      { $sort: { scheduledAt: 1 } },
      {
        $group: {
          _id: '$websiteId',
          nextPostAt: { $first: '$scheduledAt' },
        },
      },
    ]);
    const nextPostByWebsite = new Map(nextItems.map((n) => [String(n._id), n.nextPostAt]));

    const summary = websites.map((w) => {
      const social = w.settings.social || {};
      const socialSummary = {
        facebook: !!(social.facebook && social.facebook.enabled && social.facebook.socialAccountId),
        instagram: !!(social.instagram && social.instagram.enabled && social.instagram.socialAccountId),
        linkedin: !!(social.linkedin && social.linkedin.enabled && social.linkedin.socialAccountId),
      };

      return {
        websiteId: w._id,
        websiteName: w.name,
        autoPostingEnabled: w.settings.autoPostingEnabled,
        status: w.runtime.status,
        currentArticleTitle: w.runtime.currentArticleTitle,
        currentSocialPlatform: w.runtime.currentSocialPlatform,
        processedToday: w.runtime.processedToday,
        dailyLimit: w.settings.dailyLimit,
        postingGapMinutes: w.settings.postingGapMinutes,
        nextPostAt: nextPostByWebsite.get(String(w._id)) || null,
        lastRunAt: w.runtime.lastRunAt,
        connectionStatus: w.status,
        lastError: w.lastError,
        socialSummary,
      };
    });

    return res.json({ websites: summary });
  } catch (err) {
    console.error('Queue status error:', err.message);
    return res.status(500).json({ error: 'Could not load status' });
  }
});

module.exports = router;

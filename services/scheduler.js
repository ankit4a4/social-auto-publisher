const cron = require('node-cron');
const Website = require('../models/Website');
const QueueItem = require('../models/QueueItem');
const { decrypt } = require('../utils/encryption');
const wordpressService = require('./wordpressService');
const socialPublisher = require('./socialPublisher');

/**
 * Returns "today" as YYYY-MM-DD in the given IANA timezone, so the daily
 * counter resets correctly for each website's own timezone.
 */
function todayInTimezone(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch (err) {
    // Falls back to server local date if the timezone string is invalid.
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Processes a single website: fetches eligible articles, respects the
 * category / latest-article / daily-limit settings, skips duplicates, and
 * enqueues new articles spaced out by the configured posting gap.
 */
async function processWebsite(website) {
  const { settings } = website;
  const today = todayInTimezone(settings.timezone);

  // Reset the daily counter if this is a new day for the website.
  if (website.runtime.processedDate !== today) {
    website.runtime.processedDate = today;
    website.runtime.processedToday = 0;
  }

  const remainingToday = settings.dailyLimit - website.runtime.processedToday;
  if (remainingToday <= 0) {
    website.runtime.status = 'waiting';
    website.runtime.currentArticleTitle = '';
    await website.save();
    return;
  }

  website.runtime.status = 'fetching';
  await website.save();

  const fullWebsite = await Website.findById(website._id).select('+encryptedPassword');
  const appPassword = decrypt(fullWebsite.encryptedPassword);

  let posts;
  try {
    posts = await wordpressService.fetchLatestPosts(
      website.url,
      website.username,
      appPassword,
      {
        categoryId: settings.categoryMode === 'category' ? settings.categoryId : null,
        limit: settings.latestArticleLimit,
      }
    );
  } catch (err) {
    website.runtime.status = 'error';
    website.status = 'error';
    website.lastError = err.message;
    await website.save();
    return;
  }

  // Only take as many as the daily limit still allows.
  const candidates = posts.slice(0, remainingToday);

  // Figure out the next available slot, spaced by the posting gap, after
  // whatever is already scheduled for this website.
  const lastQueued = await QueueItem.findOne({ websiteId: website._id })
    .sort({ scheduledAt: -1 })
    .lean();

  let nextSlot = lastQueued && lastQueued.scheduledAt > new Date()
    ? new Date(lastQueued.scheduledAt)
    : new Date();

  const gapMs = settings.postingGapMinutes * 60 * 1000;
  let addedCount = 0;

  for (const post of candidates) {
    // Duplicate protection: skip if this WordPress post is already queued
    // or has already been processed for this website.
    // eslint-disable-next-line no-await-in-loop
    const exists = await QueueItem.findOne({
      websiteId: website._id,
      wordpressPostId: post.id,
    });
    if (exists) continue;

    try {
      // eslint-disable-next-line no-await-in-loop
      await QueueItem.create({
        userId: website.userId,
        websiteId: website._id,
        wordpressPostId: post.id,
        title: post.title,
        url: post.url,
        excerpt: post.excerpt,
        featuredImage: post.featuredImage,
        scheduledAt: nextSlot,
        status: 'PENDING',
      });
      addedCount += 1;
      website.runtime.processedToday += 1;
      nextSlot = new Date(nextSlot.getTime() + gapMs);
    } catch (err) {
      // Unique index violation means another process already queued this
      // exact article at the same moment - safe to ignore.
      if (err.code !== 11000) throw err;
    }

    if (website.runtime.processedToday >= settings.dailyLimit) break;
  }

  website.runtime.status = 'waiting';
  website.runtime.currentArticleTitle = candidates[0] ? candidates[0].title : '';
  website.runtime.lastRunAt = new Date();
  website.status = 'connected';
  website.lastError = '';
  await website.save();
}

/**
 * Runs one scheduling pass across every enabled, auto-posting website.
 */
async function runSchedulerOnce() {
  const websites = await Website.find({
    'settings.autoPostingEnabled': true,
    status: { $ne: 'error' },
  });

  for (const website of websites) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await processWebsite(website);
    } catch (err) {
      console.error(`Scheduler error for website ${website._id}:`, err.message);
    }
  }
}

/**
 * Finds queue items whose scheduled time has arrived and publishes them to
 * whichever social platforms their website has enabled. This is what
 * actually turns "Posting Gap" spacing into real, timed social posts.
 */
async function processDueSocialPosts() {
  const dueItems = await QueueItem.find({
    status: 'PENDING',
    scheduledAt: { $lte: new Date() },
  }).sort({ scheduledAt: 1 });

  for (const item of dueItems) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const website = await Website.findOne({ _id: item.websiteId, userId: item.userId });

      if (!website || !website.settings.autoPostingEnabled) {
        // Auto posting was turned off (or the website was deleted) after
        // this item was queued - leave it PENDING so it's picked up again
        // once auto posting is re-enabled, rather than silently dropping it.
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await socialPublisher.publishQueueItem(item, website);
    } catch (err) {
      console.error(`Social publish error for queue item ${item._id}:`, err.message);
      try {
        // eslint-disable-next-line no-await-in-loop
        item.status = 'FAILED';
        item.failureReason = err.message || 'Publishing failed';
        // eslint-disable-next-line no-await-in-loop
        await item.save();
      } catch (_saveErr) {
        // Non-fatal - move on to the next item.
      }
    }
  }
}

/**
 * Starts the recurring cron jobs.
 *  - Article discovery/enqueueing runs every 5 minutes.
 *  - Social publishing runs every minute so scheduled posting times
 *    (posting gap) are respected fairly precisely.
 */
function startScheduler() {
  cron.schedule('*/5 * * * *', () => {
    runSchedulerOnce().catch((err) => console.error('Scheduler run failed:', err.message));
  });

  cron.schedule('* * * * *', () => {
    processDueSocialPosts().catch((err) => console.error('Social publishing run failed:', err.message));
  });

  console.log('Scheduler started (articles every 5 minutes, social publishing every minute)');
}

module.exports = {
  startScheduler,
  runSchedulerOnce,
  processWebsite,
  processDueSocialPosts,
  todayInTimezone,
};

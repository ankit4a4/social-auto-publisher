const SocialAccount = require('../models/SocialAccount');
const SocialPost = require('../models/SocialPost');
const { decrypt } = require('../utils/encryption');
const facebookService = require('./facebookService');
const instagramService = require('./instagramService');
const linkedinService = require('./linkedinService');

const PLATFORM_LABELS = { FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', LINKEDIN: 'LinkedIn' };

/**
 * Publishes a single queued article to a single connected social account,
 * recording an independent SocialPost result. Never throws - failures are
 * captured as a FAILED SocialPost so one platform's failure never affects
 * another's.
 */
async function publishOne({ queueItem, website, platform, socialAccountId }) {
  // Duplicate protection: if this exact (queueItem, platform, account)
  // combination was already published successfully, skip it entirely.
  const existing = await SocialPost.findOne({
    queueItemId: queueItem._id,
    platform,
    socialAccountId,
  });
  if (existing && existing.status === 'PUBLISHED') {
    return existing;
  }

  const post =
    existing ||
    (await SocialPost.create({
      userId: queueItem.userId,
      websiteId: website._id,
      queueItemId: queueItem._id,
      platform,
      socialAccountId,
      status: 'PENDING',
    }));

  post.status = 'PROCESSING';
  await post.save();

  try {
    const account = await SocialAccount.findOne({ _id: socialAccountId, userId: queueItem.userId }).select(
      '+encryptedAccessToken'
    );
    if (!account) {
      throw new Error('Connected account no longer exists');
    }
    if (account.status !== 'connected') {
      throw new Error(account.lastError || 'Connected account is not in a usable state');
    }

    const accessToken = decrypt(account.encryptedAccessToken);
    const caption = queueItem.excerpt
      ? `${queueItem.title}\n\n${queueItem.excerpt}\n\n${queueItem.url}`
      : `${queueItem.title}\n\n${queueItem.url}`;

    let result;
    if (platform === 'FACEBOOK') {
      result = await facebookService.publishToPage(accessToken, account.accountId, {
        title: queueItem.title,
        url: queueItem.url,
        excerpt: queueItem.excerpt,
      });
    } else if (platform === 'INSTAGRAM') {
      result = await instagramService.publishToAccount(accessToken, account.accountId, {
        caption,
        imageUrl: queueItem.featuredImage,
      });
    } else if (platform === 'LINKEDIN') {
      result = await linkedinService.publishPost(accessToken, account.accountId, {
        title: queueItem.title,
        url: queueItem.url,
      });
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    post.status = 'PUBLISHED';
    post.externalPostId = result.externalPostId || '';
    post.error = '';
    post.publishedAt = new Date();
  } catch (err) {
    post.status = 'FAILED';
    post.error = err.message || 'Publishing failed';

    // If the account itself looks broken (expired/invalid token), reflect
    // that on the SocialAccount too, so the UI can prompt a reconnect.
    if (/expired|invalid|reconnect/i.test(post.error)) {
      await SocialAccount.updateOne(
        { _id: socialAccountId },
        { status: 'error', lastError: post.error }
      ).catch(() => {});
    }
  }

  await post.save();
  return post;
}

/**
 * Publishes one queue item to every platform the website has enabled,
 * updating the website's runtime status ("Publishing to Facebook...")
 * along the way. Always marks the queue item as processed afterwards -
 * per-platform results live independently in SocialPost.
 */
async function publishQueueItem(queueItem, website) {
  const social = website.settings.social || {};
  const enabledPlatforms = [
    social.facebook && social.facebook.enabled && social.facebook.socialAccountId
      ? { platform: 'FACEBOOK', socialAccountId: social.facebook.socialAccountId }
      : null,
    social.instagram && social.instagram.enabled && social.instagram.socialAccountId
      ? { platform: 'INSTAGRAM', socialAccountId: social.instagram.socialAccountId }
      : null,
    social.linkedin && social.linkedin.enabled && social.linkedin.socialAccountId
      ? { platform: 'LINKEDIN', socialAccountId: social.linkedin.socialAccountId }
      : null,
  ].filter(Boolean);

  if (enabledPlatforms.length === 0) {
    queueItem.status = 'COMPLETED';
    await queueItem.save();
    return;
  }

  queueItem.status = 'PROCESSING';
  await queueItem.save();

  website.runtime.status = 'publishing';
  website.runtime.currentArticleTitle = queueItem.title;

  for (const { platform, socialAccountId } of enabledPlatforms) {
    website.runtime.currentSocialPlatform = PLATFORM_LABELS[platform];
    // eslint-disable-next-line no-await-in-loop
    await website.save();
    // eslint-disable-next-line no-await-in-loop
    await publishOne({ queueItem, website, platform, socialAccountId });
  }

  website.runtime.currentSocialPlatform = '';
  website.runtime.status = 'waiting';
  await website.save();

  queueItem.status = 'COMPLETED';
  await queueItem.save();
}

module.exports = { publishQueueItem, publishOne };
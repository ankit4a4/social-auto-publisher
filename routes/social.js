const crypto = require('crypto');
const express = require('express');
const SocialAccount = require('../models/SocialAccount');
const OAuthSession = require('../models/OAuthSession');
const Website = require('../models/Website');
const { requireAuth } = require('../middleware/auth');
const { encrypt } = require('../utils/encryption');
const facebookService = require('../services/facebookService');
const linkedinService = require('../services/linkedinService');

const router = express.Router();
router.use(requireAuth);

function generateState() {
  return crypto.randomBytes(24).toString('hex');
}

// Looks up a pending "state" session by its state token alone (not by
// platform) - Meta only lets an app register a small, fixed set of OAuth
// redirect URIs, so /facebook/callback and /instagram/callback may both
// point at the same registered URI in practice. The session itself
// (created at /connect time) is what actually remembers whether this was
// a Facebook or an Instagram connection attempt, and which website (if
// any) the "Connect" button was clicked from.
async function consumeStateSession(userId, state) {
  const session = await OAuthSession.findOne({ userId, kind: 'state', state });
  if (!session) return null;
  const { platform, websiteId } = session;
  await session.deleteOne();
  return { platform, websiteId: websiteId || null };
}

// Confirms a websiteId (if provided) actually belongs to this user, so a
// Connect click always ends up wired to the right website - or is
// silently ignored rather than trusted blindly.
async function ownedWebsiteId(userId, websiteId) {
  if (!websiteId) return null;
  const website = await Website.findOne({ _id: websiteId, userId }).select('_id');
  return website ? website._id : null;
}

// After a SocialAccount is created/updated for a given platform, wires it
// straight into the website that the "Connect" button was clicked from
// (enabled + pointed at this account) so the person doesn't have to jump
// to a separate settings screen to finish the job.
async function autoAssignToWebsite(userId, websiteId, platformKey, account) {
  if (!websiteId) return null;
  const website = await Website.findOne({ _id: websiteId, userId });
  if (!website) return null;
  website.settings.social[platformKey].enabled = true;
  website.settings.social[platformKey].socialAccountId = account._id;
  await website.save();
  return website;
}

// ============================================================
// Shared account list / disconnect
// ============================================================

// GET /api/social/accounts
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await SocialAccount.find({ userId: req.user.id }).sort({ createdAt: -1 });
    return res.json({ accounts });
  } catch (err) {
    console.error('List social accounts error:', err.message);
    return res.status(500).json({ error: 'Could not load connected accounts' });
  }
});

// DELETE /api/social/accounts/:id
router.delete('/accounts/:id', async (req, res) => {
  try {
    const account = await SocialAccount.findOne({ _id: req.params.id, userId: req.user.id });
    if (!account) {
      return res.status(404).json({ error: 'Connected account not found' });
    }

    await account.deleteOne();

    // Turn off + unlink this account from every website that referenced it.
    const platformKey = account.platform.toLowerCase();
    await Website.updateMany(
      { userId: req.user.id, [`settings.social.${platformKey}.socialAccountId`]: account._id },
      {
        $set: {
          [`settings.social.${platformKey}.enabled`]: false,
          [`settings.social.${platformKey}.socialAccountId`]: null,
        },
      }
    );

    return res.json({ message: 'Disconnected' });
  } catch (err) {
    console.error('Disconnect social account error:', err.message);
    return res.status(500).json({ error: 'Could not disconnect account' });
  }
});

// ============================================================
// Facebook
// ============================================================

// GET /api/social/facebook/connect?websiteId=<id>
router.get('/facebook/connect', async (req, res) => {
  try {
    const websiteId = await ownedWebsiteId(req.user.id, req.query.websiteId);
    const state = generateState();
    await OAuthSession.create({ userId: req.user.id, platform: 'FACEBOOK', kind: 'state', state, websiteId });
    const url = facebookService.getAuthUrl(state);
    return res.redirect(url);
  } catch (err) {
    console.error('Facebook connect error:', err.message);
    return res.status(500).json({ error: err.message || 'Could not start Facebook connection' });
  }
});

// GET /api/social/facebook/callback
router.get('/facebook/callback', async (req, res) => {
  return handleMetaCallback(req, res);
});

// GET /api/social/instagram/connect?websiteId=<id> - same Meta login,
// since Instagram Business accounts are only reachable through a linked
// Facebook Page.
router.get('/instagram/connect', async (req, res) => {
  try {
    const websiteId = await ownedWebsiteId(req.user.id, req.query.websiteId);
    const state = generateState();
    await OAuthSession.create({ userId: req.user.id, platform: 'INSTAGRAM', kind: 'state', state, websiteId });
    const url = facebookService.getAuthUrl(state);
    return res.redirect(url);
  } catch (err) {
    console.error('Instagram connect error:', err.message);
    return res.status(500).json({ error: err.message || 'Could not start Instagram connection' });
  }
});

// GET /api/social/instagram/callback - handles the identical Meta OAuth
// response as /facebook/callback (see consumeStateSession above for why).
router.get('/instagram/callback', async (req, res) => {
  return handleMetaCallback(req, res);
});

async function handleMetaCallback(req, res) {
  let platform = null;
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      return res.redirect(`/index.html?social_error=${encodeURIComponent(String(oauthError))}`);
    }
    if (!code || !state) {
      return res.redirect('/index.html?social_error=Missing+OAuth+response');
    }

    const consumed = await consumeStateSession(req.user.id, state);
    if (!consumed) {
      return res.redirect('/index.html?social_error=Invalid+or+expired+login+attempt');
    }
    platform = consumed.platform;
    const { websiteId } = consumed;

    const { accessToken } = await facebookService.exchangeCodeForLongLivedToken(code);
    const pages = await facebookService.getEligiblePages(accessToken);

    if (pages.length === 0) {
      return res.redirect('/index.html?social_error=No+eligible+Facebook+Pages+found+for+this+account');
    }

    // Only expose what the picker needs; each page's own access token stays
    // encrypted and server-side until the user actually selects it.
    const choices = pages.map((p) => ({
      pageId: p.id,
      name: p.name,
      encryptedPageToken: encrypt(p.accessToken),
      instagramAccount: p.instagramAccount,
    }));

    await OAuthSession.deleteMany({ userId: req.user.id, platform, kind: 'selection' });
    await OAuthSession.create({
      userId: req.user.id,
      platform,
      websiteId,
      kind: 'selection',
      choices,
      // expiresIn from Facebook (seconds) is informational only here.
    });

    const redirectTarget = platform === 'INSTAGRAM' ? 'instagram-select' : 'facebook-select';
    const websiteParam = websiteId ? `&websiteId=${websiteId}` : '';
    return res.redirect(`/index.html?social=${redirectTarget}${websiteParam}`);
  } catch (err) {
    console.error(`${platform || 'Meta'} callback error:`, err.message);
    return res.redirect(`/index.html?social_error=${encodeURIComponent(err.message || 'Connection failed')}`);
  }
}

// GET /api/social/facebook/pending - Pages available to pick from.
router.get('/facebook/pending', async (req, res) => {
  try {
    const session = await OAuthSession.findOne({ userId: req.user.id, platform: 'FACEBOOK', kind: 'selection' });
    if (!session) return res.json({ pages: [] });

    const pages = session.choices.map((c) => ({
      pageId: c.pageId,
      name: c.name,
      hasInstagram: Boolean(c.instagramAccount),
    }));
    return res.json({ pages, websiteId: session.websiteId || null });
  } catch (err) {
    console.error('Facebook pending error:', err.message);
    return res.status(500).json({ error: 'Could not load Facebook Pages' });
  }
});

// GET /api/social/instagram/pending - only Pages with a linked IG account.
router.get('/instagram/pending', async (req, res) => {
  try {
    const session = await OAuthSession.findOne({
      userId: req.user.id,
      platform: { $in: ['FACEBOOK', 'INSTAGRAM'] },
      kind: 'selection',
    });
    if (!session) return res.json({ accounts: [] });

    const accounts = session.choices
      .filter((c) => c.instagramAccount)
      .map((c) => ({
        pageId: c.pageId,
        pageName: c.name,
        instagramUsername: c.instagramAccount.username,
      }));
    return res.json({ accounts, websiteId: session.websiteId || null });
  } catch (err) {
    console.error('Instagram pending error:', err.message);
    return res.status(500).json({ error: 'Could not load Instagram accounts' });
  }
});

// POST /api/social/facebook/select  { pageId, websiteId? }
router.post('/facebook/select', async (req, res) => {
  try {
    const { pageId } = req.body || {};
    if (!pageId) return res.status(400).json({ error: 'pageId is required' });

    const session = await OAuthSession.findOne({ userId: req.user.id, platform: 'FACEBOOK', kind: 'selection' });
    if (!session) {
      return res.status(400).json({ error: 'No pending Facebook connection - please connect again' });
    }

    const page = session.choices.find((c) => c.pageId === pageId);
    if (!page) {
      return res.status(404).json({ error: 'Selected Page was not found in this connection attempt' });
    }

    const account = await SocialAccount.findOneAndUpdate(
      { userId: req.user.id, platform: 'FACEBOOK', accountId: page.pageId },
      {
        userId: req.user.id,
        platform: 'FACEBOOK',
        accountId: page.pageId,
        accountName: page.name,
        username: '',
        encryptedAccessToken: page.encryptedPageToken,
        status: 'connected',
        lastError: '',
      },
      { upsert: true, new: true }
    );

    // Prefer the websiteId sent by the frontend, fall back to the one the
    // "Connect" click was originally made from.
    const websiteId = await ownedWebsiteId(req.user.id, req.body.websiteId || session.websiteId);
    const website = await autoAssignToWebsite(req.user.id, websiteId, 'facebook', account);

    return res.status(201).json({ account, website });
  } catch (err) {
    console.error('Facebook select error:', err.message);
    return res.status(500).json({ error: 'Could not save Facebook connection' });
  }
});

// POST /api/social/instagram/select  { pageId, websiteId? }
router.post('/instagram/select', async (req, res) => {
  try {
    const { pageId } = req.body || {};
    if (!pageId) return res.status(400).json({ error: 'pageId is required' });

    const session = await OAuthSession.findOne({
      userId: req.user.id,
      platform: { $in: ['FACEBOOK', 'INSTAGRAM'] },
      kind: 'selection',
    });
    if (!session) {
      return res.status(400).json({ error: 'No pending Instagram connection - please connect again' });
    }

    const page = session.choices.find((c) => c.pageId === pageId);
    if (!page || !page.instagramAccount) {
      return res.status(404).json({
        error: 'That Page does not have an eligible Instagram Professional/Business account linked',
      });
    }

    const account = await SocialAccount.findOneAndUpdate(
      { userId: req.user.id, platform: 'INSTAGRAM', accountId: page.instagramAccount.id },
      {
        userId: req.user.id,
        platform: 'INSTAGRAM',
        accountId: page.instagramAccount.id,
        accountName: page.name,
        username: page.instagramAccount.username || '',
        // Instagram publishing uses the linked Page's access token.
        encryptedAccessToken: page.encryptedPageToken,
        status: 'connected',
        lastError: '',
      },
      { upsert: true, new: true }
    );

    const websiteId = await ownedWebsiteId(req.user.id, req.body.websiteId || session.websiteId);
    const website = await autoAssignToWebsite(req.user.id, websiteId, 'instagram', account);

    return res.status(201).json({ account, website });
  } catch (err) {
    console.error('Instagram select error:', err.message);
    return res.status(500).json({ error: 'Could not save Instagram connection' });
  }
});

// ============================================================
// LinkedIn
// ============================================================

// GET /api/social/linkedin/connect?websiteId=<id>
router.get('/linkedin/connect', async (req, res) => {
  try {
    const websiteId = await ownedWebsiteId(req.user.id, req.query.websiteId);
    const state = generateState();
    await OAuthSession.create({ userId: req.user.id, platform: 'LINKEDIN', kind: 'state', state, websiteId });
    const url = linkedinService.getAuthUrl(state);
    return res.redirect(url);
  } catch (err) {
    console.error('LinkedIn connect error:', err.message);
    return res.status(500).json({ error: err.message || 'Could not start LinkedIn connection' });
  }
});

// GET /api/social/linkedin/callback
router.get('/linkedin/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      return res.redirect(`/index.html?social_error=${encodeURIComponent(String(oauthError))}`);
    }
    if (!code || !state) {
      return res.redirect('/index.html?social_error=Missing+OAuth+response');
    }

    const consumed = await consumeStateSession(req.user.id, state);
    if (!consumed) {
      return res.redirect('/index.html?social_error=Invalid+or+expired+login+attempt');
    }
    const { websiteId } = consumed;

    const { accessToken } = await linkedinService.exchangeCodeForToken(code);
    const profile = await linkedinService.getUserInfo(accessToken);
    const organizations = await linkedinService.getAdministeredOrganizations(accessToken);

    const encryptedToken = encrypt(accessToken);
    const choices = [
      { urn: profile.urn, name: profile.name, type: 'person', encryptedToken },
      ...organizations.map((org) => ({ urn: org.urn, name: org.name, type: 'organization', encryptedToken })),
    ];

    await OAuthSession.deleteMany({ userId: req.user.id, platform: 'LINKEDIN', kind: 'selection' });
    await OAuthSession.create({ userId: req.user.id, platform: 'LINKEDIN', websiteId, kind: 'selection', choices });

    const websiteParam = websiteId ? `&websiteId=${websiteId}` : '';
    return res.redirect(`/index.html?social=linkedin-select${websiteParam}`);
  } catch (err) {
    console.error('LinkedIn callback error:', err.message);
    return res.redirect(`/index.html?social_error=${encodeURIComponent(err.message || 'Connection failed')}`);
  }
});

// GET /api/social/linkedin/pending
router.get('/linkedin/pending', async (req, res) => {
  try {
    const session = await OAuthSession.findOne({ userId: req.user.id, platform: 'LINKEDIN', kind: 'selection' });
    if (!session) return res.json({ entities: [] });

    const entities = session.choices.map((c) => ({ urn: c.urn, name: c.name, type: c.type }));
    return res.json({ entities, websiteId: session.websiteId || null });
  } catch (err) {
    console.error('LinkedIn pending error:', err.message);
    return res.status(500).json({ error: 'Could not load LinkedIn accounts' });
  }
});

// POST /api/social/linkedin/select  { urn, websiteId? }
router.post('/linkedin/select', async (req, res) => {
  try {
    const { urn } = req.body || {};
    if (!urn) return res.status(400).json({ error: 'urn is required' });

    const session = await OAuthSession.findOne({ userId: req.user.id, platform: 'LINKEDIN', kind: 'selection' });
    if (!session) {
      return res.status(400).json({ error: 'No pending LinkedIn connection - please connect again' });
    }

    const entity = session.choices.find((c) => c.urn === urn);
    if (!entity) {
      return res.status(404).json({ error: 'Selected LinkedIn account was not found in this connection attempt' });
    }

    const account = await SocialAccount.findOneAndUpdate(
      { userId: req.user.id, platform: 'LINKEDIN', accountId: entity.urn },
      {
        userId: req.user.id,
        platform: 'LINKEDIN',
        accountId: entity.urn,
        accountName: entity.name,
        username: '',
        encryptedAccessToken: entity.encryptedToken,
        status: 'connected',
        lastError: '',
      },
      { upsert: true, new: true }
    );

    const websiteId = await ownedWebsiteId(req.user.id, req.body.websiteId || session.websiteId);
    const website = await autoAssignToWebsite(req.user.id, websiteId, 'linkedin', account);

    return res.status(201).json({ account, website });
  } catch (err) {
    console.error('LinkedIn select error:', err.message);
    return res.status(500).json({ error: 'Could not save LinkedIn connection' });
  }
});

module.exports = router;

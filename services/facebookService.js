const axios = require('axios');

const GRAPH_VERSION = 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Scopes needed to list Pages and publish to them, plus the Instagram
// scopes so the same "Connect Facebook" login can also surface eligible
// Instagram Business accounts (Instagram publishing goes through a
// connected Facebook Page, per Meta's official API).
const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_metadata',
  'business_management',
  'instagram_basic',
  'instagram_content_publish',
].join(',');

function assertConfigured() {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET || !process.env.META_REDIRECT_URI) {
    throw new Error('Facebook integration is not configured (missing META_APP_ID/META_APP_SECRET/META_REDIRECT_URI)');
  }
}

function getAuthUrl(state) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: process.env.META_REDIRECT_URI,
    state,
    scope: SCOPES,
    response_type: 'code',
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

// Exchanges the OAuth `code` for a short-lived user access token, then
// upgrades it to a long-lived one (per Meta's documented flow), and
// returns just the long-lived token.
async function exchangeCodeForLongLivedToken(code) {
  assertConfigured();

  const { data: shortLived } = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
    params: {
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri: process.env.META_REDIRECT_URI,
      code,
    },
  });

  const { data: longLived } = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: shortLived.access_token,
    },
  });

  return {
    accessToken: longLived.access_token,
    expiresIn: longLived.expires_in || null, // seconds
  };
}

// Returns the Pages the user manages, each with its own Page access token
// and (if linked) the connected Instagram Business account.
async function getEligiblePages(userAccessToken) {
  const { data } = await axios.get(`${GRAPH_BASE}/me/accounts`, {
    params: {
      access_token: userAccessToken,
      fields: 'id,name,access_token,instagram_business_account{id,username}',
    },
  });

  return (data.data || []).map((page) => ({
    id: page.id,
    name: page.name,
    accessToken: page.access_token,
    instagramAccount: page.instagram_business_account
      ? { id: page.instagram_business_account.id, username: page.instagram_business_account.username }
      : null,
  }));
}

// Publishes a link post (article title + URL) to a Facebook Page's feed.
async function publishToPage(pageAccessToken, pageId, { title, url }) {
  try {
    const { data } = await axios.post(`${GRAPH_BASE}/${pageId}/feed`, null, {
      params: {
        message: title,
        link: url,
        access_token: pageAccessToken,
      },
    });
    return { externalPostId: data.id };
  } catch (err) {
    throw new Error(describeMetaError(err));
  }
}

function describeMetaError(err) {
  const fbError = err.response && err.response.data && err.response.data.error;
  if (fbError) {
    if (fbError.code === 190) return 'Facebook access token expired or invalid - please reconnect';
    if (fbError.code === 200 || fbError.code === 10) return 'Missing Facebook permission for this action';
    if (fbError.error_subcode === 2069011) return 'This Facebook Page does not support automated posting';
    return fbError.message || 'Facebook API error';
  }
  if (err.code === 'ECONNABORTED') return 'Facebook API request timed out';
  return 'Could not reach the Facebook API';
}

module.exports = {
  getAuthUrl,
  exchangeCodeForLongLivedToken,
  getEligiblePages,
  publishToPage,
  describeMetaError,
};

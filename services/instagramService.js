const axios = require('axios');

const GRAPH_VERSION = 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Instagram publishing (for eligible Professional/Business accounts) goes
 * through the Instagram Graph API using the access token of the Facebook
 * Page the Instagram account is linked to - there is no separate
 * "Instagram login". Connection therefore reuses facebookService's OAuth
 * flow and Page list; this module only handles the two-step publish.
 *
 * Official flow:
 *   1. POST /{ig-user-id}/media       -> creates a media container
 *   2. POST /{ig-user-id}/media_publish -> publishes that container
 *
 * Image posts require a public image_url; Instagram does not support
 * plain link/text-only posts the way Facebook or LinkedIn do.
 */
async function publishToAccount(pageAccessToken, igUserId, { caption, imageUrl }) {
  if (!imageUrl) {
    const err = new Error(
      'This article has no featured image - Instagram requires an image to publish a post'
    );
    err.code = 'NO_IMAGE';
    throw err;
  }

  try {
    const { data: container } = await axios.post(`${GRAPH_BASE}/${igUserId}/media`, null, {
      params: {
        image_url: imageUrl,
        caption,
        access_token: pageAccessToken,
      },
    });

    const { data: published } = await axios.post(`${GRAPH_BASE}/${igUserId}/media_publish`, null, {
      params: {
        creation_id: container.id,
        access_token: pageAccessToken,
      },
    });

    return { externalPostId: published.id };
  } catch (err) {
    throw new Error(describeInstagramError(err));
  }
}

function describeInstagramError(err) {
  const igError = err.response && err.response.data && err.response.data.error;
  if (igError) {
    if (igError.code === 190) return 'Instagram access token expired or invalid - please reconnect';
    if (igError.code === 9007) return 'Instagram rejected the image (must be a public JPEG/PNG URL)';
    return igError.message || 'Instagram API error';
  }
  if (err.code === 'ECONNABORTED') return 'Instagram API request timed out';
  return 'Could not reach the Instagram API';
}

module.exports = { publishToAccount };

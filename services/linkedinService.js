const axios = require('axios');

const AUTH_BASE = 'https://www.linkedin.com/oauth/v2';
const API_BASE = 'https://api.linkedin.com/v2';

// w_member_social publishes as the person themself; the organization
// scopes are needed to discover and post as a Company Page the user
// administers. rw_organization_admin is what lets us list those orgs.
const SCOPES = ['openid', 'profile', 'w_member_social', 'w_organization_social', 'rw_organization_admin'].join(' ');

function assertConfigured() {
  if (
    !process.env.LINKEDIN_CLIENT_ID ||
    !process.env.LINKEDIN_CLIENT_SECRET ||
    !process.env.LINKEDIN_REDIRECT_URI
  ) {
    throw new Error(
      'LinkedIn integration is not configured (missing LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET/LINKEDIN_REDIRECT_URI)'
    );
  }
}

function getAuthUrl(state) {
  assertConfigured();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LINKEDIN_CLIENT_ID,
    redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
    state,
    scope: SCOPES,
  });
  return `${AUTH_BASE}/authorization?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  assertConfigured();
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
    client_id: process.env.LINKEDIN_CLIENT_ID,
    client_secret: process.env.LINKEDIN_CLIENT_SECRET,
  });

  const { data } = await axios.post(`${AUTH_BASE}/accessToken`, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in || null, // seconds
  };
}

async function getUserInfo(accessToken) {
  const { data } = await axios.get(`${API_BASE}/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return { urn: `urn:li:person:${data.sub}`, name: data.name || 'LinkedIn Profile' };
}

// Organizations (Company Pages) the user administers and can post to,
// per LinkedIn's official Community Management / Marketing API.
async function getAdministeredOrganizations(accessToken) {
  try {
    const { data } = await axios.get(`${API_BASE}/organizationAcls`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        q: 'roleAssignee',
        role: 'ADMINISTRATOR',
        projection: '(elements*(organization~(id,localizedName)))',
      },
    });

    return (data.elements || []).map((el) => ({
      urn: `urn:li:organization:${el['organization~'].id}`,
      name: el['organization~'].localizedName,
    }));
  } catch (err) {
    // Not every LinkedIn app/user has organization access approved - that's
    // fine, personal profile posting still works.
    return [];
  }
}

async function publishPost(accessToken, authorUrn, { title, url }) {
  const body = {
    author: authorUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: title },
        shareMediaCategory: 'ARTICLE',
        media: [
          {
            status: 'READY',
            originalUrl: url,
            title: { text: title },
          },
        ],
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };

  try {
    const { data, headers } = await axios.post(`${API_BASE}/ugcPosts`, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
    });
    const postId = (data && data.id) || headers['x-restli-id'] || '';
    return { externalPostId: postId };
  } catch (err) {
    throw new Error(describeLinkedInError(err));
  }
}

function describeLinkedInError(err) {
  const status = err.response && err.response.status;
  const message = err.response && err.response.data && err.response.data.message;
  if (status === 401) return 'LinkedIn access token expired or invalid - please reconnect';
  if (status === 403) return 'Missing LinkedIn permission for this account (check organization admin access)';
  if (status === 429) return 'LinkedIn API rate limit reached - will retry later';
  if (message) return `LinkedIn API error: ${message}`;
  if (err.code === 'ECONNABORTED') return 'LinkedIn API request timed out';
  return 'Could not reach the LinkedIn API';
}

module.exports = {
  getAuthUrl,
  exchangeCodeForToken,
  getUserInfo,
  getAdministeredOrganizations,
  publishPost,
};

const axios = require('axios');

/**
 * Normalizes a user-provided WordPress site URL into a clean base URL
 * with no trailing slash, e.g. "https://example.com/".
 */
function normalizeUrl(url) {
  return String(url).trim().replace(/\/+$/, '');
}

function buildClient(url, username, appPassword) {
  return axios.create({
    baseURL: `${normalizeUrl(url)}/wp-json/wp/v2`,
    timeout: 15000,
    auth: {
      username,
      password: appPassword,
    },
    headers: {
      Accept: 'application/json',
    },
  });
}

/**
 * Verifies that a WordPress site is reachable and that the given
 * Application Password credentials are valid, by requesting one post.
 * Throws a user-friendly Error on failure.
 */
async function testConnection(url, username, appPassword) {
  const client = buildClient(url, username, appPassword);

  try {
    await client.get('/posts', { params: { per_page: 1 } });
    return true;
  } catch (err) {
    throw new Error(describeWordPressError(err));
  }
}

/**
 * Fetches the list of categories from a WordPress site.
 */
async function fetchCategories(url, username, appPassword) {
  const client = buildClient(url, username, appPassword);

  try {
    const res = await client.get('/categories', {
      params: { per_page: 100, orderby: 'count', order: 'desc' },
    });
    return res.data.map((cat) => ({
      id: cat.id,
      name: cat.name,
      count: cat.count,
    }));
  } catch (err) {
    throw new Error(describeWordPressError(err));
  }
}

/**
 * Fetches the latest posts from a WordPress site, optionally filtered by
 * category, mapped down to only the fields the auto-poster needs.
 */
async function fetchLatestPosts(url, username, appPassword, { categoryId, limit } = {}) {
  const client = buildClient(url, username, appPassword);

  const params = {
    per_page: limit || 5,
    orderby: 'date',
    order: 'desc',
    _embed: 'wp:featuredmedia,wp:term',
  };

  if (categoryId) {
    params.categories = categoryId;
  }

  try {
    const res = await client.get('/posts', { params });
    return res.data.map(mapPost);
  } catch (err) {
    throw new Error(describeWordPressError(err));
  }
}

function mapPost(post) {
  let featuredImage = '';
  const media = post._embedded && post._embedded['wp:featuredmedia'];
  if (Array.isArray(media) && media[0] && media[0].source_url) {
    featuredImage = media[0].source_url;
  }

  let categories = [];
  const terms = post._embedded && post._embedded['wp:term'];
  if (Array.isArray(terms)) {
    const categoryTerms = terms.flat().filter((t) => t && t.taxonomy === 'category');
    categories = categoryTerms.map((t) => ({ id: t.id, name: t.name }));
  }

  return {
    id: post.id,
    title: stripHtml(post.title && post.title.rendered),
    url: post.link,
    excerpt: stripHtml(post.excerpt && post.excerpt.rendered).slice(0, 300),
    featuredImage,
    categories,
    publishedDate: post.date,
  };
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').trim();
}

function describeWordPressError(err) {
  if (err.response) {
    const status = err.response.status;
    if (status === 401 || status === 403) {
      return 'Invalid WordPress username or application password';
    }
    if (status === 404) {
      return 'WordPress REST API not found at this URL (check the site address)';
    }
    return `WordPress site responded with an error (status ${status})`;
  }
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
    return 'Could not resolve the WordPress URL - check that it is correct';
  }
  if (err.code === 'ECONNREFUSED' || err.code === 'ECONNABORTED') {
    return 'Could not reach the WordPress site (connection failed or timed out)';
  }
  return 'Could not connect to the WordPress site';
}

module.exports = {
  testConnection,
  fetchCategories,
  fetchLatestPosts,
  normalizeUrl,
};

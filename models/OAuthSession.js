const mongoose = require('mongoose');

/**
 * Two distinct uses, both short-lived:
 *
 * 1. "state" documents - created right before redirecting the user to the
 *    provider, used to validate the `state` query param on the callback
 *    (CSRF protection) and to know which logged-in user the callback
 *    belongs to.
 *
 * 2. "selection" documents - created after a successful OAuth callback,
 *    holding the encrypted user/page access token plus the list of
 *    eligible Pages/Accounts/Organizations so the frontend can render a
 *    picker. The frontend only ever sees the non-secret `choices` array;
 *    the encrypted token stays on the backend until the user makes a
 *    selection, at which point it is copied into a SocialAccount and this
 *    document is deleted.
 */
const oauthSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Which website this connection attempt was started from (the
    // "Connect" button lives inside a website's own detail page now), so
    // the callback knows which website to auto-assign the account to.
    // null means "connected from the general pool, not tied to a website".
    websiteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Website',
      default: null,
    },
    platform: {
      type: String,
      enum: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN'],
      required: true,
    },
    kind: {
      type: String,
      enum: ['state', 'selection'],
      required: true,
    },
    state: {
      type: String,
      default: null,
      index: true,
    },
    // Encrypted user access token (state kind doesn't use this).
    encryptedToken: {
      type: String,
      default: null,
      select: false,
    },
    choices: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      // TTL index - documents disappear on their own 15 minutes after
      // creation, so an abandoned OAuth attempt never lingers.
      expires: 900,
    },
  },
  { timestamps: false }
);

module.exports = mongoose.model('OAuthSession', oauthSessionSchema);

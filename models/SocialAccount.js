const mongoose = require('mongoose');

const socialAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN'],
      required: true,
    },
    // The external ID on the platform - a Facebook Page ID, an Instagram
    // Business Account ID, or a LinkedIn person/organization URN.
    accountId: {
      type: String,
      required: true,
    },
    accountName: {
      type: String,
      required: true,
      trim: true,
    },
    // Handle, e.g. an Instagram @username. Not all platforms have one.
    username: {
      type: String,
      default: '',
      trim: true,
    },
    // Encrypted long-lived / page access token. Never sent to the frontend.
    encryptedAccessToken: {
      type: String,
      required: true,
      select: false,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ['connected', 'expired', 'error'],
      default: 'connected',
    },
    lastError: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

// A user can only connect the same external account once per platform.
socialAccountSchema.index({ userId: 1, platform: 1, accountId: 1 }, { unique: true });

socialAccountSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.encryptedAccessToken;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('SocialAccount', socialAccountSchema);

const mongoose = require('mongoose');

const socialPostSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    websiteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Website',
      required: true,
      index: true,
    },
    queueItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QueueItem',
      required: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN'],
      required: true,
    },
    socialAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SocialAccount',
      required: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'],
      default: 'PENDING',
      index: true,
    },
    externalPostId: {
      type: String,
      default: '',
    },
    error: {
      type: String,
      default: '',
    },
    publishedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Duplicate protection at the DB level: one result per queue item, per
// platform, per connected account.
socialPostSchema.index({ queueItemId: 1, platform: 1, socialAccountId: 1 }, { unique: true });

socialPostSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('SocialPost', socialPostSchema);

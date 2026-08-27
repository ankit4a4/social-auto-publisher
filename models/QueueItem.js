const mongoose = require('mongoose');

const queueItemSchema = new mongoose.Schema(
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
    wordpressPostId: {
      type: Number,
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    excerpt: {
      type: String,
      default: '',
    },
    featuredImage: {
      type: String,
      default: '',
    },
    scheduledAt: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
      default: 'PENDING',
      index: true,
    },
    failureReason: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

// A given WordPress post on a given website should only ever occupy one
// queue slot - this is the duplicate-protection guarantee at the DB level.
queueItemSchema.index({ websiteId: 1, wordpressPostId: 1 }, { unique: true });

queueItemSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('QueueItem', queueItemSchema);

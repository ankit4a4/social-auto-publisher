const mongoose = require('mongoose');

const websiteSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    username: {
      type: String,
      required: true,
      trim: true,
    },
    // AES-encrypted WordPress Application Password. Never sent to the frontend.
    encryptedPassword: {
      type: String,
      required: true,
      select: false,
    },
    status: {
      type: String,
      enum: ['pending', 'connected', 'error'],
      default: 'pending',
    },
    lastError: {
      type: String,
      default: '',
    },

    // ---- Auto posting settings ----
    settings: {
      categoryMode: {
        type: String,
        enum: ['all', 'category'],
        default: 'all',
      },
      categoryId: {
        type: Number,
        default: null,
      },
      categoryName: {
        type: String,
        default: '',
      },
      latestArticleLimit: {
        type: Number,
        default: 5,
        min: 1,
        max: 50,
      },
      postingGapMinutes: {
        type: Number,
        default: 60,
        min: 5,
      },
      dailyLimit: {
        type: Number,
        default: 10,
        min: 1,
      },
      timezone: {
        type: String,
        default: 'Asia/Kolkata',
      },
      autoPostingEnabled: {
        type: Boolean,
        default: false,
      },

      // ---- Which connected social accounts this website posts to ----
      social: {
        facebook: {
          enabled: { type: Boolean, default: false },
          socialAccountId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'SocialAccount',
            default: null,
          },
        },
        instagram: {
          enabled: { type: Boolean, default: false },
          socialAccountId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'SocialAccount',
            default: null,
          },
        },
        linkedin: {
          enabled: { type: Boolean, default: false },
          socialAccountId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'SocialAccount',
            default: null,
          },
        },
      },
    },

    // ---- Runtime status, shown in the "Current Status" section ----
    runtime: {
      status: {
        type: String,
        enum: ['idle', 'fetching', 'waiting', 'publishing', 'error'],
        default: 'idle',
      },
      currentArticleTitle: {
        type: String,
        default: '',
      },
      // e.g. "FACEBOOK" while a post is actively being published, shown as
      // "Publishing to Facebook..." on the dashboard.
      currentSocialPlatform: {
        type: String,
        default: '',
      },
      processedToday: {
        type: Number,
        default: 0,
      },
      processedDate: {
        // Stored as YYYY-MM-DD in the website's timezone, used to reset
        // processedToday when a new day starts.
        type: String,
        default: '',
      },
      lastRunAt: {
        type: Date,
        default: null,
      },
    },
  },
  { timestamps: true }
);

websiteSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.encryptedPassword;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Website', websiteSchema);

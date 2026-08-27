require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const connectDB = require('./config/db');
const { startScheduler } = require('./services/scheduler');

const authRoutes = require('./routes/auth');
const websiteRoutes = require('./routes/websites');
const wordpressRoutes = require('./routes/wordpress');
const queueRoutes = require('./routes/queue');
const socialRoutes = require('./routes/social');

const app = express();

app.use(
  cors({
    origin: process.env.APP_URL || true,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// ---- API routes ----
app.use('/api/auth', authRoutes);
app.use('/api/websites', websiteRoutes);
app.use('/api/wordpress', wordpressRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/social', socialRoutes);

// ---- Static frontend (login.html + index.html only) ----
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.redirect('/index.html');
});

// ---- Centralized error handler (never leak stack traces) ----
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 5000;

async function start() {
  await connectDB();
  startScheduler();
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

start();

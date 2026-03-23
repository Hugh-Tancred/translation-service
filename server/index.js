require('dotenv').config({ override: false });

const express = require('express');
const path = require('path');
const uploadRoutes = require('./routes/upload');
const quoteRoutes = require('./routes/quote');
const statusRoutes = require('./routes/status');
const webhookRoutes = require('./routes/webhook');
const { startScheduler } = require('./services/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe webhook — must be before express.json()
app.use('/api/webhook', webhookRoutes);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve main page (must be before static middleware)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/trans-editor-website.html'));
});

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api/upload', uploadRoutes);
app.use('/api/quote', quoteRoutes);
app.use('/api/status', statusRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Beta access code verification
app.post('/api/verify-access', (req, res) => {
  const { code } = req.body;
  const validCode = process.env.BETA_ACCESS_CODE;

  if (!validCode) {
    return res.json({ valid: true });
  }

  if (code === validCode) {
    return res.json({ valid: true });
  }

  res.status(401).json({ valid: false, error: 'Invalid access code' });
});

app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/success.html'));
});

app.get('/cancel', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/trans-editor-website.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File size must be less than 10MB' });
  }

  if (err.message === 'Only PDF files are allowed') {
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({ error: 'An unexpected error occurred' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Translation service running on http://localhost:${PORT}`);

  if (process.env.NODE_ENV !== 'test') {
    startScheduler();
  }
});

module.exports = app;

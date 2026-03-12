const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const upload = require('../middleware/upload');
const { uploadFile } = require('../services/storage');
const { assessDocument } = require('../services/assessment');
const { generateQuote } = require('../services/quotation');
const { sendQuoteEmail } = require('../services/email');

const router = express.Router();

router.post('/', upload.single('document'), async (req, res) => {
  try {
    const { email, sourceLanguage } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }

    const orderId = uuidv4();
    const s3Key = `uploads/${orderId}/${req.file.originalname}`;

    // Upload to S3
    const mimeType = req.file.mimetype;
await uploadFile(s3Key, req.file.buffer, mimeType);

    // Assess document complexity (MVP: returns 1)
    const assessment = assessDocument(req.file.buffer, req.file.originalname);
const quote = generateQuote(assessment.wordCount);

    // Create order in database
    const stmt = db.prepare(`
      INSERT INTO orders (id, email, original_filename, source_language, s3_key_original, complexity_score, quote_amount, status, quoted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'quoted', CURRENT_TIMESTAMP)
    `);

    stmt.run(
      orderId,
      email,
      req.file.originalname,
      sourceLanguage || 'European Language',
      s3Key,
      assessment.complexityScore,
      quote.amount
    );

    // Get the created order
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

    // Send quote email
    await sendQuoteEmail(order);

    res.json({
      success: true,
      orderId,
      message: 'Document uploaded successfully. Please check your email for the quote.',
      quote: {
        amount: quote.amount,
        currency: quote.currency
      }
    });
  } catch (error) {
    console.error('Upload error:', error);

    if (error.message === 'Only PDF files are allowed') {
      return res.status(400).json({ error: error.message });
    }

    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size must be less than 10MB' });
    }

    res.status(500).json({ error: 'Failed to process upload. Please try again.' });
  }
});

module.exports = router;

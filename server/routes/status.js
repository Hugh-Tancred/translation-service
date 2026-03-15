const express = require('express');
const db = require('../config/database');
const { getPresignedUrl } = require('../services/storage');

const router = express.Router();

// Look up order by Stripe session ID (used by success page polling)
router.get('/session/:sessionId', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(req.params.sessionId);

    if (!order) {
      // Order not yet updated by webhook — still processing
      return res.json({ status: 'processing' });
    }

    const response = {
      orderId: order.id,
      status: order.status,
      filename: order.original_filename
    };

    if (order.status === 'delivered') {
      const s3Key = order.s3_key_word || order.s3_key_pdf || order.s3_key_translated;
      if (s3Key) {
        const baseName = order.original_filename.replace(/\.(pdf|docx)$/i, '');
        const isWord = s3Key.endsWith('.docx');
        const downloadName = isWord ? `${baseName}_EN.docx` : `${baseName}_EN.pdf`;
        response.downloadUrl = await getPresignedUrl(s3Key, 48 * 60 * 60, downloadName);
        response.filename = downloadName;
      }
    }

    res.json(response);
  } catch (error) {
    console.error('Get status by session error:', error);
    res.status(500).json({ error: 'Failed to retrieve order status' });
  }
});

// Look up order by order ID
router.get('/:orderId', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const response = {
      orderId: order.id,
      filename: order.original_filename,
      sourceLanguage: order.source_language,
      status: order.status,
      quoteAmount: order.quote_amount,
      createdAt: order.created_at,
      quotedAt: order.quoted_at,
      paidAt: order.paid_at,
      completedAt: order.completed_at,
      deliveredAt: order.delivered_at,
      expiresAt: order.expires_at
    };
    console.log(`Status check for ${order.id}: status=${order.status}, s3_key_translated=${order.s3_key_translated}, s3_key_pdf=${order.s3_key_pdf}`);
    if (order.status === 'delivered' && order.s3_key_translated) {
      const now = new Date();
      const expiresAt = new Date(order.expires_at);

      if (now < expiresAt) {
        const isWord = order.s3_key_translated.endsWith('.docx');
        const downloadExt = isWord ? '_EN.docx' : '_EN.pdf';
        const downloadFileName = order.original_filename.replace('.pdf', downloadExt);

        response.downloadUrl = await getPresignedUrl(
          order.s3_key_translated,
          48 * 60 * 60,
          downloadFileName
        );
        response.downloadExpiresAt = order.expires_at;
      } else {
        response.expired = true;
      }
    }

    res.json(response);
  } catch (error) {
    console.error('Get status error:', error);
    res.status(500).json({ error: 'Failed to retrieve order status' });
  }
});

module.exports = router;

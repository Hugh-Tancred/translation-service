const express = require('express');
const db = require('../config/database');
const { createCheckoutSession } = require('../services/stripe');
const { sendDeliveryEmail } = require('../services/email');
const { getPresignedUrl } = require('../services/storage');

const router = express.Router();

// Get quote details
router.get('/:orderId', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({
      orderId: order.id,
      filename: order.original_filename,
      sourceLanguage: order.source_language,
      quoteAmount: order.quote_amount,
      status: order.status,
      createdAt: order.created_at
    });
  } catch (error) {
    console.error('Get quote error:', error);
    res.status(500).json({ error: 'Failed to retrieve quote' });
  }
});

// Accept quote — either free mode bypass or Stripe Checkout
router.post('/:orderId/accept', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status !== 'quoted') {
      return res.status(400).json({
        error: `Order cannot be accepted. Current status: ${order.status}`
      });
    }

    const outputFormat = req.body.outputFormat || 'pdf';
    const deliveryEmail = req.body.deliveryEmail || null;

    // FREE MODE: bypass Stripe and process immediately
    if (process.env.FREE_MODE === 'true') {
      const { processTranslation } = require('../services/translation');
      db.prepare('UPDATE orders SET status = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('paid', order.id);

      try {
        await processTranslation(order.id, outputFormat);

        const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
        const finalS3Key = (outputFormat === 'word')
          ? updatedOrder.s3_key_word
          : updatedOrder.s3_key_pdf;
        const keyToUse = finalS3Key || updatedOrder.s3_key_translated;

        const baseName = updatedOrder.original_filename.replace(/\.(pdf|docx)$/i, '');
        const downloadName = outputFormat === 'word'
          ? `${baseName}_EN.docx`
          : `${baseName}_EN.pdf`;

        const downloadUrl = await getPresignedUrl(keyToUse, 48 * 60 * 60, downloadName);

        db.prepare('UPDATE orders SET status = ?, delivered_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run('delivered', order.id);

        const emailToUse = deliveryEmail || updatedOrder.email;
        if (emailToUse && emailToUse !== 'noemail@placeholder.com') {
          const emailOrder = { ...updatedOrder, email: emailToUse };
          sendDeliveryEmail(emailOrder, downloadUrl).catch(err => {
            console.error(`Failed to send delivery email for order ${order.id}:`, err);
          });
        }

        console.log(`Order ${order.id} completed in FREE MODE`);

        return res.json({
          success: true,
          orderId: order.id,
          message: 'Translation complete! Your document is ready to download.',
          status: 'delivered',
          downloadUrl,
          filename: downloadName
        });

      } catch (translationError) {
        console.error(`Translation failed for order ${order.id}:`, translationError);
        return res.status(500).json({
          error: 'Translation failed: ' + translationError.message,
          orderId: order.id
        });
      }
    }

    // PAID MODE: create Stripe Checkout session
    const session = await createCheckoutSession(order, outputFormat, deliveryEmail);
    res.json({ checkoutUrl: session.url });

  } catch (error) {
    console.error('Accept quote error:', error);
    res.status(500).json({ error: 'Failed to create payment session. Please try again.' });
  }
});

module.exports = router;

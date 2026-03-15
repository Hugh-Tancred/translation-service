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

// Accept quote — either promo code bypass or Stripe Checkout
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
    const promoCode = (req.body.promoCode || '').trim().toUpperCase();

    // PROMO MODE: valid promo code bypasses Stripe and processes immediately
    const validPromoCode = (process.env.PROMO_CODE || '').trim().toUpperCase();
    if (promoCode && promoCode === validPromoCode) {
      const { processTranslation } = require('../services/translation');
      // Mark as "paid"
      db.prepare('UPDATE orders SET status = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?').run('paid', order.id);

      try {
        // Wait for translation process to finish before responding
        await processTranslation(order.id, outputFormat);

        // Get updated order info after translation
        const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);

        const keyToUse = updatedOrder.s3_key_translated;

        const baseName = updatedOrder.original_filename.replace(/\.(pdf|docx)$/i, '');
        const downloadName = outputFormat === 'word'
          ? `${baseName}_EN.docx`
          : `${baseName}_EN.pdf`;

        const downloadUrl = await getPresignedUrl(keyToUse, 48 * 60 * 60, downloadName);

        db.prepare('UPDATE orders SET status = ?, delivered_at = CURRENT_TIMESTAMP WHERE id = ?').run('delivered', order.id);

        const emailToUse = deliveryEmail || updatedOrder.email;
        if (emailToUse && emailToUse !== 'noemail@placeholder.com') {
          const emailOrder = { ...updatedOrder, email: emailToUse };
          sendDeliveryEmail(emailOrder, downloadUrl).catch(err => {
            console.error(`Failed to send delivery email for order ${order.id}:`, err);
          });
        }

        console.log(`Order ${order.id} completed via promo code`);

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

    // Invalid promo code entered — reject before hitting Stripe
    if (promoCode && promoCode !== validPromoCode) {
      return res.status(400).json({ error: 'Invalid promo code.' });
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

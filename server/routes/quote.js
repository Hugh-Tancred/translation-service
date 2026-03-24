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

    // PROMO MODE: valid promo code bypasses Stripe
    const validPromoCode = (process.env.PROMO_CODE || '').trim().toUpperCase();
    if (promoCode && promoCode === validPromoCode) {
      const { processTranslation } = require('../services/translation');

      // Mark as paid immediately
      db.prepare('UPDATE orders SET status = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('paid', order.id);

      // [MONITORING] Job accepted via promo code
      console.log(`[QUOTE_ACCEPT_PROMO] orderId=${order.id} file=${order.original_filename} outputFormat=${outputFormat}`);

      // Fire translation in background — do not await
      processTranslation(order.id, outputFormat)
        .then(async () => {
          const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
          const keyToUse = updatedOrder.s3_key_translated;

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

          console.log(`Order ${order.id} completed via promo code`);
        })
        .catch(err => {
          console.error(`Promo translation failed for order ${order.id}:`, err);
        });

      // Respond immediately — frontend redirects to success page and polls by orderId
      return res.json({
        success: true,
        orderId: order.id,
        promoRedirectUrl: `${process.env.BASE_URL}/success?order_id=${order.id}`
      });
    }

    // Invalid promo code entered — reject before hitting Stripe
    if (promoCode && promoCode !== validPromoCode) {
      return res.status(400).json({ error: 'Invalid promo code.' });
    }

    // PAID MODE: create Stripe Checkout session
    const session = await createCheckoutSession(order, outputFormat, deliveryEmail);

    // [MONITORING] Job accepted via Stripe — checkout session created
    console.log(`[QUOTE_ACCEPT_STRIPE] orderId=${order.id} file=${order.original_filename} amount=€${order.quote_amount} outputFormat=${outputFormat}`);

    res.json({ checkoutUrl: session.url });

  } catch (error) {
    console.error(`[QUOTE_ACCEPT_FAIL] orderId=${req.params.orderId} error=${error.message}`);
    res.status(500).json({ error: 'Failed to create payment session. Please try again.' });
  }
});

module.exports = router;

const express = require('express');
const db = require('../config/database');
const { stripe } = require('../services/stripe');
const { processTranslation } = require('../services/translation');
const { sendDeliveryEmail } = require('../services/email');
const { getPresignedUrl } = require('../services/storage');

const router = express.Router();

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { orderId, outputFormat, deliveryEmail } = session.metadata;

    try {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!order) throw new Error(`Order ${orderId} not found`);

      // Mark as paid and save Stripe session ID for success page polling
      db.prepare('UPDATE orders SET status = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('paid', order.id);
      db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?')
        .run(session.id, order.id);

      // Store payment intent ID so translation pipeline can capture or cancel
      if (session.payment_intent) {
        db.prepare('UPDATE orders SET payment_intent_id = ? WHERE id = ?')
          .run(session.payment_intent, order.id);
      }

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

      console.log(`Order ${order.id} completed and delivered via webhook`);
    } catch (err) {
      console.error(`Webhook processing error for order ${orderId}:`, err);
    }
  }

  res.json({ received: true });
});

module.exports = router;

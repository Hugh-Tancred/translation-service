const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

async function createCheckoutSession(order, outputFormat, deliveryEmail) {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: {
          name: 'Document Translation',
          description: `${order.original_filename} → English`,
        },
        unit_amount: Math.round(order.quote_amount * 100),
      },
      quantity: 1,
    }],
    mode: 'payment',
    payment_intent_data: {
      capture_method: 'manual',
    },
    success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.BASE_URL}/cancel`,
    metadata: {
      orderId: String(order.id),
      outputFormat: outputFormat || 'pdf',
      deliveryEmail: deliveryEmail || '',
    },
  });
  return session;
}

async function capturePayment(paymentIntentId) {
  try {
    const intent = await stripe.paymentIntents.capture(paymentIntentId);
    console.log(`Payment captured: ${paymentIntentId}`);
    return intent;
  } catch (error) {
    console.error(`Payment capture failed: ${paymentIntentId}`, error.message);
    throw error;
  }
}

async function cancelPayment(paymentIntentId) {
  try {
    const intent = await stripe.paymentIntents.cancel(paymentIntentId);
    console.log(`Payment cancelled: ${paymentIntentId}`);
    return intent;
  } catch (error) {
    console.error(`Payment cancel failed: ${paymentIntentId}`, error.message);
    // Log but don't throw — translation already failed, don't mask that error
  }
}

module.exports = { createCheckoutSession, capturePayment, cancelPayment, stripe };
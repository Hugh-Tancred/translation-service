const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

async function createCheckoutSession(order, outputFormat, deliveryEmail) {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'gbp',
        product_data: {
          name: 'Document Translation',
          description: `${order.original_filename} → English`,
        },
        unit_amount: Math.round(order.quote_amount * 100), // pence
      },
      quantity: 1,
    }],
    mode: 'payment',
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

module.exports = { createCheckoutSession, stripe };

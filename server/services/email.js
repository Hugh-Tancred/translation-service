const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;
const BASE_URL = process.env.BASE_URL;

async function sendQuoteEmail(order) {
  const quoteUrl = `${BASE_URL}/quote.html?id=${order.id}`;

  const msg = {
    to: order.email,
    from: FROM_EMAIL,
    subject: 'Your Translation Quote - €10.00',
    html: `
      <h2>Translation Quote</h2>
      <p>Thank you for submitting your document for translation.</p>

      <h3>Order Details</h3>
      <ul>
        <li><strong>Document:</strong> ${order.original_filename}</li>
        <li><strong>Source Language:</strong> ${order.source_language || 'European Language'}</li>
        <li><strong>Target Language:</strong> English</li>
        <li><strong>Quote Amount:</strong> €${order.quote_amount.toFixed(2)}</li>
      </ul>

      <p><a href="${quoteUrl}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 6px;">Accept Quote & Start Translation</a></p>

      <p style="color: #666; font-size: 12px; margin-top: 24px;">
        <strong>Note:</strong> This is an AI-powered translation service. While we strive for accuracy,
        AI translations may contain errors. Please review the translated document carefully.
      </p>
    `
  };

  await sgMail.send(msg);
}

async function sendDeliveryEmail(order, downloadUrl) {
  const msg = {
    to: order.email,
    from: FROM_EMAIL,
    subject: 'Your Translated Document is Ready',
    html: `
      <h2>Translation Complete!</h2>
      <p>Your document has been translated and is ready for download.</p>

      <h3>Order Details</h3>
      <ul>
        <li><strong>Original Document:</strong> ${order.original_filename}</li>
        <li><strong>Source Language:</strong> ${order.source_language || 'European Language'}</li>
        <li><strong>Target Language:</strong> English</li>
      </ul>

      <p><a href="${downloadUrl}" style="display: inline-block; padding: 12px 24px; background-color: #16a34a; color: white; text-decoration: none; border-radius: 6px;">Download Translated Document</a></p>

      <p style="color: #dc2626; font-weight: bold;">This download link will expire in 48 hours.</p>

      <p style="color: #666; font-size: 12px; margin-top: 24px;">
        <strong>Important:</strong> This translation was generated using AI technology.
        While we strive for accuracy, AI translations may contain errors or miss nuances
        present in the original document. We recommend reviewing the translation carefully,
        especially for legal, medical, or other critical documents.
      </p>
    `
  };

  await sgMail.send(msg);
}

module.exports = { sendQuoteEmail, sendDeliveryEmail };

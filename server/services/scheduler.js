const cron = require('node-cron');
const db = require('../config/database');
const { deleteFile } = require('./storage');

function startScheduler() {
  // Run every hour to check for expired orders
  cron.schedule('0 * * * *', async () => {
    console.log('Running cleanup job...');
    await cleanupExpiredOrders();
  });

  console.log('Scheduler started - cleanup runs every hour');
}

async function cleanupExpiredOrders() {
  const now = new Date().toISOString();

  // Find expired orders that haven't been cleaned up
  const expiredOrders = db.prepare(`
    SELECT * FROM orders
    WHERE expires_at < ? AND status = 'delivered'
  `).all(now);

  for (const order of expiredOrders) {
    try {
      // Delete files from S3
      if (order.s3_key_original) {
        await deleteFile(order.s3_key_original);
      }
      if (order.s3_key_translated) {
        await deleteFile(order.s3_key_translated);
      }

      // Mark order as expired
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('expired', order.id);

      console.log(`Cleaned up expired order: ${order.id}`);
    } catch (error) {
      console.error(`Failed to cleanup order ${order.id}:`, error);
    }
  }

  return expiredOrders.length;
}

module.exports = { startScheduler, cleanupExpiredOrders };

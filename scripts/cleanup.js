/**
 * Manual cleanup script for expired orders
 * Run with: npm run cleanup
 */

require('dotenv').config();

const { cleanupExpiredOrders } = require('../server/services/scheduler');

async function main() {
  console.log('Starting manual cleanup...');

  try {
    const count = await cleanupExpiredOrders();
    console.log(`Cleanup complete. ${count} orders processed.`);
  } catch (error) {
    console.error('Cleanup failed:', error);
    process.exit(1);
  }

  process.exit(0);
}

main();

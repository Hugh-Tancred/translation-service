const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../../data.json');

// Simple JSON file-based database for MVP
class SimpleDB {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { orders: [] };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf8');
        this.data = JSON.parse(content);
      }
    } catch (error) {
      console.error('Database load error, starting fresh:', error.message);
      this.data = { orders: [] };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  prepare(sql) {
    const self = this;
    const sqlLower = sql.toLowerCase().trim();

    return {
      run(...params) {
        if (sqlLower.startsWith('insert into orders')) {
          const order = {
            id: params[0],
            email: params[1],
            original_filename: params[2],
            source_language: params[3],
            s3_key_original: params[4],
            s3_key_translated: null,
            s3_key_pdf: null,
            s3_key_word: null,
            requested_format: 'pdf',
            complexity_score: params[5],
            quote_amount: params[6],
            stripe_session_id: null,
            payment_intent_id: null,
            status: 'quoted',
            created_at: new Date().toISOString(),
            quoted_at: new Date().toISOString(),
            paid_at: null,
            completed_at: null,
            delivered_at: null,
            expires_at: null
          };
          self.data.orders.push(order);
          self.save();
          return { changes: 1 };
        }

        if (sqlLower.startsWith('update orders')) {
          const orderId = params[params.length - 1];
          const order = self.data.orders.find(o => o.id === orderId);
          if (order) {
            if (sqlLower.includes('stripe_session_id')) {
              order.stripe_session_id = params[0];
            } else if (sqlLower.includes('payment_intent_id')) {
              order.payment_intent_id = params[0];
            } else if (sqlLower.includes('status = ?') && sqlLower.includes('paid_at')) {
              order.status = params[0];
              order.paid_at = new Date().toISOString();
            } else if (sqlLower.includes('status = ?') && sqlLower.includes('delivered_at')) {
              order.status = params[0];
              order.delivered_at = new Date().toISOString();
            } else if (sqlLower.includes('s3_key_translated')) {
              order.s3_key_translated = params[0];
order.status = params[1];
order.completed_at = new Date().toISOString();
order.expires_at = params[2];
            } else if (sqlLower.includes('status = ?')) {
              order.status = params[0];
            }
            self.save();
            return { changes: 1 };
          }
          return { changes: 0 };
        }

        return { changes: 0 };
      },

      get(...params) {
        if (sqlLower.includes('where stripe_session_id = ?')) {
          return self.data.orders.find(o => o.stripe_session_id === params[0]) || null;
        }
        if (sqlLower.includes('from orders where id = ?')) {
          return self.data.orders.find(o => o.id === params[0]) || null;
        }
        return null;
      },

      all(...params) {
        if (sqlLower.includes('from orders')) {
          if (sqlLower.includes('expires_at < ?') && sqlLower.includes("status = 'delivered'")) {
            const now = params[0];
            return self.data.orders.filter(o =>
              o.expires_at && o.expires_at < now && o.status === 'delivered'
            );
          }
          return self.data.orders;
        }
        return [];
      }
    };
  }

  exec() {}
  pragma() {}
}

const db = new SimpleDB(dbPath);

module.exports = db;

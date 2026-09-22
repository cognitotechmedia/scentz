'use strict';

// One atomic upgrade. Historical royalty terms cannot be reconstructed: freeze
// the currently configured rate, mark it as a legacy baseline, and disclose it.
module.exports = function upgrade(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get('2026-09-controls-1')) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE customers ADD COLUMN buyer_outlet_id INTEGER REFERENCES outlets(id);
      ALTER TABLE sales ADD COLUMN buyer_outlet_id INTEGER REFERENCES outlets(id);
      ALTER TABLE sales ADD COLUMN royalty_pct REAL NOT NULL DEFAULT 0;
      ALTER TABLE sales ADD COLUMN royalty_legacy INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE credit_notes ADD COLUMN royalty_pct REAL NOT NULL DEFAULT 0;
      ALTER TABLE payments ADD COLUMN linked_payment_id INTEGER REFERENCES payments(id);
      CREATE UNIQUE INDEX ux_payment_mirror ON payments(linked_payment_id) WHERE linked_payment_id IS NOT NULL;
      ALTER TABLE expenses ADD COLUMN voided_at TEXT;
      ALTER TABLE expenses ADD COLUMN voided_by INTEGER REFERENCES users(id);
      ALTER TABLE expenses ADD COLUMN void_reason TEXT;
      UPDATE sales SET royalty_pct = COALESCE((SELECT royalty_pct FROM outlets WHERE outlets.id = sales.outlet_id), 0), royalty_legacy = 1;
      UPDATE credit_notes SET royalty_pct = COALESCE((SELECT royalty_pct FROM sales WHERE sales.id = credit_notes.sale_id), 0);
      UPDATE sales SET buyer_outlet_id = (SELECT outlet_id FROM purchases WHERE source_sale_id = sales.id)
        WHERE EXISTS (SELECT 1 FROM purchases WHERE source_sale_id = sales.id);
      CREATE INDEX ix_sales_buyer ON sales(buyer_outlet_id);
      CREATE TABLE sale_requests (
        user_id INTEGER NOT NULL, outlet_id INTEGER NOT NULL, request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(user_id, outlet_id, request_id)
      );
      CREATE TABLE closing_history (
        id INTEGER PRIMARY KEY, closing_id TEXT NOT NULL UNIQUE, outlet_id INTEGER NOT NULL,
        day TEXT NOT NULL, snapshot TEXT NOT NULL, reopened_at TEXT NOT NULL,
        reopened_by INTEGER NOT NULL, reason TEXT NOT NULL
      );
      CREATE TABLE audit_context (id INTEGER PRIMARY KEY CHECK(id = 1), actor_id INTEGER, action TEXT NOT NULL);
      INSERT INTO audit_context VALUES (1, NULL, 'startup');
      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY, occurred_at TEXT NOT NULL, actor_id INTEGER,
        action TEXT NOT NULL, entity TEXT NOT NULL, operation TEXT NOT NULL,
        before_json TEXT, after_json TEXT
      );
      CREATE INDEX ix_audit_time ON audit_events(occurred_at);
      CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'Audit history is append-only'); END;
      CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'Audit history is append-only'); END;
      CREATE TRIGGER closing_history_no_update BEFORE UPDATE ON closing_history BEGIN SELECT RAISE(ABORT, 'Closing history is append-only'); END;
      CREATE TRIGGER closing_history_no_delete BEFORE DELETE ON closing_history BEGIN SELECT RAISE(ABORT, 'Closing history is append-only'); END;
    `);
    // Capture database changes, including prices and user roles, in the same
    // transaction as the operation. Never include passwords or session tokens.
    const tables = ['outlets', 'users', 'settings', 'materials', 'products', 'outlet_stock', 'stock_ledger', 'customers', 'sales', 'purchases', 'payments', 'transfers', 'royalty_payments', 'credit_notes', 'formulas', 'formula_versions', 'production_runs', 'stock_counts', 'expenses', 'vouchers', 'day_closings', 'closing_history', 'loyalty_ledger', 'salesmen'];
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).filter(c => !['salt', 'hash'].includes(c));
      const json = prefix => `json_object(${columns.map(c => `'${c}', ${prefix}."${c}"`).join(', ')})`;
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        db.exec(`CREATE TRIGGER audit_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
          INSERT INTO audit_events(occurred_at, actor_id, action, entity, operation, before_json, after_json)
          VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'), (SELECT actor_id FROM audit_context WHERE id=1),
          (SELECT action FROM audit_context WHERE id=1), '${table}', '${operation}',
          ${operation === 'INSERT' ? 'NULL' : json('OLD')}, ${operation === 'DELETE' ? 'NULL' : json('NEW')}); END`);
      }
    }
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run('2026-09-controls-1', new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
};

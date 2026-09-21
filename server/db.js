'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, process.env.DB_FILE || 'velour.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS outlets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('hq', 'franchise')),
  gstin TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  royalty_pct REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'biller')),
  outlet_id INTEGER REFERENCES outlets(id),
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type TEXT NOT NULL,
  art TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  default_alert REAL NOT NULL DEFAULT 50
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type TEXT NOT NULL,
  price REAL NOT NULL,
  gst_rate REAL NOT NULL DEFAULT 18,
  cost REAL NOT NULL DEFAULT 0,
  category TEXT NOT NULL,
  art TEXT NOT NULL,
  format TEXT NOT NULL,
  signature INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS outlet_stock (
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  material_id TEXT NOT NULL REFERENCES materials(id),
  stock REAL NOT NULL DEFAULT 0,
  cost_per_ml REAL NOT NULL DEFAULT 0,
  alert_ml REAL NOT NULL DEFAULT 50,
  PRIMARY KEY (outlet_id, material_id)
);
CREATE TABLE IF NOT EXISTS stock_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outlet_id INTEGER NOT NULL,
  material_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  ref TEXT,
  note TEXT,
  effective_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_ledger ON stock_ledger (outlet_id, material_id);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  UNIQUE (outlet_id, phone)
);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  day TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  tax_mode TEXT NOT NULL,
  subtotal REAL NOT NULL, discount REAL NOT NULL, taxable REAL NOT NULL,
  cgst REAL NOT NULL, sgst REAL NOT NULL, round_off REAL NOT NULL, total REAL NOT NULL,
  lines TEXT NOT NULL,
  created_by INTEGER,
  UNIQUE (outlet_id, number)
);
CREATE INDEX IF NOT EXISTS ix_sales_outlet ON sales (outlet_id, day);
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  number TEXT NOT NULL,
  supplier TEXT NOT NULL,
  invoice_no TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  total REAL NOT NULL,
  lines TEXT NOT NULL,
  created_by INTEGER,
  UNIQUE (outlet_id, number)
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('sale', 'purchase')),
  ref_id TEXT NOT NULL,
  outlet_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  mode TEXT NOT NULL,
  amount REAL NOT NULL,
  created_by INTEGER
);
CREATE INDEX IF NOT EXISTS ix_payments ON payments (kind, ref_id);
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  from_outlet INTEGER NOT NULL REFERENCES outlets(id),
  to_outlet INTEGER NOT NULL REFERENCES outlets(id),
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_transit', 'received', 'cancelled')),
  lines TEXT NOT NULL,
  value REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  received_by INTEGER,
  received_at TEXT
);
CREATE TABLE IF NOT EXISTS royalty_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  mode TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER
);
CREATE TABLE IF NOT EXISTS counters (scope TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS credit_notes (
  id TEXT PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  day TEXT NOT NULL,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  sale_number TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  reason TEXT NOT NULL,
  taxable REAL NOT NULL, cgst REAL NOT NULL, sgst REAL NOT NULL, round_off REAL NOT NULL, total REAL NOT NULL,
  refund REAL NOT NULL DEFAULT 0,
  refund_mode TEXT NOT NULL DEFAULT '',
  lines TEXT NOT NULL,
  created_by INTEGER,
  UNIQUE (outlet_id, number)
);
CREATE INDEX IF NOT EXISTS ix_cn_sale ON credit_notes (sale_id);
CREATE TABLE IF NOT EXISTS formulas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('signature', 'rnd')),
  product_id TEXT REFERENCES products(id),
  status TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  target_price REAL NOT NULL DEFAULT 0,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by INTEGER
);
CREATE TABLE IF NOT EXISTS formula_versions (
  formula_id TEXT NOT NULL REFERENCES formulas(id),
  version INTEGER NOT NULL,
  unit_ml REAL NOT NULL,
  lines TEXT NOT NULL,
  pack TEXT,
  notes TEXT NOT NULL DEFAULT '',
  rating INTEGER,
  created_at TEXT NOT NULL,
  created_by INTEGER,
  PRIMARY KEY (formula_id, version)
);
CREATE TABLE IF NOT EXISTS production_runs (
  id TEXT PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  number TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('batch', 'sample')),
  formula_id TEXT NOT NULL REFERENCES formulas(id),
  formula_name TEXT NOT NULL,
  version INTEGER NOT NULL,
  product_id TEXT,
  product_name TEXT NOT NULL DEFAULT '',
  units INTEGER NOT NULL,
  date TEXT NOT NULL,
  day TEXT NOT NULL,
  lines TEXT NOT NULL,
  total_cost REAL NOT NULL,
  unit_cost REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  UNIQUE (outlet_id, number)
);
CREATE TABLE IF NOT EXISTS stock_counts (
  id TEXT PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'completed', 'cancelled')),
  blind INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_by INTEGER,
  completed_by INTEGER,
  note TEXT NOT NULL DEFAULT '',
  lines TEXT NOT NULL,
  variance_value REAL NOT NULL DEFAULT 0,
  UNIQUE (outlet_id, number)
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  mode TEXT NOT NULL,
  created_by INTEGER
);
CREATE INDEX IF NOT EXISTS ix_expenses ON expenses (outlet_id, date);
`);

/* ---------- Upgrades for databases created by earlier versions ---------- */
const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some(entry => entry.name === column);
if (!hasColumn('materials', 'unit')) db.exec("ALTER TABLE materials ADD COLUMN unit TEXT NOT NULL DEFAULT 'ml'");
if (!hasColumn('materials', 'code')) db.exec('ALTER TABLE materials ADD COLUMN code TEXT');
if (!hasColumn('materials', 'ean')) db.exec('ALTER TABLE materials ADD COLUMN ean TEXT');
if (!hasColumn('products', 'needs_recipe')) {
  db.exec(`ALTER TABLE products ADD COLUMN needs_recipe INTEGER NOT NULL DEFAULT 0;
           ALTER TABLE products ADD COLUMN recipe_ml REAL NOT NULL DEFAULT 0;
           ALTER TABLE products ADD COLUMN stock_material_id TEXT;
           ALTER TABLE products ADD COLUMN pack_material_id TEXT;
           ALTER TABLE products ADD COLUMN pack_qty INTEGER NOT NULL DEFAULT 1;`);
  // The two original formats are the ones that use the production (recipe) screen.
  db.exec(`UPDATE products SET needs_recipe = 1, recipe_ml = CASE format WHEN 'attar' THEN 3 ELSE 30 END WHERE format IN ('attar', 'perfume');
           UPDATE products SET type = 'Packed perfume · 30ml' WHERE type = 'Signature perfume · 30ml';`);
}

/* ---------- Receipt and payment vouchers, purchases booked from a supplier invoice ---------- */
// Every payment taken from a customer or made to a supplier (after the bill) is a numbered voucher that can be allocated to bills.
db.exec(`CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'payment')),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  day TEXT NOT NULL,
  party_key TEXT NOT NULL,
  party_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  UNIQUE (outlet_id, number)
)`);
db.exec('CREATE INDEX IF NOT EXISTS ix_vouchers_outlet ON vouchers (outlet_id, kind, day)');
if (!hasColumn('payments', 'voucher_id')) db.exec('ALTER TABLE payments ADD COLUMN voucher_id TEXT');
// A purchase can carry GST and other charges that are not stock (extra_amount) and can point at the sale invoice it was loaded from.
if (!hasColumn('purchases', 'extra_amount')) db.exec('ALTER TABLE purchases ADD COLUMN extra_amount REAL NOT NULL DEFAULT 0; ALTER TABLE purchases ADD COLUMN source_sale_id TEXT;');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_purchases_source ON purchases (source_sale_id) WHERE source_sale_id IS NOT NULL');

/* ---------- Day closing: the drawer and every payment mode tallied against the system ---------- */
db.exec(`CREATE TABLE IF NOT EXISTS day_closings (
  id TEXT PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  day TEXT NOT NULL,
  opening_cash REAL NOT NULL,
  system TEXT NOT NULL,
  counted TEXT NOT NULL,
  variance TEXT NOT NULL,
  cash_counted REAL NOT NULL,
  float_kept REAL NOT NULL,
  deposit REAL NOT NULL,
  cash_notes TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  closed_by INTEGER,
  closed_by_name TEXT NOT NULL DEFAULT '',
  closed_at TEXT NOT NULL,
  UNIQUE (outlet_id, day)
)`);

/* ---------- Brand name ---------- */
// The house is called Scentz now; outlets named after the old name are renamed once (their own names stay editable).
db.exec("UPDATE outlets SET name = REPLACE(name, 'Velour & Vine', 'Scentz') WHERE name LIKE '%Velour & Vine%'");

/* ---------- Loyalty points ---------- */
// Points are a running ledger per customer and outlet: earned on bills, redeemed on bills, adjusted by staff, reversed on returns.
db.exec(`CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  phone TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  points INTEGER NOT NULL,
  expires_at TEXT,
  sale_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER
)`);
db.exec('CREATE INDEX IF NOT EXISTS ix_loyalty_customer ON loyalty_ledger (outlet_id, phone)');
if (!hasColumn('sales', 'points_earned')) db.exec('ALTER TABLE sales ADD COLUMN points_earned INTEGER NOT NULL DEFAULT 0; ALTER TABLE sales ADD COLUMN points_redeemed INTEGER NOT NULL DEFAULT 0; ALTER TABLE sales ADD COLUMN points_value REAL NOT NULL DEFAULT 0; ALTER TABLE sales ADD COLUMN points_balance INTEGER NOT NULL DEFAULT 0;');

/* ---------- Salesmen: who made each sale ---------- */
// A salesman is a person at an outlet the sale is credited to. It is separate from the login that keyed the bill in.
db.exec(`CREATE TABLE IF NOT EXISTS salesmen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  name TEXT NOT NULL COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (outlet_id, name)
)`);
if (!hasColumn('sales', 'salesman_id')) db.exec("ALTER TABLE sales ADD COLUMN salesman_id INTEGER; ALTER TABLE sales ADD COLUMN salesman_name TEXT NOT NULL DEFAULT '';");

/* ---------- Three price slabs and customer types ---------- */
// Products keep a retail, wholesale and franchise price. Customers are retail, wholesale or franchise;
// each bill is priced from its customer's slab and keeps a snapshot of the buyer's GSTIN and address.
if (!hasColumn('products', 'code')) db.exec('ALTER TABLE products ADD COLUMN code TEXT');
// A blend can name a material that tops the bottle up automatically (for example perfumer's alcohol for a 30ml perfume).
if (!hasColumn('products', 'fill_material_id')) {
  db.exec('ALTER TABLE products ADD COLUMN fill_material_id TEXT');
  db.exec("UPDATE products SET fill_material_id = 'alcohol' WHERE needs_recipe = 1 AND format = 'perfume' AND EXISTS (SELECT 1 FROM materials WHERE id = 'alcohol')");
}
if (!hasColumn('products', 'wholesale_price')) {
  db.exec('ALTER TABLE products ADD COLUMN wholesale_price REAL; ALTER TABLE products ADD COLUMN franchise_price REAL;');
  db.exec('UPDATE products SET wholesale_price = price, franchise_price = price');
}
if (!hasColumn('customers', 'type')) {
  db.exec("ALTER TABLE customers ADD COLUMN type TEXT NOT NULL DEFAULT 'retail'; ALTER TABLE customers ADD COLUMN gstin TEXT NOT NULL DEFAULT ''; ALTER TABLE customers ADD COLUMN address TEXT NOT NULL DEFAULT '';");
}
if (!hasColumn('sales', 'price_type')) {
  db.exec("ALTER TABLE sales ADD COLUMN price_type TEXT NOT NULL DEFAULT 'retail'; ALTER TABLE sales ADD COLUMN customer_gstin TEXT NOT NULL DEFAULT ''; ALTER TABLE sales ADD COLUMN customer_address TEXT NOT NULL DEFAULT '';");
}

/* ---------- Third role: biller ---------- */
// Databases created before the biller role have a CHECK that only allows admin and manager. SQLite cannot change a
// CHECK in place, so the users table is rebuilt (sessions keep pointing at it by name).
if (!db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().sql.includes("'biller'")) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(() => {
      db.exec(`CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'biller')),
        outlet_id INTEGER REFERENCES outlets(id),
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      )`);
      db.exec('INSERT INTO users_new (id, username, name, role, outlet_id, salt, hash, active) SELECT id, username, name, role, outlet_id, salt, hash, active FROM users');
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
    });
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
}

/* ---------- Item codes ---------- */
// Every stock item has a short unique code (M001, M002...) and an optional EAN/barcode.
function nextItemCode() {
  const used = db.prepare("SELECT code FROM materials WHERE code GLOB 'M[0-9]*'").all().map(row => Number(row.code.slice(1))).filter(Number.isFinite);
  return 'M' + String((used.length ? Math.max(...used) : 0) + 1).padStart(3, '0');
}
function ensureItemCodes() {
  db.prepare("SELECT id FROM materials WHERE code IS NULL OR code = '' ORDER BY rowid").all().forEach(row => {
    db.prepare('UPDATE materials SET code = ? WHERE id = ?').run(nextItemCode(), row.id);
  });
}
// Products get a short code too (P001, P002...), used to find them quickly on the price screen.
function nextProductCode() {
  const used = db.prepare("SELECT code FROM products WHERE code GLOB 'P[0-9]*'").all().map(row => Number(row.code.slice(1))).filter(Number.isFinite);
  return 'P' + String((used.length ? Math.max(...used) : 0) + 1).padStart(3, '0');
}
function ensureProductCodes() {
  db.prepare("SELECT id FROM products WHERE code IS NULL OR code = '' ORDER BY rowid").all().forEach(row => {
    db.prepare('UPDATE products SET code = ? WHERE id = ?').run(nextProductCode(), row.id);
  });
}
ensureProductCodes();
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_products_code ON products (code COLLATE NOCASE)');
ensureItemCodes();
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_materials_code ON materials (code COLLATE NOCASE)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_materials_ean ON materials (ean) WHERE ean IS NOT NULL");

/* ---------- Backups ---------- */
// VACUUM INTO writes a consistent copy of the live database, even while requests are running.
function backupTo(file) {
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_BACKUPS = 14;
function dailyBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const file = path.join(BACKUP_DIR, `velour-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.db`);
    if (!fs.existsSync(file)) backupTo(file);
    const old = fs.readdirSync(BACKUP_DIR).filter(name => /^velour-\d{4}-\d{2}-\d{2}\.db$/.test(name)).sort();
    old.slice(0, Math.max(0, old.length - KEEP_BACKUPS)).forEach(name => fs.rmSync(path.join(BACKUP_DIR, name), { force: true }));
  } catch (error) {
    console.error('Automatic backup failed:', error.message);
  }
}
function startBackupSchedule() {
  dailyBackup();
  setInterval(dailyBackup, 60 * 60 * 1000).unref();
}

// Runs fn inside one transaction so a failed request never leaves half-written data.
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

/* ---------- Passwords ---------- */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, salt, hash) {
  const candidate = Buffer.from(crypto.scryptSync(password, salt, 64).toString('hex'));
  const expected = Buffer.from(hash);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/* ---------- Shared helpers ---------- */
function nextCounter(scope) {
  const row = db.prepare('SELECT value FROM counters WHERE scope = ?').get(scope);
  const value = (row ? row.value : 0) + 1;
  db.prepare('INSERT INTO counters (scope, value) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET value = excluded.value').run(scope, value);
  return value;
}
function peekCounter(scope) {
  const row = db.prepare('SELECT value FROM counters WHERE scope = ?').get(scope);
  return (row ? row.value : 0) + 1;
}
// Every outlet keeps its own stock row per material; make sure none are missing.
function ensureStockRows() {
  db.exec(`INSERT OR IGNORE INTO outlet_stock (outlet_id, material_id, alert_ml)
           SELECT o.id, m.id, m.default_alert FROM outlets o CROSS JOIN materials m`);
}

/* ---------- First-run seed ---------- */
function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) AS n FROM outlets').get().n > 0) return null;
  let generated = null;
  tx(() => {
    db.prepare("INSERT INTO outlets (code, name, type) VALUES ('HQ', 'Scentz HQ', 'hq')").run();
    const materials = [
      ['zafran', 'Zafran', 'Attar stock', 'plum', 'woody', 50], ['gul-hina', 'Gul Hina', 'Attar stock', 'rose', 'floral', 50],
      ['oud', 'Oud', 'Attar stock', 'amber', 'woody', 50], ['mogra', 'Mogra', 'Attar stock', 'cream', 'floral', 50],
      ['kewda', 'Kewda', 'Attar stock', 'green', 'fresh', 50], ['sandal', 'Sandal', 'Attar stock', 'cream', 'woody', 50],
      ['alcohol', "Perfumer's alcohol", 'Raw material', 'slate', 'base', 500]
    ];
    const addMaterial = db.prepare('INSERT INTO materials (id, name, type, art, category, default_alert) VALUES (?, ?, ?, ?, ?, ?)');
    materials.forEach(row => addMaterial.run(...row));
    // Prices, GST rates and bottle costs are placeholders: HQ edits them under Products.
    const addProduct = db.prepare('INSERT INTO products (id, name, type, price, gst_rate, cost, category, art, format, signature, needs_recipe, recipe_ml) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    addProduct.run('attar-3ml', 'Attar 3ml', 'Pure attar · 3ml', 450, 18, 0, 'all', 'amber', 'attar', 0, 1, 3);
    addProduct.run('perfume-30ml', 'Perfume 30ml', 'Custom perfume · 30ml', 950, 18, 0, 'all', 'rose', 'perfume', 0, 1, 30);
    db.prepare("UPDATE products SET fill_material_id = 'alcohol' WHERE id = 'perfume-30ml'").run();
    addProduct.run('signature-oud', 'Velour Oud', 'Packed perfume · 30ml', 1800, 18, 780, 'signature', 'plum', 'signature', 1, 0, 0);
    addProduct.run('signature-rose', 'Rose Atelier', 'Packed perfume · 30ml', 1650, 18, 700, 'signature', 'rose', 'signature', 1, 0, 0);
    db.prepare("INSERT INTO settings (key, value) VALUES ('taxMode', 'inclusive')").run();
    generated = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const { salt, hash } = hashPassword(generated);
    db.prepare("INSERT INTO users (username, name, role, outlet_id, salt, hash) VALUES ('admin', 'HQ Administrator', 'admin', NULL, ?, ?)").run(salt, hash);
    ensureItemCodes();
    ensureProductCodes();
    ensureStockRows();
  });
  return generated;
}

module.exports = { db, tx, nextItemCode, ensureItemCodes, nextProductCode, backupTo, startBackupSchedule, hashPassword, verifyPassword, nextCounter, peekCounter, ensureStockRows, seedIfEmpty };

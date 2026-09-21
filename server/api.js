'use strict';
const crypto = require('node:crypto');
const { db, tx, nextItemCode, nextProductCode, hashPassword, verifyPassword, nextCounter, peekCounter, ensureStockRows } = require('./db');
const { PAYMENT_MODES, GST_RATES, EXPENSE_CATEGORIES, round2, isValidPhone, isValidGstin, pad, dateKey, todayKey, computeBill, recipeTarget, computeCreditNote, refundFor } = require('../public/shared.js');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = message => { throw new HttpError(400, message); };
const conflict = message => { throw new HttpError(409, message); };
const forbid = message => { throw new HttpError(403, message || 'You do not have permission to do that'); };

/* ---------- Small helpers ---------- */
const now = () => new Date().toISOString();
const clean = (value, max = 120) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const num = value => (value === '' || value === null || value === undefined || typeof value === 'boolean') ? NaN : Number(value);
const slugify = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
const isDateKey = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const cost4 = n => Math.round(n * 10000) / 10000;
const ART = ['amber', 'rose', 'plum', 'green', 'cream', 'slate'];
// ---------- Loyalty program settings (HQ controls them for every outlet) ----------
const LOYALTY_DEFAULT = { enabled: false, earnAmount: 100, earnPoints: 1, types: ['retail'], paidOnly: true, pointValue: 1, minPoints: 50, minBill: 0, maxPercent: 50, expiryDays: 0 };
function loyaltyConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'loyalty'").get();
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  return { ...LOYALTY_DEFAULT, ...saved };
}
const taxMode = () => db.prepare("SELECT value FROM settings WHERE key = 'taxMode'").get().value;
const hqOutlet = () => db.prepare("SELECT * FROM outlets WHERE type = 'hq'").get();
const getOutlet = id => db.prepare('SELECT * FROM outlets WHERE id = ?').get(id);
const nameTaken = (name, exceptId) => [...db.prepare('SELECT id, name FROM materials').all(), ...db.prepare('SELECT id, name FROM products').all()]
  .some(item => item.name.toLowerCase() === name.toLowerCase() && item.id !== exceptId);

/* ---------- Mappers (database rows to the shapes the browser uses) ---------- */
const mapOutlet = row => ({ id: row.id, code: row.code, name: row.name, type: row.type, gstin: row.gstin, address: row.address, phone: row.phone, royaltyPct: row.royalty_pct, active: Boolean(row.active) });
const mapProduct = row => ({ id: row.id, fillMaterialId: row.fill_material_id, code: row.code, name: row.name, type: row.type, price: row.price, wholesalePrice: row.wholesale_price ?? row.price, franchisePrice: row.franchise_price ?? row.price, gstRate: row.gst_rate, cost: row.cost, category: row.category, art: row.art, format: row.format, needsRecipe: Boolean(row.needs_recipe), recipeMl: row.recipe_ml, stockMaterialId: row.stock_material_id, packMaterialId: row.pack_material_id, packQty: row.pack_qty, ...(row.needs_recipe ? {} : { signature: true }) });
const mapPayments = list => list.map(payment => ({ date: payment.date, mode: payment.mode, amount: payment.amount }));
const mapSale = (row, payments) => ({ id: row.id, outletId: row.outlet_id, number: row.number, date: row.date, day: row.day, customerName: row.customer_name, customerPhone: row.customer_phone, customerGstin: row.customer_gstin, customerAddress: row.customer_address, priceType: row.price_type, pointsEarned: row.points_earned || 0, pointsRedeemed: row.points_redeemed || 0, pointsValue: row.points_value || 0, pointsBalance: row.points_balance || 0, salesmanId: row.salesman_id, salesmanName: row.salesman_name || '', taxMode: row.tax_mode, lines: JSON.parse(row.lines), subtotal: row.subtotal, discount: row.discount, taxable: row.taxable, cgst: row.cgst, sgst: row.sgst, roundOff: row.round_off, total: row.total, payments: mapPayments(payments || []) });
const mapPurchase = (row, payments) => ({ id: row.id, outletId: row.outlet_id, number: row.number, supplier: row.supplier, invoiceNo: row.invoice_no, date: row.date, total: row.total, extraAmount: row.extra_amount, sourceSaleId: row.source_sale_id, lines: JSON.parse(row.lines), payments: mapPayments(payments || []) });
const mapExpense = row => ({ id: row.id, outletId: row.outlet_id, date: row.date, category: row.category, description: row.description, amount: row.amount, mode: row.mode });
const mapTransfer = row => ({ id: row.id, number: row.number, fromOutlet: row.from_outlet, toOutlet: row.to_outlet, date: row.date, status: row.status, lines: JSON.parse(row.lines), value: row.value, note: row.note, receivedAt: row.received_at });

function groupPayments(kind, whereSql, params, table) {
  const rows = db.prepare(`SELECT * FROM payments WHERE kind = ? AND ref_id IN (SELECT id FROM ${table} ${whereSql}) ORDER BY id`).all(kind, ...params);
  const grouped = new Map();
  rows.forEach(row => { if (!grouped.has(row.ref_id)) grouped.set(row.ref_id, []); grouped.get(row.ref_id).push(row); });
  return grouped;
}
const mapCreditNote = row => ({ id: row.id, outletId: row.outlet_id, number: row.number, date: row.date, day: row.day, saleId: row.sale_id, saleNumber: row.sale_number, customerName: row.customer_name, customerPhone: row.customer_phone, reason: row.reason, lines: JSON.parse(row.lines), taxable: row.taxable, cgst: row.cgst, sgst: row.sgst, roundOff: row.round_off, total: row.total, refund: row.refund, refundMode: row.refund_mode });
// Each sale carries `credited` (total of its credit notes) and, per line, `returned` units.
function loadSales(whereSql = '', params = []) {
  const payments = groupPayments('sale', whereSql, params, 'sales');
  const credits = new Map();
  db.prepare(`SELECT sale_id, total, lines FROM credit_notes WHERE sale_id IN (SELECT id FROM sales ${whereSql})`).all(...params).forEach(note => {
    const entry = credits.get(note.sale_id) || { total: 0, returned: {} };
    entry.total = round2(entry.total + note.total);
    JSON.parse(note.lines).forEach(line => { entry.returned[line.index] = (entry.returned[line.index] || 0) + line.qty; });
    credits.set(note.sale_id, entry);
  });
  return db.prepare(`SELECT * FROM sales ${whereSql} ORDER BY date DESC, rowid DESC`).all(...params).map(row => {
    const sale = mapSale(row, payments.get(row.id)), entry = credits.get(row.id);
    sale.credited = entry ? entry.total : 0;
    sale.lines.forEach((line, index) => { line.returned = entry ? entry.returned[index] || 0 : 0; });
    return sale;
  });
}
const mapSalesman = row => ({ id: row.id, name: row.name, active: Boolean(row.active) });
const mapVoucher = (row, allocations) => ({ id: row.id, outletId: row.outlet_id, kind: row.kind, number: row.number, date: row.date, day: row.day, partyKey: row.party_key, party: row.party_name, mode: row.mode, amount: row.amount, note: row.note, allocations: allocations || [] });
// Vouchers with what each one was applied to (bill numbers), newest first.
function loadVouchers(whereSql = '', params = [], limit = 500) {
  const rows = db.prepare(`SELECT * FROM vouchers ${whereSql} ORDER BY date DESC, rowid DESC LIMIT ${Number(limit)}`).all(...params);
  if (!rows.length) return [];
  const ids = rows.map(row => row.id), marks = ids.map(() => '?').join(',');
  const applied = db.prepare(`SELECT p.voucher_id, p.kind, p.ref_id, p.amount, COALESCE(s.number, u.number) AS number FROM payments p LEFT JOIN sales s ON p.kind = 'sale' AND s.id = p.ref_id LEFT JOIN purchases u ON p.kind = 'purchase' AND u.id = p.ref_id WHERE p.voucher_id IN (${marks}) ORDER BY p.id`).all(...ids);
  const grouped = new Map();
  applied.forEach(row => { if (!grouped.has(row.voucher_id)) grouped.set(row.voucher_id, []); grouped.get(row.voucher_id).push({ refId: row.ref_id, number: row.number, amount: row.amount }); });
  return rows.map(row => mapVoucher(row, grouped.get(row.id)));
}
function loadPurchases(whereSql = '', params = []) {
  const payments = groupPayments('purchase', whereSql, params, 'purchases');
  return db.prepare(`SELECT * FROM purchases ${whereSql} ORDER BY date DESC, rowid DESC`).all(...params).map(row => mapPurchase(row, payments.get(row.id)));
}
const MATERIAL_SQL = `
  SELECT m.id, m.name, m.type, m.art, m.category, m.unit, m.code, m.ean, s.outlet_id, s.stock, s.cost_per_ml, s.alert_ml,
    EXISTS (SELECT 1 FROM stock_ledger l WHERE l.outlet_id = s.outlet_id AND l.material_id = m.id AND l.kind <> 'opening') AS locked,
    (SELECT l.qty FROM stock_ledger l WHERE l.outlet_id = s.outlet_id AND l.material_id = m.id AND l.kind = 'opening' ORDER BY l.id DESC LIMIT 1) AS opening_qty,
    (SELECT l.unit_cost FROM stock_ledger l WHERE l.outlet_id = s.outlet_id AND l.material_id = m.id AND l.kind = 'opening' ORDER BY l.id DESC LIMIT 1) AS opening_cost,
    (SELECT l.effective_date FROM stock_ledger l WHERE l.outlet_id = s.outlet_id AND l.material_id = m.id AND l.kind = 'opening' ORDER BY l.id DESC LIMIT 1) AS opening_date
  FROM materials m JOIN outlet_stock s ON s.material_id = m.id`;
const mapMaterial = row => ({ id: row.id, name: row.name, type: row.type, art: row.art, category: row.category, unit: row.unit, code: row.code, ean: row.ean, outletId: row.outlet_id, stock: row.stock, costPerMl: row.cost_per_ml, alertMl: row.alert_ml, openingLocked: Boolean(row.locked), openingQty: row.opening_qty, openingCost: row.opening_cost, openingDate: row.opening_date });
const loadMaterials = outletId => db.prepare(`${MATERIAL_SQL} WHERE s.outlet_id = ? ORDER BY m.rowid`).all(outletId).map(mapMaterial);

// What a biller must not see: cost prices and everything about buying and stock control.
const withoutCosts = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'cost' || key === 'costPerMl' ? undefined : item));
function buildState(user, outlet) {
  const state = buildFullState(user, outlet);
  if (user.role !== 'biller') return state;
  return {
    ...state,
    materials: state.materials.map(material => ({ ...material, costPerMl: 0, openingQty: null, openingCost: null, openingDate: null, openingLocked: false })),
    products: state.products.map(product => ({ ...product, cost: null })),
    sales: withoutCosts(state.sales), creditNotes: withoutCosts(state.creditNotes),
    purchases: [], expenses: [], stockCounts: [], transfers: [],
    vouchers: state.vouchers.filter(voucher => voucher.kind === 'receipt'), dayClosings: []
  };
}
function buildFullState(user, outlet) {
  const year = new Date().getFullYear();
  const isAdmin = user.role === 'admin';
  const outlets = (isAdmin ? db.prepare('SELECT * FROM outlets ORDER BY id').all() : [outlet]).map(mapOutlet);
  const transferRows = isAdmin ? db.prepare('SELECT * FROM transfers ORDER BY rowid DESC').all()
    : db.prepare('SELECT * FROM transfers WHERE from_outlet = ? OR to_outlet = ? ORDER BY rowid DESC').all(outlet.id, outlet.id);
  return {
    me: { id: user.id, username: user.username, name: user.name, role: user.role, outletId: user.outlet_id },
    outlet: { ...mapOutlet(outlet), nextInvoice: `${outlet.code}-INV-${year}-${pad(peekCounter(`inv:${outlet.id}:${year}`)).padStart(4, '0')}`, nextInvoiceFranchise: `${outlet.code}-FRN-${year}-${pad(peekCounter(`frn:${outlet.id}:${year}`)).padStart(4, '0')}`, nextPurchase: `${outlet.code}-PUR-${year}-${pad(peekCounter(`pur:${outlet.id}:${year}`)).padStart(4, '0')}` },
    outlets,
    hqOutletId: hqOutlet().id,
    settings: { taxMode: taxMode(), loyalty: loyaltyConfig() },
    materials: loadMaterials(outlet.id),
    products: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY rowid').all().map(mapProduct),
    customers: (() => { const points = loyaltyStates(outlet.id); return db.prepare('SELECT name, phone, email, type, gstin, address FROM customers WHERE outlet_id = ? ORDER BY id DESC').all(outlet.id).map(row => ({ ...row, ...(points.get(row.phone) || { points: 0, expiringPoints: 0, expiresOn: null }) })); })(),
    sales: loadSales('WHERE outlet_id = ?', [outlet.id]),
    purchases: loadPurchases('WHERE outlet_id = ?', [outlet.id]),
    expenses: db.prepare('SELECT * FROM expenses WHERE outlet_id = ? ORDER BY date DESC, id DESC').all(outlet.id).map(mapExpense),
    creditNotes: db.prepare('SELECT * FROM credit_notes WHERE outlet_id = ? ORDER BY date DESC, rowid DESC').all(outlet.id).map(mapCreditNote),
    vouchers: loadVouchers('WHERE outlet_id = ?', [outlet.id]),
    salesmen: db.prepare('SELECT * FROM salesmen WHERE outlet_id = ? ORDER BY name').all(outlet.id).map(mapSalesman),
    dayClosings: db.prepare('SELECT * FROM day_closings WHERE outlet_id = ? ORDER BY day DESC LIMIT 120').all(outlet.id).map(mapClosing),
    stockCounts: loadCounts('WHERE c.outlet_id = ?', [outlet.id]),
    transfers: transferRows.map(mapTransfer)
  };
}

/* ---------- Sessions and login ---------- */
const SESSION_HOURS = 12;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), userId, Date.now() + SESSION_HOURS * 3600 * 1000);
  return token;
}
function userForToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1').get(sha(token), Date.now());
  return row || null;
}
const attempts = new Map();
function throttle(ip, ok) {
  const entry = attempts.get(ip) || { count: 0, since: Date.now() };
  if (Date.now() - entry.since > 10 * 60 * 1000) { entry.count = 0; entry.since = Date.now(); }
  if (ok) { attempts.delete(ip); return; }
  entry.count += 1; attempts.set(ip, entry);
}
const blocked = ip => { const entry = attempts.get(ip); return Boolean(entry) && entry.count >= 10 && Date.now() - entry.since < 10 * 60 * 1000; };

/* ---------- Stock helpers ---------- */
function ledger(outletId, materialId, kind, qty, unitCost, ref, note, userId, effective = todayKey()) {
  db.prepare('INSERT INTO stock_ledger (outlet_id, material_id, kind, qty, unit_cost, ref, note, effective_date, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(outletId, materialId, kind, qty, unitCost, ref || null, note || null, effective, now(), userId);
}
const stockRow = (outletId, materialId) => db.prepare('SELECT s.*, m.name, m.unit FROM outlet_stock s JOIN materials m ON m.id = s.material_id WHERE s.outlet_id = ? AND s.material_id = ?').get(outletId, materialId);
// Quantities are ml for liquids and whole pieces for bottles, packaging and packed products.
const stockText = row => row.unit === 'pcs' ? `${round2(row.stock)} pcs` : `${row.stock.toFixed(2)}ml`;
function wholeIfPcs(unit, qty, what) { if (unit === 'pcs' && !Number.isInteger(qty)) bad(`${what} must be a whole number of pieces`); }
// Adds stock and re-averages the cost per unit.
function addStock(outletId, materialId, qty, unitCost) {
  const row = stockRow(outletId, materialId);
  const stock = round2(row.stock + qty);
  const cost = stock > 0 ? cost4((row.stock * row.cost_per_ml + qty * unitCost) / stock) : row.cost_per_ml;
  db.prepare('UPDATE outlet_stock SET stock = ?, cost_per_ml = ? WHERE outlet_id = ? AND material_id = ?').run(stock, cost, outletId, materialId);
}
function removeStock(outletId, materialId, qty) {
  const row = stockRow(outletId, materialId);
  if (row.stock + 1e-9 < qty) conflict(`Not enough ${row.name} in stock (${stockText(row)} available)`);
  db.prepare('UPDATE outlet_stock SET stock = ? WHERE outlet_id = ? AND material_id = ?').run(round2(row.stock - qty), outletId, materialId);
}
function checkMode(mode) { if (!PAYMENT_MODES.includes(mode)) bad('Choose a valid payment mode'); return mode; }
const PRICE_TYPES = ['retail', 'wholesale', 'franchise'];
// The price a customer type pays. Older products without a slab price fall back to retail.
const slabPrice = (product, type) => type === 'wholesale' ? (product.wholesale_price ?? product.price) : type === 'franchise' ? (product.franchise_price ?? product.price) : product.price;
// Retail and wholesale bills share the INV series; franchise invoices are raised in their own FRN series.
const INVOICE_SERIES = { retail: 'inv', wholesale: 'inv', franchise: 'frn' };
function numbered(outlet, kind) {
  const year = new Date().getFullYear();
  const value = nextCounter(`${kind}:${outlet.id}:${year}`);
  return `${outlet.code}-${kind.toUpperCase()}-${year}-${String(value).padStart(4, '0')}`;
}

/* ---------- Day closing ---------- */
const mapClosing = row => {
  const system = JSON.parse(row.system), sales = system._sales || null;   // the sales-versus-submitted figures are saved beside the modes
  delete system._sales;
  return { id: row.id, outletId: row.outlet_id, day: row.day, openingCash: row.opening_cash, system, sales, counted: JSON.parse(row.counted), variance: JSON.parse(row.variance), cashCounted: row.cash_counted, floatKept: row.float_kept, deposit: row.deposit, cashNotes: JSON.parse(row.cash_notes), notes: row.notes, closedBy: row.closed_by_name, closedAt: row.closed_at };
};
// Every rupee that moved on one day at one outlet, by payment mode: what came in, what went out, what is left.
function daySummary(outlet, day) {
  const money = PAYMENT_MODES;
  const blank = () => Object.fromEntries(money.map(mode => [mode, 0]));
  const lines = { sales: blank(), royalty: blank(), refunds: blank(), suppliers: blank(), expenses: blank() };
  let loyalty = 0, loyaltyOnBills = 0, collectedOnBills = 0;
  const billIds = new Set(db.prepare('SELECT id FROM sales WHERE outlet_id = ? AND day = ?').all(outlet.id, day).map(row => row.id));
  const from = new Date(new Date(day + 'T00:00:00').getTime() - 36 * 3600 * 1000).toISOString(), to = new Date(new Date(day + 'T00:00:00').getTime() + 60 * 3600 * 1000).toISOString();
  db.prepare('SELECT kind, mode, amount, date, ref_id, voucher_id FROM payments WHERE outlet_id = ? AND date >= ? AND date < ?').all(outlet.id, from, to).forEach(row => {
    if (dateKey(row.date) !== day) return;
    const atBilling = row.kind === 'sale' && row.amount >= 0 && !row.voucher_id && billIds.has(row.ref_id);   // taken while the bill was made, not a later receipt
    if (row.mode === 'Loyalty points') { if (row.kind === 'sale') { loyalty = round2(loyalty + row.amount); if (atBilling) loyaltyOnBills = round2(loyaltyOnBills + row.amount); } return; }
    if (!money.includes(row.mode)) return;
    if (atBilling) collectedOnBills = round2(collectedOnBills + row.amount);
    if (row.kind === 'sale') { if (row.amount >= 0) lines.sales[row.mode] = round2(lines.sales[row.mode] + row.amount); else lines.refunds[row.mode] = round2(lines.refunds[row.mode] - row.amount); }
    else lines.suppliers[row.mode] = round2(lines.suppliers[row.mode] + row.amount);
  });
  db.prepare('SELECT mode, amount FROM expenses WHERE outlet_id = ? AND date = ?').all(outlet.id, day).forEach(row => { if (money.includes(row.mode)) lines.expenses[row.mode] = round2(lines.expenses[row.mode] + row.amount); });
  if (outlet.type === 'hq') db.prepare('SELECT mode, amount FROM royalty_payments WHERE date = ?').all(day).forEach(row => { if (money.includes(row.mode)) lines.royalty[row.mode] = round2(lines.royalty[row.mode] + row.amount); });
  const modes = Object.fromEntries(money.map(mode => {
    // Cash is counted in the drawer, so everything in and out matters. Card, UPI and bank are checked against what was collected (less refunds): what the machine or app reports.
    const incoming = round2(lines.sales[mode] + lines.royalty[mode]), refunds = lines.refunds[mode], paidOut = round2(lines.suppliers[mode] + lines.expenses[mode]);
    const net = round2(incoming - refunds - paidOut);
    return [mode, { in: incoming, refunds, paidOut, out: round2(refunds + paidOut), net, tally: mode === 'Cash' ? net : round2(incoming - refunds) }];
  }));
  const bills = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM sales WHERE outlet_id = ? AND day = ?').get(outlet.id, day);
  const returns = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM credit_notes WHERE outlet_id = ? AND day = ?').get(outlet.id, day);
  // How the day's sales were settled: what was billed, less returns, less what stayed on credit or was paid in points, plus dues collected
  // from earlier bills, is the money that should have come in (royalty is not a sale, so it is left out).
  const returnsRefunded = round2(money.reduce((sum, mode) => sum + lines.refunds[mode], 0));
  const moneyIn = round2(money.reduce((sum, mode) => sum + lines.sales[mode], 0));
  const sales = {
    billed: round2(bills.total), returns: round2(returns.total), netSales: round2(bills.total - returns.total),
    onCredit: round2(bills.total - collectedOnBills - loyaltyOnBills), points: loyaltyOnBills,
    dueCollected: round2(moneyIn - collectedOnBills), returnsKept: round2(returns.total - returnsRefunded),
    royalty: Object.fromEntries(money.map(mode => [mode, lines.royalty[mode]])),
    expenses: round2(money.reduce((sum, mode) => sum + lines.expenses[mode], 0)), suppliers: round2(money.reduce((sum, mode) => sum + lines.suppliers[mode], 0))
  };
  sales.expected = round2(sales.netSales - sales.onCredit - sales.points + sales.dueCollected + sales.returnsKept);
  return { day, lines, modes, loyalty, sales, bills: { count: bills.n, total: round2(bills.total) }, returns: { count: returns.n, total: round2(returns.total) } };
}
// The cash left in the drawer as tomorrow's change is today's closing float.
function lastFloat(outlet, day) {
  const row = db.prepare('SELECT day, float_kept FROM day_closings WHERE outlet_id = ? AND day < ? ORDER BY day DESC LIMIT 1').get(outlet.id, day);
  return row ? { day: row.day, amount: row.float_kept } : null;
}
function dayClosingSummary({ query, outlet }) {
  const day = isDateKey(query.day) ? query.day : todayKey();
  if (day > todayKey()) bad('That day has not happened yet');
  const existing = db.prepare('SELECT * FROM day_closings WHERE outlet_id = ? AND day = ?').get(outlet.id, day);
  const openDays = db.prepare('SELECT DISTINCT day FROM sales WHERE outlet_id = ? AND day < ? AND day NOT IN (SELECT day FROM day_closings WHERE outlet_id = ?) ORDER BY day DESC LIMIT 10').all(outlet.id, todayKey(), outlet.id).map(row => row.day);
  return { ...daySummary(outlet, day), previousFloat: lastFloat(outlet, day), closing: existing ? mapClosing(existing) : null, unclosedDays: openDays };
}
function closeDay({ body, user, outlet }) {
  const day = isDateKey(body.day) ? body.day : todayKey();
  if (day > todayKey()) bad('That day has not happened yet');
  const number = value => value === undefined || value === null || value === '' ? null : round2(Number(value));
  const opening = number(body.openingCash);
  if (opening === null || !(opening >= 0)) bad('Enter the cash that was in the drawer when the day started');
  return tx(() => {
    if (db.prepare('SELECT 1 FROM day_closings WHERE outlet_id = ? AND day = ?').get(outlet.id, day)) conflict('This day is already closed');
    const summary = daySummary(outlet, day), counted = {}, variance = {}, system = {};
    const given = body.counted && typeof body.counted === 'object' ? body.counted : {};
    for (const mode of PAYMENT_MODES) {
      const value = number(given[mode]), net = summary.modes[mode].tally;
      if (value !== null && !(value >= 0)) bad(`The ${mode} amount must be 0 or more`);
      if (mode === 'Cash' && value === null) bad('Enter the cash you counted in the drawer');
      if (mode !== 'Cash' && value === null && Math.abs(net) > 0.004) bad(`Enter the ${mode} total from your ${mode === 'Card' ? 'card machine' : mode === 'UPI' ? 'UPI app' : 'bank statement'}`);
      const expected = mode === 'Cash' ? round2(opening + net) : net;   // net is what should be in the drawer / collected
      system[mode] = { ...summary.modes[mode], expected };
      counted[mode] = value;
      variance[mode] = value === null ? 0 : round2(value - expected);
    }
    system._sales = summary.sales;
    const floatKept = number(body.floatKept) ?? 0;
    if (!(floatKept >= 0) || floatKept > counted.Cash + 1e-9) bad('The cash kept for change cannot be more than the cash counted');
    const notes = clean(body.notes, 500);
    if (Object.values(variance).some(value => Math.abs(value) >= 0.005) && !notes) bad('Add a note explaining the difference');
    const cashNotes = {};
    if (body.cashNotes && typeof body.cashNotes === 'object') for (const [face, qty] of Object.entries(body.cashNotes)) { const count = Math.round(Number(qty)); if (/^\d{1,5}$/.test(face) && count > 0 && count < 1e6) cashNotes[face] = count; }
    const id = `day-${crypto.randomBytes(8).toString('hex')}`;
    db.prepare('INSERT INTO day_closings (id, outlet_id, day, opening_cash, system, counted, variance, cash_counted, float_kept, deposit, cash_notes, notes, closed_by, closed_by_name, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, outlet.id, day, opening, JSON.stringify(system), JSON.stringify(counted), JSON.stringify(variance), counted.Cash, floatKept, round2(counted.Cash - floatKept), JSON.stringify(cashNotes), notes, user.id, user.name, now());
    return mapClosing(db.prepare('SELECT * FROM day_closings WHERE id = ?').get(id));
  });
}
// A closed day can be reopened by HQ (for example when a late bill was missed); the record is removed and the day is counted again.
function reopenDay({ params, outlet }) {
  const row = db.prepare('SELECT * FROM day_closings WHERE id = ? AND outlet_id = ?').get(String(params.id), outlet.id);
  if (!row) throw new HttpError(404, 'Closing not found');
  db.prepare('DELETE FROM day_closings WHERE id = ?').run(row.id);
  return { ok: true };
}

/* ---------- Loyalty points ---------- */
// Balance with expiry: earned points form lots, spending uses the oldest lot first, and a lot past its date no longer counts.
function computeLoyalty(rows, nowIso) {
  const lots = [];
  for (const row of rows) {
    if (row.points > 0) { lots.push({ left: row.points, exp: row.expires_at }); continue; }
    let need = -row.points;
    for (const lot of lots) {
      if (need <= 0) break;
      if (lot.left <= 0 || (lot.exp && lot.exp <= row.date)) continue;
      const take = Math.min(lot.left, need);
      lot.left -= take; need -= take;
    }
  }
  const alive = lots.filter(lot => lot.left > 0 && (!lot.exp || lot.exp > nowIso));
  const dated = alive.filter(lot => lot.exp).sort((a, b) => a.exp.localeCompare(b.exp));
  const firstDay = dated.length ? dated[0].exp.slice(0, 10) : null;
  return { points: alive.reduce((sum, lot) => sum + lot.left, 0), expiringPoints: dated.filter(lot => lot.exp.slice(0, 10) === firstDay).reduce((sum, lot) => sum + lot.left, 0), expiresOn: firstDay };
}
function loyaltyState(outletId, phone) {
  return computeLoyalty(db.prepare('SELECT points, expires_at, date FROM loyalty_ledger WHERE outlet_id = ? AND phone = ? ORDER BY id').all(outletId, String(phone)), now());
}
function loyaltyStates(outletId) {
  const grouped = new Map();
  db.prepare('SELECT phone, points, expires_at, date FROM loyalty_ledger WHERE outlet_id = ? ORDER BY id').all(outletId).forEach(row => { if (!grouped.has(row.phone)) grouped.set(row.phone, []); grouped.get(row.phone).push(row); });
  const at = now();
  return new Map([...grouped.entries()].map(([phone, rows]) => [phone, computeLoyalty(rows, at)]));
}
function addPoints({ outlet, phone, kind, points, saleId = null, note = '', userId = null, cfg = loyaltyConfig() }) {
  if (!points) return;
  const expires = points > 0 && cfg.expiryDays > 0 ? new Date(Date.now() + cfg.expiryDays * 86400000).toISOString() : null;
  db.prepare('INSERT INTO loyalty_ledger (outlet_id, phone, date, kind, points, expires_at, sale_id, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(outlet.id, String(phone), now(), kind, points, expires, saleId, note, userId);
}
// Points a customer asks to use on this bill, checked against the program's conditions.
function redemption(body, total, customer, outlet, cfg) {
  const points = Math.floor(Number(body.redeemPoints) || 0);
  if (!(points > 0)) return { points: 0, value: 0 };
  if (!cfg.enabled) bad('The loyalty program is not switched on');
  if (!customer || !cfg.types.includes(customer.type)) bad('Loyalty points are not available for this customer');
  const available = loyaltyState(outlet.id, customer.phone).points;
  if (points > available) bad(`Only ${available} points are available`);
  if (points < cfg.minPoints) bad(`Redeem at least ${cfg.minPoints} points at a time`);
  if (total < cfg.minBill) bad(`Points can be used on bills of ₹${cfg.minBill} or more`);
  const value = round2(points * cfg.pointValue), most = round2(total * cfg.maxPercent / 100);
  if (value > most + 1e-9) bad(`Points can pay at most ${cfg.maxPercent}% of the bill (₹${most})`);
  return { points, value };
}
// HQ: switch the program on and set how points are earned and used.
function saveLoyaltySettings({ body }) {
  const cfg = {
    enabled: Boolean(body.enabled), earnAmount: round2(num(body.earnAmount)), earnPoints: Math.round(num(body.earnPoints)),
    types: (Array.isArray(body.types) ? body.types : []).filter(type => PRICE_TYPES.includes(type)), paidOnly: body.paidOnly !== false,
    pointValue: round2(num(body.pointValue)), minPoints: Math.round(num(body.minPoints) || 0), minBill: round2(num(body.minBill) || 0),
    maxPercent: round2(num(body.maxPercent)), expiryDays: Math.round(num(body.expiryDays) || 0)
  };
  if (!(cfg.earnAmount > 0 && cfg.earnAmount <= 1e6)) bad('Enter the spend that earns points, greater than ₹0');
  if (!(cfg.earnPoints >= 1 && cfg.earnPoints <= 1000)) bad('Points earned must be between 1 and 1000');
  if (!cfg.types.length) bad('Choose at least one customer type that can earn points');
  if (!(cfg.pointValue > 0 && cfg.pointValue <= 1000)) bad('Enter what one point is worth, greater than ₹0');
  if (!(cfg.minPoints >= 0 && cfg.minPoints <= 1e6)) bad('Minimum points to redeem must be 0 or more');
  if (!(cfg.minBill >= 0 && cfg.minBill <= 1e7)) bad('Minimum bill must be 0 or more');
  if (!(cfg.maxPercent >= 1 && cfg.maxPercent <= 100)) bad('The share of a bill points can pay must be between 1% and 100%');
  if (!(cfg.expiryDays >= 0 && cfg.expiryDays <= 3650)) bad('Expiry must be between 0 (never) and 3650 days');
  db.prepare("INSERT INTO settings (key, value) VALUES ('loyalty', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(cfg));
  return cfg;
}
// Staff add or take away points with a reason (goodwill, a correction).
function adjustLoyalty({ body, user, outlet }) {
  const phone = String(body.phone || ''), points = Math.round(Number(body.points)), reason = clean(body.reason, 200);
  const customer = db.prepare('SELECT phone FROM customers WHERE outlet_id = ? AND phone = ?').get(outlet.id, phone);
  if (!customer) throw new HttpError(404, 'Customer not found');
  if (!points || !Number.isFinite(points) || Math.abs(points) > 1e6) bad('Enter the points to add or remove');
  if (!reason) bad('Give a reason for the adjustment');
  return tx(() => {
    const available = loyaltyState(outlet.id, phone).points;
    if (points < 0 && -points > available) bad(`Only ${available} points are available to remove`);
    addPoints({ outlet, phone, kind: 'adjust', points, note: reason, userId: user.id });
    return loyaltyState(outlet.id, phone);
  });
}
function loyaltyHistory({ params, outlet }) {
  const rows = db.prepare('SELECT l.date, l.kind, l.points, l.expires_at, l.note, s.number AS sale_number FROM loyalty_ledger l LEFT JOIN sales s ON s.id = l.sale_id WHERE l.outlet_id = ? AND l.phone = ? ORDER BY l.id DESC LIMIT 100').all(outlet.id, String(params.phone));
  return { ...loyaltyState(outlet.id, params.phone), history: rows.map(row => ({ date: row.date, kind: row.kind, points: row.points, expiresAt: row.expires_at, note: row.note, saleNumber: row.sale_number })) };
}

/* ---------- Bills ---------- */
// Money taken at the counter: one payment ({ mode, amount }) or several (payments: [...], e.g. part cash, part UPI).
// Only cash can be more than what is left to pay; the difference is change handed back and is not recorded as income.
function counterPayments(body, total) {
  const requested = Array.isArray(body.payments) ? body.payments : body.payment ? [body.payment] : [];
  if (requested.length > 6) bad('Use at most 6 payment lines');
  const byMode = new Map();
  for (const entry of requested) {
    const amount = round2(Number(entry && entry.amount) || 0);
    if (amount < 0) bad(`The amount received must be between ₹0 and ₹${total}`);
    if (amount === 0) continue;
    if (amount > 1e8) bad('That amount is too large');
    const mode = checkMode(entry.mode);
    byMode.set(mode, round2((byMode.get(mode) || 0) + amount));
  }
  const cash = byMode.get('Cash') || 0;
  const other = round2([...byMode.entries()].filter(([mode]) => mode !== 'Cash').reduce((sum, [, amount]) => sum + amount, 0));
  if (other > total + 1e-9) bad(`The amount received must be between ₹0 and ₹${total}. Only cash can be more than the bill`);
  const cashUsed = Math.min(cash, round2(total - other)), change = round2(cash - cashUsed);
  const applied = [...byMode.entries()].map(([mode, amount]) => ({ mode, amount: mode === 'Cash' ? cashUsed : amount })).filter(entry => entry.amount > 0);
  return { applied, change, tendered: round2(cash + other) };
}
function createSale({ body, user, outlet }) {
  const name = clean(body.customerName), phone = String(body.customerPhone || '');
  if (!name) bad('Customer name is required');
  if (!isValidPhone(phone)) bad('Enter a valid 10-digit mobile number');
  const requested = Array.isArray(body.lines) ? body.lines : [];
  if (!requested.length || requested.length > 100) bad('Add at least one item to the bill');
  const discount = { type: body.discount?.type === 'percent' ? 'percent' : 'amount', value: Number(body.discount?.value) || 0 };
  if (discount.value < 0 || (discount.type === 'percent' && discount.value > 100)) bad('Enter a valid discount');

  return tx(() => {
    let customer = db.prepare('SELECT * FROM customers WHERE outlet_id = ? AND phone = ?').get(outlet.id, phone);
    if (customer && customer.name.toLowerCase() !== name.toLowerCase()) conflict(`This number is saved for ${customer.name}`);
    if (!customer) db.prepare('INSERT INTO customers (outlet_id, name, phone) VALUES (?, ?, ?)').run(outlet.id, name, phone);
    // Optional: who made the sale. Must be an active salesman of this outlet.
    let salesman = null;
    if (body.salesmanId !== undefined && body.salesmanId !== null && body.salesmanId !== '') {
      salesman = db.prepare('SELECT * FROM salesmen WHERE id = ? AND outlet_id = ?').get(Number(body.salesmanId), outlet.id);
      if (!salesman || !salesman.active) bad('Choose an active salesman of this outlet');
    }
    // The price list follows the customer: new walk-ins are retail; wholesalers and franchisees are set up in the customer book.
    const buyer = customer || { type: 'retail', gstin: '', address: '' }, priceType = PRICE_TYPES.includes(buyer.type) ? buyer.type : 'retail';

    const usage = new Map(), items = [], built = [];
    const use = (id, qty) => usage.set(id, round2((usage.get(id) || 0) + qty));
    for (const line of requested) {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(String(line.productId));
      if (!product) bad('One of the products is no longer available');
      const qty = Number(line.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 999) bad('Invalid quantity');
      if (!product.needs_recipe) {
        // Packed product: added straight to the bill; optionally counted out of stock in pieces.
        items.push({ price: slabPrice(product, priceType), quantity: qty, gstRate: product.gst_rate });
        if (product.stock_material_id) use(product.stock_material_id, qty);
        built.push({ product, qty, name: product.name, cost: round2(product.cost * qty), recipe: null, pack: null, extras: [], tracked: product.stock_material_id });
        continue;
      }
      if (qty !== 1) bad('Each custom blend is billed as one bottle');
      const recipe = [];
      for (const part of Array.isArray(line.recipe) ? line.recipe : []) {
        const material = db.prepare('SELECT id, name, unit FROM materials WHERE id = ?').get(String(part.id));
        const ml = round2(Number(part.ml));
        if (!material || material.unit !== 'ml' || !(ml > 0) || recipe.some(entry => entry.id === material.id)) bad('Invalid recipe');
        recipe.push({ id: material.id, name: material.name, ml });
      }
      const total = round2(recipe.reduce((sum, part) => sum + part.ml, 0));
      if (!recipe.length || Math.abs(total - product.recipe_ml) > 0.001) bad(`The ${product.name} recipe must add up to exactly ${product.recipe_ml}ml`);
      recipe.forEach(part => use(part.id, part.ml));
      // Packaging (e.g. one 30ml bottle) is taken out of stock automatically with every bottle made.
      let pack = null;
      if (product.pack_material_id) {
        const packMaterial = db.prepare('SELECT id, name, unit FROM materials WHERE id = ?').get(product.pack_material_id);
        pack = { id: packMaterial.id, name: packMaterial.name, qty: product.pack_qty, unit: packMaterial.unit };
        use(pack.id, pack.qty);
      }
      // Bottles and packaging chosen on the production screen (whole pieces, outside the ml total).
      const extras = [];
      for (const extra of Array.isArray(line.extras) ? line.extras : []) {
        const material = db.prepare('SELECT id, name, unit FROM materials WHERE id = ?').get(String(extra.id));
        const pieces = Number(extra.qty);
        if (!material || material.unit !== 'pcs' || !Number.isInteger(pieces) || pieces < 1 || pieces > 99 || extras.some(entry => entry.id === material.id)) bad('Invalid bottle or packaging choice');
        extras.push({ id: material.id, name: material.name, qty: pieces, unit: 'pcs' });
        use(material.id, pieces);
      }
      const attars = recipe.filter(part => part.id !== 'alcohol');
      const dominant = [...attars].sort((a, b) => b.ml - a.ml)[0];
      items.push({ price: slabPrice(product, priceType), quantity: 1, gstRate: product.gst_rate });
      built.push({ product, qty: 1, name: dominant ? (attars.length > 1 ? `${dominant.name}+Blend` : dominant.name) : product.name, cost: 0, recipe, pack, extras, tracked: null });
    }
    for (const [materialId, amount] of usage) {
      const row = stockRow(outlet.id, materialId);
      if (row.stock + 1e-9 < amount) conflict(`Not enough ${row.name} in stock (${stockText(row)} available)`);
    }
    // Cost snapshot at today's average cost: ingredients and packaging, or the tracked item's average cost.
    built.forEach(entry => {
      if (entry.recipe) entry.cost = round2(entry.recipe.reduce((sum, part) => sum + part.ml * stockRow(outlet.id, part.id).cost_per_ml, 0) + (entry.pack ? entry.pack.qty * stockRow(outlet.id, entry.pack.id).cost_per_ml : 0) + entry.extras.reduce((sum, extra) => sum + extra.qty * stockRow(outlet.id, extra.id).cost_per_ml, 0));
      else if (entry.tracked) entry.cost = round2(entry.qty * stockRow(outlet.id, entry.tracked).cost_per_ml);
    });

    const bill = computeBill(items, discount, taxMode());
    // Loyalty points used on this bill pay part of it; the rest is taken as cash, card or UPI.
    const cfg = loyaltyConfig(), redeem = redemption(body, bill.total, customer, outlet, cfg);
    const counter = counterPayments(body, round2(bill.total - redeem.value));

    const at = now(), id = `sale-${crypto.randomBytes(8).toString('hex')}`, number = numbered(outlet, INVOICE_SERIES[priceType]);
    const lines = built.map((entry, index) => ({ product: entry.product.name, name: entry.name, label: entry.product.needs_recipe ? entry.product.name : entry.product.type, qty: entry.qty, price: items[index].price, gstRate: bill.lines[index].rate, taxable: bill.lines[index].taxable, gst: bill.lines[index].gst, total: bill.lines[index].total, cost: entry.cost, recipe: entry.recipe, pack: entry.pack, extras: entry.extras, stockItem: entry.tracked || null }));
    db.prepare('INSERT INTO sales (id, outlet_id, number, date, day, customer_name, customer_phone, tax_mode, subtotal, discount, taxable, cgst, sgst, round_off, total, lines, created_by, price_type, customer_gstin, customer_address, salesman_id, salesman_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, outlet.id, number, at, dateKey(at), customer ? customer.name : name, phone, taxMode(), bill.subtotal, bill.discount, bill.taxable, bill.cgst, bill.sgst, bill.roundOff, bill.total, JSON.stringify(lines), user.id, priceType, buyer.gstin, buyer.address, salesman ? salesman.id : null, salesman ? salesman.name : '');
    for (const [materialId, amount] of usage) {
      const unitCost = stockRow(outlet.id, materialId).cost_per_ml;
      removeStock(outlet.id, materialId, amount);
      ledger(outlet.id, materialId, 'sale', -amount, unitCost, number, null, user.id);
    }
    const tenders = redeem.value > 0 ? [{ mode: 'Loyalty points', amount: redeem.value }, ...counter.applied] : counter.applied;
    tenders.forEach(entry => db.prepare('INSERT INTO payments (kind, ref_id, outlet_id, date, mode, amount, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run('sale', id, outlet.id, at, entry.mode, entry.amount, user.id));
    // Points: spent first, then earned on what the customer really paid (optionally only when the bill is settled in full).
    let earned = 0;
    if (redeem.points > 0) addPoints({ outlet, phone, kind: 'redeem', points: -redeem.points, saleId: id, note: `Used on ${number}`, userId: user.id, cfg });
    if (cfg.enabled && cfg.types.includes(buyer.type)) {
      const settled = round2(counter.applied.reduce((sum, entry) => sum + entry.amount, 0) + redeem.value) >= bill.total - 0.005;
      if (!cfg.paidOnly || settled) earned = Math.floor(round2(bill.total - redeem.value) * cfg.earnPoints / cfg.earnAmount + 1e-9);
      if (earned > 0) addPoints({ outlet, phone, kind: 'earn', points: earned, saleId: id, note: `Earned on ${number}`, userId: user.id, cfg });
    }
    if (earned || redeem.points) db.prepare('UPDATE sales SET points_earned = ?, points_redeemed = ?, points_value = ?, points_balance = ? WHERE id = ?').run(earned, redeem.points, redeem.value, loyaltyState(outlet.id, phone).points, id);
    // `change` is for the counter only (not stored): what to hand back when more cash was given than the bill needed.
    return { ...loadSales('WHERE id = ?', [id])[0], change: counter.change, tendered: counter.tendered };
  });
}

/* ---------- Receipts and payments (vouchers) ---------- */
const paidOn = (kind, id) => db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE kind = ? AND ref_id = ?').get(kind, id).n;
// What is still owed on a bill: its total, less credit notes, less net payments (refunds count as negative).
const creditedOn = saleId => db.prepare('SELECT COALESCE(SUM(total), 0) AS n FROM credit_notes WHERE sale_id = ?').get(saleId).n;
const saleDue = sale => round2(sale.total - creditedOn(sale.id) - paidOn('sale', sale.id));
const purchaseDue = purchase => round2(purchase.total - paidOn('purchase', purchase.id));
// Bills a customer (by mobile number) or a supplier (by name, ignoring case) still owes on, oldest first.
function outstanding(outlet, kind, partyKey) {
  if (kind === 'receipt') return db.prepare('SELECT id, number, customer_name AS name, total FROM sales WHERE outlet_id = ? AND customer_phone = ? ORDER BY date, rowid').all(outlet.id, String(partyKey)).map(row => ({ ...row, due: saleDue(row) })).filter(row => row.due > 0);
  return db.prepare('SELECT id, number, supplier AS name, total FROM purchases WHERE outlet_id = ? AND lower(trim(supplier)) = ? ORDER BY date, rowid').all(outlet.id, String(partyKey).trim().toLowerCase()).map(row => ({ ...row, due: purchaseDue(row) })).filter(row => row.due > 0);
}
// One voucher = one receipt or payment, applied to one or more bills.
function createVoucher({ outlet, user, kind, partyKey, partyName, mode, date, note, picks }) {
  const total = round2(picks.reduce((sum, pick) => sum + pick.amount, 0));
  if (!(total > 0)) bad('Enter an amount greater than 0');
  const day = isDateKey(date) && date <= todayKey() ? date : todayKey(), at = day === todayKey() ? now() : `${day}T12:00:00.000Z`;
  const id = `vch-${crypto.randomBytes(8).toString('hex')}`, number = numbered(outlet, kind === 'receipt' ? 'rct' : 'pay');
  db.prepare('INSERT INTO vouchers (id, outlet_id, kind, number, date, day, party_key, party_name, mode, amount, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, outlet.id, kind, number, at, day, String(partyKey), partyName, mode, total, clean(note, 200), user.id);
  const refKind = kind === 'receipt' ? 'sale' : 'purchase';
  picks.forEach(pick => db.prepare('INSERT INTO payments (kind, ref_id, outlet_id, date, mode, amount, created_by, voucher_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(refKind, pick.id, outlet.id, at, mode, pick.amount, user.id, id));
  return loadVouchers('WHERE id = ?', [id])[0];
}
// Spread an amount over the oldest bills first.
function firstInFirstOut(owing, amount) {
  const totalDue = round2(owing.reduce((sum, bill) => sum + bill.due, 0));
  if (amount > totalDue + 1e-9) bad(`Amount cannot exceed the due ₹${totalDue}`);
  const picks = [];
  let remaining = amount;
  for (const bill of owing) {
    const part = Math.min(remaining, bill.due);
    if (part > 0) { picks.push({ id: bill.id, amount: round2(part) }); remaining = round2(remaining - part); }
  }
  return picks;
}
// POST /api/vouchers: { kind, partyKey, mode, date, note, allocations: [{ id, amount }] } or { amount } to settle oldest bills first.
function saveVoucher({ body, user, outlet }) {
  const kind = body.kind === 'payment' ? 'payment' : body.kind === 'receipt' ? 'receipt' : bad('Choose receipt or payment');
  if (kind === 'payment' && user.role === 'biller') forbid('Your biller login cannot pay suppliers');
  const mode = checkMode(body.mode);
  return tx(() => {
    const owing = outstanding(outlet, kind, body.partyKey);
    if (!owing.length) throw new HttpError(404, kind === 'receipt' ? 'This customer has nothing due' : 'This supplier has nothing due');
    let picks;
    if (Array.isArray(body.allocations) && body.allocations.length) {
      const seen = new Set();
      picks = body.allocations.map(entry => {
        const bill = owing.find(row => row.id === String(entry.id)), amount = round2(Number(entry.amount));
        if (!bill || seen.has(bill.id)) throw new HttpError(404, 'Record not found');
        seen.add(bill.id);
        if (!(amount > 0)) bad('Enter an amount greater than 0 for each bill you are settling');
        if (amount > bill.due + 1e-9) bad(`Amount cannot exceed the due ₹${bill.due}`);
        return { id: bill.id, amount };
      });
    } else {
      const amount = round2(Number(body.amount));
      if (!(amount > 0)) bad('Enter an amount greater than 0');
      picks = firstInFirstOut(owing, amount);
    }
    return createVoucher({ outlet, user, kind, partyKey: body.partyKey, partyName: owing[0].name, mode, date: body.date, note: body.note, picks });
  });
}
function recordPayment({ body, user, outlet }) {
  const amount = round2(Number(body.amount)), mode = checkMode(body.mode);
  if (user.role === 'biller' && body.kind === 'purchase') forbid('Your biller login cannot pay suppliers');
  if (!(amount > 0)) bad('Enter an amount greater than 0');
  if (user.role === 'biller' && body.kind === 'supplier') forbid('Your biller login cannot pay suppliers');
  return tx(() => {
    if (body.kind === 'sale' || body.kind === 'purchase') {
      const isSale = body.kind === 'sale', table = isSale ? 'sales' : 'purchases';
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND outlet_id = ?`).get(String(body.id), outlet.id);
      if (!row) throw new HttpError(404, 'Record not found');
      const due = isSale ? saleDue(row) : purchaseDue(row);
      if (amount > due + 1e-9) bad(`Amount cannot exceed the due ₹${due}`);
      const voucher = createVoucher({ outlet, user, kind: isSale ? 'receipt' : 'payment', partyKey: isSale ? row.customer_phone : row.supplier, partyName: isSale ? row.customer_name : row.supplier, mode, date: body.date, note: body.note, picks: [{ id: row.id, amount }] });
      return { ok: true, voucher };
    }
    if (body.kind === 'customer' || body.kind === 'supplier') {
      const kind = body.kind === 'customer' ? 'receipt' : 'payment', owing = outstanding(outlet, kind, body.id);
      const picks = firstInFirstOut(owing, amount);
      const voucher = createVoucher({ outlet, user, kind, partyKey: body.id, partyName: owing.length ? owing[0].name : String(body.id), mode, date: body.date, note: body.note, picks });
      return { ok: true, voucher };
    }
    return bad('Unknown payment target');
  });
}

/* ---------- Returns (credit notes) ---------- */
function createCreditNote({ body, user, outlet }) {
  const reason = clean(body.reason, 200);
  if (!reason) bad('Give a reason for the return');
  const picks = (Array.isArray(body.lines) ? body.lines : []).map(line => ({ index: Number(line.index), qty: Number(line.qty) })).filter(line => line.qty > 0);
  if (!picks.length) bad('Choose at least one item to return');
  return tx(() => {
    const sale = loadSales('WHERE id = ? AND outlet_id = ?', [String(body.saleId), outlet.id])[0];
    if (!sale) throw new HttpError(404, 'Bill not found');
    const seen = new Set();
    for (const pick of picks) {
      const line = sale.lines[pick.index];
      if (!line || !Number.isInteger(pick.qty) || seen.has(pick.index)) bad('Check the items to return');
      seen.add(pick.index);
      if (pick.qty > line.qty - line.returned) conflict(`Only ${line.qty - line.returned} of ${line.name} can still be returned`);
    }
    const note = computeCreditNote(sale, picks);
    const refund = refundFor(sale, note.total);
    // Money that was paid with loyalty points goes back as points; only the rest is refunded in cash, card or UPI.
    const pointsPaid = round2(sale.payments.filter(payment => payment.mode === 'Loyalty points').reduce((sum, payment) => sum + payment.amount, 0));
    const pointsBack = Math.min(refund, Math.max(0, pointsPaid)), cashRefund = round2(refund - pointsBack);
    if (cashRefund > 0) checkMode(body.refundMode);
    const at = now(), id = `cn-${crypto.randomBytes(8).toString('hex')}`, number = numbered(outlet, 'cn');
    db.prepare('INSERT INTO credit_notes (id, outlet_id, number, date, day, sale_id, sale_number, customer_name, customer_phone, reason, taxable, cgst, sgst, round_off, total, refund, refund_mode, lines, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, outlet.id, number, at, dateKey(at), sale.id, sale.number, sale.customerName, sale.customerPhone, reason, note.taxable, note.cgst, note.sgst, note.roundOff, note.total, refund, cashRefund > 0 ? body.refundMode : pointsBack > 0 ? 'Loyalty points' : '', JSON.stringify(note.lines), user.id);
    // Packed items whose stock is tracked go back on the shelf at their current average cost.
    note.lines.forEach(returned => {
      const original = sale.lines[returned.index];
      if (!original.stockItem) return;
      const unitCost = stockRow(outlet.id, original.stockItem).cost_per_ml;
      addStock(outlet.id, original.stockItem, returned.qty, unitCost);
      ledger(outlet.id, original.stockItem, 'sale_return', returned.qty, unitCost, number, null, user.id);
    });
    // A refund is stored as a negative payment on the bill, so money held always nets correctly.
    if (cashRefund > 0) db.prepare('INSERT INTO payments (kind, ref_id, outlet_id, date, mode, amount, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run('sale', sale.id, outlet.id, at, body.refundMode, -cashRefund, user.id);
    // Loyalty: points that paid for the returned goods come back, and points earned on them are taken back (never below zero).
    if (pointsBack > 0) {
      db.prepare('INSERT INTO payments (kind, ref_id, outlet_id, date, mode, amount, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run('sale', sale.id, outlet.id, at, 'Loyalty points', -pointsBack, user.id);
      const perPoint = sale.pointsRedeemed > 0 ? sale.pointsValue / sale.pointsRedeemed : loyaltyConfig().pointValue;
      addPoints({ outlet, phone: sale.customerPhone, kind: 'return_redeem', points: Math.round(pointsBack / perPoint), saleId: sale.id, note: `Returned on ${sale.number}`, userId: user.id });
    }
    if (sale.pointsEarned > 0) {
      const taken = -db.prepare("SELECT COALESCE(SUM(points), 0) AS n FROM loyalty_ledger WHERE sale_id = ? AND kind = 'return_earn'").get(sale.id).n;
      const due = Math.min(sale.pointsEarned - taken, Math.round(sale.pointsEarned * note.total / sale.total)), available = loyaltyState(outlet.id, sale.customerPhone).points;
      const reverse = Math.max(0, Math.min(due, available));
      if (reverse > 0) addPoints({ outlet, phone: sale.customerPhone, kind: 'return_earn', points: -reverse, saleId: sale.id, note: `Reversed on return from ${sale.number}`, userId: user.id });
    }
    return mapCreditNote(db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(id));
  });
}

/* ---------- Customers and purchases ---------- */
// Salesmen of the outlet you are working in. Anyone can pick one on a bill; staff add, rename and switch them off.
function saveSalesman({ body, params, outlet }) {
  const name = clean(body.name, 60);
  if (!name) bad("Enter the salesman's name");
  if (params.id) {
    const row = db.prepare('SELECT * FROM salesmen WHERE id = ? AND outlet_id = ?').get(Number(params.id), outlet.id);
    if (!row) throw new HttpError(404, 'Salesman not found');
    if (db.prepare('SELECT 1 FROM salesmen WHERE outlet_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(outlet.id, name, row.id)) conflict('There is already a salesman with that name');
    db.prepare('UPDATE salesmen SET name = ?, active = ? WHERE id = ?').run(name, body.active === false ? 0 : 1, row.id);
    return mapSalesman(db.prepare('SELECT * FROM salesmen WHERE id = ?').get(row.id));
  }
  if (db.prepare('SELECT 1 FROM salesmen WHERE outlet_id = ? AND name = ? COLLATE NOCASE').get(outlet.id, name)) conflict('There is already a salesman with that name');
  const info = db.prepare('INSERT INTO salesmen (outlet_id, name) VALUES (?, ?)').run(outlet.id, name);
  return mapSalesman(db.prepare('SELECT * FROM salesmen WHERE id = ?').get(Number(info.lastInsertRowid)));
}
const mapCustomer = row => ({ name: row.name, phone: row.phone, email: row.email, type: row.type, gstin: row.gstin, address: row.address });
// Type, GSTIN and address as entered on the customer form. A franchise must have its own GSTIN.
function partyDetails(body) {
  if (!PRICE_TYPES.includes(body.type)) bad('Choose retailer, wholesaler or franchise');
  const gstin = clean(body.gstin, 15).toUpperCase(), address = clean(body.address, 240);
  if (gstin && !isValidGstin(gstin)) bad('Enter a valid 15-character GSTIN');
  if (body.type === 'franchise' && !gstin) bad('A franchise customer needs its own GSTIN');
  return { type: body.type, gstin, address };
}
// Billing adds retail customers (no type sent). The Customers tab sends a type to add wholesalers and franchisees.
function createCustomer({ body, user, outlet }) {
  const name = clean(body.name), phone = String(body.phone || ''), email = clean(body.email, 120);
  if (!name) bad('Customer name is required');
  if (!isValidPhone(phone)) bad('Enter a valid 10-digit mobile number');
  if (email && !/^\S+@\S+\.\S+$/.test(email)) bad('Enter a valid email address');
  const typed = body.type !== undefined;
  const party = typed ? partyDetails(body) : { type: 'retail', gstin: '', address: '' };
  if (party.type !== 'retail' && user.role === 'biller') forbid('Your biller login can only add retail customers');
  const existing = db.prepare('SELECT * FROM customers WHERE outlet_id = ? AND phone = ?').get(outlet.id, phone);
  if (existing) {
    if (typed) conflict(`This number is already saved for ${existing.name}. Use Edit to change their type`);
    if (existing.name.toLowerCase() !== name.toLowerCase()) conflict(`This number is saved for ${existing.name}`);
    return mapCustomer(existing);
  }
  db.prepare('INSERT INTO customers (outlet_id, name, phone, email, type, gstin, address) VALUES (?, ?, ?, ?, ?, ?, ?)').run(outlet.id, name, phone, email, party.type, party.gstin, party.address);
  return mapCustomer(db.prepare('SELECT * FROM customers WHERE outlet_id = ? AND phone = ?').get(outlet.id, phone));
}
// Change a customer's details or move them between retail, wholesale and franchise. Past bills keep the prices they were made at.
function updateCustomer({ body, params, outlet }) {
  const row = db.prepare('SELECT * FROM customers WHERE outlet_id = ? AND phone = ?').get(outlet.id, params.id);
  if (!row) throw new HttpError(404, 'Customer not found');
  const name = clean(body.name), email = clean(body.email, 120);
  if (!name) bad('Customer name is required');
  if (email && !/^\S+@\S+\.\S+$/.test(email)) bad('Enter a valid email address');
  const party = partyDetails(body);
  db.prepare('UPDATE customers SET name = ?, email = ?, type = ?, gstin = ?, address = ? WHERE id = ?').run(name, email, party.type, party.gstin, party.address, row.id);
  return mapCustomer(db.prepare('SELECT * FROM customers WHERE id = ?').get(row.id));
}

/* ---------- Invoices raised on this outlet by another outlet (e.g. HQ to a franchisee) ---------- */
// Matched by the outlet's own GSTIN: an invoice whose buyer GSTIN is this outlet's GSTIN can be loaded as a purchase.
function franchiseInvoices(outlet) {
  const gstin = String(outlet.gstin || '').trim().toUpperCase();
  if (!gstin) return { gstin: '', invoices: [] };
  const booked = new Map(db.prepare('SELECT source_sale_id, number FROM purchases WHERE outlet_id = ? AND source_sale_id IS NOT NULL').all(outlet.id).map(row => [row.source_sale_id, row.number]));
  const invoices = loadSales('WHERE customer_gstin = ? AND outlet_id <> ?', [gstin, outlet.id]).map(sale => {
    const stockLines = [], skipped = [];
    sale.lines.forEach(line => {
      const available = line.qty - (line.returned || 0), material = line.stockItem ? db.prepare('SELECT id, name, unit FROM materials WHERE id = ?').get(line.stockItem) : null;
      if (available <= 0) return;
      if (!material) { skipped.push(line.name); return; }
      // Cost is the value before GST: the GST paid to the seller is claimed back, not part of the stock cost.
      stockLines.push({ materialId: material.id, name: material.name, unit: material.unit, qty: available, total: round2(line.taxable * available / line.qty) });
    });
    const payable = round2(sale.total - (sale.credited || 0)), stockCost = round2(stockLines.reduce((sum, line) => sum + line.total, 0));
    return { id: sale.id, number: sale.number, date: sale.date, day: sale.day, seller: getOutlet(sale.outletId).name, sellerGstin: getOutlet(sale.outletId).gstin, total: sale.total, credited: sale.credited || 0, payable, stockCost, extra: round2(payable - stockCost), stockLines, skipped, loadedAs: booked.get(sale.id) || null };
  });
  return { gstin, invoices };
}
function createPurchaseFromInvoice({ body, user, outlet }) {
  const invoice = franchiseInvoices(outlet).invoices.find(entry => entry.id === String(body.sourceSaleId));
  if (!invoice) throw new HttpError(404, "That invoice is not addressed to your outlet's GSTIN");
  if (invoice.loadedAs) conflict(`This invoice was already loaded as ${invoice.loadedAs}`);
  const date = isDateKey(body.date) ? body.date : invoice.day;
  const paid = body.paid === '' || body.paid === undefined || body.paid === null ? 0 : round2(Number(body.paid));
  if (!(paid >= 0) || paid > invoice.payable) bad('Paid amount must be between ₹0 and the invoice total');
  if (paid > 0) checkMode(body.mode);
  return tx(() => {
    const id = `pur-${crypto.randomBytes(8).toString('hex')}`, number = numbered(outlet, 'pur');
    const lines = invoice.stockLines.map(line => ({ materialId: line.materialId, name: line.name, qty: line.qty, total: line.total }));
    db.prepare('INSERT INTO purchases (id, outlet_id, number, supplier, invoice_no, date, total, lines, created_by, extra_amount, source_sale_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, outlet.id, number, invoice.seller, invoice.number, date, invoice.payable, JSON.stringify(lines), user.id, invoice.extra, invoice.id);
    lines.forEach(line => { addStock(outlet.id, line.materialId, line.qty, line.total / line.qty); ledger(outlet.id, line.materialId, 'purchase', line.qty, cost4(line.total / line.qty), number, null, user.id, date); });
    if (paid > 0) db.prepare('INSERT INTO payments (kind, ref_id, outlet_id, date, mode, amount, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run('purchase', id, outlet.id, now(), body.mode, paid, user.id);
    return loadPurchases('WHERE id = ?', [id])[0];
  });
}
function createPurchase({ body, user, outlet }) {
  if (body.sourceSaleId) return createPurchaseFromInvoice({ body, user, outlet });
  const supplier = clean(body.supplier);
  if (!supplier) bad('Supplier is required');
  const date = isDateKey(body.date) ? body.date : todayKey();
  const requested = Array.isArray(body.lines) ? body.lines : [];
  if (!requested.length || requested.length > 100) bad('Add at least one material');
  return tx(() => {
    const lines = requested.map(line => {
      const material = db.prepare('SELECT id, name, unit FROM materials WHERE id = ?').get(String(line.materialId));
      const qty = round2(Number(line.qty)), total = round2(Number(line.total));
      if (!material || !(qty > 0) || qty > 1e6 || !(total >= 0)) bad('Check the material lines');
      wholeIfPcs(material.unit, qty, material.name);
      return { materialId: material.id, name: material.name, qty, total };
    });
    const total = round2(lines.reduce((sum, line) => sum + line.total, 0));
    const paid = body.paid === '' || body.paid === undefined || body.paid === null ? total : round2(Number(body.paid));
    if (!(paid >= 0) || paid > total) bad('Paid amount must be between ₹0 and the purchase total');
    if (paid > 0) checkMode(body.mode);
    const id = `pur-${crypto.randomBytes(8).toString('hex')}`, number = numbered(outlet, 'pur');
    db.prepare('INSERT INTO purchases (id, outlet_id, number, supplier, invoice_no, date, total, lines, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, outlet.id, number, supplier, clean(body.invoiceNo, 60), date, total, JSON.stringify(lines), user.id);
    lines.forEach(line => { addStock(outlet.id, line.materialId, line.qty, line.total / line.qty); ledger(outlet.id, line.materialId, 'purchase', line.qty, cost4(line.total / line.qty), number, null, user.id, date); });
    if (paid > 0) db.prepare('INSERT INTO payments (kind, ref_id, outlet_id, date, mode, amount, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run('purchase', id, outlet.id, now(), body.mode, paid, user.id);
    return loadPurchases('WHERE id = ?', [id])[0];
  });
}

/* ---------- Expenses ---------- */
function createExpense({ body, user, outlet }) {
  const category = String(body.category || ''), amount = round2(Number(body.amount));
  if (!EXPENSE_CATEGORIES.includes(category)) bad('Choose an expense category');
  if (!(amount > 0) || amount > 1e8) bad('Enter an amount greater than 0');
  const description = clean(body.description, 200);
  if (category === 'Other' && !description) bad('Describe what this expense was for');
  const date = isDateKey(body.date) ? body.date : todayKey();
  const info = db.prepare('INSERT INTO expenses (outlet_id, date, category, description, amount, mode, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(outlet.id, date, category, description, amount, checkMode(body.mode), user.id);
  return mapExpense(db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(info.lastInsertRowid)));
}
function deleteExpense({ params, user, outlet }) {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(params.id));
  // Managers can only remove their own outlet's entries; HQ can correct any outlet.
  if (!row || (user.role !== 'admin' && row.outlet_id !== outlet.id)) throw new HttpError(404, 'Expense not found');
  db.prepare('DELETE FROM expenses WHERE id = ?').run(row.id);
  return { ok: true };
}

/* ---------- Stock verification: count the shelves, compare with the system, update to the physical stock ---------- */
const mapCount = row => ({ id: row.id, outletId: row.outlet_id, number: row.number, status: row.status, blind: Boolean(row.blind), startedAt: row.started_at, completedAt: row.completed_at, startedBy: row.starter || '', completedBy: row.completer || '', note: row.note, varianceValue: row.variance_value, lines: JSON.parse(row.lines) });
const COUNT_SQL = 'SELECT c.*, u1.name AS starter, u2.name AS completer FROM stock_counts c LEFT JOIN users u1 ON u1.id = c.created_by LEFT JOIN users u2 ON u2.id = c.completed_by';
const loadCounts = (where = '', params = []) => db.prepare(`${COUNT_SQL} ${where} ORDER BY c.started_at DESC, c.rowid DESC`).all(...params).map(mapCount);
const openCountRow = outletId => db.prepare("SELECT * FROM stock_counts WHERE outlet_id = ? AND status = 'draft'").get(outletId);

function startStockCount({ body, user, outlet }) {
  if (openCountRow(outlet.id)) conflict('A count is already in progress. Finish or cancel it first');
  const wanted = Array.isArray(body.materialIds) && body.materialIds.length ? new Set(body.materialIds.map(String)) : null;
  // The snapshot freezes what the system believes at this moment, so the variance is measured against it.
  const lines = loadMaterials(outlet.id).filter(material => !wanted || wanted.has(material.id))
    .map(material => ({ materialId: material.id, name: material.name, type: material.type, unit: material.unit, system: material.stock, cost: material.costPerMl, physical: null, reason: '' }));
  if (!lines.length) bad('There is nothing to count');
  const id = `cnt-${crypto.randomBytes(6).toString('hex')}`;
  tx(() => db.prepare("INSERT INTO stock_counts (id, outlet_id, number, status, blind, started_at, note, lines, created_by) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)").run(id, outlet.id, numbered(outlet, 'cnt'), body.blind ? 1 : 0, now(), clean(body.note, 300), JSON.stringify(lines), user.id));
  return loadCounts('WHERE c.id = ?', [id])[0];
}
// Applies the entered physical quantities and reasons onto the frozen snapshot (draft counts only).
function applyCountEntries(row, body) {
  const lines = JSON.parse(row.lines);
  for (const entry of Array.isArray(body.lines) ? body.lines : []) {
    const line = lines.find(item => item.materialId === String(entry.materialId));
    if (!line) bad('That item is not part of this count');
    const blank = entry.physical === null || entry.physical === undefined || entry.physical === '';
    const physical = blank ? null : round2(Number(entry.physical));
    if (!blank && !(physical >= 0)) bad(`${line.name}: the physical quantity cannot be negative`);
    if (!blank) wholeIfPcs(line.unit, physical, line.name);
    line.physical = physical;
    line.reason = clean(entry.reason, 200);
  }
  return lines;
}
function saveStockCount({ body, params, outlet }) {
  const row = db.prepare('SELECT * FROM stock_counts WHERE id = ? AND outlet_id = ?').get(params.id, outlet.id);
  if (!row) throw new HttpError(404, 'Count not found');
  if (row.status !== 'draft') conflict('This count is already closed');
  const lines = applyCountEntries(row, body);
  db.prepare('UPDATE stock_counts SET lines = ?, note = ? WHERE id = ?').run(JSON.stringify(lines), body.note === undefined ? row.note : clean(body.note, 300), row.id);
  return loadCounts('WHERE c.id = ?', [row.id])[0];
}
function completeStockCount({ body, params, user, outlet }) {
  const row = db.prepare('SELECT * FROM stock_counts WHERE id = ? AND outlet_id = ?').get(params.id, outlet.id);
  if (!row) throw new HttpError(404, 'Count not found');
  if (row.status !== 'draft') conflict('This count is already closed');
  return tx(() => {
    const lines = applyCountEntries(row, body);
    const counted = lines.filter(line => line.physical !== null);
    if (!counted.length) bad('Enter the physical quantity for at least one item');
    let total = 0;
    for (const line of counted) {
      const delta = round2(line.physical - line.system);
      const current = stockRow(outlet.id, line.materialId);
      // Sales and purchases made during the count are kept: only the counted difference is applied to today's stock.
      const after = round2(current.stock + delta);
      if (after < -1e-9) conflict(`${line.name}: stock has moved since the count started, so this difference no longer fits. Cancel and recount`);
      line.delta = delta; line.before = current.stock; line.after = after; line.value = round2(delta * line.cost);
      total += line.value;
      if (delta !== 0) {
        db.prepare('UPDATE outlet_stock SET stock = ? WHERE outlet_id = ? AND material_id = ?').run(after, outlet.id, line.materialId);
        ledger(outlet.id, line.materialId, 'stock_take', delta, current.cost_per_ml, row.number, line.reason || 'Stock verification', user.id);
      }
    }
    db.prepare("UPDATE stock_counts SET status = 'completed', completed_at = ?, completed_by = ?, lines = ?, variance_value = ?, note = ? WHERE id = ?")
      .run(now(), user.id, JSON.stringify(lines), round2(total), body.note === undefined ? row.note : clean(body.note, 300), row.id);
    return loadCounts('WHERE c.id = ?', [row.id])[0];
  });
}
function cancelStockCount({ params, outlet }) {
  const row = db.prepare('SELECT * FROM stock_counts WHERE id = ? AND outlet_id = ?').get(params.id, outlet.id);
  if (!row) throw new HttpError(404, 'Count not found');
  if (row.status !== 'draft') conflict('This count is already closed');
  db.prepare("UPDATE stock_counts SET status = 'cancelled' WHERE id = ?").run(row.id);
  return loadCounts('WHERE c.id = ?', [row.id])[0];
}

/* ---------- Opening stock and adjustments ---------- */
function setOpeningStock({ body, user, outlet }) {
  const asOf = isDateKey(body.asOf) ? body.asOf : todayKey();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) bad('Enter opening stock for at least one material');
  return tx(() => {
    for (const item of items) {
      const material = db.prepare('SELECT id, name, unit FROM materials WHERE id = ?').get(String(item.materialId));
      const qty = round2(num(item.qty)), cost = cost4(num(item.costPerMl));
      if (!material || !(qty >= 0) || !(cost >= 0)) bad('Opening quantity and cost must be 0 or more');
      wholeIfPcs(material.unit, qty, material.name);
      const locked = db.prepare("SELECT 1 AS n FROM stock_ledger WHERE outlet_id = ? AND material_id = ? AND kind <> 'opening' LIMIT 1").get(outlet.id, material.id);
      if (locked) conflict(`${material.name} already has stock movements. Use a stock adjustment instead`);
      db.prepare('UPDATE outlet_stock SET stock = ?, cost_per_ml = ? WHERE outlet_id = ? AND material_id = ?').run(qty, cost, outlet.id, material.id);
      ledger(outlet.id, material.id, 'opening', qty, cost, null, null, user.id, asOf);
    }
    return { ok: true };
  });
}
function adjustStock({ body, user, outlet }) {
  const delta = round2(Number(body.delta)), reason = clean(body.reason, 200);
  if (!delta || !Number.isFinite(delta)) bad('Enter a quantity to add or remove');
  if (!reason) bad('Give a reason for the adjustment');
  return tx(() => {
    const row = stockRow(outlet.id, String(body.materialId));
    if (!row) throw new HttpError(404, 'Material not found');
    wholeIfPcs(row.unit, delta, row.name);
    if (delta > 0) addStock(outlet.id, row.material_id, delta, row.cost_per_ml); else removeStock(outlet.id, row.material_id, -delta);
    ledger(outlet.id, row.material_id, 'adjustment', delta, row.cost_per_ml, null, reason, user.id);
    return { ok: true };
  });
}
function setAlert({ body, outlet, params }) {
  const alertMl = num(body.alertMl);
  if (!(alertMl >= 0)) bad('Enter an alert level of 0 or more');
  if (!stockRow(outlet.id, params.id)) throw new HttpError(404, 'Material not found');
  db.prepare('UPDATE outlet_stock SET alert_ml = ? WHERE outlet_id = ? AND material_id = ?').run(alertMl, outlet.id, params.id);
  return { ok: true };
}

/* ---------- Stock transfers (HQ to outlet) ---------- */
function createTransfer({ body, user }) {
  const hq = hqOutlet(), target = getOutlet(Number(body.toOutletId));
  if (!target || target.type !== 'franchise' || !target.active) bad('Choose an active franchise outlet');
  const requested = Array.isArray(body.lines) ? body.lines : [];
  if (!requested.length) bad('Add at least one material');
  return tx(() => {
    const seen = new Set();
    const lines = requested.map(line => {
      const row = stockRow(hq.id, String(line.materialId));
      const qty = round2(Number(line.qty)), rate = cost4(Number(line.rate));
      if (!row || seen.has(row.material_id) || !(qty > 0) || !(rate >= 0)) bad('Check the material lines');
      wholeIfPcs(row.unit, qty, row.name);
      seen.add(row.material_id);
      return { materialId: row.material_id, name: row.name, unit: row.unit, qty, rate };
    });
    lines.forEach(line => { removeStock(hq.id, line.materialId, line.qty); });
    const id = `trf-${crypto.randomBytes(8).toString('hex')}`;
    const year = new Date().getFullYear(), number = `TRF-${year}-${String(nextCounter(`trf:${year}`)).padStart(4, '0')}`;
    const value = round2(lines.reduce((sum, line) => sum + line.qty * line.rate, 0));
    db.prepare("INSERT INTO transfers (id, number, from_outlet, to_outlet, date, status, lines, value, note, created_by) VALUES (?, ?, ?, ?, ?, 'in_transit', ?, ?, ?, ?)")
      .run(id, number, hq.id, target.id, now(), JSON.stringify(lines), value, clean(body.note, 200), user.id);
    lines.forEach(line => ledger(hq.id, line.materialId, 'transfer_out', -line.qty, line.rate, number, `To ${target.code}`, user.id));
    return mapTransfer(db.prepare('SELECT * FROM transfers WHERE id = ?').get(id));
  });
}
function receiveTransfer({ params, user, outlet }) {
  return tx(() => {
    const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(params.id);
    if (!transfer) throw new HttpError(404, 'Transfer not found');
    if (user.role !== 'admin' && transfer.to_outlet !== outlet.id) forbid();
    if (transfer.status !== 'in_transit') conflict('This transfer is no longer in transit');
    const source = getOutlet(transfer.from_outlet);
    JSON.parse(transfer.lines).forEach(line => { addStock(transfer.to_outlet, line.materialId, line.qty, line.rate); ledger(transfer.to_outlet, line.materialId, 'transfer_in', line.qty, line.rate, transfer.number, `From ${source.code}`, user.id); });
    db.prepare("UPDATE transfers SET status = 'received', received_by = ?, received_at = ? WHERE id = ?").run(user.id, now(), transfer.id);
    return mapTransfer(db.prepare('SELECT * FROM transfers WHERE id = ?').get(transfer.id));
  });
}
function cancelTransfer({ params, user }) {
  return tx(() => {
    const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(params.id);
    if (!transfer) throw new HttpError(404, 'Transfer not found');
    if (transfer.status !== 'in_transit') conflict('Only transfers in transit can be cancelled');
    JSON.parse(transfer.lines).forEach(line => { addStock(transfer.from_outlet, line.materialId, line.qty, stockRow(transfer.from_outlet, line.materialId).cost_per_ml); ledger(transfer.from_outlet, line.materialId, 'transfer_cancel', line.qty, line.rate, transfer.number, 'Cancelled', user.id); });
    db.prepare("UPDATE transfers SET status = 'cancelled' WHERE id = ?").run(transfer.id);
    return mapTransfer(db.prepare('SELECT * FROM transfers WHERE id = ?').get(transfer.id));
  });
}

/* ---------- Manufacturing: blends, R&D and production runs (HQ only) ---------- */
// Formulas are trade secrets, so they are only ever served through admin routes.
const FORMULA_STATUS = { signature: ['active', 'retired'], rnd: ['idea', 'testing', 'approved', 'launched', 'dropped'] };
const mapFormula = (row, versions) => ({
  id: row.id, name: row.name, kind: row.kind, productId: row.product_id, status: row.status, brief: row.brief, targetPrice: row.target_price, currentVersion: row.current_version, createdAt: row.created_at,
  versions: versions.map(entry => ({ version: entry.version, unitMl: entry.unit_ml, lines: JSON.parse(entry.lines), pack: entry.pack ? JSON.parse(entry.pack) : null, notes: entry.notes, rating: entry.rating, createdAt: entry.created_at }))
});
const mapRun = row => ({ id: row.id, outletId: row.outlet_id, number: row.number, kind: row.kind, formulaId: row.formula_id, formulaName: row.formula_name, version: row.version, productId: row.product_id, productName: row.product_name, units: row.units, date: row.date, day: row.day, lines: JSON.parse(row.lines), totalCost: row.total_cost, unitCost: row.unit_cost, note: row.note });
function loadFormulas(where = '', params = []) {
  const versions = new Map();
  db.prepare('SELECT * FROM formula_versions ORDER BY formula_id, version').all().forEach(entry => { if (!versions.has(entry.formula_id)) versions.set(entry.formula_id, []); versions.get(entry.formula_id).push(entry); });
  return db.prepare(`SELECT * FROM formulas ${where} ORDER BY created_at DESC, rowid DESC`).all(...params).map(row => mapFormula(row, versions.get(row.id) || []));
}
function manufacturingData() {
  return { formulas: loadFormulas(), runs: db.prepare('SELECT * FROM production_runs ORDER BY date DESC, rowid DESC').all().map(mapRun) };
}
// Validates ingredients (ml stock items) and optional packaging (pieces) for one finished unit.
function parseBlend(body) {
  const lines = [];
  for (const part of Array.isArray(body.lines) ? body.lines : []) {
    const material = db.prepare('SELECT id, unit FROM materials WHERE id = ?').get(String(part.materialId));
    const ml = round2(Number(part.ml));
    if (!material || material.unit !== 'ml' || !(ml > 0) || lines.some(line => line.materialId === material.id)) bad('Check the ingredients: each must be a liquid item with an amount above 0, listed once');
    lines.push({ materialId: material.id, ml });
  }
  if (!lines.length) bad('Add at least one ingredient');
  const unitMl = round2(lines.reduce((sum, line) => sum + line.ml, 0));
  if (unitMl > 1000) bad('One bottle cannot be more than 1000ml');
  let pack = null;
  if (body.pack && body.pack.materialId) {
    const material = db.prepare('SELECT id, unit FROM materials WHERE id = ?').get(String(body.pack.materialId));
    const qty = Number(body.pack.qty || 1);
    if (!material || material.unit !== 'pcs' || !Number.isInteger(qty) || qty < 1 || qty > 99) bad('Packaging must be an item counted in pieces (1 to 99 per bottle)');
    pack = { materialId: material.id, qty };
  }
  return { unitMl, lines, pack, notes: clean(body.notes, 2000) };
}
function insertVersion(formulaId, version, blend, userId) {
  db.prepare('INSERT INTO formula_versions (formula_id, version, unit_ml, lines, pack, notes, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(formulaId, version, blend.unitMl, JSON.stringify(blend.lines), blend.pack ? JSON.stringify(blend.pack) : null, blend.notes, now(), userId);
}
function createFormula({ body, user }) {
  const kind = body.kind === 'rnd' ? 'rnd' : 'signature';
  const name = clean(body.name);
  if (!name) bad('Give the blend a name');
  if (db.prepare('SELECT 1 FROM formulas WHERE name = ? COLLATE NOCASE AND kind = ?').get(name, kind)) conflict('A blend with this name already exists');
  const blend = parseBlend(body);
  let productId = null;
  if (kind === 'signature' && body.productId) {
    const product = db.prepare('SELECT id, needs_recipe FROM products WHERE id = ?').get(String(body.productId));
    if (!product || product.needs_recipe) bad('Link the blend to a packed product');
    if (db.prepare("SELECT 1 FROM formulas WHERE product_id = ? AND kind = 'signature'").get(product.id)) conflict('That product already has a blend. Add a new version to it instead');
    productId = product.id;
  }
  const status = kind === 'rnd' ? (FORMULA_STATUS.rnd.includes(body.status) ? body.status : 'idea') : 'active';
  const targetPrice = Math.max(0, Math.round(num(body.targetPrice) || 0));
  const id = `frm-${crypto.randomBytes(6).toString('hex')}`;
  tx(() => {
    db.prepare('INSERT INTO formulas (id, name, kind, product_id, status, brief, target_price, current_version, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').run(id, name, kind, productId, status, clean(body.brief, 1000), targetPrice, now(), user.id);
    insertVersion(id, 1, blend, user.id);
  });
  return loadFormulas('WHERE id = ?', [id])[0];
}
function addFormulaVersion({ body, params, user }) {
  const formula = db.prepare('SELECT * FROM formulas WHERE id = ?').get(params.id);
  if (!formula) throw new HttpError(404, 'Blend not found');
  const blend = parseBlend(body);
  tx(() => {
    const next = db.prepare('SELECT MAX(version) AS v FROM formula_versions WHERE formula_id = ?').get(formula.id).v + 1;
    insertVersion(formula.id, next, blend, user.id);
    db.prepare('UPDATE formulas SET current_version = ? WHERE id = ?').run(next, formula.id);
  });
  return loadFormulas('WHERE id = ?', [formula.id])[0];
}
function updateFormula({ body, params }) {
  const formula = db.prepare('SELECT * FROM formulas WHERE id = ?').get(params.id);
  if (!formula) throw new HttpError(404, 'Blend not found');
  const name = clean(body.name) || formula.name;
  if (db.prepare('SELECT 1 FROM formulas WHERE name = ? COLLATE NOCASE AND kind = ? AND id <> ?').get(name, formula.kind, formula.id)) conflict('A blend with this name already exists');
  const status = FORMULA_STATUS[formula.kind].includes(body.status) ? body.status : formula.status;
  let productId = formula.product_id;
  if (formula.kind === 'signature' && body.productId !== undefined) {
    if (body.productId) {
      const product = db.prepare('SELECT id, needs_recipe FROM products WHERE id = ?').get(String(body.productId));
      if (!product || product.needs_recipe) bad('Link the blend to a packed product');
      if (db.prepare("SELECT 1 FROM formulas WHERE product_id = ? AND kind = 'signature' AND id <> ?").get(product.id, formula.id)) conflict('That product already has a blend');
      productId = product.id;
    } else productId = null;
  }
  db.prepare('UPDATE formulas SET name = ?, status = ?, brief = ?, target_price = ?, product_id = ? WHERE id = ?')
    .run(name, status, body.brief === undefined ? formula.brief : clean(body.brief, 1000), body.targetPrice === undefined ? formula.target_price : Math.max(0, Math.round(num(body.targetPrice) || 0)), productId, formula.id);
  return loadFormulas('WHERE id = ?', [formula.id])[0];
}
function updateFormulaVersion({ body, params }) {
  const row = db.prepare('SELECT * FROM formula_versions WHERE formula_id = ? AND version = ?').get(params.id, Number(params.version));
  if (!row) throw new HttpError(404, 'Version not found');
  const rating = body.rating === null || body.rating === '' || body.rating === undefined ? null : Number(body.rating);
  if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) bad('Rating must be between 1 and 5');
  db.prepare('UPDATE formula_versions SET notes = ?, rating = ? WHERE formula_id = ? AND version = ?').run(clean(body.notes, 2000), rating, row.formula_id, row.version);
  return loadFormulas('WHERE id = ?', [row.formula_id])[0];
}
function setCurrentVersion({ body, params }) {
  const row = db.prepare('SELECT 1 FROM formula_versions WHERE formula_id = ? AND version = ?').get(params.id, Number(body.version));
  if (!row) throw new HttpError(404, 'Version not found');
  db.prepare('UPDATE formulas SET current_version = ? WHERE id = ?').run(Number(body.version), params.id);
  return loadFormulas('WHERE id = ?', [params.id])[0];
}
// A packed product keeps its own stock item (counted in pieces) so production can add finished bottles to it.
function ensureStockItem(product) {
  if (product.stock_material_id) return product.stock_material_id;
  const stockName = `${product.name} (packed stock)`;
  if (nameTaken(stockName)) conflict('A stock item with this name already exists');
  let stockId = `stock-${slugify(product.name)}`;
  for (let suffix = 2; db.prepare('SELECT 1 FROM materials WHERE id = ?').get(stockId); suffix += 1) stockId = `stock-${slugify(product.name)}-${suffix}`;
  db.prepare("INSERT INTO materials (id, name, type, art, category, default_alert, unit, code) VALUES (?, ?, 'Packed product', ?, 'other', 5, 'pcs', ?)").run(stockId, stockName, product.art, nextItemCode());
  ensureStockRows();
  db.prepare('UPDATE products SET stock_material_id = ? WHERE id = ?').run(stockId, product.id);
  return stockId;
}
// R&D to launch: create the packed product and give it a signature blend copied from the chosen trial.
function promoteFormula({ body, params, user }) {
  const project = db.prepare("SELECT * FROM formulas WHERE id = ? AND kind = 'rnd'").get(params.id);
  if (!project) throw new HttpError(404, 'R&D project not found');
  if (project.status === 'launched') conflict('This project has already been launched');
  const version = db.prepare('SELECT * FROM formula_versions WHERE formula_id = ? AND version = ?').get(project.id, Number(body.version) || project.current_version);
  if (!version) throw new HttpError(404, 'Version not found');
  const name = clean(body.productName), price = Math.round(num(body.price)), gstRate = num(body.gstRate);
  if (!name) bad('Give the new product a name');
  if (!(price > 0)) bad('Enter a selling price greater than 0');
  if (!GST_RATES.includes(gstRate)) bad('Choose a valid GST rate');
  if (nameTaken(name)) conflict('A product with this name already exists');
  if (db.prepare("SELECT 1 FROM formulas WHERE name = ? COLLATE NOCASE AND kind = 'signature'").get(name)) conflict('A signature blend with this name already exists');
  return tx(() => {
    let id = slugify(name);
    for (let suffix = 2; db.prepare('SELECT 1 FROM products WHERE id = ?').get(id) || db.prepare('SELECT 1 FROM materials WHERE id = ?').get(id); suffix += 1) id = `${slugify(name)}-${suffix}`;
    const art = ART.includes(body.art) ? body.art : 'plum';
    db.prepare("INSERT INTO products (id, code, name, type, price, wholesale_price, franchise_price, gst_rate, cost, category, art, format, signature, needs_recipe, recipe_ml) VALUES (?, ?, ?, 'Packed perfume', ?, ?, ?, ?, 0, 'signature', ?, 'signature', 1, 0, 0)").run(id, nextProductCode(), name, price, price, price, gstRate, art);
    ensureStockItem(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
    const formulaId = `frm-${crypto.randomBytes(6).toString('hex')}`;
    db.prepare("INSERT INTO formulas (id, name, kind, product_id, status, brief, target_price, current_version, created_at, created_by) VALUES (?, ?, 'signature', ?, 'active', ?, ?, 1, ?, ?)").run(formulaId, name, id, `Launched from R&D project ${project.name} (trial ${version.version})`, price, now(), user.id);
    insertVersion(formulaId, 1, { unitMl: version.unit_ml, lines: JSON.parse(version.lines), pack: version.pack ? JSON.parse(version.pack) : null, notes: version.notes }, user.id);
    db.prepare("UPDATE formulas SET status = 'launched', product_id = ? WHERE id = ?").run(id, project.id);
    return { productId: id, formulaId };
  });
}
// A batch turns ingredients and packaging into finished packed stock; a sample only uses materials (R&D).
function createProductionRun({ body, user, outlet }) {
  const formula = db.prepare('SELECT * FROM formulas WHERE id = ?').get(String(body.formulaId));
  if (!formula) throw new HttpError(404, 'Blend not found');
  const kind = body.kind === 'sample' ? 'sample' : 'batch';
  const units = Number(body.units);
  if (!Number.isInteger(units) || units < 1 || units > (kind === 'sample' ? 50 : 10000)) bad(kind === 'sample' ? 'A sample run is 1 to 50 bottles' : 'Enter a whole number of bottles (up to 10,000)');
  if (kind === 'batch' && (formula.kind !== 'signature' || !formula.product_id)) bad('Link the blend to a packed product before producing it');
  const versionRow = db.prepare('SELECT * FROM formula_versions WHERE formula_id = ? AND version = ?').get(formula.id, Number(body.version) || formula.current_version);
  if (!versionRow) throw new HttpError(404, 'Version not found');
  const date = isDateKey(body.date) ? body.date : todayKey();
  return tx(() => {
    const need = new Map();
    JSON.parse(versionRow.lines).forEach(line => need.set(line.materialId, round2((need.get(line.materialId) || 0) + line.ml * units)));
    const pack = versionRow.pack ? JSON.parse(versionRow.pack) : null;
    if (pack) need.set(pack.materialId, round2((need.get(pack.materialId) || 0) + pack.qty * units));
    let total = 0;
    const consumed = [];
    for (const [materialId, qty] of need) {
      const row = stockRow(outlet.id, materialId);
      if (row.stock + 1e-9 < qty) conflict(`Not enough ${row.name}: this run needs ${row.unit === 'pcs' ? `${qty} pcs` : `${qty.toFixed(2)}ml`} and ${stockText(row)} is in stock`);
      const cost = round2(qty * row.cost_per_ml);
      total += cost;
      consumed.push({ id: materialId, name: row.name, unit: row.unit, qty, cost });
    }
    total = round2(total);
    const unitCost = cost4(total / units);
    const number = numbered(outlet, 'prd');
    const at = now(), id = `run-${crypto.randomBytes(6).toString('hex')}`;
    consumed.forEach(entry => { removeStock(outlet.id, entry.id, entry.qty); ledger(outlet.id, entry.id, kind === 'batch' ? 'production_use' : 'sample_use', -entry.qty, cost4(entry.cost / entry.qty), number, formula.name, user.id, date); });
    let product = null;
    if (kind === 'batch') {
      product = db.prepare('SELECT * FROM products WHERE id = ?').get(formula.product_id);
      const stockId = ensureStockItem(product);
      addStock(outlet.id, stockId, units, unitCost);
      ledger(outlet.id, stockId, 'production_output', units, unitCost, number, formula.name, user.id, date);
    }
    db.prepare('INSERT INTO production_runs (id, outlet_id, number, kind, formula_id, formula_name, version, product_id, product_name, units, date, day, lines, total_cost, unit_cost, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, outlet.id, number, kind, formula.id, formula.name, versionRow.version, product ? product.id : null, product ? product.name : '', units, at, date, JSON.stringify(consumed), total, unitCost, clean(body.note, 300), user.id);
    return mapRun(db.prepare('SELECT * FROM production_runs WHERE id = ?').get(id));
  });
}

/* ---------- HQ: catalog, outlets, users, royalty ---------- */
// Item code (short, unique) and EAN/barcode (optional, unique). Blank code means "assign the next one".
function parseItemIds(body, exceptId) {
  const code = String(body.code ?? '').trim().toUpperCase(), ean = String(body.ean ?? '').trim();
  if (code && !/^[A-Z0-9._-]{1,20}$/.test(code)) bad('Item code can use letters, digits, dots and dashes (up to 20 characters)');
  if (ean && !/^[A-Za-z0-9-]{4,20}$/.test(ean)) bad('EAN / barcode must be 4 to 20 letters or digits');
  if (code && db.prepare('SELECT 1 FROM materials WHERE code = ? COLLATE NOCASE AND id <> ?').get(code, exceptId || '')) conflict('That item code is already used');
  if (ean && db.prepare('SELECT 1 FROM materials WHERE ean = ? AND id <> ?').get(ean, exceptId || '')) conflict('That EAN / barcode belongs to another item');
  return { code, ean: ean || null };
}
function saveMaterial({ body, params }) {
  const name = clean(body.name), art = ART.includes(body.art) ? body.art : 'amber';
  if (!name) bad('Product name is required');
  if (params.id) {
    if (!db.prepare('SELECT 1 FROM materials WHERE id = ?').get(params.id)) throw new HttpError(404, 'Material not found');
    if (nameTaken(name, params.id)) conflict('A product with this name already exists');
    const ids = parseItemIds(body, params.id);
    const existing = db.prepare('SELECT code FROM materials WHERE id = ?').get(params.id);
    db.prepare('UPDATE materials SET name = ?, art = ?, code = ?, ean = ? WHERE id = ?').run(name, art, ids.code || existing.code, ids.ean, params.id);
    return { id: params.id };
  }
  if (nameTaken(name)) conflict('A product with this name already exists');
  const ids = parseItemIds(body, '');
  const type = ['Raw material', 'Packaging'].includes(body.type) ? body.type : 'Attar stock';
  const unit = body.unit === 'pcs' ? 'pcs' : 'ml';
  const alert = Number.isFinite(num(body.alertMl)) && num(body.alertMl) >= 0 ? num(body.alertMl) : (unit === 'pcs' ? 5 : 50);
  let id = slugify(name), suffix = 2;
  while (db.prepare('SELECT 1 FROM materials WHERE id = ?').get(id) || db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) id = `${slugify(name)}-${suffix++}`;
  tx(() => { db.prepare("INSERT INTO materials (id, name, type, art, category, default_alert, unit, code, ean) VALUES (?, ?, ?, ?, 'other', ?, ?, ?, ?)").run(id, name, type, art, alert, unit, ids.code || nextItemCode(), ids.ean); ensureStockRows(); });
  return { id };
}
function saveProduct({ body, params }) {
  const name = clean(body.name), art = ART.includes(body.art) ? body.art : 'amber';
  const price = round2(num(body.price)), gstRate = num(body.gstRate), cost = round2(num(body.cost) || 0);
  // Needs the production screen: the outlet records the exact blend when selling. Otherwise it is added straight to the bill.
  const needsRecipe = Boolean(body.needsRecipe), recipeMl = round2(num(body.recipeMl));
  if (!name) bad('Product name is required');
  if (!(price > 0)) bad('Enter a price greater than 0');
  if (!GST_RATES.includes(gstRate)) bad('Choose a valid GST rate');
  if (!(cost >= 0)) bad('Enter a cost of 0 or more');
  if (needsRecipe && !(recipeMl > 0 && recipeMl <= 1000)) bad('Enter the recipe volume in ml (up to 1000)');
  // The material that fills the rest of the bottle on the production screen (must be measured in ml).
  let fillId = null;
  if (needsRecipe && body.fillMaterialId) {
    const fill = db.prepare('SELECT id, unit FROM materials WHERE id = ?').get(String(body.fillMaterialId));
    if (!fill || fill.unit !== 'ml') bad('The top-up material must be measured in ml');
    fillId = fill.id;
  }
  // Packed products can carry a size for the catalog ("Packed perfume · 50ml").
  const sizeMl = needsRecipe ? 0 : round2(num(body.sizeMl) || 0);
  if (sizeMl < 0 || sizeMl > 10000) bad('Enter a size in ml between 0 and 10000');
  let packId = null, packQty = 1;
  if (needsRecipe && body.packMaterialId) {
    const pack = db.prepare('SELECT id, unit FROM materials WHERE id = ?').get(String(body.packMaterialId));
    if (!pack || pack.unit !== 'pcs') bad('Packaging must be an item counted in pieces');
    packId = pack.id; packQty = Math.round(num(body.packQty) || 1);
    if (!(packQty >= 1 && packQty <= 99)) bad('Packaging quantity must be between 1 and 99');
  }
  const existing = params.id ? db.prepare('SELECT * FROM products WHERE id = ?').get(params.id) : null;
  if (params.id && !existing) throw new HttpError(404, 'Product not found');
  if (nameTaken(name, params.id)) conflict('A product with this name already exists');
  // Wholesale and franchise prices: kept as they were when not sent; a new product starts at the retail price.
  const slab = (value, fallback) => { if (value === undefined || value === null || value === '') return fallback; const amount = round2(num(value)); if (!(amount > 0)) bad('Wholesale and franchise prices must be greater than 0'); return amount; };
  const wholesale = slab(body.wholesalePrice, existing ? existing.wholesale_price ?? existing.price : price), franchise = slab(body.franchisePrice, existing ? existing.franchise_price ?? existing.price : price);
  // Counting packed stock in pieces: the product gets its own stock item, managed like any other (opening stock, purchases, transfers).
  let stockId = existing ? existing.stock_material_id : null;
  if (!needsRecipe && body.trackStock && !stockId) {
    const stockName = name + ' (packed stock)';
    if (nameTaken(stockName)) conflict('A stock item with this name already exists');
    stockId = 'stock-' + slugify(name);
    for (let suffix = 2; db.prepare('SELECT 1 FROM materials WHERE id = ?').get(stockId); suffix += 1) stockId = 'stock-' + slugify(name) + '-' + suffix;
    db.prepare("INSERT INTO materials (id, name, type, art, category, default_alert, unit, code) VALUES (?, ?, 'Packed product', ?, 'other', 5, 'pcs', ?)").run(stockId, stockName, art, nextItemCode());
    ensureStockRows();
  }
  const type = needsRecipe ? (existing && existing.needs_recipe && existing.recipe_ml === recipeMl ? existing.type : 'Custom blend · ' + recipeMl + 'ml') : (sizeMl > 0 ? `Packed perfume · ${sizeMl}ml` : existing && !existing.needs_recipe ? existing.type : 'Packed product');
  const category = needsRecipe ? 'all' : 'signature';
  if (existing) {
    db.prepare('UPDATE products SET name = ?, type = ?, price = ?, wholesale_price = ?, franchise_price = ?, gst_rate = ?, cost = ?, category = ?, art = ?, needs_recipe = ?, recipe_ml = ?, stock_material_id = ?, pack_material_id = ?, pack_qty = ?, fill_material_id = ? WHERE id = ?')
      .run(name, type, price, wholesale, franchise, gstRate, cost, category, art, needsRecipe ? 1 : 0, needsRecipe ? recipeMl : 0, stockId, packId, packQty, fillId, existing.id);
    return { id: existing.id };
  }
  let id = slugify(name), suffix = 2;
  while (db.prepare('SELECT 1 FROM products WHERE id = ?').get(id) || db.prepare('SELECT 1 FROM materials WHERE id = ?').get(id)) id = slugify(name) + '-' + (suffix++);
  db.prepare('INSERT INTO products (id, code, name, type, price, wholesale_price, franchise_price, gst_rate, cost, category, art, format, signature, needs_recipe, recipe_ml, stock_material_id, pack_material_id, pack_qty, fill_material_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, nextProductCode(), name, type, price, wholesale, franchise, gstRate, cost, category, art, needsRecipe ? 'custom' : 'signature', needsRecipe ? 0 : 1, needsRecipe ? 1 : 0, needsRecipe ? recipeMl : 0, stockId, packId, packQty, fillId);
  return { id };
}
// HQ price list: retail, wholesale and franchise price of many products in one save.
function updatePrices({ body }) {
  const list = Array.isArray(body.prices) ? body.prices : [];
  if (!list.length || list.length > 500) bad('Change at least one price');
  return tx(() => {
    for (const entry of list) {
      const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(String(entry.id));
      if (!product) throw new HttpError(404, 'Product not found');
      const retail = round2(num(entry.price)), wholesale = round2(num(entry.wholesalePrice)), franchise = round2(num(entry.franchisePrice));
      if (![retail, wholesale, franchise].every(value => value > 0)) bad(`${product.name}: all three prices must be greater than 0`);
      db.prepare('UPDATE products SET price = ?, wholesale_price = ?, franchise_price = ? WHERE id = ?').run(retail, wholesale, franchise, product.id);
    }
    return { ok: true, updated: list.length };
  });
}
// The outlet a user is working on: managers may change contact details, admins also the name and GSTIN.
function saveOwnOutlet({ body, user, outlet }) {
  const isAdmin = user.role === 'admin';
  const gstin = clean(body.gstin, 15).toUpperCase(), phone = clean(body.phone, 30), address = clean(body.address, 240);
  if (isAdmin && gstin && !isValidGstin(gstin)) bad('Enter a valid 15-character GSTIN');
  const name = isAdmin ? clean(body.name) : outlet.name;
  if (!name) bad('Outlet name is required');
  db.prepare('UPDATE outlets SET name = ?, gstin = ?, address = ?, phone = ? WHERE id = ?').run(name, isAdmin ? gstin : outlet.gstin, address, phone, outlet.id);
  return { ok: true };
}
// HQ only: create or edit any outlet, including royalty and active status.
function saveOutlet({ body, params }) {
  const gstin = clean(body.gstin, 15).toUpperCase(), phone = clean(body.phone, 30), address = clean(body.address, 240);
  if (gstin && !isValidGstin(gstin)) bad('Enter a valid 15-character GSTIN');
  const royalty = num(body.royaltyPct);
  if (!(royalty >= 0 && royalty <= 100)) bad('Royalty must be between 0 and 100%');
  const name = clean(body.name);
  if (!name) bad('Outlet name is required');
  if (params.id) {
    const target = getOutlet(Number(params.id));
    if (!target) throw new HttpError(404, 'Outlet not found');
    const active = body.active === false ? 0 : 1;
    if (target.type === 'hq' && !active) bad('The HQ outlet cannot be deactivated');
    db.prepare('UPDATE outlets SET name = ?, gstin = ?, address = ?, phone = ?, royalty_pct = ?, active = ? WHERE id = ?').run(name, gstin, address, phone, target.type === 'hq' ? 0 : royalty, active, target.id);
    return { id: target.id };
  }
  const code = clean(body.code, 8).toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(code)) bad('Outlet code must be 2 to 8 letters or digits');
  if (db.prepare('SELECT 1 FROM outlets WHERE code = ?').get(code)) conflict('That outlet code is already used');
  return tx(() => {
    const info = db.prepare("INSERT INTO outlets (code, name, type, gstin, address, phone, royalty_pct) VALUES (?, ?, 'franchise', ?, ?, ?, ?)").run(code, name, gstin, address, phone, royalty);
    ensureStockRows();
    return { id: Number(info.lastInsertRowid) };
  });
}
const mapUser = row => ({ id: row.id, username: row.username, name: row.name, role: row.role, outletId: row.outlet_id, active: Boolean(row.active) });
function saveUser({ body, params, user }) {
  const name = clean(body.name), role = ['admin', 'biller'].includes(body.role) ? body.role : 'manager';
  const outletId = role !== 'admin' ? Number(body.outletId) : null;
  if (!name) bad('Name is required');
  if (role !== 'admin' && !getOutlet(outletId)) bad(`Choose an outlet for this ${role}`);
  const password = body.password ? String(body.password) : '';
  if (password && password.length < 8) bad('Password must be at least 8 characters');
  if (params.id) {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
    if (!target) throw new HttpError(404, 'User not found');
    const active = body.active === false ? 0 : 1;
    if (target.id === user.id && (!active || role !== 'admin')) bad('You cannot deactivate or demote your own account');
    db.prepare('UPDATE users SET name = ?, role = ?, outlet_id = ?, active = ? WHERE id = ?').run(name, role, outletId, active, target.id);
    if (password) { const { salt, hash } = hashPassword(password); db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hash, target.id); }
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    return mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id));
  }
  const username = String(body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) bad('Username must be 3 to 30 letters, digits, dots or dashes');
  if (!password) bad('Set a password of at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) conflict('That username is already taken');
  const { salt, hash } = hashPassword(password);
  const info = db.prepare('INSERT INTO users (username, name, role, outlet_id, salt, hash) VALUES (?, ?, ?, ?, ?, ?)').run(username, name, role, outletId, salt, hash);
  return mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid)));
}
function recordRoyalty({ body, user }) {
  const outlet = getOutlet(Number(body.outletId)), amount = round2(Number(body.amount));
  if (!outlet || outlet.type !== 'franchise') bad('Choose a franchise outlet');
  if (!(amount > 0)) bad('Enter an amount greater than 0');
  const date = isDateKey(body.date) ? body.date : todayKey();
  db.prepare('INSERT INTO royalty_payments (outlet_id, date, amount, mode, note, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(outlet.id, date, amount, checkMode(body.mode), clean(body.note, 200), user.id);
  return { ok: true };
}
function networkData() {
  return {
    outlets: db.prepare('SELECT * FROM outlets ORDER BY id').all().map(mapOutlet),
    sales: loadSales(),
    purchases: loadPurchases(),
    stock: db.prepare(`${MATERIAL_SQL} ORDER BY s.outlet_id, m.rowid`).all().map(mapMaterial),
    expenses: db.prepare('SELECT * FROM expenses ORDER BY date DESC, id DESC').all().map(mapExpense),
    creditNotes: db.prepare('SELECT * FROM credit_notes ORDER BY date DESC, rowid DESC').all().map(mapCreditNote),
    stockCounts: loadCounts("WHERE c.status = 'completed'"),
    royaltyPayments: db.prepare('SELECT id, outlet_id AS outletId, date, amount, mode, note FROM royalty_payments ORDER BY date DESC, id DESC').all(),
    transfers: db.prepare('SELECT * FROM transfers ORDER BY rowid DESC').all().map(mapTransfer)
  };
}
function hqStock() {
  return loadMaterials(hqOutlet().id).map(material => ({ id: material.id, name: material.name, unit: material.unit, stock: material.stock, costPerMl: material.costPerMl }));
}

/* ---------- Routing ---------- */
// auth: 'none' | 'any' (every signed-in user) | 'staff' (admin or manager, not biller) | 'admin'. Handlers receive { body, params, query, user, outlet, ip, setCookie }.
const routes = [
  ['POST', '/api/login', 'none', ({ body, ip, setCookie }) => {
    if (blocked(ip)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes');
    const row = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(body.username || '').trim().toLowerCase());
    const ok = row && verifyPassword(String(body.password || ''), row.salt, row.hash);
    throttle(ip, Boolean(ok));
    if (!ok) throw new HttpError(401, 'Incorrect username or password');
    setCookie(createSession(row.id));
    return { ok: true };
  }],
  ['POST', '/api/logout', 'none', ({ token, setCookie }) => { if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)); setCookie(null); return { ok: true }; }],
  ['GET', '/api/state', 'any', ({ user, outlet }) => { ensureStockRows(); return buildState(user, outlet); }],
  ['POST', '/api/change-password', 'any', ({ body, user }) => {
    if (!verifyPassword(String(body.current || ''), user.salt, user.hash)) bad('Your current password is incorrect');
    if (String(body.next || '').length < 8) bad('The new password must be at least 8 characters');
    const { salt, hash } = hashPassword(String(body.next));
    db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hash, user.id);
    return { ok: true };
  }],
  ['POST', '/api/customers', 'any', createCustomer],
  ['PUT', '/api/customers/:id', 'staff', updateCustomer],
  ['POST', '/api/salesmen', 'staff', saveSalesman],
  ['GET', '/api/day-closing', 'staff', dayClosingSummary],
  ['POST', '/api/day-closings', 'staff', closeDay],
  ['POST', '/api/day-closings/:id/reopen', 'admin', reopenDay],
  ['PUT', '/api/loyalty-settings', 'admin', saveLoyaltySettings],
  ['POST', '/api/loyalty/adjust', 'staff', adjustLoyalty],
  ['GET', '/api/loyalty/:phone', 'staff', loyaltyHistory],
  ['PUT', '/api/salesmen/:id', 'staff', saveSalesman],
  ['PUT', '/api/prices', 'admin', updatePrices],
  ['POST', '/api/sales', 'any', createSale],
  ['POST', '/api/payments', 'any', recordPayment],
  ['POST', '/api/vouchers', 'any', saveVoucher],
  ['GET', '/api/hq-invoices', 'staff', ({ outlet }) => franchiseInvoices(outlet)],
  ['POST', '/api/purchases', 'staff', createPurchase],
  ['POST', '/api/credit-notes', 'staff', createCreditNote],
  ['POST', '/api/expenses', 'staff', createExpense],
  ['DELETE', '/api/expenses/:id', 'staff', deleteExpense],
  ['POST', '/api/stock-counts', 'staff', startStockCount],
  ['PUT', '/api/stock-counts/:id', 'staff', saveStockCount],
  ['POST', '/api/stock-counts/:id/complete', 'staff', completeStockCount],
  ['POST', '/api/stock-counts/:id/cancel', 'staff', cancelStockCount],
  ['POST', '/api/opening-stock', 'staff', setOpeningStock],
  ['POST', '/api/stock-adjustments', 'staff', adjustStock],
  ['PUT', '/api/outlet-stock/:id', 'staff', setAlert],
  ['PUT', '/api/outlet', 'staff', saveOwnOutlet],
  ['POST', '/api/transfers/:id/receive', 'staff', receiveTransfer],
  ['POST', '/api/transfers', 'admin', createTransfer],
  ['POST', '/api/transfers/:id/cancel', 'admin', cancelTransfer],
  ['GET', '/api/hq-stock', 'admin', hqStock],
  ['GET', '/api/network', 'admin', networkData],
  ['GET', '/api/manufacturing', 'admin', manufacturingData],
  ['POST', '/api/formulas', 'admin', createFormula],
  ['PUT', '/api/formulas/:id', 'admin', updateFormula],
  ['POST', '/api/formulas/:id/versions', 'admin', addFormulaVersion],
  ['PUT', '/api/formulas/:id/versions/:version', 'admin', updateFormulaVersion],
  ['POST', '/api/formulas/:id/current', 'admin', setCurrentVersion],
  ['POST', '/api/formulas/:id/promote', 'admin', promoteFormula],
  ['POST', '/api/production-runs', 'admin', createProductionRun],
  ['POST', '/api/materials', 'admin', saveMaterial],
  ['PUT', '/api/materials/:id', 'admin', saveMaterial],
  ['POST', '/api/products', 'admin', saveProduct],
  ['PUT', '/api/products/:id', 'admin', saveProduct],
  ['POST', '/api/outlets', 'admin', saveOutlet],
  ['PUT', '/api/outlets/:id', 'admin', saveOutlet],
  ['GET', '/api/users', 'admin', () => db.prepare('SELECT * FROM users ORDER BY id').all().map(mapUser)],
  ['POST', '/api/users', 'admin', saveUser],
  ['PUT', '/api/users/:id', 'admin', saveUser],
  ['POST', '/api/royalty-payments', 'admin', recordRoyalty],
  ['PUT', '/api/settings', 'admin', ({ body }) => {
    if (!['inclusive', 'exclusive'].includes(body.taxMode)) bad('Invalid tax mode');
    db.prepare("UPDATE settings SET value = ? WHERE key = 'taxMode'").run(body.taxMode);
    return { ok: true };
  }]
].map(([method, pattern, auth, handler]) => ({ method, auth, handler, regex: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`) }));

// Resolves the outlet a request works on: managers are pinned to theirs, admins choose via X-Outlet-Id (default HQ).
function contextOutlet(user, header) {
  if (user.role !== 'admin') {
    const own = getOutlet(user.outlet_id);
    if (!own || !own.active) forbid('Your outlet is not active');
    return own;
  }
  const wanted = header ? getOutlet(Number(header)) : null;
  return wanted || hqOutlet();
}

function dispatch({ method, pathname, query, body, token, outletHeader, ip, setCookie }) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.regex.exec(pathname);
    if (!match) continue;
    let user = null, outlet = null;
    if (route.auth !== 'none') {
      user = userForToken(token);
      if (!user) throw new HttpError(401, 'Please sign in');
      if (route.auth === 'admin' && user.role !== 'admin') forbid('Only HQ administrators can do that');
      if (route.auth === 'staff' && user.role === 'biller') forbid('Your biller login cannot do that');
      outlet = contextOutlet(user, outletHeader);
    }
    return route.handler({ body, params: { ...match.groups }, query, user, outlet, token, ip, setCookie });
  }
  throw new HttpError(404, 'Not found');
}

module.exports = { dispatch, HttpError, userForToken };

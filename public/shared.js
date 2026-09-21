/* Pure helpers used by both the browser and the server.
   Anything money- or tax-related lives here so the two always agree. */
const PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Bank transfer'];
const GST_RATES = [0, 5, 12, 18, 28];
const EXPENSE_CATEGORIES = ['Rent', 'Salaries', 'Utilities', 'Marketing', 'Transport', 'Packaging', 'Maintenance', 'Royalty & fees', 'Other'];

// Three price lists: retail, wholesale and franchise. A customer's type decides which one a bill uses.
const PRICE_LABELS = { retail: 'Retail', wholesale: 'Wholesale', franchise: 'Franchise' };
const priceFor = (product, type) => (type === 'wholesale' ? product.wholesalePrice : type === 'franchise' ? product.franchisePrice : product.price) ?? product.price;
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const currency = amount => { const n = round2(amount); return `${n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`; };
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const isValidPhone = phone => /^[6-9]\d{9}$/.test(phone);
const formatPhone = phone => `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`;
const initialsOf = name => name.split(' ').filter(Boolean).slice(0, 2).map(word => word[0].toUpperCase()).join('');
const isValidGstin = gstin => /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(gstin);

/* ---------- Dates (keys are local-time YYYY-MM-DD strings) ---------- */
const pad = n => String(n).padStart(2, '0');
const dateKey = date => { const d = new Date(date); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const todayKey = () => dateKey(new Date());
const keyToDate = key => new Date(`${key}T00:00:00`);
const addDays = (key, days) => { const d = keyToDate(key); d.setDate(d.getDate() + days); return dateKey(d); };
const formatKey = key => keyToDate(key).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const formatStamp = iso => `${formatKey(dateKey(iso))}, ${new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
const daysBetween = (fromKey, toKey) => Math.round((keyToDate(toKey) - keyToDate(fromKey)) / 86400000);

/* ---------- Bill maths ---------- */
// Discount is spread across lines pro rata, then GST is worked out per line.
// Prices are GST inclusive (MRP) or exclusive depending on taxMode.
function computeBill(items, discount = { type: 'amount', value: 0 }, taxMode = 'inclusive') {
  const gross = items.map(item => round2(item.price * item.quantity));
  const subtotal = round2(gross.reduce((sum, value) => sum + value, 0));
  const requested = discount.type === 'percent' ? subtotal * (Number(discount.value) || 0) / 100 : Number(discount.value) || 0;
  const discountAmount = round2(Math.min(Math.max(requested, 0), subtotal));
  const lines = items.map((item, index) => {
    const share = subtotal ? gross[index] / subtotal : 0;
    const net = round2(gross[index] - discountAmount * share);
    const rate = item.gstRate ?? 18;
    const taxable = taxMode === 'inclusive' ? round2(net / (1 + rate / 100)) : net;
    const gst = taxMode === 'inclusive' ? round2(net - taxable) : round2(net * rate / 100);
    return { gross: gross[index], net, rate, taxable, gst, total: round2(taxable + gst) };
  });
  const taxable = round2(lines.reduce((sum, line) => sum + line.taxable, 0));
  const gst = round2(lines.reduce((sum, line) => sum + line.gst, 0));
  const exact = round2(taxable + gst);
  const total = Math.round(exact);
  const cgst = round2(gst / 2);
  return { lines, subtotal, discount: discountAmount, taxable, gst, cgst, sgst: round2(gst - cgst), roundOff: round2(total - exact), total };
}
// The ml a custom recipe must add up to, by format.
const recipeTarget = format => format === 'perfume' ? 30 : 3;

/* ---------- Payments, dues and stock status ---------- */
// Payments include refunds as negative amounts, so paidOf is always the net money held.
// Credit notes (record.credited) reduce what the customer owes on a bill.
const paidOf = record => round2(record.payments.reduce((sum, payment) => sum + payment.amount, 0));
const netTotal = record => round2(record.total - (record.credited || 0));
const dueOf = record => Math.max(0, round2(netTotal(record) - paidOf(record)));
const statusOf = record => (record.credited && netTotal(record) <= 0) ? 'Returned' : dueOf(record) <= 0 ? 'Paid' : paidOf(record) > 0 ? 'Partial' : 'Unpaid';

/* ---------- Credit notes (returns) ---------- */
// picks: [{ index, qty }] into sale.lines. Each sale line carries `returned` (units already credited).
// Credited at the price actually paid (discount already spread across the lines), GST reversed pro rata.
function computeCreditNote(sale, picks) {
  const chosen = picks.filter(pick => pick.qty > 0);
  const lines = chosen.map(pick => {
    const line = sale.lines[pick.index];
    const ratio = pick.qty / line.qty;
    // A signature bottle goes back on the shelf; a custom blend cannot be un-mixed, so its cost stays.
    const restock = !line.recipe;
    return { index: pick.index, qty: pick.qty, product: line.product, name: line.name, label: line.label, gstRate: line.gstRate, taxable: round2(line.taxable * ratio), gst: round2(line.gst * ratio), total: round2(line.total * ratio), costReversed: restock ? round2(line.cost * ratio) : 0, restock };
  });
  const taxable = round2(lines.reduce((sum, line) => sum + line.taxable, 0));
  const gst = round2(lines.reduce((sum, line) => sum + line.gst, 0));
  const exact = round2(taxable + gst);
  const remainingAfter = sale.lines.reduce((sum, line, index) => sum + line.qty - (line.returned || 0) - (chosen.find(pick => pick.index === index)?.qty || 0), 0);
  const completes = remainingAfter === 0;
  const available = round2(sale.total - (sale.credited || 0));
  // The final return takes exactly what is left, so the rounding on the original bill nets to zero.
  const total = completes ? available : Math.min(Math.round(exact), available);
  const cgst = round2(gst / 2);
  return { lines, taxable, gst, cgst, sgst: round2(gst - cgst), roundOff: round2(total - exact), total, completes };
}
// Money to hand back: what has been paid beyond what the customer still owes after the credit.
function refundFor(sale, creditTotal) {
  return Math.max(0, round2(paidOf(sale) - round2(sale.total - (sale.credited || 0) - creditTotal)));
}
// Liquids are counted in ml (two decimals); bottles, packaging and packed products in whole pieces.
const fmtQty = (qty, unit = 'ml') => unit === 'pcs' ? `${round2(qty)} pcs` : `${Number(qty).toFixed(2)}ml`;
const stockStatus = material => material.stock <= 0 ? 'Out' : material.stock <= material.alertMl ? 'Low' : 'OK';

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PAYMENT_MODES, GST_RATES, EXPENSE_CATEGORIES, round2, isValidPhone, isValidGstin, pad, dateKey, todayKey, computeBill, recipeTarget, paidOf, netTotal, computeCreditNote, refundFor };
}

/* ---------- Reports: Sales & GST, Profit, Stock, Dues & purchases, Royalty ---------- */
let reportTab = 'sales';
let reportExport = { name: 'report.csv', rows: [] };
let networkCache = null;
let reportToken = 0;

const sumOf = (list, pick) => round2(list.reduce((total, item) => total + pick(item), 0));
const inRange = (day, range) => (!range.from || day >= range.from) && (!range.to || day <= range.to);
const percent = (part, whole) => whole > 0 ? `${(part / whole * 100).toFixed(1)}%` : '—';

function reportRange() {
  const today = todayKey(), mode = $('#reportRange').value, monthStart = `${today.slice(0, 8)}01`;
  if (mode === 'today') return { from: today, to: today, label: 'Today' };
  if (mode === '7d') return { from: addDays(today, -6), to: today, label: 'Last 7 days' };
  if (mode === 'month') return { from: monthStart, to: today, label: 'This month' };
  if (mode === 'lastmonth') { const first = keyToDate(monthStart); first.setMonth(first.getMonth() - 1); return { from: dateKey(first), to: addDays(monthStart, -1), label: 'Last month' }; }
  if (mode === 'custom') { const from = $('#reportFrom').value || null, to = $('#reportTo').value || null; return { from, to, label: `${from ? formatKey(from) : 'Start'} – ${to ? formatKey(to) : 'today'}` }; }
  return { from: null, to: null, label: 'All time' };
}

/* ---------- Data: one outlet for managers, the whole network (or one outlet) for HQ ---------- */
async function reportData() {
  if (!isAdmin()) {
    return { multi: false, outlets: state.outlets, sales, purchases, expenses, creditNotes, stockCounts: stockCounts.filter(count => count.status === 'completed'), transfers: state.transfers, royaltyPayments: [], stock: rawMaterials.map(material => ({ ...material, outletId: state.outlet.id })) };
  }
  if (!networkCache) networkCache = await api('GET', '/api/network');
  const scope = $('#reportScope').value || 'all';
  const keep = row => scope === 'all' || String(row.outletId) === scope;
  const outlets = scope === 'all' ? networkCache.outlets : networkCache.outlets.filter(outlet => String(outlet.id) === scope);
  return {
    multi: outlets.length > 1, outlets,
    sales: networkCache.sales.filter(keep), purchases: networkCache.purchases.filter(keep), expenses: networkCache.expenses.filter(keep), creditNotes: networkCache.creditNotes.filter(keep), stockCounts: networkCache.stockCounts.filter(keep), stock: networkCache.stock.filter(keep),
    transfers: networkCache.transfers.filter(transfer => scope === 'all' || String(transfer.toOutlet) === scope),
    royaltyPayments: networkCache.royaltyPayments.filter(keep), allOutlets: networkCache.outlets
  };
}
function fillScopeOptions() {
  const select = $('#reportScope'), outlets = state.outlets;
  const wanted = ['all', ...outlets.map(outlet => String(outlet.id))].join(',');
  if (select.dataset.options === wanted) return;
  const current = select.value || 'all';
  select.innerHTML = `<option value="all">All outlets</option>${outlets.map(outlet => `<option value="${outlet.id}">${escapeHtml(outlet.name)}</option>`).join('')}`;
  select.dataset.options = wanted;
  select.value = [...select.options].some(option => option.value === current) ? current : 'all';
}
const outletCode = (data, id) => (data.allOutlets || data.outlets).find(outlet => outlet.id === id)?.code || '';
const withOutlet = (data, id, text) => data.multi ? `${text}<small>${outletCode(data, id)}</small>` : text;

/* ---------- Building blocks ---------- */
const kpi = (label, value, note = '') => `<div class="kpi"><span class="kpi-label">${label}</span><strong>${value}</strong>${note ? `<span class="kpi-note">${note}</span>` : ''}</div>`;
// headers: [label, isNumeric]; rows: arrays of ready-made HTML cells; foot: optional totals row
function tableCard(title, headers, rows, { empty = 'Nothing to show for this period.', foot, note } = {}) {
  const cells = (row, tag) => row.map((cell, index) => `<${tag} class="${headers[index][1] ? 'num' : ''}">${cell}</${tag}>`).join('');
  return `<section class="report-card"><div class="report-card-head"><h3>${title}</h3>${note ? `<span>${note}</span>` : ''}</div>${rows.length ? `<div class="table-scroll"><table class="report-table"><thead><tr>${headers.map(([label, numeric]) => `<th class="${numeric ? 'num' : ''}">${label}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${cells(row, 'td')}</tr>`).join('')}</tbody>${foot ? `<tfoot><tr>${cells(foot, 'td')}</tr></tfoot>` : ''}</table></div>` : `<p class="report-empty">${empty}</p>`}</section>`;
}
const statusPill = status => `<span class="status-badge status-${status.toLowerCase()}">${status}</span>`;
const marginBar = (profit, revenue) => {
  const margin = revenue > 0 ? profit / revenue * 100 : 0;
  return `<div class="bar-cell"><span class="bar-track"><span class="bar-fill ${margin < 0 ? 'negative' : ''}" style="width:${Math.min(Math.max(margin, 0), 100)}%"></span></span><span>${revenue > 0 ? `${margin.toFixed(1)}%` : '—'}</span></div>`;
};
const compact = value => value >= 100000 ? `₹${+(value / 100000).toFixed(1)}L` : value >= 1000 ? `₹${+(value / 1000).toFixed(1)}k` : `₹${value}`;

/* ---------- Sales chart (single series, so no legend; a table is offered below) ---------- */
function salesChart(list, range) {
  if (!list.length) return '';
  const today = todayKey();
  const days = list.map(sale => sale.day).sort();
  const start = range.from || days[0], end = range.to && range.to < today ? range.to : today;
  if (start > end) return '';
  const daily = daysBetween(start, end) + 1 <= 62;
  const buckets = new Map();
  if (daily) for (let day = start; day <= end; day = addDays(day, 1)) buckets.set(day, { total: 0, bills: 0 });
  // Records are bills (positive) and credit notes (negative, dated when issued).
  list.forEach(sale => { const key = daily ? sale.day : sale.day.slice(0, 7); const bucket = buckets.get(key) || { total: 0, bills: 0 }; bucket.total = round2(bucket.total + sale.total); bucket.bills += sale.bills; buckets.set(key, bucket); });
  const entries = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const labelOf = key => daily ? keyToDate(key).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : keyToDate(`${key}-01`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  const max = Math.max(...entries.map(([, bucket]) => bucket.total), 1);
  const rawStep = max / 4, magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const niceMax = [1, 2, 2.5, 5, 10].map(multiple => multiple * magnitude).find(step => step >= rawStep) * 4;
  const width = 720, height = 230, left = 52, right = 12, top = 14, bottom = 30, plotW = width - left - right, plotH = height - top - bottom;
  const band = plotW / entries.length, barW = Math.min(26, band * 0.62), labelStep = Math.ceil(entries.length / 12);
  const grid = [0, 1, 2, 3, 4].map(step => { const y = top + plotH - plotH * step / 4; return `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text class="chart-axis" x="${left - 8}" y="${y + 4}" text-anchor="end">${compact(niceMax * step / 4)}</text>`; }).join('');
  const bars = entries.map(([key, bucket], index) => {
    const x = left + band * index + (band - barW) / 2, barH = Math.max(0, bucket.total) / niceMax * plotH, y = top + plotH - barH, radius = Math.min(4, barH, barW / 2);
    const tip = `${labelOf(key)} · ${currency(bucket.total)} · ${bucket.bills} bill${bucket.bills === 1 ? '' : 's'}`;
    const shape = bucket.total > 0 ? `<path class="chart-bar" d="M${x} ${y + barH}V${y + radius}Q${x} ${y} ${x + radius} ${y}H${x + barW - radius}Q${x + barW} ${y} ${x + barW} ${y + radius}V${y + barH}Z"/>` : '';
    return `<g class="bar-group"><rect class="chart-hit" data-tip="${tip}" x="${left + band * index}" y="${top}" width="${band}" height="${plotH}"/>${shape}${index % labelStep === 0 ? `<text class="chart-axis" x="${x + barW / 2}" y="${height - 8}" text-anchor="middle">${labelOf(key)}</text>` : ''}</g>`;
  }).join('');
  const table = `<details class="chart-table"><summary>View as table</summary><table class="report-table"><thead><tr><th>${daily ? 'Day' : 'Month'}</th><th class="num">Bills</th><th class="num">Sales</th></tr></thead><tbody>${entries.filter(([, bucket]) => bucket.bills).map(([key, bucket]) => `<tr><td>${labelOf(key)}</td><td class="num">${bucket.bills}</td><td class="num">${currency(bucket.total)}</td></tr>`).join('')}</tbody></table></details>`;
  return `<section class="report-card"><div class="report-card-head"><h3>Sales ${daily ? 'by day' : 'by month'}</h3><span>${range.label}</span></div><div class="chart-wrap"><svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Bar chart of sales ${daily ? 'by day' : 'by month'}">${grid}${bars}</svg><div class="chart-tip hidden" id="chartTip"></div></div>${table}</section>`;
}

/* ---------- Sales & GST ---------- */
function salesReport(range, data) {
  const list = data.sales.filter(sale => inRange(sale.day, range));
  const returns = data.creditNotes.filter(note => inRange(note.day, range));
  const returned = sumOf(returns, note => note.total);
  // Net sales = bills in the period less credit notes issued in the period.
  const total = round2(sumOf(list, sale => sale.total) - returned), received = sumOf(list, sale => paidOf(sale)), gst = round2(sumOf(list, sale => sale.cgst + sale.sgst) - sumOf(returns, note => note.cgst + note.sgst));
  const byProduct = new Map(), byCustomer = new Map(), modes = new Map(), rates = new Map(), byOutlet = new Map();
  returns.forEach(note => {
    const key = `${note.outletId}:${note.customerPhone}`;
    const customer = byCustomer.get(key) || { name: note.customerName, outletId: note.outletId, bills: 0, total: 0, due: 0 };
    customer.total -= note.total; byCustomer.set(key, customer);
    const outlet = byOutlet.get(note.outletId) || { bills: 0, total: 0, gst: 0, due: 0 };
    outlet.total -= note.total; outlet.gst -= note.cgst + note.sgst; byOutlet.set(note.outletId, outlet);
    note.lines.forEach(line => {
      const product = byProduct.get(line.product) || { qty: 0, total: 0 }; product.qty -= line.qty; product.total -= line.total; byProduct.set(line.product, product);
      const rate = rates.get(line.gstRate) || { taxable: 0, gst: 0 }; rate.taxable -= line.taxable; rate.gst -= line.gst; rates.set(line.gstRate, rate);
    });
  });
  list.forEach(sale => {
    const key = `${sale.outletId}:${sale.customerPhone}`;
    const customer = byCustomer.get(key) || { name: sale.customerName, outletId: sale.outletId, bills: 0, total: 0, due: 0 };
    customer.bills += 1; customer.total += sale.total; customer.due += dueOf(sale); byCustomer.set(key, customer);
    const outlet = byOutlet.get(sale.outletId) || { bills: 0, total: 0, gst: 0, due: 0 };
    outlet.bills += 1; outlet.total += sale.total; outlet.gst += sale.cgst + sale.sgst; outlet.due += dueOf(sale); byOutlet.set(sale.outletId, outlet);
    sale.payments.forEach(payment => modes.set(payment.mode, (modes.get(payment.mode) || 0) + payment.amount));
    sale.lines.forEach(line => {
      const product = byProduct.get(line.product) || { qty: 0, total: 0 }; product.qty += line.qty; product.total += line.total; byProduct.set(line.product, product);
      const rate = rates.get(line.gstRate) || { taxable: 0, gst: 0 }; rate.taxable += line.taxable; rate.gst += line.gst; rates.set(line.gstRate, rate);
    });
  });
  // Sales by price list: retail, wholesale and franchise bills side by side.
  const byList = new Map();
  list.forEach(sale => { const key = sale.priceType || 'retail'; const entry = byList.get(key) || { bills: 0, total: 0, gst: 0 }; entry.bills += 1; entry.total += sale.total; entry.gst += sale.cgst + sale.sgst; byList.set(key, entry); });
  const listTable = list.length ? tableCard('Sales by price list', [['Price list'], ['Bills', true], ['Sales', true], ['GST', true]], ['retail', 'wholesale', 'franchise'].filter(key => byList.has(key)).map(key => [PRICE_LABELS[key], byList.get(key).bills, currency(round2(byList.get(key).total)), currency(round2(byList.get(key).gst))]), { note: 'Before returns' }) : '';
  const sortedProducts = [...byProduct.entries()].sort((a, b) => b[1].total - a[1].total);
  const sortedCustomers = [...byCustomer.values()].sort((a, b) => b.total - a.total);
  const sortedModes = [...modes.entries()].sort((a, b) => b[1] - a[1]);
  const sortedRates = [...rates.entries()].sort((a, b) => a[0] - b[0]);
  reportExport = { name: 'sales-report.csv', rows: [['Outlet', 'Invoice', 'Date', 'Customer', 'Phone', 'Subtotal', 'Discount', 'Taxable', 'CGST', 'SGST', 'Total', 'Paid', 'Due', 'Status'], ...list.map(sale => [outletCode(data, sale.outletId), sale.number, sale.day, sale.customerName, sale.customerPhone, sale.subtotal, sale.discount, sale.taxable, sale.cgst, sale.sgst, sale.total, paidOf(sale), dueOf(sale), statusOf(sale)]), ...returns.map(note => [outletCode(data, note.outletId), note.number, note.day, note.customerName, note.customerPhone, '', '', -note.taxable, -note.cgst, -note.sgst, -note.total, -note.refund, '', 'Credit note'])] };
  const outletTable = data.multi ? tableCard('Sales by outlet', [['Outlet'], ['Bills', true], ['Sales', true], ['GST', true], ['Outstanding', true]], [...byOutlet.entries()].sort((a, b) => b[1].total - a[1].total).map(([id, entry]) => [escapeHtml(data.outlets.find(outlet => outlet.id === id).name), entry.bills, currency(round2(entry.total)), currency(round2(entry.gst)), entry.due > 0 ? `<span class="due-text">${currency(round2(entry.due))}</span>` : '—']), { foot: ['Network total', list.length, currency(total), currency(gst), currency(sumOf(list, sale => dueOf(sale)))] }) : '';
  const chartRecords = [...list.map(sale => ({ day: sale.day, total: sale.total, bills: 1 })), ...returns.map(note => ({ day: note.day, total: -note.total, bills: 0 }))];
  return `<div class="kpi-grid">${kpi('Net sales', currency(total), returned ? `${range.label} · after ${currency(returned)} returns` : range.label)}${kpi('Bills', list.length, list.length ? `${currency(round2(total / list.length))} average` : 'no bills')}${kpi('GST collected', currency(gst), 'CGST + SGST, net of returns')}${kpi('Received', currency(received), 'net of refunds')}${kpi('Outstanding', currency(sumOf(list, sale => dueOf(sale))), 'unpaid on these bills')}${kpi('Returns', currency(returned), `${returns.length} credit note${returns.length === 1 ? '' : 's'}`)}${kpi('Discounts given', currency(sumOf(list, sale => sale.discount)), 'across all bills')}</div>
    ${salesChart(chartRecords, range) || '<section class="report-card"><p class="report-empty">No bills in this period.</p></section>'}
    ${outletTable}${listTable}
    <div class="report-grid">
      ${tableCard('Sales by product', [['Product'], ['Qty', true], ['Sales', true]], sortedProducts.map(([name, entry]) => [escapeHtml(name), entry.qty, currency(round2(entry.total))]), { foot: ['Total', sumOf(sortedProducts, ([, entry]) => entry.qty), currency(total)] })}
      ${tableCard('Sales by customer', [['Customer'], ['Bills', true], ['Sales', true], ['Due', true]], sortedCustomers.slice(0, 10).map(customer => [withOutlet(data, customer.outletId, escapeHtml(customer.name)), customer.bills, currency(round2(customer.total)), customer.due > 0 ? `<span class="due-text">${currency(round2(customer.due))}</span>` : '—']), { note: 'Top 10' })}
      ${tableCard('Collections by payment mode', [['Mode'], ['Amount', true], ['Share', true]], sortedModes.map(([mode, amount]) => [mode, currency(round2(amount)), percent(amount, received)]), { empty: 'No payments received in this period.' })}
      ${tableCard('GST summary', [['GST rate'], ['Taxable', true], ['CGST', true], ['SGST', true], ['Total tax', true]], sortedRates.map(([rate, entry]) => [`${rate}%`, currency(round2(entry.taxable)), currency(round2(entry.gst / 2)), currency(round2(entry.gst / 2)), currency(round2(entry.gst))]), { foot: ['Total', currency(round2(sumOf(list, sale => sale.taxable) - sumOf(returns, note => note.taxable))), currency(round2(sumOf(list, sale => sale.cgst) - sumOf(returns, note => note.cgst))), currency(round2(sumOf(list, sale => sale.sgst) - sumOf(returns, note => note.sgst))), currency(gst)], note: returned ? 'Net of credit notes' : '' })}
    </div>`;
}

/* ---------- Profit & margin ---------- */
function profitReport(range, data) {
  const list = data.sales.filter(sale => inRange(sale.day, range));
  const returns = data.creditNotes.filter(note => inRange(note.day, range));
  // Returns take back the revenue; the bottle cost comes back only for items that return to stock.
  const returnedCost = note => sumOf(note.lines, line => line.costReversed);
  const revenue = round2(sumOf(list, sale => sale.taxable) - sumOf(returns, note => note.taxable));
  const cost = round2(sumOf(list, sale => sumOf(sale.lines, line => line.cost)) - sumOf(returns, returnedCost)), profit = round2(revenue - cost);
  const spent = data.expenses.filter(expense => inRange(expense.date, range));
  const expenseTotal = sumOf(spent, expense => expense.amount), netProfit = round2(profit - expenseTotal);
  const byProduct = new Map(), byOutlet = new Map(), byCategory = new Map();
  returns.forEach(note => {
    const outlet = byOutlet.get(note.outletId) || { revenue: 0, cost: 0 };
    outlet.revenue -= note.taxable; outlet.cost -= returnedCost(note); byOutlet.set(note.outletId, outlet);
    note.lines.forEach(line => { const product = byProduct.get(line.product) || { qty: 0, revenue: 0, cost: 0 }; product.qty -= line.qty; product.revenue -= line.taxable; product.cost -= line.costReversed; byProduct.set(line.product, product); });
  });
  spent.forEach(expense => { const entry = byCategory.get(expense.category) || { count: 0, amount: 0 }; entry.count += 1; entry.amount += expense.amount; byCategory.set(expense.category, entry); });
  let unpriced = 0;
  list.forEach(sale => {
    const outlet = byOutlet.get(sale.outletId) || { revenue: 0, cost: 0 };
    outlet.revenue += sale.taxable; outlet.cost += sumOf(sale.lines, line => line.cost); byOutlet.set(sale.outletId, outlet);
    sale.lines.forEach(line => {
      const product = byProduct.get(line.product) || { qty: 0, revenue: 0, cost: 0 };
      product.qty += line.qty; product.revenue += line.taxable; product.cost += line.cost; byProduct.set(line.product, product);
      if (!line.cost) unpriced += 1;
    });
  });
  const productRows = [...byProduct.entries()].sort((a, b) => (b[1].revenue - b[1].cost) - (a[1].revenue - a[1].cost));
  const billRows = list.map(sale => ({ sale, revenue: sale.taxable, cost: sumOf(sale.lines, line => line.cost) }));
  reportExport = { name: 'profit-report.csv', rows: [['Outlet', 'Invoice', 'Date', 'Customer', 'Revenue (ex GST)', 'Cost', 'Profit', 'Margin %'], ...billRows.map(({ sale, revenue: rev, cost: c }) => [outletCode(data, sale.outletId), sale.number, sale.day, sale.customerName, rev, c, round2(rev - c), rev > 0 ? round2((rev - c) / rev * 100) : ''])] };
  const warning = unpriced ? `<p class="report-alert">${unpriced} bill line${unpriced === 1 ? ' has' : 's have'} no cost recorded, so profit is overstated. Enter opening stock with costs, record purchases, and set signature bottle costs under Products.</p>` : '';
  const outletRows = data.outlets.map(outlet => {
    const sold = byOutlet.get(outlet.id) || { revenue: 0, cost: 0 };
    const outgoing = sumOf(spent.filter(expense => expense.outletId === outlet.id), expense => expense.amount);
    return { outlet, revenue: sold.revenue, gross: round2(sold.revenue - sold.cost), outgoing, net: round2(sold.revenue - sold.cost - outgoing) };
  }).sort((a, b) => b.net - a.net);
  const outletTable = data.multi ? tableCard('Profit by outlet', [['Outlet'], ['Revenue', true], ['Gross profit', true], ['Expenses', true], ['Net profit', true], ['Net margin', true]], outletRows.map(row => [escapeHtml(row.outlet.name), currency(round2(row.revenue)), currency(row.gross), currency(row.outgoing), currency(row.net), marginBar(row.net, row.revenue)])) : '';
  const expenseTable = tableCard('Expenses by category', [['Category'], ['Entries', true], ['Amount', true], ['Share of revenue', true]], [...byCategory.entries()].sort((a, b) => b[1].amount - a[1].amount).map(([category, entry]) => [category, entry.count, currency(round2(entry.amount)), percent(entry.amount, revenue)]), { empty: 'No expenses recorded in this period. Add them under Expenses to see net profit.', foot: spent.length ? ['Total', spent.length, currency(expenseTotal), percent(expenseTotal, revenue)] : undefined });
  return `<div class="kpi-grid">${kpi('Revenue (ex-GST)', currency(revenue), `${list.length} bill${list.length === 1 ? '' : 's'} · after discounts`)}${kpi('Cost of goods', currency(cost), 'materials and bottles')}${kpi('Gross profit', currency(profit), `${percent(profit, revenue)} margin`)}${kpi('Expenses', currency(expenseTotal), `${spent.length} entr${spent.length === 1 ? 'y' : 'ies'}`)}${kpi('Net profit', currency(netProfit), `${percent(netProfit, revenue)} of revenue`)}</div>${warning}
    ${outletTable}
    ${expenseTable}
    ${tableCard('Profit by product', [['Product'], ['Qty', true], ['Revenue', true], ['Cost', true], ['Profit', true], ['Margin', true]], productRows.map(([name, entry]) => [escapeHtml(name), entry.qty, currency(round2(entry.revenue)), currency(round2(entry.cost)), currency(round2(entry.revenue - entry.cost)), marginBar(entry.revenue - entry.cost, entry.revenue)]), { foot: ['Total', sumOf(productRows, ([, entry]) => entry.qty), currency(revenue), currency(cost), currency(profit), percent(profit, revenue)], note: 'Revenue excludes GST' })}
    ${tableCard('Profit by bill', [['Invoice'], ['Customer'], ['Revenue', true], ['Cost', true], ['Profit', true], ['Margin', true]], billRows.slice(0, 30).map(({ sale, revenue: rev, cost: c }) => [`#${sale.number}<small>${formatKey(sale.day)}</small>`, escapeHtml(sale.customerName), currency(rev), currency(c), currency(round2(rev - c)), marginBar(rev - c, rev)]), { note: list.length > 30 ? 'Latest 30 (export for all)' : '' })}
    <p class="report-footnote">Cost uses the outlet's average cost per ml at the time of sale for custom blends, and the HQ bottle cost for signature perfumes. Expenses are what you recorded under Expenses for the period; purchases of stock are not counted twice.</p>`;
}

/* ---------- Stock ---------- */
function stockReport(range, data) {
  const rank = { Out: 0, Low: 1, OK: 2 };
  const received = (material) => sumOf(data.transfers.filter(transfer => transfer.status === 'received' && transfer.toOutlet === material.outletId && inRange(dateKey(transfer.receivedAt), range)), transfer => sumOf(transfer.lines.filter(line => line.materialId === material.id), line => line.qty));
  // Consumption of a stock item by one bill: recipe ml, packaging pieces, or packed items sold.
  const consumedBy = (sale, materialId) => sumOf(sale.lines, line => sumOf((line.recipe || []).filter(part => part.id === materialId), part => part.ml) + (line.pack && line.pack.id === materialId ? line.pack.qty : 0) + sumOf((line.extras || []).filter(extra => extra.id === materialId), extra => extra.qty) + (line.stockItem === materialId ? line.qty : 0));
  const rows = data.stock.map(material => ({
    material, status: stockStatus(material), value: round2(material.stock * material.costPerMl), received: received(material),
    bought: sumOf(data.purchases.filter(purchase => purchase.outletId === material.outletId && inRange(purchase.date, range)), purchase => sumOf(purchase.lines.filter(line => line.materialId === material.id), line => line.qty)),
    used: sumOf(data.sales.filter(sale => sale.outletId === material.outletId && inRange(sale.day, range)), sale => consumedBy(sale, material.id))
  })).sort((a, b) => rank[a.status] - rank[b.status] || a.material.outletId - b.material.outletId || a.material.name.localeCompare(b.material.name));
  reportExport = { name: 'stock-report.csv', rows: [['Outlet', 'Material', 'Type', 'In stock (ml)', 'Unit', 'Cost per unit', 'Stock value', 'Alert level', 'Purchased', 'Received', 'Used', 'Status'], ...rows.map(row => [outletCode(data, row.material.outletId), row.material.name, row.material.type, row.material.stock, row.material.unit, row.material.costPerMl, row.value, row.material.alertMl, row.bought, row.received, row.used, row.status])] };
  const counts = data.stockCounts.filter(count => inRange(dateKey(count.completedAt), range)), countNet = sumOf(counts, count => count.varianceValue);
  const low = rows.filter(row => row.status === 'Low').length, out = rows.filter(row => row.status === 'Out').length;
  const liquids = rows.filter(row => row.material.unit !== 'pcs');
  const amount = (value, row) => fmtQty(value, row.material.unit);
  const mlOnly = value => `${value.toFixed(2)}ml`;
  return `<div class="kpi-grid">${kpi('Stock value', currency(sumOf(rows, row => row.value)), 'at average cost')}${kpi(data.multi ? 'Stock lines' : 'Materials', rows.length, data.multi ? 'material × outlet' : 'attars and raw materials')}${kpi('Low stock', low, low ? 'reorder soon' : 'all above alert level')}${kpi('Out of stock', out, out ? 'needs stock' : 'none')}${kpi('Count variance', currency(countNet), `${counts.length} verification${counts.length === 1 ? '' : 's'} · ${range.label}`)}${kpi('Liquids used', mlOnly(sumOf(liquids, row => row.used)), `${range.label} · pieces are in the table`)}</div>
    ${tableCard('Stock position', [['Material'], ['In stock', true], ['Cost / unit', true], ['Value', true], ['Alert at', true], ['Purchased', true], ['Received', true], ['Used', true], ['Status']], rows.map(row => [withOutlet(data, row.material.outletId, `${escapeHtml(row.material.name)}`), amount(row.material.stock, row), currency(row.material.costPerMl), currency(row.value), `${row.material.alertMl} ${row.material.unit}`, amount(row.bought, row), amount(row.received, row), amount(row.used, row), `<span class="status-badge stock-pill-${row.status.toLowerCase()}">${row.status === 'OK' ? 'In stock' : row.status === 'Low' ? 'Low stock' : 'Out of stock'}</span>`]), { note: 'Purchased, Received and Used follow the selected period · totals count liquids (ml) only', foot: ['Total', '', '', currency(sumOf(rows, row => row.value)), '', mlOnly(sumOf(liquids, row => row.bought)), mlOnly(sumOf(liquids, row => row.received)), mlOnly(sumOf(liquids, row => row.used)), ''] })}
    <p class="report-footnote">Signature perfumes are bought-in bottles and are not tracked by quantity. Stock changes with purchases, transfers, adjustments and bills.</p>`;
}

/* ---------- Dues & purchases ---------- */
function duesReport(range, data) {
  const today = todayKey();
  const receivables = new Map();
  data.sales.filter(sale => dueOf(sale) > 0).forEach(sale => {
    const key = `${sale.outletId}:${sale.customerPhone}`;
    const entry = receivables.get(key) || { name: sale.customerName, phone: sale.customerPhone, outletId: sale.outletId, bills: 0, due: 0, oldest: sale.day };
    entry.bills += 1; entry.due += dueOf(sale); if (sale.day < entry.oldest) entry.oldest = sale.day; receivables.set(key, entry);
  });
  const owed = [...receivables.values()].sort((a, b) => b.due - a.due);
  const payables = data.purchases.filter(purchase => dueOf(purchase) > 0);
  const inPeriod = data.purchases.filter(purchase => inRange(purchase.date, range));
  const bySupplier = new Map();
  inPeriod.forEach(purchase => { const entry = bySupplier.get(purchase.supplier) || { count: 0, total: 0, due: 0 }; entry.count += 1; entry.total += purchase.total; entry.due += dueOf(purchase); bySupplier.set(purchase.supplier, entry); });
  reportExport = { name: 'dues-report.csv', rows: [['Outlet', 'Customer', 'Phone', 'Unpaid bills', 'Oldest bill', 'Days outstanding', 'Due'], ...owed.map(entry => [outletCode(data, entry.outletId), entry.name, entry.phone, entry.bills, entry.oldest, daysBetween(entry.oldest, today), round2(entry.due)])] };
  const totalDue = sumOf(owed, entry => entry.due), totalPayable = sumOf(payables, purchase => dueOf(purchase));
  const days = key => { const n = daysBetween(key, today); return n === 0 ? 'today' : `${n} day${n === 1 ? '' : 's'} ago`; };
  // Payments always apply to the outlet you are working as, so only offer buttons for that outlet.
  const canAct = outletId => outletId === state.outlet.id;
  return `<div class="kpi-grid">${kpi('Receivable', currency(totalDue), `${owed.length} customer${owed.length === 1 ? ' owes' : 's owe'} you`)}${kpi('Payable', currency(totalPayable), `${payables.length} unpaid purchase${payables.length === 1 ? '' : 's'}`)}${kpi('Net position', currency(round2(totalDue - totalPayable)), 'receivable − payable')}${kpi('Purchased', currency(sumOf(inPeriod, purchase => purchase.total)), range.label)}</div>
    ${tableCard('Customers who owe you', [['Customer'], ['Unpaid bills', true], ['Oldest bill'], ['Due', true], ['']], owed.map(entry => [withOutlet(data, entry.outletId, `${escapeHtml(entry.name)}<small>${formatPhone(entry.phone)}</small>`), entry.bills, `${formatKey(entry.oldest)}<small>${days(entry.oldest)}</small>`, `<span class="due-text">${currency(round2(entry.due))}</span>`, canAct(entry.outletId) ? `<button class="link-button accent" data-pay-customer="${entry.phone}">Receive</button>` : '']), { empty: 'No customer dues. Everyone has paid in full.', note: 'All time' })}
    ${tableCard('Suppliers you owe', [['Purchase'], ['Supplier'], ['Total', true], ['Paid', true], ['Due', true], ['']], payables.map(purchase => [withOutlet(data, purchase.outletId, `${purchase.number}<small>${formatKey(purchase.date)}</small>`), escapeHtml(purchase.supplier), currency(purchase.total), currency(paidOf(purchase)), `<span class="due-text">${currency(dueOf(purchase))}</span>`, canAct(purchase.outletId) ? `<button class="link-button accent" data-pay-purchase="${purchase.id}">Pay</button>` : '']), { empty: 'No supplier payments pending.', note: 'All time' })}
    <div class="report-grid">
      ${tableCard('Purchases in period', [['Purchase'], ['Supplier'], ['Total', true], ['Status']], inPeriod.map(purchase => [`${purchase.number}<small>${formatKey(purchase.date)}</small>`, escapeHtml(purchase.supplier), currency(purchase.total), statusPill(statusOf(purchase))]), { empty: 'No purchases in this period.', foot: inPeriod.length ? ['Total', '', currency(sumOf(inPeriod, purchase => purchase.total)), ''] : undefined })}
      ${tableCard('Purchases by supplier', [['Supplier'], ['Purchases', true], ['Total', true], ['Due', true]], [...bySupplier.entries()].sort((a, b) => b[1].total - a[1].total).map(([supplier, entry]) => [escapeHtml(supplier), entry.count, currency(round2(entry.total)), entry.due > 0 ? `<span class="due-text">${currency(round2(entry.due))}</span>` : '—']), { empty: 'No purchases in this period.' })}
    </div>`;
}

/* ---------- Salesman-wise sales ---------- */
// Bills are credited to the salesman chosen on them; returns come off the salesman of the original bill.
function salesmanReport(range, data) {
  const soldBy = new Map(data.sales.map(sale => [sale.id, sale]));
  const bills = data.sales.filter(sale => inRange(sale.day, range)), returns = data.creditNotes.filter(note => inRange(note.day, range));
  const groups = new Map();
  const groupFor = sale => {
    const key = `${sale.outletId}|${sale.salesmanId ?? 'none'}`;
    if (!groups.has(key)) groups.set(key, { key, outletId: sale.outletId, name: sale.salesmanName || 'Not assigned', assigned: sale.salesmanId != null, bills: 0, items: 0, gross: 0, returned: 0 });
    return groups.get(key);
  };
  // Bills arrive newest first, so the name on a salesman's latest bill is the one shown if they were renamed.
  bills.forEach(sale => { const group = groupFor(sale); group.bills += 1; group.items += sumOf(sale.lines, line => line.qty); group.gross = round2(group.gross + sale.total); });
  returns.forEach(note => { const sale = soldBy.get(note.saleId); if (!sale) return; const group = groupFor(sale); group.returned = round2(group.returned + note.total); });
  const rows = [...groups.values()].map(group => ({ ...group, net: round2(group.gross - group.returned) })).sort((a, b) => b.net - a.net);
  const totalNet = sumOf(rows, row => row.net), totalBills = sumOf(rows, row => row.bills), unassigned = rows.filter(row => !row.assigned);
  const top = rows.find(row => row.assigned);
  const listing = [...bills].sort((a, b) => b.date.localeCompare(a.date));
  reportExport = { name: 'salesman-wise-sales.csv', rows: [['Outlet', 'Salesman', 'Invoice', 'Date', 'Customer', 'Items', 'Bill total', 'Credited (returns)', 'Net'],
    ...listing.map(sale => [outletCode(data, sale.outletId), sale.salesmanName || 'Not assigned', sale.number, sale.day, sale.customerName, sumOf(sale.lines, line => line.qty), sale.total, sale.credited || 0, round2(sale.total - (sale.credited || 0))])] };
  const summaryTable = tableCard('Sales by salesman', [['Salesman'], ['Bills', true], ['Items', true], ['Sales', true], ['Returns', true], ['Net sales', true], ['Avg bill', true], ['Share', true]],
    rows.map(row => [withOutlet(data, row.outletId, `${escapeHtml(row.name)}${row.assigned ? '' : '<small>No salesman chosen on these bills</small>'}`), row.bills, row.items, currency(row.gross), row.returned ? `<span class="due-text">−${currency(row.returned)}</span>` : '—', `<strong>${currency(row.net)}</strong>`, row.bills ? currency(round2(row.gross / row.bills)) : '—', marginBar(row.net, totalNet)]),
    { empty: 'No sales in this period.', foot: rows.length ? ['Total', totalBills, sumOf(rows, row => row.items), currency(sumOf(rows, row => row.gross)), sumOf(rows, row => row.returned) ? `−${currency(sumOf(rows, row => row.returned))}` : '—', currency(totalNet), totalBills ? currency(round2(sumOf(rows, row => row.gross) / totalBills)) : '—', ''] : undefined, note: range.label });
  const billsTable = tableCard('Bills with their salesman', [['Invoice'], ['Customer'], ['Salesman'], ['Amount', true]],
    listing.slice(0, 40).map(sale => [withOutlet(data, sale.outletId, `#${sale.number}<small>${formatKey(sale.day)}</small>`), escapeHtml(sale.customerName), sale.salesmanName ? escapeHtml(sale.salesmanName) : '<span class="muted-text">Not assigned</span>', currency(sale.total)]),
    { empty: 'No bills in this period.', note: listing.length > 40 ? 'Latest 40 (export for all)' : '' });
  return `<div class="kpi-grid">${kpi('Net sales', currency(totalNet), `${totalBills} bill${totalBills === 1 ? '' : 's'} · ${range.label}`)}${kpi('Top salesman', top ? escapeHtml(top.name) : '—', top ? `${currency(top.net)} · ${percent(top.net, totalNet)} of sales` : 'no salesman chosen yet')}${kpi('Salesmen with sales', rows.filter(row => row.assigned && row.bills).length, 'in this period')}${kpi('Not assigned', currency(sumOf(unassigned, row => row.net)), `${sumOf(unassigned, row => row.bills)} bill${sumOf(unassigned, row => row.bills) === 1 ? '' : 's'} without a salesman`)}</div>
    ${summaryTable}
    ${billsTable}
    <p class="report-footnote">Sales are bill totals including GST. Returns are taken off the salesman who made the original bill, in the period the credit note was issued. Choose the salesman on each bill in New bill; bills made without one are listed as Not assigned.</p>`;
}

/* ---------- Opening stock ---------- */
// A register of the starting quantities and costs entered for each outlet. It does not depend on the period.
function openingReport(range, data) {
  const entered = data.stock.filter(material => material.openingQty !== null && material.openingQty !== undefined)
    .sort((a, b) => a.outletId - b.outletId || (a.openingDate || '').localeCompare(b.openingDate || '') || a.name.localeCompare(b.name));
  const pending = data.stock.filter(material => material.openingQty === null || material.openingQty === undefined);
  const worth = material => round2(material.openingQty * (material.openingCost || 0));
  const total = sumOf(entered, worth), locked = entered.filter(material => material.openingLocked).length;
  reportExport = { name: 'opening-stock-report.csv', rows: [['Outlet', 'Item code', 'EAN', 'Item', 'Type', 'Unit', 'As of', 'Opening quantity', 'Cost per unit', 'Opening value', 'Current stock', 'Status'],
    ...entered.map(material => [outletCode(data, material.outletId), material.code, material.ean || '', material.name, material.type, material.unit, material.openingDate || '', material.openingQty, material.openingCost, worth(material), material.stock, material.openingLocked ? 'Locked' : 'Editable']),
    ...pending.map(material => [outletCode(data, material.outletId), material.code, material.ean || '', material.name, material.type, material.unit, '', '', '', '', material.stock, 'Not entered'])] };
  const outletRows = data.multi ? data.outlets.map(outlet => {
    const own = entered.filter(material => material.outletId === outlet.id), all = data.stock.filter(material => material.outletId === outlet.id);
    return [`${escapeHtml(outlet.name)}<small>${outlet.code}</small>`, own.length, all.length - own.length, currency(sumOf(own, worth))];
  }) : [];
  const outletTable = data.multi ? tableCard('Opening stock by outlet', [['Outlet'], ['Items entered', true], ['Not entered', true], ['Opening value', true]], outletRows, { foot: ['Total', entered.length, pending.length, currency(total)] }) : '';
  return `<div class="kpi-grid">${kpi('Opening value', currency(total), 'at the entered cost')}${kpi('Items entered', entered.length, `of ${data.stock.length} item${data.stock.length === 1 ? '' : 's'}`)}${kpi('Not entered yet', pending.length, pending.length ? 'no opening stock recorded' : 'every item has one')}${kpi('Locked', locked, 'later purchases, sales or transfers')}</div>
    ${outletTable}
    ${tableCard('Opening stock register', [['Item'], ['As of'], ['Opening qty', true], ['Cost / unit', true], ['Value', true], ['Stock now', true], ['Status']], entered.map(material => [withOutlet(data, material.outletId, `${escapeHtml(material.name)}<small>${escapeHtml(material.code || '')} · ${material.type}</small>`), material.openingDate ? formatKey(material.openingDate) : '—', fmtQty(material.openingQty, material.unit), currency(material.openingCost || 0), currency(worth(material)), fmtQty(material.stock, material.unit), material.openingLocked ? '<span class="status-badge status-partial">Locked</span>' : '<span class="status-badge status-paid">Editable</span>']), { empty: 'No opening stock has been entered yet.', note: 'All dates', foot: entered.length ? ['Total', '', '', '', currency(total), '', ''] : undefined })}
    ${pending.length ? tableCard('Items without opening stock', [['Item'], ['Type'], ['Unit'], ['Stock now', true]], pending.slice(0, 100).map(material => [withOutlet(data, material.outletId, `${escapeHtml(material.name)}<small>${escapeHtml(material.code || '')}</small>`), material.type, material.unit, fmtQty(material.stock, material.unit)]), { note: pending.length > 100 ? 'First 100 (export for all)' : '' }) : ''}
    <p class="report-footnote">Locked means the item has had purchases, transfers, sales or adjustments since, so its opening quantity can no longer be edited. Stock now is the live quantity.</p>`;
}

/* ---------- Royalty (HQ) ---------- */
function royaltyReport(range, data) {
  const franchises = data.outlets.filter(outlet => outlet.type === 'franchise');
  const rows = franchises.map(outlet => {
    const own = data.sales.filter(sale => sale.outletId === outlet.id);
    const ownReturns = data.creditNotes.filter(note => note.outletId === outlet.id);
    const period = round2(sumOf(own.filter(sale => inRange(sale.day, range)), sale => sale.taxable) - sumOf(ownReturns.filter(note => inRange(note.day, range)), note => note.taxable));
    const lifetimeDue = round2((sumOf(own, sale => sale.taxable) - sumOf(ownReturns, note => note.taxable)) * outlet.royaltyPct / 100);
    const paid = sumOf(data.royaltyPayments.filter(payment => payment.outletId === outlet.id), payment => payment.amount);
    return { outlet, period, periodRoyalty: round2(period * outlet.royaltyPct / 100), lifetimeDue, paid, outstanding: round2(lifetimeDue - paid) };
  });
  const payments = data.royaltyPayments.filter(payment => inRange(payment.date, range));
  reportExport = { name: 'royalty-report.csv', rows: [['Outlet', 'Royalty %', 'Net sales (period)', 'Royalty (period)', 'Royalty due (all time)', 'Received (all time)', 'Outstanding'], ...rows.map(row => [row.outlet.code, row.outlet.royaltyPct, row.period, row.periodRoyalty, row.lifetimeDue, row.paid, row.outstanding])] };
  const name = id => (data.allOutlets || data.outlets).find(outlet => outlet.id === id)?.name || '';
  return `<div class="kpi-grid">${kpi('Royalty for period', currency(sumOf(rows, row => row.periodRoyalty)), range.label)}${kpi('Franchise net sales', currency(sumOf(rows, row => row.period)), 'ex-GST, after discounts')}${kpi('Received', currency(sumOf(payments, payment => payment.amount)), 'in this period')}${kpi('Outstanding', currency(sumOf(rows, row => row.outstanding)), 'all time, all outlets')}</div>
    ${tableCard('Royalty by outlet', [['Outlet'], ['Rate', true], ['Net sales', true], ['Royalty (period)', true], ['Due (all time)', true], ['Received', true], ['Outstanding', true], ['']], rows.map(row => [`${escapeHtml(row.outlet.name)}<small>${row.outlet.code}</small>`, `${row.outlet.royaltyPct}%`, currency(row.period), currency(row.periodRoyalty), currency(row.lifetimeDue), currency(row.paid), row.outstanding > 0 ? `<span class="due-text">${currency(row.outstanding)}</span>` : currency(row.outstanding), `<button class="link-button accent" data-royalty-outlet="${row.outlet.id}" data-due="${Math.max(0, row.outstanding)}">Record payment</button>`]), { empty: 'No franchise outlets in this view.', foot: ['Total', '', currency(sumOf(rows, row => row.period)), currency(sumOf(rows, row => row.periodRoyalty)), currency(sumOf(rows, row => row.lifetimeDue)), currency(sumOf(rows, row => row.paid)), currency(sumOf(rows, row => row.outstanding)), ''] })}
    ${tableCard('Royalty payments received', [['Date'], ['Outlet'], ['Mode'], ['Note'], ['Amount', true]], payments.map(payment => [formatKey(payment.date), escapeHtml(name(payment.outletId)), payment.mode, escapeHtml(payment.note || '—'), currency(payment.amount)]), { empty: 'No royalty payments recorded in this period.' })}
    <p class="report-footnote">Royalty is the outlet's rate applied to net sales excluding GST, after discounts and returns. A rate change applies to all past sales.</p>`;
}

/* ---------- Render and wire up ---------- */
async function renderReports() {
  const token = ++reportToken;
  if (!isAdmin() && reportTab === 'royalty') reportTab = 'sales';
  if (isAdmin()) fillScopeOptions();
  const range = reportRange();
  $$('.report-tab').forEach(tab => { const active = tab.dataset.report === reportTab; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); });
  let data;
  try { data = await reportData(); }
  catch (error) { if (token === reportToken) $('#reportBody').innerHTML = `<p class="report-alert">${escapeHtml(error.message)}</p>`; return; }
  if (token !== reportToken) return;
  const builders = { sales: salesReport, profit: profitReport, stock: stockReport, dues: duesReport, opening: openingReport, salesman: salesmanReport, royalty: royaltyReport };
  $('#reportBody').innerHTML = builders[reportTab](range, data);
}
$$('.report-tab').forEach(tab => tab.addEventListener('click', () => { reportTab = tab.dataset.report; renderReports(); }));
$('#reportRange').addEventListener('change', () => {
  const custom = $('#reportRange').value === 'custom';
  $('#rangeFromBox').classList.toggle('hidden', !custom); $('#rangeToBox').classList.toggle('hidden', !custom);
  if (custom && !$('#reportFrom').value) { $('#reportFrom').value = `${todayKey().slice(0, 8)}01`; $('#reportTo').value = todayKey(); }
  renderReports();
});
$('#reportScope').addEventListener('change', renderReports);
$('#reportFrom').addEventListener('change', renderReports);
$('#reportTo').addEventListener('change', renderReports);
$('#exportReport').addEventListener('click', () => downloadCsv(reportExport.name, reportExport.rows));
$('#reportBody').addEventListener('click', event => {
  const button = event.target.closest('[data-royalty-outlet]');
  if (button) openRoyaltyModal(Number(button.dataset.royaltyOutlet), Number(button.dataset.due));
});
$('#reportBody').addEventListener('mousemove', event => {
  const tip = $('#chartTip');
  if (!tip) return;
  const hit = event.target.closest('[data-tip]');
  tip.classList.toggle('hidden', !hit);
  if (!hit) return;
  const wrap = tip.parentElement.getBoundingClientRect();
  tip.textContent = hit.dataset.tip;
  tip.style.left = `${Math.min(event.clientX - wrap.left + 12, wrap.width - tip.offsetWidth - 4)}px`;
  tip.style.top = `${event.clientY - wrap.top - 38}px`;
});
$('#reportBody').addEventListener('mouseleave', () => $('#chartTip')?.classList.add('hidden'));

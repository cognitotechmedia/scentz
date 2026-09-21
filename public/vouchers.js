/* ---------- Receipts and payments, and franchise invoices loaded as purchases ---------- */
let voucherKind = 'receipt';
let voucherPartyKey = null;
const VOUCHER_TEXT = {
  receipt: { tab: 'Receipt', title: 'Receipt', noun: 'Customer', from: 'RECEIVED FROM', amount: 'Amount received', pay: 'Receive now', save: 'Save receipt', dues: 'Customers with a balance', list: 'Recent receipts', search: 'Search name or mobile number', pick: 'Choose a customer to see what is outstanding.', bill: 'Bill', appliedTo: 'Invoice' },
  payment: { tab: 'Payment', title: 'Payment', noun: 'Supplier', from: 'PAID TO', amount: 'Amount paid', pay: 'Pay now', save: 'Save payment', dues: 'Suppliers you owe', list: 'Recent payments', search: 'Search supplier name', pick: 'Choose a supplier to see what is outstanding.', bill: 'Purchase', appliedTo: 'Purchase' }
};
const supplierKey = name => String(name).trim().toLowerCase();

/* ----- Who owes what ----- */
// Customers (by mobile number) with unpaid bills, or suppliers (by name) with unpaid purchases.
function dueParties(kind) {
  const parties = new Map();
  const add = (key, name, phone, due, day) => {
    const party = parties.get(key) || { key, name, phone, due: 0, bills: 0, oldest: day };
    party.due = round2(party.due + due); party.bills += 1;
    if (day < party.oldest) { party.oldest = day; party.name = name; }   // spelled as on the oldest bill, like the voucher will be
    parties.set(key, party);
  };
  if (kind === 'receipt') sales.forEach(sale => { const due = dueOf(sale); if (due > 0) add(sale.customerPhone, sale.customerName, sale.customerPhone, due, sale.day); });
  else purchases.forEach(purchase => { const due = dueOf(purchase); if (due > 0) add(supplierKey(purchase.supplier), purchase.supplier, '', due, purchase.date); });
  return [...parties.values()].sort((a, b) => b.due - a.due);
}
// The unpaid bills of one party, oldest first.
function partyBills(kind, key) {
  if (kind === 'receipt') return sales.filter(sale => sale.customerPhone === key && dueOf(sale) > 0).sort((a, b) => a.date.localeCompare(b.date)).map(sale => ({ id: sale.id, number: sale.number, day: sale.day, total: netTotal(sale), due: dueOf(sale) }));
  return purchases.filter(purchase => supplierKey(purchase.supplier) === key && dueOf(purchase) > 0).sort((a, b) => a.date.localeCompare(b.date)).map(purchase => ({ id: purchase.id, number: purchase.number, day: purchase.date, total: purchase.total, due: dueOf(purchase) }));
}

/* ----- The screen ----- */
function renderVouchers() {
  if (isBiller()) voucherKind = 'receipt';
  const text = VOUCHER_TEXT[voucherKind], today = todayKey();
  $$('#voucherKind [data-voucher-kind]').forEach(button => button.classList.toggle('active', button.dataset.voucherKind === voucherKind));
  $('#voucherSubtitle').textContent = voucherKind === 'receipt'
    ? 'Money received from customers who bought on credit. Each receipt is numbered and applied to their unpaid bills.'
    : 'Money paid to suppliers you bought from on credit. Each payment is numbered and applied to their unpaid purchases.';
  $('#voucherPartyLabel').textContent = text.noun; $('#voucherParty').placeholder = text.search;
  $('#voucherAmountLabel').textContent = text.amount; $('#vbPayHead').textContent = text.pay; $('#vbBillHead').textContent = text.bill;
  $('#voucherSave').textContent = text.save;
  if (!$('#voucherDate').value) $('#voucherDate').value = today;
  $('#voucherDate').max = today;
  const owed = dueParties('receipt'), owing = isBiller() ? [] : dueParties('payment'), month = today.slice(0, 7);
  const sumKind = kind => round2(vouchers.filter(voucher => voucher.kind === kind && voucher.day.startsWith(month)).reduce((sum, voucher) => sum + voucher.amount, 0));
  $('#voucherKpis').innerHTML = kpi('Receivable', currency(round2(owed.reduce((sum, party) => sum + party.due, 0))), `${owed.length} customer${owed.length === 1 ? '' : 's'} owe you`)
    + (isBiller() ? '' : kpi('Payable', currency(round2(owing.reduce((sum, party) => sum + party.due, 0))), `${owing.length} supplier${owing.length === 1 ? '' : 's'} to pay`))
    + kpi('Received this month', currency(sumKind('receipt')), `${vouchers.filter(voucher => voucher.kind === 'receipt' && voucher.day.startsWith(month)).length} receipts`)
    + (isBiller() ? '' : kpi('Paid this month', currency(sumKind('payment')), `${vouchers.filter(voucher => voucher.kind === 'payment' && voucher.day.startsWith(month)).length} payments`));
  // parties with a balance
  const parties = voucherKind === 'receipt' ? owed : owing;
  $('#voucherDuesHead').textContent = `${text.dues} (${parties.length})`;
  $('#voucherDues').innerHTML = parties.length ? parties.map(party => `<div class="due-party-row" data-load-party="${escapeHtml(party.key)}" tabindex="0" role="button" aria-label="Choose ${escapeHtml(party.name)}"><span><strong>${escapeHtml(party.name)}</strong><small>${party.phone ? formatPhone(party.phone) : 'Supplier'}</small></span><span data-label="Bills">${party.bills} bill${party.bills === 1 ? '' : 's'}</span><span data-label="Oldest">${formatKey(party.oldest)}</span><span class="num due-text" data-label="Due">${currency(party.due)}</span><span class="row-actions"><span class="link-button accent">${voucherKind === 'receipt' ? 'Receive' : 'Pay'}</span></span></div>`).join('') : `<div class="purchase-empty">${voucherKind === 'receipt' ? 'No customer owes you anything.' : 'You owe no supplier anything.'}</div>`;
  // recent vouchers of this kind
  const list = vouchers.filter(voucher => voucher.kind === voucherKind);
  $('#voucherListHead').textContent = `${text.list} (${list.length})`;
  $('#voucherRows').innerHTML = list.length ? list.slice(0, 60).map(voucher => `<div class="voucher-row"><span><strong>${voucher.number}</strong><small>${formatKey(voucher.day)}</small></span><span data-label="Party">${escapeHtml(voucher.party)}${voucher.note ? `<small>${escapeHtml(voucher.note)}</small>` : ''}</span><span data-label="Mode">${voucher.mode}</span><span data-label="Applied to">${voucher.allocations.map(entry => `#${escapeHtml(entry.number)}`).join(', ') || '—'}</span><span class="num" data-label="Amount">${currency(voucher.amount)}</span><span class="row-actions"><button class="link-button" data-view-voucher="${voucher.id}">View</button></span></div>`).join('') : `<div class="purchase-empty">No ${voucherKind === 'receipt' ? 'receipts' : 'payments'} yet</div>`;
  // the form keeps what the user is typing unless the party has nothing left to settle
  if (voucherPartyKey && !partyBills(voucherKind, voucherPartyKey).length) clearVoucherForm(false);
}
$('#voucherKind').addEventListener('click', event => {
  const button = event.target.closest('[data-voucher-kind]');
  if (!button || button.dataset.voucherKind === voucherKind) return;
  voucherKind = button.dataset.voucherKind;
  clearVoucherForm(false);
  renderVouchers();
});

/* ----- The form ----- */
const voucherLookup = { choose: (row, item) => loadVoucherParty(item.id) };
const voucherPool = () => dueParties(voucherKind).map(party => ({ id: party.key, code: party.phone, ean: null, name: party.name, type: `Due ${currency(party.due)} · ${party.bills} bill${party.bills === 1 ? '' : 's'}`, stock: null, unit: 'pcs' }));
const billInputs = () => $$('#voucherBills .vb-amount');
function syncVoucherTotal() {
  const total = round2(billInputs().reduce((sum, input) => sum + (Number(input.value) || 0), 0));
  $('#voucherAmount').value = total > 0 ? String(total) : '';
  $('#voucherSave').disabled = !(total > 0);
}
function loadVoucherParty(key) {
  const text = VOUCHER_TEXT[voucherKind], bills = partyBills(voucherKind, key), party = dueParties(voucherKind).find(entry => entry.key === key);
  if (!party || !bills.length) return;
  hideSuggest();
  voucherPartyKey = key;
  $('#voucherParty').value = party.name;
  $('#voucherPartyBox').classList.remove('hidden');
  $('#voucherPartyBox').innerHTML = `<div><strong>${escapeHtml(party.name)}</strong><small>${party.phone ? formatPhone(party.phone) : 'Supplier'}</small></div><div class="num"><span>Total due</span><strong class="due-text">${currency(party.due)}</strong><small>${party.bills} bill${party.bills === 1 ? '' : 's'} · oldest ${formatKey(party.oldest)}</small></div>`;
  $('#voucherBills').innerHTML = bills.map(bill => `<div class="vb-row" data-bill="${bill.id}"><span><strong>#${escapeHtml(bill.number)}</strong><small>${formatKey(bill.day)}</small></span><span class="num" data-label="Bill total">${currency(bill.total)}</span><span class="num" data-label="Still due">${currency(bill.due)}</span><span class="num" data-label="${text.pay}"><div class="input-with-unit"><span>₹</span><input class="vb-amount" type="text" inputmode="decimal" autocomplete="off" data-bill="${bill.id}" data-due="${bill.due}" value="${bill.due}" aria-label="Amount against ${escapeHtml(bill.number)}" /></div></span></div>`).join('');
  $('#voucherAmount').disabled = false;
  syncVoucherTotal();
  $('#voucherAmount').focus(); $('#voucherAmount').select();
}
function clearVoucherForm(focus = true) {
  voucherPartyKey = null;
  $('#voucherParty').value = ''; $('#voucherNote').value = ''; $('#voucherAmount').value = ''; $('#voucherAmount').disabled = true;
  $('#voucherSave').disabled = true; $('#voucherPartyBox').classList.add('hidden'); $('#voucherPartyBox').innerHTML = '';
  $('#voucherBills').innerHTML = `<div class="purchase-empty">${VOUCHER_TEXT[voucherKind].pick}</div>`;
  hideSuggest();
  if (focus) $('#voucherParty').focus();
}
$('#voucherParty').addEventListener('input', event => {
  if (voucherPartyKey) { voucherPartyKey = null; $('#voucherAmount').value = ''; $('#voucherAmount').disabled = true; $('#voucherSave').disabled = true; $('#voucherPartyBox').classList.add('hidden'); $('#voucherBills').innerHTML = `<div class="purchase-empty">${VOUCHER_TEXT[voucherKind].pick}</div>`; }
  const query = event.target.value;
  suggestState = query.trim() ? { grid: voucherLookup, row: null, input: event.target, list: searchItems(query, voucherPool()), active: 0 } : null;
  renderSuggest();
});
$('#voucherParty').addEventListener('focus', event => {
  if (voucherPartyKey) return;
  const pool = voucherPool();
  if (!event.target.value.trim() && pool.length) { suggestState = { grid: voucherLookup, row: null, input: event.target, list: pool.slice(0, 8), active: 0 }; renderSuggest(); }
});
$('#voucherParty').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    const inList = suggestState && suggestState.input === event.target;
    const list = inList ? suggestState.list : searchItems(event.target.value, voucherPool()), choice = list[inList ? suggestState.active : 0];
    if (choice) loadVoucherParty(choice.id); else showToast(`No ${VOUCHER_TEXT[voucherKind].noun.toLowerCase()} with a balance matches`);
  } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestState && suggestState.input === event.target && suggestState.list.length) {
    event.preventDefault();
    suggestState.active = (suggestState.active + (event.key === 'ArrowDown' ? 1 : -1) + suggestState.list.length) % suggestState.list.length;
    renderSuggest();
  } else if (event.key === 'Escape') hideSuggest();
});
$('#voucherParty').addEventListener('blur', () => setTimeout(() => { if (suggestState && suggestState.input === $('#voucherParty')) hideSuggest(); }, 130));
const decimalOnly = input => { const clean = input.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'); if (clean !== input.value) input.value = clean; };
// Typing the total settles the oldest bills first.
$('#voucherAmount').addEventListener('input', event => {
  decimalOnly(event.target);
  let remaining = round2(Number(event.target.value) || 0);
  billInputs().forEach(input => { const part = Math.min(remaining, Number(input.dataset.due)); input.value = part > 0 ? String(round2(part)) : ''; remaining = round2(remaining - part); });
  $('#voucherSave').disabled = !(Number(event.target.value) > 0);
  $('#voucherHint').textContent = remaining > 0 ? `That is ${currency(remaining)} more than what is due.` : 'Type the total to settle the oldest bills first, or fill in the amount against each bill.';
});
$('#voucherBills').addEventListener('input', event => {
  const input = event.target.closest('.vb-amount');
  if (!input) return;
  decimalOnly(input);
  input.closest('.vb-row').classList.toggle('over', Number(input.value) > Number(input.dataset.due) + 1e-9);
  syncVoucherTotal();
});
$('#voucherBills').addEventListener('focusin', event => { if (event.target.classList.contains('vb-amount')) event.target.select(); });
$('#voucherBills').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || !event.target.classList.contains('vb-amount')) return;
  event.preventDefault();
  const inputs = billInputs(), next = inputs[inputs.indexOf(event.target) + 1];
  if (next) next.focus(); else $('#voucherNote').focus();
});
$('#voucherClear').addEventListener('click', () => clearVoucherForm());
$('#voucherForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!voucherPartyKey) { showToast(`Choose a ${VOUCHER_TEXT[voucherKind].noun.toLowerCase()} first`); $('#voucherParty').focus(); return; }
  submitting($('#voucherSave'), async () => {
    const allocations = billInputs().map(input => ({ id: input.dataset.bill, amount: round2(Number(input.value) || 0), due: Number(input.dataset.due) })).filter(entry => entry.amount > 0);
    const over = allocations.find(entry => entry.amount > entry.due + 1e-9);
    if (over) { showToast(`An amount is more than the ${currency(over.due)} due on that bill`); return; }
    if (!allocations.length) { showToast('Enter an amount greater than 0'); return; }
    const date = $('#voucherDate').value || todayKey();
    const voucher = await api('POST', '/api/vouchers', { kind: voucherKind, partyKey: voucherPartyKey, mode: $('#voucherMode').value, date, note: $('#voucherNote').value.trim(), allocations: allocations.map(entry => ({ id: entry.id, amount: entry.amount })) });
    const wasReceipt = voucherKind === 'receipt';
    voucherPartyKey = null;
    await reloadAll();
    clearVoucherForm(false);
    showVoucher(voucher.id);
    showToast(`${voucher.number} saved · ${currency(voucher.amount)} ${wasReceipt ? 'received' : 'paid'}`);
  });
});
$('#voucherDues').addEventListener('click', event => { const row = event.target.closest('[data-load-party]'); if (row) loadVoucherParty(row.dataset.loadParty); });
$('#voucherDues').addEventListener('keydown', event => { const row = event.target.closest('[data-load-party]'); if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); loadVoucherParty(row.dataset.loadParty); } });
$('#voucherRows').addEventListener('click', event => { const button = event.target.closest('[data-view-voucher]'); if (button) showVoucher(button.dataset.viewVoucher); });
$('#exportVouchers').addEventListener('click', () => {
  const list = vouchers.filter(voucher => voucher.kind === voucherKind);
  downloadCsv(`${voucherKind === 'receipt' ? 'receipts' : 'payments'}.csv`, [['Voucher', 'Date', 'Party', 'Mode', 'Amount', 'Applied to', 'Reference'], ...list.map(voucher => [voucher.number, voucher.day, voucher.party, voucher.mode, voucher.amount, voucher.allocations.map(entry => `${entry.number} (${entry.amount})`).join('; '), voucher.note])]);
});

/* ----- Voucher document ----- */
function voucherHtml(voucher) {
  const store = outletById(voucher.outletId), text = VOUCHER_TEXT[voucher.kind], receipt = voucher.kind === 'receipt';
  const balance = receipt ? round2(sales.filter(sale => sale.customerPhone === voucher.partyKey).reduce((sum, sale) => sum + Math.max(0, dueOf(sale)), 0)) : round2(purchases.filter(purchase => supplierKey(purchase.supplier) === voucher.partyKey).reduce((sum, purchase) => sum + Math.max(0, dueOf(purchase)), 0));
  const rows = voucher.allocations.map((entry, index) => `<tr><td>${index + 1}</td><td><strong>${text.appliedTo} #${escapeHtml(entry.number)}</strong></td><td>${currency(entry.amount)}</td></tr>`).join('');
  const totalRow = (label, value, strong = false) => `<div class="${strong ? 'inv-grand' : ''}"><span>${label}</span><span>${value}</span></div>`;
  return `<div class="inv-head"><div><h2>${escapeHtml(store.name)}</h2>${store.address ? `<p>${escapeHtml(store.address)}</p>` : ''}${store.phone ? `<p>Phone: ${escapeHtml(store.phone)}</p>` : ''}${store.gstin ? `<p>GSTIN: ${escapeHtml(store.gstin)}</p>` : ''}</div><div class="inv-meta"><span class="bill-label">${receipt ? 'RECEIPT VOUCHER' : 'PAYMENT VOUCHER'}</span><strong>#${voucher.number}</strong><p>${formatKey(voucher.day)}</p></div></div>
    <div class="inv-party"><span class="bill-label">${text.from}</span><strong>${escapeHtml(voucher.party)}</strong>${receipt ? `<p>${formatPhone(voucher.partyKey)}</p>` : ''}</div>
    <table class="inv-table inv-cols3"><thead><tr><th>#</th><th>Applied to</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="inv-totals">${totalRow(text.amount, currency(voucher.amount), true)}${totalRow('Mode', voucher.mode)}${voucher.note ? totalRow('Reference', escapeHtml(voucher.note)) : ''}${totalRow(receipt ? 'Balance still due from customer' : 'Balance still due to supplier', currency(balance))}</div>
    <p class="inv-foot">${receipt ? `Thank you. Received with thanks by ${escapeHtml(store.name)}.` : `Payment made by ${escapeHtml(store.name)}.`}</p>`;
}
function showVoucher(id) {
  const voucher = vouchers.find(entry => entry.id === id);
  if (!voucher) return;
  currentDoc = { type: 'voucher', id };
  $('#invoiceContent').innerHTML = voucherHtml(voucher);
  $('#returnFromInvoice').classList.add('hidden');
  $('#shareInvoice').classList.toggle('hidden', voucher.kind !== 'receipt');
  $('#invoiceModal').classList.remove('hidden');
}
function shareVoucher() {
  const voucher = vouchers.find(entry => entry.id === currentDoc.id);
  if (!voucher || voucher.kind !== 'receipt') return;
  const store = outletById(voucher.outletId);
  const text = [`*${store.name}*`, `Receipt ${voucher.number} · ${formatKey(voucher.day)}`, '', `Received ${currency(voucher.amount)} via ${voucher.mode}`, `Against: ${voucher.allocations.map(entry => `#${entry.number}`).join(', ')}`, '', 'Thank you!'].join('\n');
  window.open(`https://wa.me/91${voucher.partyKey}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

/* ---------- Franchise invoices loaded into the purchase form ---------- */
let hqInvoiceData = { gstin: '', invoices: [] };
async function loadHqInvoices() {
  if (isBiller() || !state.me) return;
  try { hqInvoiceData = await api('GET', '/api/hq-invoices'); } catch { hqInvoiceData = { gstin: '', invoices: [] }; }
  renderHqInvoices();
}
function renderHqInvoices() {
  const invoices = hqInvoiceData.invoices, box = $('#hqInvoices');
  box.classList.toggle('hidden', !invoices.length);
  if (!invoices.length) return;
  const waiting = invoices.filter(invoice => !invoice.loadedAs);
  $('#hqInvoiceNote').textContent = waiting.length ? `${waiting.length} waiting to be loaded · matched by your GSTIN ${hqInvoiceData.gstin}` : 'All loaded';
  $('#hqInvoiceRows').innerHTML = invoices.map(invoice => `<div class="hq-invoice-row"><span><strong>${escapeHtml(invoice.number)}</strong><small>${escapeHtml(invoice.seller)} · ${formatKey(invoice.day)}</small></span><span data-label="Stock lines">${invoice.stockLines.length} item${invoice.stockLines.length === 1 ? '' : 's'} to stock${invoice.skipped.length ? `<small>Not stock-counted: ${invoice.skipped.map(escapeHtml).join(', ')}</small>` : ''}</span><span class="num" data-label="Invoice total">${currency(invoice.payable)}<small>GST and other ${currency(invoice.extra)}</small></span><span class="row-actions">${invoice.loadedAs ? `<span class="status-badge status-paid">Loaded as ${escapeHtml(invoice.loadedAs)}</span>` : `<button class="primary-button small-button" type="button" data-load-invoice="${invoice.id}">Load into purchase</button>`}</span></div>`).join('');
}
$('#hqInvoiceRows').addEventListener('click', event => {
  const button = event.target.closest('[data-load-invoice]');
  if (button) openInvoicePurchase(hqInvoiceData.invoices.find(invoice => invoice.id === button.dataset.loadInvoice));
});
function openInvoicePurchase(invoice) {
  if (!invoice || invoice.loadedAs) return;
  activeInvoice = invoice;
  $('#purchaseSupplier').value = invoice.seller; $('#purchaseInvoice').value = invoice.number; $('#purchaseDate').value = invoice.day;
  ['#purchaseSupplier', '#purchaseInvoice'].forEach(selector => { $(selector).disabled = true; });
  $('#purchasePaid').value = '0';
  $('#purchaseLinesBox').classList.add('hidden');
  $('#invoiceLoaded').classList.remove('hidden');
  $('#invoiceLoaded').innerHTML = `<div class="invoice-banner"><div><span class="bill-label">LOADED FROM INVOICE</span><strong>${escapeHtml(invoice.number)}</strong><small>${escapeHtml(invoice.seller)}${invoice.sellerGstin ? ` · GSTIN ${escapeHtml(invoice.sellerGstin)}` : ''} · ${formatKey(invoice.day)}</small></div><button class="outline-button" type="button" id="detachInvoice">Cancel loading</button></div>
    <div class="table-scroll"><table class="report-table"><thead><tr><th>Item</th><th class="num">Quantity</th><th class="num">Cost before GST</th><th class="num">Per unit</th></tr></thead><tbody>${invoice.stockLines.map(line => `<tr><td>${escapeHtml(line.name)}</td><td class="num">${fmtQty(line.qty, line.unit)}</td><td class="num">${currency(line.total)}</td><td class="num">${currency(round2(line.total / line.qty))}</td></tr>`).join('') || '<tr><td colspan="4">No stock-counted items on this invoice.</td></tr>'}</tbody><tfoot><tr><td>GST and other charges</td><td></td><td class="num">${currency(invoice.extra)}</td><td></td></tr><tr><td>Invoice total payable</td><td></td><td class="num">${currency(invoice.payable)}</td><td></td></tr></tfoot></table></div>
    <p class="report-footnote">Quantities and amounts come from the invoice and cannot be edited here. Stock is added at the cost before GST; the GST is part of what you owe HQ.${invoice.skipped.length ? ` Not added to stock because the product is not stock-counted: ${invoice.skipped.map(escapeHtml).join(', ')}.` : ''}${invoice.credited ? ` HQ has already credited ${currency(invoice.credited)} for returns.` : ''} Set how much you have paid below (0 keeps it as a payable).</p>`;
  $('#purchaseTotal').textContent = currency(invoice.payable);
  $('#invoiceLoaded').scrollIntoView({ behavior: 'smooth', block: 'center' });
  showToast(`${invoice.number} loaded. Check it, set the payment and press Save purchase`);
}
function closeInvoicePurchase() {
  activeInvoice = null;
  ['#purchaseSupplier', '#purchaseInvoice'].forEach(selector => { $(selector).disabled = false; $(selector).value = ''; });
  $('#purchasePaid').value = '';
  $('#purchaseDate').value = todayKey();
  $('#invoiceLoaded').classList.add('hidden'); $('#invoiceLoaded').innerHTML = '';
  $('#purchaseLinesBox').classList.remove('hidden');
  purchaseGrid.refreshAll();
}
$('#invoiceLoaded').addEventListener('click', event => { if (event.target.closest('#detachInvoice')) closeInvoicePurchase(); });
async function savePurchaseFromInvoice() {
  const invoice = activeInvoice, paid = $('#purchasePaid').value === '' ? 0 : round2(Number($('#purchasePaid').value));
  if (!(paid >= 0) || paid > invoice.payable) { showToast(`Paid must be between ₹0 and ${currency(invoice.payable)}`); return; }
  const purchase = await api('POST', '/api/purchases', { sourceSaleId: invoice.id, date: $('#purchaseDate').value, paid, mode: $('#purchaseMode').value });
  closeInvoicePurchase();
  await reloadAll();
  showToast(`${purchase.number} booked from ${invoice.number}${invoice.stockLines.length ? ` · ${invoice.stockLines.length} item${invoice.stockLines.length === 1 ? '' : 's'} added to stock` : ''}`);
}

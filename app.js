/* ---------- App state ---------- */
let activeCategory = 'all';
let recipeProduct = null;
let recipeMaterialQuery = '';
let billDiscount = { type: 'amount', value: 0 };
let currentDoc = null;
let returningSaleId = null;
let paymentTarget = null;
let editingProduct = null;
const productGrid = $('#productGrid');
const cartList = $('#cartList');

/* ---------- Catalog and cart ---------- */
function productVisual(product, small = false) {
  return `<div class="product-art art-${product.art} ${small ? 'cart-thumb' : ''}"><div class="bottle"></div></div>`;
}
function renderProducts() {
  const query = $('#productSearch').value.toLowerCase();
  const filtered = products.filter(p => (activeCategory === 'all' || p.category === activeCategory) && `${p.name} ${p.type}`.toLowerCase().includes(query));
  $('#catalogCount').textContent = `${filtered.length} products`;
  productGrid.innerHTML = filtered.map(product => {
    // Packed products can count their stock in pieces; the card then shows what is left after the open bill.
    const tracked = product.stockMaterialId ? findMaterial(product.stockMaterialId) : null;
    const left = tracked ? Math.floor(availableMl(tracked)) : 0;
    const soldOut = Boolean(tracked) && left < 1;
    return `<article class="product-card ${soldOut ? 'sold-out' : ''}"><div>${productVisual(product)}</div><div class="product-info"><div class="product-name">${escapeHtml(product.name)}</div><div class="product-type">${product.type}</div>${tracked ? `<div class="product-stock ${left <= tracked.alertMl ? 'low' : ''}">${soldOut ? 'Out of stock' : `${left} in stock`}</div>` : ''}<div class="product-bottom"><span class="product-price">${currency(priceFor(product, billingType()))}</span><button class="add-product" data-add="${product.id}" aria-label="Add ${escapeHtml(product.name)}" ${soldOut ? 'disabled' : ''}>+</button></div></div></article>`;
  }).join('') || '<div class="empty-cart"><strong>No products found</strong><span>Try another search or category</span></div>';
}
// Stock reserved by the open bill: recipe materials, counted packed items and packaging.
// The server deducts it for real when the bill is created.
const reservedMl = materialId => db.cart.reduce((sum, item) => sum + (item.recipe || []).filter(line => line.id === materialId).reduce((total, line) => total + line.ml, 0) + (item.stockMaterialId === materialId ? item.quantity : 0) + (item.packMaterialId === materialId && item.includePack !== false ? (item.packQty || 1) * item.quantity : 0) + (item.extras || []).filter(extra => extra.id === materialId).reduce((total, extra) => total + extra.qty, 0), 0);
const availableMl = material => round2(material.stock - reservedMl(material.id));

// Who the open bill is for decides the price list: a saved wholesaler or franchise pays their own prices.
let billingTypeShown = 'retail';
const billingCustomer = () => { const phone = $('#customerPhone').value.trim(); return phone.length === 10 ? customers.find(customer => customer.phone === phone) || null : null; };
const billingType = () => billingCustomer()?.type || 'retail';
function refreshBillingParty() {
  const customer = billingCustomer(), type = customer?.type || 'retail', badge = $('#priceListBadge');
  badge.classList.toggle('hidden', type === 'retail');
  badge.className = `price-list-badge party-${type}${type === 'retail' ? ' hidden' : ''}`;
  badge.innerHTML = type === 'retail' ? '' : `<strong>${PRICE_LABELS[type]} price list</strong><span>${customer.gstin ? `GSTIN ${escapeHtml(customer.gstin)} · ` : ''}${type === 'franchise' ? 'franchise invoice series' : 'prices below are wholesale'}</span>`;
  if (type !== billingTypeShown) { syncCartWithCatalog(); renderCart(); }
  renderInvoiceNumber();
  renderTotals();   // loyalty points and the amount to pay follow the customer
}
function syncCartWithCatalog() {
  db.cart = db.cart.filter(item => products.some(product => product.id === item.productId));
  billingTypeShown = billingType();
  db.cart.forEach(item => { const product = products.find(entry => entry.id === item.productId);
    Object.assign(item, { price: priceFor(product, billingTypeShown), gstRate: product.gstRate, stockMaterialId: product.stockMaterialId, packMaterialId: product.packMaterialId, packQty: product.packQty }); });
}
function renderCart() {
  if (!db.cart.length) {
    cartList.innerHTML = '<div class="empty-cart"><div class="empty-icon">✦</div><strong>Your bill is empty</strong><span>Select products from the catalog to get started</span></div>';
  } else {
    cartList.innerHTML = db.cart.map(item => `<div class="cart-item"><div>${productVisual(item, true)}</div><div><div class="cart-name">${escapeHtml(item.name)}</div><div class="cart-meta">${item.type}</div><div class="cart-controls"><button class="qty-button" data-qty="${item.id}" data-change="-1">−</button><span>${item.quantity}</span><button class="qty-button" data-qty="${item.id}" data-change="1" ${item.recipe ? 'disabled title="Record another recipe for another bottle"' : ''}>+</button><button class="remove-item" data-remove="${item.id}" aria-label="Remove ${escapeHtml(item.name)}">×</button></div>${item.recipe ? `<span class="recipe-note">${item.recipe.map(line => `${escapeHtml(line.name)} ${line.ml.toFixed(2)}ml`).join(' · ')}${item.packMaterialId && item.includePack !== false ? ` · ${(item.packQty || 1)} × ${escapeHtml(findMaterial(item.packMaterialId)?.name || 'packaging')}` : ''}${(item.extras || []).map(extra => ` · ${extra.qty} × ${escapeHtml(extra.name)}`).join('')}</span>` : ''}</div><div class="cart-price">${currency(item.price * item.quantity)}</div></div>`).join('');
  }
  renderTotals();
  persistCart();
  renderProducts();
}
const currentBill = () => computeBill(db.cart, billDiscount, state.settings.taxMode);
function renderTotals() {
  const bill = currentBill();
  $('#subtotal').textContent = currency(bill.subtotal);
  $('#discountButton').innerHTML = bill.discount > 0 ? `−${currency(bill.discount)} · Edit` : 'Add discount <span>＋</span>';
  $('#taxable').textContent = currency(bill.taxable);
  $('#gstSplit').textContent = `${currency(bill.cgst)} / ${currency(bill.sgst)}`;
  $('#roundOffRow').classList.toggle('hidden', bill.roundOff === 0);
  $('#roundOff').textContent = `${bill.roundOff > 0 ? '+' : ''}${currency(bill.roundOff)}`;
  $('#total').textContent = currency(bill.total);
  renderLoyaltyBox(bill);
  autoFillPayment(payableNow(bill));
  updateDue(bill);
  $('#createBill').disabled = !db.cart.length;
}
/* ---------- Payment at the counter: one line, or several when the bill is split ---------- */
// Only cash may be more than the bill; the extra is change to hand back. Card, UPI and bank amounts stay within the bill.
let paymentLines = [{ mode: 'Cash', amount: '', touched: false, typed: false }];
let lastChange = null;   // { id, change, tendered } for the bill just made, shown on its invoice
const payAmount = line => round2(Number(line.amount) || 0);
const SPLIT_LIMIT = 4;
function renderPaymentLines() {
  const many = paymentLines.length > 1;
  $('#paymentLines').innerHTML = `<div class="pay-head"><span>Payment mode</span><span>Amount received</span></div>` + paymentLines.map((line, index) => `<div class="pay-line ${many ? 'has-remove' : ''}" data-pay="${index}"><div class="customer-input"><select class="pay-mode" aria-label="Payment mode">${PAYMENT_MODES.map(mode => `<option ${mode === line.mode ? 'selected' : ''}>${mode}</option>`).join('')}</select></div><div class="customer-input"><span class="phone-prefix">₹</span><input class="pay-amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0" value="${line.amount}" aria-label="Amount received" /></div>${many ? `<button class="remove-line" type="button" data-remove-pay="${index}" aria-label="Remove this payment">×</button>` : ''}</div>`).join('');
  $('#addSplit').classList.toggle('hidden', paymentLines.length >= SPLIT_LIMIT);
  $('#addSplit').textContent = many ? '＋ Add another payment' : '＋ Split payment';
}
// The last line that has not been typed into follows what is still left to pay.
function autoFillPayment(total) {
  const last = paymentLines[paymentLines.length - 1];
  if (last.touched) return;
  const others = paymentLines.slice(0, -1).reduce((sum, line) => sum + payAmount(line), 0), left = db.cart.length ? Math.max(0, round2(total - others)) : 0;
  last.amount = left > 0 ? String(left) : '';
  const input = $$('#paymentLines .pay-amount').pop();
  if (input && document.activeElement !== input) input.value = last.amount;
}
// Why the payment cannot be accepted, or '' when it can.
function paymentProblem(total) {
  const nonCash = round2(paymentLines.filter(line => line.mode !== 'Cash').reduce((sum, line) => sum + payAmount(line), 0));
  return nonCash > total + 1e-9 ? `Card, UPI and bank amounts cannot be more than the bill (${currency(total)}). Only cash can be more.` : '';
}
function updateDue(bill = currentBill()) {
  const payable = payableNow(bill);   // the bill less any loyalty points used
  const received = round2(paymentLines.reduce((sum, line) => sum + payAmount(line), 0)), problem = db.cart.length ? paymentProblem(payable) : '';
  const due = Math.max(0, round2(payable - received)), change = problem ? 0 : Math.max(0, round2(received - payable));
  $('#dueRow').classList.toggle('hidden', !db.cart.length || due <= 0);
  $('#dueAmount').textContent = currency(due);
  $('#changeRow').classList.toggle('hidden', !db.cart.length || change <= 0);
  $('#changeAmount').textContent = currency(change);
  $('#amountReceivedError').textContent = problem;
  $$('#paymentLines .pay-amount').forEach((input, index) => input.closest('.customer-input').classList.toggle('invalid', Boolean(problem) && paymentLines[index].mode !== 'Cash'));
}
$('#paymentLines').addEventListener('input', event => {
  const input = event.target.closest('.pay-amount');
  if (!input) return;
  const clean = input.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
  if (clean !== input.value) input.value = clean;
  const index = Number(input.closest('.pay-line').dataset.pay);
  paymentLines[index].amount = clean; paymentLines[index].touched = true; paymentLines[index].typed = true;
  if (index < paymentLines.length - 1) autoFillPayment(payableNow());
  updateDue();
});
$('#paymentLines').addEventListener('change', event => {
  const select = event.target.closest('.pay-mode');
  if (!select) return;
  paymentLines[Number(select.closest('.pay-line').dataset.pay)].mode = select.value;
  updateDue();
});
$('#paymentLines').addEventListener('focusin', event => { if (event.target.classList.contains('pay-amount')) event.target.select(); });
$('#paymentLines').addEventListener('click', event => {
  const remove = event.target.closest('[data-remove-pay]');
  if (!remove) return;
  paymentLines.splice(Number(remove.dataset.removePay), 1);
  const last = paymentLines[paymentLines.length - 1];
  last.touched = last.typed;   // the new last line follows what is left to pay, unless someone typed into it
  renderPaymentLines(); autoFillPayment(payableNow()); updateDue();
});
$('#addSplit').addEventListener('click', () => {
  if (paymentLines.length >= SPLIT_LIMIT) return;
  paymentLines.forEach(line => { line.touched = true; });   // what is typed so far stays; the new line takes the rest
  const unused = PAYMENT_MODES.find(mode => mode !== 'Cash' && !paymentLines.some(line => line.mode === mode)) || 'UPI';
  paymentLines.push({ mode: unused, amount: '', touched: false, typed: false });
  renderPaymentLines(); autoFillPayment(payableNow()); updateDue();
  const first = $('#paymentLines .pay-amount'); first.focus(); first.select();
});
function resetPayments() { paymentLines = [{ mode: 'Cash', amount: '', touched: false, typed: false }]; renderPaymentLines(); }
renderPaymentLines();
function addToCart(id) {
  const product = products.find(item => item.id === id);
  if (product.signature) {
    const tracked = product.stockMaterialId ? findMaterial(product.stockMaterialId) : null;
    if (tracked && availableMl(tracked) < 1) { showToast(`${product.name} is out of stock`); return; }
    const existing = db.cart.find(item => item.id === id);
    if (existing) existing.quantity += 1; else db.cart.push({ ...product, price: priceFor(product, billingType()), productId: product.id, quantity: 1 });
    renderCart(); showToast(`${product.name} added to bill`); return;
  }
  openRecipe(product);
}

/* ---------- Recipe modal ---------- */
const recipeMaterials = () => rawMaterials.filter(material => material.unit === 'ml' && material.id !== recipeProduct?.fillMaterialId);
const recipeFillId = () => recipeProduct?.fillMaterialId || null;
// Bottles and packaging can be chosen per bottle. The product's automatic packaging is left out so it is never counted twice.
function renderRecipeExtras() {
  const pack = recipeProduct?.packMaterialId ? findMaterial(recipeProduct.packMaterialId) : null;
  const choices = rawMaterials.filter(material => material.unit === 'pcs' && material.type !== 'Packed product' && material.id !== recipeProduct?.packMaterialId);
  $('#recipeExtrasWrap').classList.toggle('hidden', !pack && !choices.length);
  const automatic = pack ? `<label class="recipe-row default-pack-row"><span><input type="checkbox" id="recipeIncludePack" checked /><strong>${escapeHtml(pack.name)}</strong><small>Default bottle · ${fmtQty(availableMl(pack), 'pcs')} available · untick if not required</small></span><span class="pack-count">× ${recipeProduct.packQty || 1}</span></label>` : '';
  $('#recipeExtras').innerHTML = automatic + choices.map(material => `<label class="recipe-row"><span><input type="checkbox" data-extra="${material.id}" /><strong>${escapeHtml(material.name)}</strong><small>${material.type} · ${fmtQty(availableMl(material), 'pcs')} available</small></span><input class="ml-input" type="number" min="1" max="99" step="1" value="1" data-extra-qty="${material.id}" aria-label="${escapeHtml(material.name)} pieces" /></label>`).join('');
}
const extraChoices = () => $$('[data-extra]:checked').map(input => ({ id: input.dataset.extra, name: findMaterial(input.dataset.extra).name, qty: Math.round(Number($(`[data-extra-qty="${input.dataset.extra}"]`).value)) || 0 }));
function openRecipe(product) {
  recipeProduct = product;
  recipeMaterialQuery = '';
  const pack = product.packMaterialId ? findMaterial(product.packMaterialId) : null;
  $('#recipeTitle').textContent = `Record ${product.name}`;
  $('#recipeHelp').textContent = `Record every attar and raw material used. The total must be exactly ${product.recipeMl}ml.${pack ? ` ${(product.packQty || 1)} × ${pack.name} is selected by default; untick it below when the bottle is not required.` : ''}`;
  $('#recipeSearch').value = '';
  // Selections are preserved while searching inside one recipe, but a new recipe must start clean.
  $('#recipeOptions').innerHTML = '';
  renderRecipeFiller();
  renderRecipeExtras();
  renderRecipeOptions();
  $('#recipeModal').classList.remove('hidden');
  updateRecipeSummary();
}
function renderRecipeOptions() {
  const query = recipeMaterialQuery.trim().toLowerCase();
  const pool = recipeMaterials();
  const selectedIds = new Set($$('[data-material]:checked').map(input => input.dataset.material));
  const quantities = new Map($$('[data-ml]').map(input => [input.dataset.ml, input.value]));
  const matching = pool.filter(material => `${material.name} ${material.type}`.toLowerCase().includes(query));
  const choices = matching.filter(material => !selectedIds.has(material.id)).sort((a, b) => a.name.localeCompare(b.name));
  $('#recipeMaterialSelect').innerHTML = '<option value="">Select a material to add</option>' + choices.map(material => `<option value="${escapeHtml(material.id)}">${escapeHtml(material.name)} · ${availableMl(material).toFixed(2)}ml available</option>`).join('');
  $('#recipeMaterialSelect').disabled = !choices.length;
  $('#recipeFilterStatus').textContent = choices.length ? `${choices.length} material${choices.length === 1 ? '' : 's'} available · choose one, then enter its quantity below` : 'No more matching materials. Clear the search to see other choices.';
  const selected = pool.filter(material => selectedIds.has(material.id));
  $('#recipeOptions').innerHTML = selected.length ? selected.map(material => `<div class="recipe-row"><span><input type="checkbox" data-material="${escapeHtml(material.id)}" checked hidden /><strong>${escapeHtml(material.name)}</strong><small>${escapeHtml(material.type)} · ${availableMl(material).toFixed(2)}ml available</small></span><input class="ml-input" type="number" min="0" step="0.01" value="${escapeHtml(quantities.get(material.id) ?? '0.00')}" data-ml="${escapeHtml(material.id)}" aria-label="${escapeHtml(material.name)} quantity in ml" /><button type="button" class="link-button" data-remove-recipe="${escapeHtml(material.id)}" aria-label="Remove ${escapeHtml(material.name)}">Remove</button></div>`).join('') : '<div class="recipe-empty">Choose a material from the dropdown to start.</div>';
}
// The top-up material sits above the list: it is not chosen, its amount is whatever the bottle still needs.
function renderRecipeFiller() {
  const material = recipeFillId() ? findMaterial(recipeFillId()) : null;
  $('#recipeFiller').innerHTML = material ? `<div class="recipe-row filler-row"><span><input type="checkbox" data-material="${material.id}" checked disabled /><strong>${escapeHtml(material.name)}</strong><small>Fills the rest of the ${recipeProduct.recipeMl}ml automatically · ${availableMl(material).toFixed(2)}ml available</small></span><input class="ml-input" type="text" value="0.00" data-ml="${material.id}" readonly tabindex="-1" aria-label="${escapeHtml(material.name)} top-up in ml" /></div>` : '';
}
function syncRecipeFiller() {
  const id = recipeFillId(), box = id && $(`#recipeFiller [data-ml="${id}"]`);
  if (!box) return;
  const others = recipeLines().filter(line => line.id !== id).reduce((sum, line) => sum + line.ml, 0);
  box.value = Math.max(0, round2(recipeProduct.recipeMl - others)).toFixed(2);
}
const recipeLines = () => $$('[data-material]:checked').map(input => ({ id: input.dataset.material, name: findMaterial(input.dataset.material).name, ml: Number($(`[data-ml="${input.dataset.material}"]`).value) || 0 }));
function updateRecipeSummary() {
  syncRecipeFiller();
  const fill = recipeFillId(), used = recipeLines().filter(line => !(line.id === fill && line.ml === 0)), chosen = used.filter(line => line.id !== fill);
  const total = round2(used.reduce((sum, line) => sum + line.ml, 0));
  const target = recipeProduct?.recipeMl || 0;
  $('#recipeSummary').textContent = `${used.length} material${used.length === 1 ? '' : 's'} recorded · ${total.toFixed(2)}ml of ${target.toFixed(2)}ml${total > target + 0.001 ? ' · over the bottle size' : ''}`;
  $('#saveRecipe').disabled = !chosen.length || chosen.some(line => line.ml <= 0) || Math.abs(total - target) >= 0.001;
}
function saveRecipe() {
  if ($('#saveRecipe').disabled) return;
  const recipe = recipeLines().filter(line => line.ml > 0).map(line => ({ ...line, ml: round2(line.ml) }));
  const short = recipe.find(line => line.ml > availableMl(findMaterial(line.id)));
  if (short) { showToast(`Not enough ${short.name} in stock`); return; }
  const includePack = !recipeProduct.packMaterialId || $('#recipeIncludePack')?.checked !== false;
  const pack = includePack && recipeProduct.packMaterialId ? findMaterial(recipeProduct.packMaterialId) : null;
  if (pack && availableMl(pack) < (recipeProduct.packQty || 1)) { showToast(`Not enough ${pack.name} in stock`); return; }
  const extras = extraChoices();
  const badExtra = extras.find(extra => !(extra.qty >= 1 && extra.qty <= 99));
  if (badExtra) { showToast(`Enter a whole number of pieces for ${badExtra.name}`); return; }
  const shortExtra = extras.find(extra => extra.qty > availableMl(findMaterial(extra.id)));
  if (shortExtra) { showToast(`Not enough ${shortExtra.name} in stock`); return; }
  const attars = recipe.filter(line => line.id !== 'alcohol' && line.id !== recipeFillId());
  const dominant = [...attars].sort((a, b) => b.ml - a.ml)[0];
  const name = dominant ? (attars.length > 1 ? `${dominant.name}+Blend` : dominant.name) : recipeProduct.name;
  db.cart.push({ ...recipeProduct, price: priceFor(recipeProduct, billingType()), id: `${recipeProduct.id}-${Date.now()}`, productId: recipeProduct.id, name, type: recipeProduct.name, quantity: 1, recipe, extras, includePack });
  $('#recipeModal').classList.add('hidden');
  renderCart(); showToast(`${name} added to bill`);
}

/* ---------- Summary, alerts, lists ---------- */
function renderSummary() {
  const today = todayKey();
  // Returns reduce the day they are credited, not the day of the original sale.
  const dayTotal = day => round2(sales.filter(sale => sale.day === day).reduce((sum, sale) => sum + sale.total, 0) - creditNotes.filter(note => note.day === day).reduce((sum, note) => sum + note.total, 0));
  const todayTotal = dayTotal(today), yesterdayTotal = dayTotal(addDays(today, -1));
  $('#todaySales').textContent = currency(todayTotal);
  const trend = $('#todayTrend');
  trend.classList.toggle('hidden', yesterdayTotal <= 0);
  if (yesterdayTotal > 0) {
    const change = (todayTotal - yesterdayTotal) / yesterdayTotal * 100;
    trend.textContent = `${change >= 0 ? '↑' : '↓'} ${Math.abs(change).toFixed(1)}%`;
    trend.classList.toggle('down', change < 0);
  }
  const monthBills = sales.filter(sale => sale.day.startsWith(today.slice(0, 7))).length;
  const todayBills = sales.filter(sale => sale.day === today).length;
  $('#billCount').textContent = monthBills; $('#navSalesCount').textContent = monthBills;
  $('#billSub').textContent = todayBills ? `${todayBills} today` : 'none today';
  const tally = new Map();
  sales.filter(sale => sale.day >= addDays(today, -6)).forEach(sale => sale.lines.forEach(line => tally.set(line.product, (tally.get(line.product) || 0) + line.qty)));
  creditNotes.filter(note => note.day >= addDays(today, -6)).forEach(note => note.lines.forEach(line => tally.set(line.product, (tally.get(line.product) || 0) - line.qty)));
  const top = [...tally.entries()].filter(([, qty]) => qty > 0).sort((a, b) => b[1] - a[1])[0];
  $('#topSeller').textContent = top ? top[0] : '—';
  $('#topSellerMeta').textContent = top ? `${top[1]} sold in 7 days` : 'no sales in 7 days';
  const owing = sales.filter(sale => dueOf(sale) > 0);
  $('#duesTotal').textContent = currency(owing.reduce((sum, sale) => sum + dueOf(sale), 0));
  const debtors = new Set(owing.map(sale => sale.customerPhone)).size;
  $('#duesMeta').textContent = debtors ? `${debtors} customer${debtors === 1 ? '' : 's'}` : 'all clear';
  $('#lowStockDot').classList.toggle('hidden', !lowStockItems().length);
}
const lowStockItems = () => rawMaterials.filter(material => stockStatus(material) !== 'OK');
function renderInvoiceNumber() {
  $('#invoiceNumber').textContent = `#${billingType() === 'franchise' ? state.outlet.nextInvoiceFranchise : state.outlet.nextInvoice}`;
  $('#purchaseNumber').textContent = state.outlet.nextPurchase;
}
function itemCountLabel(sale) {
  const count = sale.lines.reduce((sum, line) => sum + line.qty, 0);
  return `${count} item${count === 1 ? '' : 's'}`;
}
const canReturn = sale => !isBiller() && sale.lines.some(line => line.qty - (line.returned || 0) > 0);
function renderSales() {
  $('#salesRows').innerHTML = sales.length ? sales.map(sale => {
    const due = dueOf(sale), status = statusOf(sale);
    return `<div class="sale-row"><span><strong>#${sale.number}</strong><small>${formatStamp(sale.date)}</small>${sale.priceType && sale.priceType !== 'retail' ? `<small class="party-tag party-${sale.priceType}">${PRICE_LABELS[sale.priceType]}</small>` : ''}</span><span data-label="Customer">${escapeHtml(sale.customerName)}<small>${formatPhone(sale.customerPhone)}</small>${sale.salesmanName ? `<small class="salesman-tag">Salesman: ${escapeHtml(sale.salesmanName)}</small>` : ''}</span><span data-label="Items">${itemCountLabel(sale)}</span><span data-label="Amount">${currency(sale.total)}${sale.credited ? `<small>Credit −${currency(sale.credited)}</small>` : ''}${due > 0 ? `<small class="due-text">Due ${currency(due)}</small>` : ''}</span><span data-label="Status"><span class="status-badge status-${status.toLowerCase()}">${status}</span></span><span class="row-actions"><button class="link-button" data-view-invoice="${sale.id}">View</button>${due > 0 ? `<button class="link-button accent" data-pay-sale="${sale.id}">Receive</button>` : ''}${canReturn(sale) ? `<button class="link-button" data-return-sale="${sale.id}">Return</button>` : ''}</span></div>`;
  }).join('') : '<div class="purchase-empty">No bills yet. Create your first bill from New bill.</div>';
  renderCreditNotes();
}
function renderCreditNotes() {
  $('#creditRows').innerHTML = creditNotes.length ? creditNotes.map(note => `<div class="cn-row"><span><strong>${note.number}</strong><small>${formatStamp(note.date)}</small></span><span data-label="Against bill">#${note.saleNumber}<small>${escapeHtml(note.reason)}</small></span><span data-label="Customer">${escapeHtml(note.customerName)}<small>${formatPhone(note.customerPhone)}</small></span><span class="num" data-label="Credited">${currency(note.total)}</span><span class="num" data-label="Refunded">${note.refund > 0 ? `${currency(note.refund)}<small>${note.refundMode}</small>` : '—'}</span><span class="row-actions"><button class="link-button" data-view-credit="${note.id}">View</button></span></div>`).join('') : '<div class="purchase-empty">No credit notes yet. Use Return on a bill to issue one.</div>';
}
// The Products screen search: words match the name, code, barcode and type; the buttons narrow it to one group.
let inventoryFilter = 'all';
const inventoryWords = () => ($('#inventorySearch').value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
const inventoryMatches = (words, parts) => { const text = parts.filter(Boolean).join(' ').toLowerCase(); return words.every(word => text.includes(word)); };
const trackedStock = product => product.stockMaterialId ? findMaterial(product.stockMaterialId) : null;
function visibleMaterials() {
  const words = inventoryWords();
  if (inventoryFilter === 'catalog') return [];
  return rawMaterials.filter(material => (inventoryFilter !== 'low' || stockStatus(material) !== 'OK') && inventoryMatches(words, [material.name, material.code, material.ean, material.type, material.unit]));
}
function visibleProducts() {
  const words = inventoryWords();
  if (inventoryFilter === 'stock') return [];
  return products.filter(product => (inventoryFilter !== 'low' || (trackedStock(product) && stockStatus(trackedStock(product)) !== 'OK')) && inventoryMatches(words, [product.name, product.code, product.type, product.needsRecipe ? 'custom blend production recipe' : 'packed']));
}
function renderInventory() {
  $('#productsSubtitle').textContent = isAdmin() ? 'HQ controls the item master, prices and GST. Stock and cost shown here belong to the selected outlet.' : 'The item master, prices and GST are set by HQ. You can set your own low-stock alert levels.';
  const shownMaterials = visibleMaterials(), shownProducts = visibleProducts(), searching = inventoryWords().length > 0 || inventoryFilter !== 'all';
  $('#stockHead').classList.toggle('hidden', inventoryFilter === 'catalog'); $('#catalogHead').classList.toggle('hidden', inventoryFilter === 'stock');
  $('#inventoryGrid').classList.toggle('hidden', inventoryFilter === 'catalog'); $('#catalogGrid').classList.toggle('hidden', inventoryFilter === 'stock');
  $('#stockHead').textContent = `Stock items${searching ? ` (${shownMaterials.length} of ${rawMaterials.length})` : ''}`; $('#catalogHead').textContent = `Billing catalog${searching ? ` (${shownProducts.length} of ${products.length})` : ''}`;
  $('#inventoryCount').textContent = searching ? `${shownMaterials.length + shownProducts.length} match${shownMaterials.length + shownProducts.length === 1 ? '' : 'es'}` : '';
  $('#inventoryGrid').innerHTML = shownMaterials.map(material => {
    const status = stockStatus(material);
    return `<article class="inventory-card">${productVisual(material)}<div class="card-body"><div class="product-name">${escapeHtml(material.name)}</div><div class="product-type">${material.type} · counted in ${material.unit}</div><div class="item-ids"><span class="code-chip">${escapeHtml(material.code || "")}</span>${material.ean ? `<span class="ean-text">${escapeHtml(material.ean)}</span>` : ""}</div><div class="inventory-stock stock-${status.toLowerCase()}">${fmtQty(material.stock, material.unit)} ${status === 'OK' ? 'available' : status === 'Low' ? '· low stock' : '· out of stock'}</div><div class="card-meta">${isBiller() ? '' : `Cost ${currency(material.costPerMl)}/${material.unit} · `}alert at ${material.alertMl} ${material.unit}</div>${isBiller() ? '' : `<button class="link-button" data-edit-material="${material.id}">${isAdmin() ? 'Edit' : 'Set alert level'}</button>`}</div></article>`;
  }).join('') || (inventoryFilter === 'catalog' ? '' : `<div class="purchase-empty">${searching ? 'No stock item matches.' : 'No stock items yet.'}</div>`);
  $('#catalogGrid').innerHTML = shownProducts.map(product => {
    const stockItem = product.stockMaterialId ? findMaterial(product.stockMaterialId) : null, pack = product.packMaterialId ? findMaterial(product.packMaterialId) : null;
    const how = product.needsRecipe ? `Production screen · ${product.recipeMl}ml${pack ? ` · uses ${product.packQty || 1} × ${escapeHtml(pack.name)}` : ''}` : stockItem ? `Packed · ${fmtQty(stockItem.stock, 'pcs')} in stock` : 'Packed · stock not counted';
    const cost = product.needsRecipe ? 'Cost comes from the recipe' : stockItem ? 'Cost comes from the stock average' : `Cost ${currency(product.cost || 0)} per piece`;
    return `<article class="inventory-card">${productVisual(product)}<div class="card-body"><div class="product-name">${escapeHtml(product.name)}</div><div class="product-type">${product.type}</div>${product.code ? `<div class="item-ids"><span class="code-chip">${escapeHtml(product.code)}</span></div>` : ''}<div class="inventory-stock">${currency(product.price)} · GST ${product.gstRate}%</div>${isBiller() ? '' : `<div class="card-meta">Wholesale ${currency(product.wholesalePrice)} · Franchise ${currency(product.franchisePrice)}</div>`}<div class="card-meta">${how}</div>${isAdmin() ? `<div class="card-meta">${cost}</div><button class="link-button" data-edit-product="${product.id}">Edit</button>` : ''}</div></article>`;
  }).join('') || (inventoryFilter === 'stock' ? '' : `<div class="purchase-empty">${searching ? 'No billing product matches.' : 'No products yet.'}</div>`);
}
function customerStats(phone) {
  const own = sales.filter(sale => sale.customerPhone === phone);
  return { spent: round2(own.reduce((sum, sale) => sum + netTotal(sale), 0)), visits: own.length, due: round2(own.reduce((sum, sale) => sum + dueOf(sale), 0)) };
}
function renderPurchases() {
  $('#purchaseCount').textContent = `${purchases.length} ${purchases.length === 1 ? 'entry' : 'entries'}`;
  $('#purchaseRows').innerHTML = purchases.length ? purchases.map(purchase => {
    const due = dueOf(purchase), status = statusOf(purchase);
    return `<div class="purchase-row"><span><strong>${purchase.number}</strong><small>${formatKey(purchase.date)}</small>${purchase.sourceSaleId ? `<small class="party-tag party-franchise">Invoice ${escapeHtml(purchase.invoiceNo)}</small>` : ''}</span><span data-label="Supplier">${escapeHtml(purchase.supplier)}</span><span data-label="Materials">${purchase.lines.length} material${purchase.lines.length === 1 ? '' : 's'}</span><span data-label="Total">${currency(purchase.total)}${due > 0 ? `<small class="due-text">Due ${currency(due)}</small>` : ''}</span><span class="row-actions" data-label="Status"><span class="status-badge status-${status.toLowerCase()}">${status}</span>${due > 0 ? `<button class="link-button accent" data-pay-purchase="${purchase.id}">Pay</button>` : ''}</span></div>`;
  }).join('') : '<div class="purchase-empty">No purchases recorded yet</div>';
}
function refreshViews() {
  renderSalesmanPicker(); renderSummary(); renderSales(); renderInventory(); renderCustomers(); renderPurchases(); if (!$('#pricesView').classList.contains('hidden')) renderPrices(); if (!$('#vouchersView').classList.contains('hidden')) renderVouchers(); if (!$('#loyaltyView').classList.contains('hidden')) renderLoyaltyView(); if (!$('#purchasesView').classList.contains('hidden')) loadHqInvoices(); renderExpenses(); renderInvoiceNumber(); renderFranchiseViews();
  if (!$('#reportsView').classList.contains('hidden')) renderReports();
}
// Re-renders everything after the server state was reloaded.
function refreshEverything() {
  syncCartWithCatalog(); renderProducts(); renderCart(); purchaseGrid.refreshAll(); refreshViews(); renderChrome();
  renderPendingBill();
}
async function reloadAll() {
  await loadState();
  networkCache = null;
  refreshEverything();
}

/* ---------- Purchases ---------- */
// Rate and amount are two ways to say the same thing: whichever was typed last is kept, the other follows the quantity.
let activeInvoice = null;   // a franchise invoice loaded into the purchase form (see vouchers.js)
const purchaseGrid = createLineGrid($('#purchaseGrid'), {
  pool: () => rawMaterials,
  columns: [
    { type: 'index', label: '#', width: '40px' },
    { type: 'code', label: 'Item code', width: '170px' },
    { type: 'out', key: 'name', label: 'Description', width: 'minmax(140px, 1fr)', out: row => `<strong>${escapeHtml(row.item.name)}</strong><small>${row.item.type}${row.item.ean ? ` · ${escapeHtml(row.item.ean)}` : ''}</small>` },
    { type: 'out', key: 'unit', label: 'Unit', width: '44px', out: row => row.item.unit },
    { type: 'out', key: 'stock', label: 'In stock', width: '92px', align: 'right', out: row => fmtQty(row.item.stock, row.item.unit) },
    { type: 'input', key: 'qty', label: 'Quantity', width: '104px', align: 'right', placeholder: '0' },
    { type: 'input', key: 'rate', label: 'Rate', width: '104px', align: 'right', placeholder: '0.00' },
    { type: 'input', key: 'amount', label: 'Amount', width: '116px', align: 'right', placeholder: '0.00' },
    { type: 'actions', width: '34px' }
  ],
  defaults: () => ({ qty: '', rate: '', amount: '' }),
  compute(row) {
    const v = row.values, qty = Number(v.qty) || 0;
    if (row.edited === 'amount') row.basis = 'amount'; else if (row.edited === 'rate') row.basis = 'rate';
    if (row.basis === 'amount') v.rate = qty > 0 && v.amount !== '' ? String(Math.round(Number(v.amount) / qty * 10000) / 10000) : '';
    else v.amount = qty > 0 && Number(v.rate) > 0 ? String(round2(qty * Number(v.rate))) : '';
  },
  onChange(grid) { $('#purchaseTotal').textContent = currency(grid.itemRows().reduce((sum, row) => sum + (Number(row.values.amount) || 0), 0)); },
  fkeys: {
    F3: grid => grid.deleteActive(),
    F5: () => $('#purchaseSupplier').focus(),
    F6: () => $('#purchaseForm').requestSubmit(),
    F12: grid => { if (!grid.dirty || confirm('Clear all rows on this purchase?')) grid.clear(); }
  }
});

const VIEWS = { closing: 'closingView', loyalty: 'loyaltyView', vouchers: 'vouchersView', prices: 'pricesView', billing: 'billingView', sales: 'salesView', products: 'productsView', purchases: 'purchasesView', expenses: 'expensesView', customers: 'customersView', reports: 'reportsView', verification: 'verificationView', manufacturing: 'manufacturingView', opening: 'openingView', transfers: 'transfersView', network: 'networkView' };
const VIEW_TITLES = { closing: 'Day closing', loyalty: 'Loyalty points', vouchers: 'Receipts & payments', prices: 'Price update', billing: 'Create a new bill', network: 'Outlets & users', opening: 'Opening stock', verification: 'Stock verification' };
function switchView(view) {
  if ((view === 'network' || view === 'manufacturing' || view === 'prices') && !isAdmin()) view = 'billing';
  if (isBiller() && !BILLER_VIEWS.includes(view)) view = 'billing';
  Object.values(VIEWS).forEach(id => $(`#${id}`).classList.add('hidden'));
  $(`#${VIEWS[view]}`).classList.remove('hidden');
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  $('#page-title').textContent = VIEW_TITLES[view] || view[0].toUpperCase() + view.slice(1);
  $('.summary-strip').classList.toggle('hidden', view !== 'billing');
  if (view === 'reports') renderReports();
  if (view === 'prices') renderPrices();
  if (view === 'vouchers') renderVouchers();
  if (view === 'loyalty') renderLoyaltyView();
  if (view === 'closing') openDayClosing();
  if (view === 'purchases') loadHqInvoices();
  if (view === 'opening') renderOpening();
  if (view === 'manufacturing') loadManufacturing();
  if (view === 'verification') renderVerification();
}

/* ---------- Delegated clicks ---------- */
document.addEventListener('click', event => {
  const hit = selector => event.target.closest(selector);
  const add = hit('[data-add]');
  if (add) addToCart(add.dataset.add);
  const qty = hit('[data-qty]');
  if (qty) {
    const item = db.cart.find(entry => String(entry.id) === qty.dataset.qty);
    if (Number(qty.dataset.change) > 0 && item.stockMaterialId && availableMl(findMaterial(item.stockMaterialId)) < 1) { showToast(`No more ${item.name} in stock`); return; }
    item.quantity += Number(qty.dataset.change);
    if (item.quantity <= 0) db.cart = db.cart.filter(entry => entry.id !== item.id);
    renderCart();
  }
  const remove = hit('[data-remove]');
  if (remove) { db.cart = db.cart.filter(entry => String(entry.id) !== remove.dataset.remove); renderCart(); }
  const category = hit('[data-category]');
  if (category) { activeCategory = category.dataset.category; $$('.category-tab').forEach(tab => tab.classList.toggle('active', tab === category)); renderProducts(); }
  const nav = hit('.nav-item');
  if (nav) switchView(nav.dataset.view);
  const invoice = hit('[data-view-invoice]');
  if (invoice) showInvoice(invoice.dataset.viewInvoice);
  const credit = hit('[data-view-credit]');
  if (credit) showCreditNote(credit.dataset.viewCredit);
  const returning = hit('[data-return-sale]');
  if (returning) openReturn(returning.dataset.returnSale);
  const paySale = hit('[data-pay-sale]');
  if (paySale) openPayment({ kind: 'sale', id: paySale.dataset.paySale });
  const payCustomer = hit('[data-pay-customer]');
  if (payCustomer) openPayment({ kind: 'customer', id: payCustomer.dataset.payCustomer });
  const payPurchase = hit('[data-pay-purchase]');
  if (payPurchase) openPayment({ kind: 'purchase', id: payPurchase.dataset.payPurchase });
  const editMaterial = hit('[data-edit-material]');
  if (editMaterial) openProductModal({ kind: 'material', id: editMaterial.dataset.editMaterial });
  const editProduct = hit('[data-edit-product]');
  if (editProduct) openProductModal({ kind: 'product', id: editProduct.dataset.editProduct });
});
$('#productSearch').addEventListener('input', renderProducts);
$('#closeRecipe').addEventListener('click', () => closeModal('#recipeModal'));
$('#recipeSearch').addEventListener('input', event => { recipeMaterialQuery = event.target.value; renderRecipeOptions(); updateRecipeSummary(); });
$('#recipeMaterialSelect').addEventListener('change', event => {
  const id = event.target.value;
  if (!recipeMaterials().some(material => material.id === id)) return;
  const input = document.createElement('input');
  input.type = 'checkbox'; input.dataset.material = id; input.checked = true; input.hidden = true;
  $('#recipeOptions').appendChild(input);
  recipeMaterialQuery = ''; $('#recipeSearch').value = '';
  renderRecipeOptions(); updateRecipeSummary();
  const quantity = $$('[data-ml]').find(input => input.dataset.ml === id);
  quantity?.focus(); quantity?.select();
});
$('#recipeOptions').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-recipe]');
  if (!button) return;
  button.closest('.recipe-row').remove(); renderRecipeOptions(); updateRecipeSummary();
});
$('#recipeOptions').addEventListener('change', updateRecipeSummary);
$('#recipeOptions').addEventListener('input', updateRecipeSummary);
$('#saveRecipe').addEventListener('click', saveRecipe);
document.addEventListener('keydown', event => { if (event.key === 'Escape') $$('.modal-backdrop:not(.hidden)').forEach(modal => modal.classList.add('hidden')); });
$('.icon-button').addEventListener('click', () => { const low = lowStockItems(); showToast(low.length ? `Low stock: ${low.map(material => material.name).join(', ')}` : 'No alerts. All stock levels are healthy'); });

/* ---------- Purchase form ---------- */
$('#purchaseForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#savePurchase'), async () => {
    if (activeInvoice) { await savePurchaseFromInvoice(); return; }
    const supplier = $('#purchaseSupplier').value.trim();
    const rows = purchaseGrid.itemRows();
    if (!supplier) { showToast('Add the supplier name'); $('#purchaseSupplier').focus(); return; }
    if (!rows.length) { showToast('Add at least one item'); purchaseGrid.focusNew(); return; }
    const missing = rows.find(row => !(Number(row.values.qty) > 0));
    if (missing) { showToast(`Enter a quantity for ${missing.item.name}, or delete the row with F3`); purchaseGrid.flash(missing); return; }
    const fraction = rows.find(row => row.item.unit === 'pcs' && !Number.isInteger(Number(row.values.qty)));
    if (fraction) { showToast(`${fraction.item.name} is counted in pieces. Enter a whole number`); purchaseGrid.flash(fraction); return; }
    await api('POST', '/api/purchases', { supplier, invoiceNo: $('#purchaseInvoice').value, date: $('#purchaseDate').value, mode: $('#purchaseMode').value, paid: $('#purchasePaid').value, lines: rows.map(row => ({ materialId: row.item.id, qty: Number(row.values.qty), total: round2(Number(row.values.amount) || 0) })) });
    $('#purchaseForm').reset(); purchaseGrid.clear(); $('#purchaseDate').value = todayKey();
    await reloadAll();
    showToast(`Purchase saved · ${rows.length} item${rows.length === 1 ? '' : 's'} added to stock`);
  });
});

/* ---------- Expenses ---------- */
function renderExpenses() {
  const month = todayKey().slice(0, 7);
  $('#expenseMonthTotal').textContent = `${currency(sumExpenses(expenses.filter(expense => expense.date.startsWith(month))))} this month`;
  $('#expenseCount').textContent = `${expenses.length} ${expenses.length === 1 ? 'entry' : 'entries'}`;
  $('#expenseRows').innerHTML = expenses.length ? expenses.map(expense => `<div class="expense-row"><span>${formatKey(expense.date)}</span><span data-label="Category"><strong>${expense.category}</strong></span><span data-label="Details">${expense.description ? escapeHtml(expense.description) : '—'}</span><span data-label="Paid by">${expense.mode}</span><span class="num" data-label="Amount">${currency(expense.amount)}</span><span class="row-actions"><button class="link-button" data-delete-expense="${expense.id}">Delete</button></span></div>`).join('') : '<div class="purchase-empty">No expenses recorded yet</div>';
}
const sumExpenses = list => round2(list.reduce((total, expense) => total + expense.amount, 0));
['expenseDescription', 'expenseAmount'].forEach(id => $(`#${id}`).addEventListener('input', () => setFieldError(id, '')));
$('#expenseForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#saveExpense'), async () => {
    const amount = round2(Number($('#expenseAmount').value)), category = $('#expenseCategory').value, description = $('#expenseDescription').value.trim();
    setFieldError('expenseAmount', amount > 0 ? '' : 'Enter an amount greater than 0');
    setFieldError('expenseDescription', category === 'Other' && !description ? 'Describe what this was for' : '');
    if ($('#expenseForm .customer-input.invalid')) { $('#expenseForm .customer-input.invalid input').focus(); return; }
    await api('POST', '/api/expenses', { date: $('#expenseDate').value, category, description, amount, mode: $('#expenseMode').value });
    $('#expenseAmount').value = ''; $('#expenseDescription').value = '';
    await reloadAll();
    showToast(`${currency(amount)} ${category.toLowerCase()} expense recorded`);
  });
});
$('#expenseRows').addEventListener('click', event => {
  const button = event.target.closest('[data-delete-expense]');
  if (!button) return;
  const expense = expenses.find(entry => String(entry.id) === button.dataset.deleteExpense);
  const reason = prompt('Why are you voiding this expense? The original entry will remain in the audit history.');
  if (!reason || reason.trim().length < 5) return;
  submitting(button, async () => {
    await api('DELETE', `/api/expenses/${expense.id}`, { reason });
    await reloadAll();
    showToast('Expense voided; history retained');
  });
});

/* ---------- Backup (HQ) ---------- */
$('#downloadBackup').addEventListener('click', () => {
  submitting($('#downloadBackup'), async () => {
    const response = await fetch('/api/backup');
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Backup failed');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await response.blob()); link.download = `velour-backup-${todayKey()}.db`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showToast('Backup downloaded. Keep it somewhere safe');
  });
});

/* ---------- Customers ---------- */
function checkCustomerFields(nameId, phoneId) {
  const name = $(`#${nameId}`).value.trim().replace(/\s+/g, ' ');
  const phone = $(`#${phoneId}`).value;
  const existing = isValidPhone(phone) ? customers.find(customer => customer.phone === phone) : null;
  const nameError = name ? '' : 'Customer name is required';
  let phoneError = '';
  if (!phone) phoneError = 'Mobile number is required';
  else if (!isValidPhone(phone)) phoneError = 'Enter a valid 10-digit mobile number';
  else if (existing && existing.name.toLowerCase() !== name.toLowerCase()) phoneError = `This number is saved for ${existing.name}`;
  setFieldError(nameId, nameError); setFieldError(phoneId, phoneError);
  return { ok: !nameError && !phoneError, name, phone, existing };
}
function selectCustomer(customer) {
  $('#customerName').value = customer.name;
  $('#customerPhone').value = customer.phone;
  setFieldError('customerName', ''); setFieldError('customerPhone', '');
  setCustomerMenuOpen(false);
  refreshBillingParty();
}
const customerMenu = document.createElement('div');
customerMenu.className = 'customer-menu hidden';
$('#customerNameWrap').appendChild(customerMenu);
function renderCustomerMenu(showAll = false) {
  const query = showAll ? '' : $('#customerName').value.trim().toLowerCase();
  const matches = customers.filter(customer => `${customer.name} ${customer.phone} ${customer.email}`.toLowerCase().includes(query));
  customerMenu.innerHTML = (matches.map(customer => `<button type="button" class="customer-option" data-customer="${customer.phone}">${escapeHtml(customer.name)}<small>${formatPhone(customer.phone)}${customer.type && customer.type !== 'retail' ? ` · ${PRICE_LABELS[customer.type]}` : ''}${customer.email ? ` · ${escapeHtml(customer.email)}` : ''}</small></button>`).join('') || '<div class="recipe-empty">No saved customer matches</div>')
    + '<button type="button" class="customer-option add-customer-option" data-add-customer>＋ Add new customer</button>';
}
function setCustomerMenuOpen(open) {
  customerMenu.classList.toggle('hidden', !open);
  $('#customerSelect').setAttribute('aria-expanded', String(open));
}
$('#customerSelect').addEventListener('click', () => { setCustomerMenuOpen(customerMenu.classList.contains('hidden')); if (!customerMenu.classList.contains('hidden')) renderCustomerMenu(true); });
$('#customerNameWrap .customer-input').addEventListener('click', event => {
  if (event.target.closest('#customerName') || event.target.closest('#customerSelect')) return;
  renderCustomerMenu(true); setCustomerMenuOpen(true);
});
$('#customerName').addEventListener('input', () => { renderCustomerMenu(); customerMenu.classList.remove('hidden'); setFieldError('customerName', ''); });
$('#customerPhone').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, ''); setFieldError('customerPhone', ''); refreshBillingParty(); });
customerMenu.addEventListener('click', event => {
  if (event.target.closest('[data-add-customer]')) { setCustomerMenuOpen(false); openCustomerModal(); return; }
  const option = event.target.closest('[data-customer]');
  if (option) selectCustomer(customers.find(customer => customer.phone === option.dataset.customer));
});
document.addEventListener('click', event => { if (!event.target.closest('.customer-field')) setCustomerMenuOpen(false); });

function openCustomerModal() {
  $('#newCustomerName').value = $('#customerName').value.trim();
  $('#newCustomerPhone').value = $('#customerPhone').value;
  $('#newCustomerEmail').value = '';
  ['newCustomerName', 'newCustomerPhone', 'newCustomerEmail'].forEach(id => setFieldError(id, ''));
  $('#customerModal').classList.remove('hidden');
  $('#newCustomerName').focus();
}
$('#closeCustomerModal').addEventListener('click', () => closeModal('#customerModal'));
$('#newCustomerName').addEventListener('input', () => setFieldError('newCustomerName', ''));
$('#newCustomerEmail').addEventListener('input', () => setFieldError('newCustomerEmail', ''));
$('#newCustomerPhone').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, ''); setFieldError('newCustomerPhone', ''); });
$('#customerForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#customerForm button[type="submit"]'), async () => {
    const result = checkCustomerFields('newCustomerName', 'newCustomerPhone');
    const email = $('#newCustomerEmail').value.trim();
    const emailInvalid = Boolean(email) && !/^\S+@\S+\.\S+$/.test(email);
    setFieldError('newCustomerEmail', emailInvalid ? 'Enter a valid email address' : '');
    if (!result.ok || emailInvalid) { $('#customerForm .customer-input.invalid input').focus(); return; }
    const customer = result.existing || await api('POST', '/api/customers', { name: result.name, phone: result.phone, email });
    if (!result.existing) { customers.unshift(customer); renderCustomers(); }
    selectCustomer(customer);
    closeModal('#customerModal');
    showToast(result.existing ? `${customer.name} is already saved · selected` : `${customer.name} added and selected`);
  });
});

/* ---------- Discount, payment and bill creation ---------- */
$('#discountButton').addEventListener('click', () => { $('#discountEditor').classList.toggle('hidden'); if (!$('#discountEditor').classList.contains('hidden')) $('#discountValue').focus(); });
const syncDiscount = () => { billDiscount = { type: $('#discountType').value, value: Number($('#discountValue').value) || 0 }; renderTotals(); };
$('#discountType').addEventListener('change', syncDiscount);
$('#discountValue').addEventListener('input', syncDiscount);
$('#discountClear').addEventListener('click', () => { $('#discountValue').value = ''; $('#discountEditor').classList.add('hidden'); syncDiscount(); });
function resetBillForm() {
  db.cart = [];
  billDiscount = { type: 'amount', value: 0 }; resetPayments(); resetRedeem();
  $('#discountType').value = 'amount'; $('#discountValue').value = ''; $('#discountEditor').classList.add('hidden');
  $('#customerName').value = ''; $('#customerPhone').value = '';
  $('#amountReceivedError').textContent = '';
  refreshBillingParty();
}
$('#createBill').addEventListener('click', () => {
  submitting($('#createBill'), async () => {
    if (pendingBill()) { await recoverPendingBill(); return; }
    const customerCheck = checkCustomerFields('customerName', 'customerPhone');
    const bill = currentBill();
    const redeem = redeemCheck(bill), problem = redeem.message || paymentProblem(payableNow(bill));
    updateDue(bill);
    if (!customerCheck.ok || problem) { showToast(problem || 'Fix the highlighted fields to create the bill'); const bad = $('.bill-panel .customer-input.invalid input'); if (bad) bad.focus(); return; }
    const sale = await submitSafeBill({
      customerName: customerCheck.name, customerPhone: customerCheck.phone,
      lines: db.cart.map(item => ({ productId: item.productId, qty: item.quantity, recipe: item.recipe ? item.recipe.map(line => ({ id: line.id, ml: line.ml })) : undefined, includePack: item.recipe ? item.includePack !== false : undefined, extras: item.extras && item.extras.length ? item.extras.map(extra => ({ id: extra.id, qty: extra.qty })) : undefined })),
      salesmanId: $('#billSalesman').value || undefined,
      redeemPoints: redeem.points > 0 ? redeem.points : undefined,
      discount: billDiscount, payments: paymentLines.map(line => ({ mode: line.mode, amount: payAmount(line) })).filter(line => line.amount > 0)
    });
    lastChange = sale.change > 0 ? { id: sale.id, change: sale.change, tendered: sale.tendered } : null;
    resetBillForm();
    await reloadAll();
    showInvoice(sale.id);
    const earnedNote = sale.pointsEarned > 0 ? ` · ${sale.pointsEarned} points earned` : '';
    showToast(sale.change > 0 ? `Bill created · return ${currency(sale.change)} to the customer${earnedNote}` : dueOf(sale) > 0 ? `Bill created · ${currency(dueOf(sale))} due${earnedNote}` : `Bill created and marked as paid${earnedNote}`);
  });
});
$('#saveDraft').addEventListener('click', () => showToast(db.cart.length ? 'Draft kept. Items stay on this bill until you create it' : 'Add a product before saving'));

/* ---------- Invoice ---------- */
function invoiceHtml(sale) {
  const store = outletById(sale.outletId), paid = paidOf(sale), due = dueOf(sale);
  const rows = sale.lines.map((line, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHtml(line.name)}</strong><small>${escapeHtml(line.label)}</small>${line.recipe ? `<small class="inv-recipe">${line.recipe.map(part => `${escapeHtml(part.name)} ${part.ml.toFixed(2)}ml`).join(' · ')}</small>` : ''}${line.pack ? `<small class="inv-recipe">${escapeHtml(line.pack.name)} × ${line.pack.qty}</small>` : ''}${(line.extras || []).map(extra => `<small class="inv-recipe">${escapeHtml(extra.name)} × ${extra.qty}</small>`).join('')}</td><td>${line.qty}</td><td>${currency(line.taxable)}</td><td>${line.gstRate}%</td><td>${currency(line.total)}</td></tr>`).join('');
  const totalRow = (label, value, strong = false) => `<div class="${strong ? 'inv-grand' : ''}"><span>${label}</span><span>${value}</span></div>`;
  return `<div class="inv-head"><div><h2>${escapeHtml(store.name)}</h2>${store.address ? `<p>${escapeHtml(store.address)}</p>` : ''}${store.phone ? `<p>Phone: ${escapeHtml(store.phone)}</p>` : ''}${store.gstin ? `<p>GSTIN: ${escapeHtml(store.gstin)}</p>` : ''}</div><div class="inv-meta"><span class="bill-label">${store.gstin ? 'TAX INVOICE' : 'INVOICE'}</span><strong>#${sale.number}</strong><p>${formatStamp(sale.date)}</p>${sale.salesmanName ? `<p>Salesman: ${escapeHtml(sale.salesmanName)}</p>` : ''}</div></div>
    <div class="inv-party"><span class="bill-label">BILL TO</span><strong>${escapeHtml(sale.customerName)}</strong><p>${formatPhone(sale.customerPhone)}</p>${sale.customerGstin ? `<p>GSTIN: ${escapeHtml(sale.customerGstin)}</p>` : ''}${sale.customerAddress ? `<p>${escapeHtml(sale.customerAddress)}</p>` : ''}${sale.priceType && sale.priceType !== 'retail' ? `<p class="inv-pricelist">${PRICE_LABELS[sale.priceType]} price list</p>` : ''}</div>
    <table class="inv-table inv-cols6"><thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Taxable</th><th>GST</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="inv-totals">${totalRow('Subtotal', currency(sale.subtotal))}${sale.discount > 0 ? totalRow('Discount', `−${currency(sale.discount)}`) : ''}${totalRow('Taxable value', currency(sale.taxable))}${totalRow('CGST', currency(sale.cgst))}${totalRow('SGST', currency(sale.sgst))}${sale.roundOff !== 0 ? totalRow('Round off', `${sale.roundOff > 0 ? '+' : ''}${currency(sale.roundOff)}`) : ''}${totalRow('Total', currency(sale.total), true)}${sale.credited ? totalRow('Credit notes', `−${currency(sale.credited)}`) + totalRow('Net amount', currency(netTotal(sale))) : ''}${totalRow('Received (net of refunds)', currency(paid))}${due > 0 ? totalRow('Balance due', currency(due), true) : ''}</div>
    ${sale.pointsEarned || sale.pointsRedeemed ? `<p class="inv-points">Loyalty points: ${sale.pointsRedeemed ? `${sale.pointsRedeemed} used (${currency(sale.pointsValue)}) · ` : ''}${sale.pointsEarned} earned · balance ${sale.pointsBalance}</p>` : ''}
    ${lastChange && lastChange.id === sale.id ? `<p class="inv-change">Cash tendered ${currency(lastChange.tendered)} · Balance returned ${currency(lastChange.change)}</p>` : ''}
    ${sale.payments.length ? `<p class="inv-pay">${sale.payments.map(payment => payment.amount < 0 ? `${formatStamp(payment.date)} · Refund via ${payment.mode} · ${currency(-payment.amount)}` : `${formatStamp(payment.date)} · ${payment.mode} · ${currency(payment.amount)}`).join('<br>')}</p>` : ''}
    ${creditNotes.filter(note => note.saleId === sale.id).length ? `<p class="inv-pay">${creditNotes.filter(note => note.saleId === sale.id).map(note => `Credit note ${note.number} · ${currency(note.total)}`).join('<br>')}</p>` : ''}
    <p class="inv-foot">${sale.taxMode === 'inclusive' ? 'Prices include GST.' : 'GST added on top of listed prices.'} Thank you for shopping with ${escapeHtml(store.name)}.</p>`;
}
function showInvoice(id) {
  const sale = sales.find(entry => entry.id === id);
  if (!sale) return;
  currentDoc = { type: 'invoice', id };
  $('#shareInvoice').classList.remove('hidden');
  $('#invoiceContent').innerHTML = invoiceHtml(sale);
  if (lastChange && lastChange.id === id) lastChange = null;   // the change note is shown once, right after the bill
  $('#returnFromInvoice').classList.toggle('hidden', !canReturn(sale));
  $('#invoiceModal').classList.remove('hidden');
}
function creditNoteHtml(note) {
  const store = outletById(note.outletId), sale = sales.find(entry => entry.id === note.saleId);
  const rows = note.lines.map((line, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHtml(line.name)}</strong><small>${escapeHtml(line.label)}${line.restock ? ' · returned to stock' : ' · blend, not restocked'}</small></td><td>${line.qty}</td><td>${currency(line.taxable)}</td><td>${line.gstRate}%</td><td>${currency(line.total)}</td></tr>`).join('');
  const totalRow = (label, value, strong = false) => `<div class="${strong ? 'inv-grand' : ''}"><span>${label}</span><span>${value}</span></div>`;
  return `<div class="inv-head"><div><h2>${escapeHtml(store.name)}</h2>${store.address ? `<p>${escapeHtml(store.address)}</p>` : ''}${store.gstin ? `<p>GSTIN: ${escapeHtml(store.gstin)}</p>` : ''}</div><div class="inv-meta"><span class="bill-label">CREDIT NOTE</span><strong>#${note.number}</strong><p>${formatStamp(note.date)}</p><p>Against invoice #${note.saleNumber}</p></div></div>
    <div class="inv-party"><span class="bill-label">CREDITED TO</span><strong>${escapeHtml(note.customerName)}</strong><p>${formatPhone(note.customerPhone)}</p></div>
    <table class="inv-table inv-cols6"><thead><tr><th>#</th><th>Returned item</th><th>Qty</th><th>Taxable</th><th>GST</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="inv-totals">${totalRow('Taxable value', currency(note.taxable))}${totalRow('CGST reversed', currency(note.cgst))}${totalRow('SGST reversed', currency(note.sgst))}${note.roundOff !== 0 ? totalRow('Round off', `${note.roundOff > 0 ? '+' : ''}${currency(note.roundOff)}`) : ''}${totalRow('Credit note total', currency(note.total), true)}${note.refund > 0 ? totalRow(`Refunded (${note.refundMode})`, currency(note.refund)) : ''}${note.total - note.refund > 0 ? totalRow('Set off against balance owed', currency(round2(note.total - note.refund))) : ''}</div>
    <p class="inv-pay">Reason: ${escapeHtml(note.reason)}</p>
    <p class="inv-foot">This credit note reduces the amount payable on invoice #${note.saleNumber}.</p>`;
}
function showCreditNote(id) {
  const note = creditNotes.find(entry => entry.id === id);
  if (!note) return;
  currentDoc = { type: 'credit', id };
  $('#shareInvoice').classList.remove('hidden');
  $('#invoiceContent').innerHTML = creditNoteHtml(note);
  $('#returnFromInvoice').classList.add('hidden');
  $('#invoiceModal').classList.remove('hidden');
}
function shareCreditNote() {
  const note = creditNotes.find(entry => entry.id === currentDoc.id);
  const text = [`*${outletById(note.outletId).name}*`, `Credit note ${note.number} against invoice #${note.saleNumber}`, '', ...note.lines.map(line => `${line.name} × ${line.qty} — ${currency(line.total)}`), '', `Credit: ${currency(note.total)}`, ...(note.refund > 0 ? [`Refunded: ${currency(note.refund)} (${note.refundMode})`] : []), '', 'Thank you.'].join('\n');
  window.open(`https://wa.me/91${note.customerPhone}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}
$('#closeInvoice').addEventListener('click', () => closeModal('#invoiceModal'));
/* ---------- Print formats: A4 sheet, or a 3 inch (80 mm) or 2 inch (58 mm) receipt roll ---------- */
// The choice is kept on this computer, because the receipt printer belongs to this counter.
const PRINT_FORMATS = { a4: 'A4 sheet', '3in': '3 inch receipt (80 mm)', '2in': '2 inch receipt (58 mm)' };
const printFormat = () => { const saved = storage.get('vv-print-format'); return PRINT_FORMATS[saved] ? saved : 'a4'; };
function setPrintFormat(format) { storage.set('vv-print-format', PRINT_FORMATS[format] ? format : 'a4'); syncPrintFormatBoxes(); }
function syncPrintFormatBoxes() { ['#printFormat', '#setPrintFormat'].forEach(selector => { const box = $(selector); if (box) box.value = printFormat(); }); }
// The layout classes only exist while printing, so the screen never changes.
function applyPrintFormat(printing) {
  document.body.classList.remove('print-3in', 'print-2in');
  if (printing && printFormat() !== 'a4') document.body.classList.add(`print-${printFormat()}`);
}
window.addEventListener('beforeprint', () => applyPrintFormat(true));
window.addEventListener('afterprint', () => applyPrintFormat(false));
['#printFormat', '#setPrintFormat'].forEach(selector => { $(selector).innerHTML = Object.entries(PRINT_FORMATS).map(([value, label]) => `<option value="${value}">${label}</option>`).join(''); $(selector).addEventListener('change', event => setPrintFormat(event.target.value)); });
syncPrintFormatBoxes();
$('#printInvoice').addEventListener('click', () => { syncPrintFormatBoxes(); window.print(); });
$('#shareInvoice').addEventListener('click', () => {
  if (currentDoc?.type === 'credit') { shareCreditNote(); return; }
  if (currentDoc?.type === 'voucher') { shareVoucher(); return; }
  if (currentDoc?.type === 'closing') return;
  const sale = sales.find(entry => entry.id === currentDoc?.id);
  if (!sale) return;
  const due = dueOf(sale);
  const text = [`*${outletById(sale.outletId).name}*`, `Invoice #${sale.number} · ${formatKey(sale.day)}`, '', ...sale.lines.map(line => `${line.name} × ${line.qty} — ${currency(line.total)}`), '', `Total: ${currency(sale.total)}`, `Paid: ${currency(paidOf(sale))}`, ...(due > 0 ? [`Balance due: ${currency(due)}`] : []), '', 'Thank you!'].join('\n');
  window.open(`https://wa.me/91${sale.customerPhone}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
});

/* ---------- Returns (credit notes) ---------- */
function openReturn(saleId) {
  const sale = sales.find(entry => entry.id === saleId);
  if (!sale || !canReturn(sale)) return;
  returningSaleId = saleId;
  $('#returnTitle').textContent = `Return items · #${sale.number}`;
  $('#returnHelp').textContent = `${sale.customerName} · bill total ${currency(sale.total)}${sale.credited ? ` · already credited ${currency(sale.credited)}` : ''}`;
  $('#returnLines').innerHTML = sale.lines.map((line, index) => {
    const remaining = line.qty - (line.returned || 0);
    return `<div class="return-line" data-index="${index}"><span><strong>${escapeHtml(line.name)}</strong><small>${escapeHtml(line.label)}${line.recipe ? ' · custom blend' : ''}</small></span><span class="num">${line.qty}</span><span class="num">${line.returned || 0}</span><span class="num"><input class="return-qty" type="number" min="0" max="${remaining}" step="1" value="0" ${remaining === 0 ? 'disabled' : ''} aria-label="Quantity of ${escapeHtml(line.name)} to return" /></span><span class="num return-credit">₹0</span></div>`;
  }).join('');
  $('#returnReason').value = ''; $('#returnError').textContent = ''; setFieldError('returnReason', '');
  $('#returnMode').value = PAYMENT_MODES[0];
  updateReturnSummary();
  $('#returnModal').classList.remove('hidden');
  ($('.return-qty:not(:disabled)') || $('#returnReason')).focus();
}
const returnPicks = () => $$('.return-line').map(row => ({ index: Number(row.dataset.index), qty: Number(row.querySelector('.return-qty').value) || 0 }));
function updateReturnSummary() {
  const sale = sales.find(entry => entry.id === returningSaleId);
  const picks = returnPicks();
  picks.forEach(pick => { const line = sale.lines[pick.index]; $(`.return-line[data-index="${pick.index}"] .return-credit`).textContent = currency(round2(line.total * Math.min(pick.qty, line.qty) / line.qty)); });
  const chosen = picks.some(pick => pick.qty > 0);
  if (!chosen) { $('#returnSummary').innerHTML = '<span class="return-hint">Enter a quantity for each item being returned.</span>'; $('#returnModeGroup').classList.add('hidden'); return; }
  const note = computeCreditNote(sale, picks);
  const refund = refundFor(sale, note.total), offset = round2(note.total - refund);
  const pointsPaid = round2(sale.payments.filter(payment => payment.mode === 'Loyalty points').reduce((sum, payment) => sum + payment.amount, 0)), pointsBack = Math.min(refund, Math.max(0, pointsPaid)), cashBack = round2(refund - pointsBack);
  $('#returnSummary').innerHTML = `<div><span>Credit note value <small>(incl. ${currency(note.gst)} GST reversed)</small></span><strong>${currency(note.total)}</strong></div>${offset > 0 ? `<div><span>Reduces what the customer owes</span><strong>${currency(offset)}</strong></div>` : ''}<div class="${cashBack > 0 ? 'return-refund' : ''}"><span>Refund to hand back</span><strong>${currency(cashBack)}</strong></div>${pointsBack > 0 ? `<div><span>Given back to the customer as loyalty points</span><strong>${currency(pointsBack)}</strong></div>` : ''}`;
  $('#returnModeGroup').classList.toggle('hidden', cashBack <= 0);
}
$('#returnLines').addEventListener('input', () => { $('#returnError').textContent = ''; updateReturnSummary(); });
$('#returnReason').addEventListener('input', () => setFieldError('returnReason', ''));
$('#closeReturn').addEventListener('click', () => closeModal('#returnModal'));
$('#returnFromInvoice').addEventListener('click', () => { const id = currentDoc?.id; closeModal('#invoiceModal'); openReturn(id); });
$('#returnForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#returnSubmit'), async () => {
    const sale = sales.find(entry => entry.id === returningSaleId);
    const picks = returnPicks();
    const tooMany = picks.find(pick => pick.qty > sale.lines[pick.index].qty - (sale.lines[pick.index].returned || 0) || (pick.qty > 0 && !Number.isInteger(pick.qty)));
    const reason = $('#returnReason').value.trim();
    $('#returnError').textContent = !picks.some(pick => pick.qty > 0) ? 'Enter a quantity for at least one item' : tooMany ? `Only ${sale.lines[tooMany.index].qty - (sale.lines[tooMany.index].returned || 0)} of ${sale.lines[tooMany.index].name} can still be returned` : '';
    setFieldError('returnReason', reason ? '' : 'Give a reason for the return');
    if ($('#returnError').textContent || !reason) return;
    const note = await api('POST', '/api/credit-notes', { saleId: sale.id, reason, lines: picks.filter(pick => pick.qty > 0), refundMode: $('#returnMode').value });
    closeModal('#returnModal');
    await reloadAll();
    showCreditNote(note.id);
    showToast(note.refund > 0 ? `${note.number} issued · refund ${currency(note.refund)}` : `${note.number} issued`);
  });
});

/* ---------- Record payments (customers and suppliers) ---------- */
function paymentContext(target) {
  if (target.kind === 'sale') { const sale = sales.find(entry => entry.id === target.id); return { title: 'Receive payment', label: 'FROM CUSTOMER', help: `Bill #${sale.number} · ${sale.customerName}`, due: dueOf(sale) }; }
  if (target.kind === 'customer') { const customer = customers.find(entry => entry.phone === target.id); return { title: 'Receive payment', label: 'FROM CUSTOMER', help: `${customer.name} · applied to the oldest unpaid bills first`, due: customerStats(customer.phone).due }; }
  const purchase = purchases.find(entry => entry.id === target.id);
  return { title: 'Pay supplier', label: 'TO SUPPLIER', help: `Purchase ${purchase.number} · ${purchase.supplier}`, due: dueOf(purchase) };
}
function openPayment(target) {
  paymentTarget = target;
  const context = paymentContext(target);
  $('#paymentTitle').textContent = context.title;
  $('#paymentLabel').textContent = context.label;
  $('#paymentHelp').textContent = `${context.help} · Due ${currency(context.due)}`;
  $('#paymentAmount').value = context.due;
  setFieldError('paymentAmount', '');
  $('#paymentModal').classList.remove('hidden');
  $('#paymentAmount').focus();
}
$('#closePayment').addEventListener('click', () => closeModal('#paymentModal'));
$('#paymentAmount').addEventListener('input', () => setFieldError('paymentAmount', ''));
$('#paymentForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#paymentForm button[type="submit"]'), async () => {
    const context = paymentContext(paymentTarget);
    const amount = round2(Number($('#paymentAmount').value));
    const error = !(amount > 0) ? 'Enter an amount greater than 0' : amount > context.due ? `Amount cannot exceed the due ${currency(context.due)}` : '';
    setFieldError('paymentAmount', error);
    if (error) return;
    const mode = $('#paymentModeSelect').value;
    await api('POST', '/api/payments', { kind: paymentTarget.kind, id: paymentTarget.id, amount, mode });
    closeModal('#paymentModal');
    await reloadAll();
    showToast(`${currency(amount)} recorded via ${mode}`);
  });
});

/* ---------- Add / edit product (the item master) ---------- */
const productFieldIds = ['newProductSize', 'newProductName', 'newProductCode', 'newProductEan', 'newProductAlert', 'newProductPrice', 'newProductCost', 'newProductRecipeMl'];
let productRestricted = false;
const stockKinds = ['attar', 'raw', 'pack'];
function fillPackOptions(selected = '') {
  const pieces = rawMaterials.filter(material => material.unit === 'pcs' && material.type !== 'Packed product');
  $('#newProductPack').innerHTML = `<option value="">None</option>${pieces.map(material => `<option value="${material.id}">${escapeHtml(material.name)}</option>`).join('')}`;
  $('#newProductPack').value = selected;
}
function syncProductType() {
  const stockItem = stockKinds.includes($('#newProductType').value);
  const needsRecipe = $('#productNeedsRecipe').checked, tracked = $('#productTrackStock').checked;
  $('#productUnitGroup').classList.toggle('hidden', !stockItem || productRestricted);
  ['#productCodeGroup', '#productEanGroup'].forEach(selector => $(selector).classList.toggle('hidden', !stockItem || productRestricted));
  $('#productAlertGroup').classList.toggle('hidden', !stockItem);
  $('#productSaleFields').classList.toggle('hidden', stockItem || !isAdmin());
  $('#productRecipeGroup').classList.toggle('hidden', stockItem || !needsRecipe);
  $('#productSizeGroup').classList.toggle('hidden', stockItem || needsRecipe);
  $('#productTrackRow').classList.toggle('hidden', stockItem || needsRecipe);
  $('#productCostGroup').classList.toggle('hidden', stockItem || needsRecipe || tracked);
  $('#productAlertUnit').textContent = $('#newProductUnit').value;
}
// Materials measured in ml, for the "top up the rest with" choice.
function fillFillOptions(selected = '') {
  const liquids = rawMaterials.filter(material => material.unit === 'ml');
  $('#newProductFill').innerHTML = `<option value="">None</option>${liquids.map(material => `<option value="${material.id}">${escapeHtml(material.name)}</option>`).join('')}`;
  $('#newProductFill').value = selected;
}
function openProductModal(target = null) {
  editingProduct = target;
  $('#productForm').reset();
  productFieldIds.forEach(id => setFieldError(id, ''));
  $('#newProductGst').value = '18';
  $('#newProductAlert').value = '50';
  fillPackOptions(); fillFillOptions();
  $('#productTrackStock').disabled = false;
  const item = target && (target.kind === 'material' ? findMaterial(target.id) : products.find(product => product.id === target.id));
  productRestricted = Boolean(item) && !isAdmin();
  $('#newProductType').disabled = Boolean(item); $('#newProductUnit').disabled = Boolean(item);
  ['#productNameGroup', '#productTypeGroup', '#productArtGroup'].forEach(selector => $(selector).classList.toggle('hidden', productRestricted));
  $('#productModalLabel').textContent = item ? (productRestricted ? 'STOCK ALERT' : 'EDIT ITEM') : 'NEW ITEM';
  $('#productModalTitle').textContent = item ? (productRestricted ? `Alert level · ${item.name}` : `Edit ${item.name}`) : 'Add to item master';
  $('#productModalHelp').textContent = item ? (productRestricted ? 'You are warned when this item falls to this level at your outlet.' : 'Changes reach every outlet immediately. Past bills keep their recorded prices.') : 'Stock items (attars, raw materials, bottles and packaging) are counted in ml or pieces. Products are what you sell. Stock is entered per outlet under Opening stock.';
  $('#productAlertLabel').textContent = item ? 'Low-stock alert at (this outlet)' : 'Default low-stock alert at';
  $('#productSubmit').textContent = item ? 'Save changes' : 'Add to item master';
  if (item) {
    $('#newProductName').value = item.name;
    if (target.kind === 'material') {
      $('#newProductType').value = item.type === 'Attar stock' ? 'attar' : item.type === 'Raw material' ? 'raw' : 'pack';
      $('#newProductUnit').value = item.unit; $('#newProductAlert').value = item.alertMl;
      $('#newProductCode').value = item.code || ''; $('#newProductEan').value = item.ean || '';
    } else {
      $('#newProductType').value = 'product';
      $('#newProductPrice').value = item.price; $('#newProductGst').value = String(item.gstRate); $('#newProductCost').value = item.cost ?? '';
      $('#productNeedsRecipe').checked = item.needsRecipe; $('#newProductRecipeMl').value = item.recipeMl || '';
      fillPackOptions(item.packMaterialId || ''); $('#newProductPackQty').value = item.packQty || 1; fillFillOptions(item.fillMaterialId || '');
      const sizeInType = !item.needsRecipe && /·\s*(\d+(?:\.\d+)?)ml/.exec(item.type || ''); $('#newProductSize').value = sizeInType ? sizeInType[1] : '';
      $('#productTrackStock').checked = Boolean(item.stockMaterialId); $('#productTrackStock').disabled = Boolean(item.stockMaterialId);
    }
    const swatch = $(`input[name="productArt"][value="${item.art}"]`);
    if (swatch) swatch.checked = true;
  }
  syncProductType();
  $('#productModal').classList.remove('hidden');
  (productRestricted ? $('#newProductAlert') : $('#newProductName')).focus();
}
$('#addProductButton').addEventListener('click', () => openProductModal());
$('#closeProductModal').addEventListener('click', () => closeModal('#productModal'));
const setDefaultAlert = () => { $('#newProductAlert').value = $('#newProductUnit').value === 'pcs' ? '5' : '50'; };
$('#newProductType').addEventListener('change', () => {
  const kind = $('#newProductType').value;
  if (kind === 'pack') $('#newProductUnit').value = 'pcs'; else if (kind === 'attar' || kind === 'raw') $('#newProductUnit').value = 'ml';
  setDefaultAlert(); syncProductType();
});
$('#newProductUnit').addEventListener('change', () => { setDefaultAlert(); syncProductType(); });
$('#productNeedsRecipe').addEventListener('change', syncProductType);
$('#productTrackStock').addEventListener('change', syncProductType);
productFieldIds.forEach(id => $(`#${id}`).addEventListener('input', () => setFieldError(id, '')));
$('#productForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#productSubmit'), async () => {
    const name = $('#newProductName').value.trim().replace(/\s+/g, ' ');
    const kind = $('#newProductType').value, stockItem = stockKinds.includes(kind);
    const unit = $('#newProductUnit').value;
    const code = $('#newProductCode').value.trim().toUpperCase(), ean = $('#newProductEan').value.trim();
    const otherItem = test => rawMaterials.find(item => test(item) && !(editingProduct && item.id === editingProduct.id));
    const alertMl = $('#newProductAlert').value === '' ? (unit === 'pcs' ? 5 : 50) : Number($('#newProductAlert').value);
    const needsRecipe = $('#productNeedsRecipe').checked, tracked = $('#productTrackStock').checked;
    const price = Number($('#newProductPrice').value), cost = Number($('#newProductCost').value || 0), recipeMl = Number($('#newProductRecipeMl').value), sizeMl = Number($('#newProductSize').value || 0);
    const taken = [...rawMaterials, ...products].some(item => item.name.toLowerCase() === name.toLowerCase() && !(editingProduct && item.id === editingProduct.id));
    const errors = {
      newProductName: productRestricted ? '' : !name ? 'Name is required' : taken ? 'An item with this name already exists' : '',
      newProductCode: !stockItem || productRestricted ? '' : code && !/^[A-Z0-9._-]{1,20}$/.test(code) ? 'Use letters, digits, dots and dashes only' : code && otherItem(item => (item.code || '').toUpperCase() === code) ? 'That code is already used' : '',
      newProductEan: !stockItem || productRestricted ? '' : ean && !/^[A-Za-z0-9-]{4,20}$/.test(ean) ? 'Enter 4 to 20 letters or digits' : ean && otherItem(item => item.ean === ean) ? `Already the barcode of ${otherItem(item => item.ean === ean).name}` : '',
      newProductAlert: stockItem && !(alertMl >= 0) ? 'Enter 0 or more' : '',
      newProductPrice: !stockItem && !productRestricted && !(price > 0) ? 'Enter a price greater than 0' : '',
      newProductCost: !stockItem && !needsRecipe && !tracked && !(cost >= 0) ? 'Enter a cost of 0 or more' : '',
      newProductRecipeMl: !stockItem && needsRecipe && !(recipeMl > 0 && recipeMl <= 1000) ? 'Enter the bottle size in ml (up to 1000)' : '',
      newProductSize: !stockItem && !needsRecipe && !(sizeMl >= 0 && sizeMl <= 10000) ? 'Enter a size in ml, or leave it empty' : ''
    };
    productFieldIds.forEach(id => setFieldError(id, errors[id]));
    if (Object.values(errors).some(Boolean)) { $('#productForm .customer-input.invalid input').focus(); return; }
    const art = $('input[name="productArt"]:checked').value, gstRate = Number($('#newProductGst').value);
    const productBody = { name, price, gstRate, cost, art, needsRecipe, recipeMl: needsRecipe ? recipeMl : 0, fillMaterialId: needsRecipe ? $('#newProductFill').value : '', sizeMl: needsRecipe ? 0 : sizeMl, packMaterialId: needsRecipe ? $('#newProductPack').value : '', packQty: Number($('#newProductPackQty').value) || 1, trackStock: !needsRecipe && tracked };
    if (productRestricted) await api('PUT', `/api/outlet-stock/${editingProduct.id}`, { alertMl });
    else if (editingProduct && stockItem) { await api('PUT', `/api/materials/${editingProduct.id}`, { name, art, code, ean }); await api('PUT', `/api/outlet-stock/${editingProduct.id}`, { alertMl }); }
    else if (editingProduct) await api('PUT', `/api/products/${editingProduct.id}`, productBody);
    else if (stockItem) await api('POST', '/api/materials', { name, type: { attar: 'Attar stock', raw: 'Raw material', pack: 'Packaging' }[kind], unit, art, alertMl, code, ean });
    else await api('POST', '/api/products', productBody);
    const wasEditing = Boolean(editingProduct);
    closeModal('#productModal');
    await reloadAll();
    showToast(wasEditing ? 'Changes saved' : stockItem ? `${name} added. Enter its stock under Opening stock` : needsRecipe ? `${name} added. It will ask for a recipe when sold` : `${name} added to the billing catalog`);
  });
});

/* ---------- Outlet settings and password ---------- */
$('#openSettings').addEventListener('click', () => {
  const outlet = state.outlet;
  $('#settingsLabel').textContent = outlet.code;
  $('#setStoreName').value = outlet.name; $('#setGstin').value = outlet.gstin; $('#setPhone').value = outlet.phone;
  $('#setAddress').value = outlet.address; $('#setTaxMode').value = state.settings.taxMode;
  $('#setStoreName').disabled = !isAdmin(); $('#setGstin').disabled = !isAdmin();
  $('#setCurrentPass').value = ''; $('#setNewPass').value = '';
  ['setStoreName', 'setGstin', 'setCurrentPass', 'setNewPass'].forEach(id => setFieldError(id, ''));
  syncPrintFormatBoxes();
  $('#settingsModal').classList.remove('hidden');
  (isBiller() ? $('#setCurrentPass') : $('#setPhone')).focus();
});
$('#closeSettings').addEventListener('click', () => closeModal('#settingsModal'));
$('#settingsForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#settingsForm button[type="submit"]'), async () => {
    const name = $('#setStoreName').value.trim(), gstin = $('#setGstin').value.trim().toUpperCase();
    const newPass = $('#setNewPass').value;
    setFieldError('setStoreName', isBiller() || name ? '' : 'Outlet name is required');
    setFieldError('setGstin', isAdmin() && gstin && !isValidGstin(gstin) ? 'Enter a valid 15-character GSTIN' : '');
    setFieldError('setCurrentPass', newPass && !$('#setCurrentPass').value ? 'Enter your current password' : '');
    setFieldError('setNewPass', newPass && newPass.length < 8 ? 'Use at least 8 characters' : '');
    if ($('#settingsForm .customer-input.invalid')) { $('#settingsForm .customer-input.invalid input').focus(); return; }
    if (!isBiller()) await api('PUT', '/api/outlet', { name, gstin, phone: $('#setPhone').value, address: $('#setAddress').value });
    if (isAdmin() && $('#setTaxMode').value !== state.settings.taxMode) await api('PUT', '/api/settings', { taxMode: $('#setTaxMode').value });
    if (newPass) await api('POST', '/api/change-password', { current: $('#setCurrentPass').value, next: newPass });
    closeModal('#settingsModal');
    await reloadAll();
    showToast(newPass ? 'Settings and password saved' : 'Settings saved');
  });
});

/* ---------- CSV exports ---------- */
$('#exportSales').addEventListener('click', () => {
  downloadCsv('sales.csv', [['Invoice', 'Date', 'Customer', 'Phone', 'Taxable', 'CGST', 'SGST', 'Total', 'Credited', 'Paid (net of refunds)', 'Due', 'Status', 'Price list', 'Customer GSTIN', 'Salesman'], ...sales.map(sale => [sale.number, sale.day, sale.customerName, sale.customerPhone, sale.taxable, sale.cgst, sale.sgst, sale.total, sale.credited || 0, paidOf(sale), dueOf(sale), statusOf(sale), PRICE_LABELS[sale.priceType || 'retail'], sale.customerGstin || '', sale.salesmanName || ''])]);
});
$('#exportCustomers').addEventListener('click', () => {
  downloadCsv('customers.csv', [['Name', 'Phone', 'Email', 'Type', 'GSTIN', 'Address', 'Lifetime spend', 'Visits', 'Due'], ...customers.map(customer => { const stats = customerStats(customer.phone); return [customer.name, customer.phone, customer.email, PRICE_LABELS[customer.type || 'retail'], customer.gstin || '', customer.address || '', stats.spent, stats.visits, stats.due]; })]);
});

/* ---------- Static setup (data loads after sign-in, see boot.js) ---------- */
$('#todayLabel').textContent = `${new Date().toLocaleDateString('en-GB', { weekday: 'long' })}, ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`.toUpperCase();
['#paymentModeSelect', '#purchaseMode', '#royaltyMode', '#returnMode', '#voucherMode'].forEach(selector => { $(selector).innerHTML = optionList(PAYMENT_MODES); });
$('#newProductGst').innerHTML = GST_RATES.map(rate => `<option value="${rate}">${rate}%</option>`).join('');
$('#purchaseDate').value = todayKey();
$('#expenseDate').value = todayKey();
$('#expenseCategory').innerHTML = optionList(EXPENSE_CATEGORIES);
$('#expenseMode').innerHTML = optionList(PAYMENT_MODES);

/* ---------- Products screen: search and group buttons ---------- */
$('#inventorySearch').addEventListener('input', renderInventory);
$('#inventorySearch').addEventListener('keydown', event => { if (event.key === 'Escape' && event.target.value) { event.target.value = ''; renderInventory(); } });
$('#inventoryFilter').addEventListener('click', event => {
  const button = event.target.closest('[data-inv-filter]');
  if (!button) return;
  inventoryFilter = button.dataset.invFilter;
  $$('#inventoryFilter [data-inv-filter]').forEach(entry => entry.classList.toggle('active', entry === button));
  renderInventory();
});

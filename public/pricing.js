/* ---------- Customer book (retail, wholesale, franchise) and the Price update tab ---------- */
let partyFilter = 'all';
let editingParty = null;
const typeOf = customer => customer.type || 'retail';
const partyBadge = type => type === 'retail' ? '' : `<span class="status-badge party-${type}">${PRICE_LABELS[type]}</span>`;

/* ----- Customer book ----- */
function renderCustomers() {
  const query = $('#customerSearch').value.trim().toLowerCase();
  const list = customers.filter(customer => (partyFilter === 'all' || typeOf(customer) === partyFilter) && (!query || `${customer.name} ${customer.phone} ${customer.gstin || ''}`.toLowerCase().includes(query)));
  $$('#partyFilter [data-party-filter]').forEach(button => {
    const key = button.dataset.partyFilter, count = key === 'all' ? customers.length : customers.filter(customer => typeOf(customer) === key).length;
    button.textContent = `${key === 'all' ? 'All' : PRICE_LABELS[key]} (${count})`;
    button.classList.toggle('active', key === partyFilter);
  });
  $('#customerList').innerHTML = list.length ? list.map(customer => {
    const stats = customerStats(customer.phone), type = typeOf(customer);
    return `<div class="customer-row"><div class="customer-avatar">${escapeHtml(initialsOf(customer.name))}</div><span><strong>${escapeHtml(customer.name)}</strong><small>${formatPhone(customer.phone)}${customer.email ? ` · ${escapeHtml(customer.email)}` : ''}</small></span><span data-label="Type">${partyBadge(type) || '<span class="muted-text">Retail</span>'}${customer.gstin ? `<small>GSTIN ${escapeHtml(customer.gstin)}</small>` : ''}${customer.buyerOutletId ? `<small class="party-tag party-franchise">Linked receiving outlet #${customer.buyerOutletId}</small>` : ''}</span><span data-label="Spend">${currency(stats.spent)}<small>${stats.visits} visit${stats.visits === 1 ? '' : 's'}</small>${state.settings.loyalty && state.settings.loyalty.enabled && customer.points ? `<small class="points-tag">${customer.points} points</small>` : ''}</span><span class="row-actions">${stats.due > 0 ? `<span class="due-text">Due ${currency(stats.due)}</span><button class="link-button accent" data-pay-customer="${customer.phone}">Receive</button>` : ''}${isBiller() ? '' : `${state.settings.loyalty && state.settings.loyalty.enabled ? `<button class="link-button" data-points-party="${customer.phone}">Points</button>` : ''}<button class="link-button" data-edit-party="${customer.phone}">Edit</button>`}</span></div>`;
  }).join('') : `<div class="purchase-empty">${customers.length ? 'No customers match.' : 'No customers yet. Retailers are added when you create a bill; add wholesalers and franchisees with Add customer.'}</div>`;
}
$('#partyFilter').addEventListener('click', event => { const button = event.target.closest('[data-party-filter]'); if (button) { partyFilter = button.dataset.partyFilter; renderCustomers(); } });
$('#customerSearch').addEventListener('input', renderCustomers);
$('#customerList').addEventListener('click', event => { const button = event.target.closest('[data-edit-party]'); if (button) openPartyModal(customers.find(customer => customer.phone === button.dataset.editParty)); });

const partyFieldIds = ['partyName', 'partyPhone', 'partyEmail', 'partyGstin'];
const partyType = () => $('input[name="partyType"]:checked').value;
function syncPartyType() {
  const type = partyType();
  $('#partyGstinLabel').innerHTML = type === 'franchise' ? 'GSTIN <span class="req">*</span> <span class="optional">(the franchise\'s own, 15 characters)</span>' : 'GSTIN <span class="optional">(15 characters, for a GST invoice)</span>';
  $('#partyHelp').textContent = type === 'retail' ? 'Billed at the retail price.' : type === 'wholesale' ? 'Billed at the wholesale price. Add a GSTIN if they are registered.' : 'Billed at the franchise price on a separate FRN invoice series, with their GSTIN.';
}
function openPartyModal(customer = null) {
  editingParty = customer;
  $('#partyForm').reset();
  $('#partyOutlet').innerHTML = '<option value="">Not linked</option>' + state.outlets.filter(o => o.type === 'franchise' && o.id !== state.outlet.id && o.active).map(o => `<option value="${o.id}">${escapeHtml(o.name)} (${escapeHtml(o.code)})</option>`).join('');
  $('#partyOutlet').value = customer?.buyerOutletId || '';
  $('#partyOutlet').disabled = !isAdmin();
  partyFieldIds.forEach(id => setFieldError(id, ''));
  $('#partyLabel').textContent = customer ? 'EDIT CUSTOMER' : 'NEW CUSTOMER';
  $('#partyTitle').textContent = customer ? customer.name : 'Add customer';
  $('#partySubmit').textContent = customer ? 'Save changes' : 'Save customer';
  $('#partyPhone').disabled = Boolean(customer);
  if (customer) {
    $('#partyName').value = customer.name; $('#partyPhone').value = customer.phone; $('#partyEmail').value = customer.email || '';
    $('#partyGstin').value = customer.gstin || ''; $('#partyAddress').value = customer.address || '';
    $(`input[name="partyType"][value="${typeOf(customer)}"]`).checked = true;
  } else if (partyFilter !== 'all') $(`input[name="partyType"][value="${partyFilter}"]`).checked = true;
  syncPartyType();
  $('#partyModal').classList.remove('hidden');
  $('#partyName').focus();
}
$('#addPartyButton').addEventListener('click', () => openPartyModal());
$('#closeParty').addEventListener('click', () => closeModal('#partyModal'));
$$('input[name="partyType"]').forEach(input => input.addEventListener('change', () => { syncPartyType(); setFieldError('partyGstin', ''); }));
partyFieldIds.forEach(id => $(`#${id}`).addEventListener('input', event => { if (id === 'partyPhone') event.target.value = event.target.value.replace(/\D/g, ''); if (id === 'partyGstin') event.target.value = event.target.value.toUpperCase(); setFieldError(id, ''); }));
$('#partyForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#partySubmit'), async () => {
    const name = $('#partyName').value.trim().replace(/\s+/g, ' '), phone = $('#partyPhone').value.trim(), email = $('#partyEmail').value.trim();
    const gstin = $('#partyGstin').value.trim().toUpperCase(), type = partyType();
    const taken = !editingParty && customers.find(customer => customer.phone === phone);
    setFieldError('partyName', name ? '' : 'Name is required');
    setFieldError('partyPhone', !editingParty && !isValidPhone(phone) ? 'Enter a valid 10-digit mobile number' : taken ? `This number is saved for ${taken.name}. Use Edit on that customer` : '');
    setFieldError('partyEmail', email && !/^\S+@\S+\.\S+$/.test(email) ? 'Enter a valid email address' : '');
    setFieldError('partyGstin', gstin && !isValidGstin(gstin) ? 'Enter a valid 15-character GSTIN' : type === 'franchise' && !gstin ? 'A franchise needs its own GSTIN' : '');
    if ($('#partyForm .customer-input.invalid')) { $('#partyForm .customer-input.invalid input').focus(); return; }
    const body = { name, email, type, gstin, address: $('#partyAddress').value.trim(), ...(isAdmin() ? { buyerOutletId: type === 'franchise' ? ($('#partyOutlet').value || null) : null } : {}) };
    if (editingParty) await api('PUT', `/api/customers/${editingParty.phone}`, body);
    else await api('POST', '/api/customers', { ...body, phone });
    const wasEditing = Boolean(editingParty);
    closeModal('#partyModal');
    await reloadAll();
    showToast(wasEditing ? `${name} updated${type === 'retail' ? '' : ` · ${PRICE_LABELS[type]} price list`}` : `${name} added as ${PRICE_LABELS[type].toLowerCase()} customer`);
  });
});

/* ----- Price update: one product at a time ----- */
const SLABS = [['price', 'Retail', 'Retail'], ['wholesalePrice', 'Wholesale', 'Wholesale'], ['franchisePrice', 'Franchise', 'Franchise']];
const NEW_BOXES = { price: '#priceNewRetail', wholesalePrice: '#priceNewWholesale', franchisePrice: '#priceNewFranchise' };
const MARGIN_BOXES = { price: '#priceMarginRetail', wholesalePrice: '#priceMarginWholesale', franchisePrice: '#priceMarginFranchise' };
const CURRENT_BOXES = { price: '#priceCurRetail', wholesalePrice: '#priceCurWholesale', franchisePrice: '#priceCurFranchise' };
let priceProduct = null;
const priceLog = [];
// Cost and price are compared with GST on both: a cost of ₹780 at 18% GST is ₹920.40, and an ex-GST price gets GST added.
const withGst = (amount, gstRate) => round2(amount * (1 + gstRate / 100));
const priceWithGst = (price, gstRate) => state.settings.taxMode === 'inclusive' ? price : withGst(price, gstRate);
// What one piece costs: a set cost, the stock's average cost, or (for blends) the average of recent bills.
function costInfo(product) {
  if (product.needsRecipe) {
    const lines = sales.flatMap(sale => sale.lines).filter(line => line.product === product.name && line.qty > 0 && line.cost > 0).slice(0, 20);
    return lines.length ? { value: round2(lines.reduce((sum, line) => sum + line.cost / line.qty, 0) / lines.length), note: 'average of recent bills' } : { value: null, note: 'varies with the recipe' };
  }
  const stock = product.stockMaterialId ? findMaterial(product.stockMaterialId) : null;
  if (stock && stock.costPerMl > 0) return { value: stock.costPerMl, note: 'stock average cost' };
  return product.cost > 0 ? { value: product.cost, note: 'cost set on the product' } : { value: null, note: 'cost not set' };
}
const costWithGst = product => { const cost = costInfo(product).value; return cost ? withGst(cost, product.gstRate) : null; };
function marginText(product, valueText) {
  const cost = costInfo(product).value, value = Number(valueText);
  if (!cost || !(value > 0)) return '';
  const gross = priceWithGst(value, product.gstRate), margin = (gross - withGst(cost, product.gstRate)) / gross * 100;
  return margin < 0 ? '<span class="neg">below cost</span>' : `${margin.toFixed(0)}% margin`;
}
function updateMargins() {
  SLABS.forEach(([key]) => { $(MARGIN_BOXES[key]).innerHTML = priceProduct ? marginText(priceProduct, $(NEW_BOXES[key]).value) : ''; });
  const changed = priceProduct && SLABS.some(([key]) => $(NEW_BOXES[key]).value !== String(priceProduct[key]));
  $('#savePrice').disabled = !priceProduct;
  $('#savePrice').textContent = !priceProduct || changed ? 'Save prices' : 'Save (no change)';
}
function clearPriceForm() {
  priceProduct = null;
  ['#priceId', '#priceName', '#priceCost', '#priceStock', ...Object.values(CURRENT_BOXES)].forEach(selector => { $(selector).value = ''; });
  Object.values(NEW_BOXES).forEach(selector => { $(selector).value = ''; $(selector).disabled = true; });
  $('#priceCostNote').textContent = '';
  updateMargins();
  hideSuggest();
  $('#priceId').focus();
}
function loadPriceProduct(product) {
  if (!product) return;
  priceProduct = product;
  hideSuggest();
  const cost = costWithGst(product), stock = product.stockMaterialId ? findMaterial(product.stockMaterialId) : null;
  $('#priceId').value = product.code || product.id;
  $('#priceName').value = product.name;
  SLABS.forEach(([key]) => { $(CURRENT_BOXES[key]).value = currency(product[key]); $(NEW_BOXES[key]).value = String(product[key]); $(NEW_BOXES[key]).disabled = false; });
  $('#priceCost').value = cost ? currency(cost) : '—';
  $('#priceCostNote').textContent = costInfo(product).value ? `Net cost is ${currency(costInfo(product).value)} + ${product.gstRate}% GST (${costInfo(product).note}).` : `Cost: ${costInfo(product).note}.`;
  $('#priceStock').value = stock ? fmtQty(stock.stock, stock.unit) : product.needsRecipe ? 'made to order' : 'not counted';
  updateMargins();
  $('#priceNewRetail').focus(); $('#priceNewRetail').select();
}
// The Id box searches by code or name and shows the same suggestion list as the entry grids.
const priceLookup = { choose: (row, item) => loadPriceProduct(products.find(product => product.id === item.id)) };
const priceLookupPool = () => products.map(product => ({ id: product.id, code: product.code || '', ean: null, name: product.name, type: product.type, stock: null, unit: 'pcs' }));
$('#priceId').addEventListener('input', event => {
  if (priceProduct) { priceProduct = null; Object.values(NEW_BOXES).forEach(selector => { $(selector).value = ''; $(selector).disabled = true; }); ['#priceName', '#priceCost', '#priceStock', ...Object.values(CURRENT_BOXES)].forEach(selector => { $(selector).value = ''; }); $('#priceCostNote').textContent = ''; updateMargins(); }
  const query = event.target.value;
  suggestState = query.trim() ? { grid: priceLookup, row: null, input: event.target, list: searchItems(query, priceLookupPool()), active: 0 } : null;
  renderSuggest();
});
$('#priceId').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    const list = suggestState && suggestState.input === event.target ? suggestState.list : searchItems(event.target.value, priceLookupPool());
    const choice = list[suggestState && suggestState.input === event.target ? suggestState.active : 0];
    if (choice) priceLookup.choose(null, choice); else showToast('No product matches. Check the code or name');
  } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestState && suggestState.input === event.target && suggestState.list.length) {
    event.preventDefault();
    suggestState.active = (suggestState.active + (event.key === 'ArrowDown' ? 1 : -1) + suggestState.list.length) % suggestState.list.length;
    renderSuggest();
  } else if (event.key === 'Escape') hideSuggest();
});
$('#priceId').addEventListener('blur', () => setTimeout(() => { if (suggestState && suggestState.input === $('#priceId')) hideSuggest(); }, 130));
$('#priceId').addEventListener('focus', event => event.target.select());

Object.entries(NEW_BOXES).forEach(([key, selector], index, all) => {
  $(selector).addEventListener('input', event => {
    const clean = event.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    if (clean !== event.target.value) event.target.value = clean;
    updateMargins();
  });
  $(selector).addEventListener('focus', event => event.target.select());
  $(selector).addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (index < all.length - 1) { const next = $(all[index + 1][1]); next.focus(); next.select(); }
    else $('#priceForm').requestSubmit();
  });
});
$('#clearPrice').addEventListener('click', clearPriceForm);
$('#priceForm').addEventListener('keydown', event => { if (event.key === 'Escape') clearPriceForm(); });
$('#priceForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!priceProduct) { showToast('Choose a product first'); $('#priceId').focus(); return; }
  submitting($('#savePrice'), async () => {
    const product = priceProduct, values = {};
    for (const [key, label] of SLABS) {
      values[key] = Number($(NEW_BOXES[key]).value);
      if (!(values[key] > 0)) { showToast(`Enter a ${label.toLowerCase()} price greater than 0`); $(NEW_BOXES[key]).focus(); return; }
    }
    const changed = SLABS.filter(([key]) => values[key] !== product[key]);
    if (!changed.length) { showToast(`No price change for ${product.name}`); clearPriceForm(); return; }
    await api('PUT', '/api/prices', { prices: [{ id: product.id, price: values.price, wholesalePrice: values.wholesalePrice, franchisePrice: values.franchisePrice }] });
    priceLog.unshift({ time: new Date(), code: product.code, name: product.name, changes: changed.map(([key, label]) => `${label} ${currency(product[key])} → ${currency(values[key])}`) });
    priceLog.length = Math.min(priceLog.length, 15);
    await reloadAll();
    clearPriceForm();
    showToast(`${product.name} prices saved`);
  });
});

function renderPrices() {
  if (!isAdmin()) return;
  const inclusive = state.settings.taxMode === 'inclusive';
  $('#pricesSubtitle').textContent = `Find a product by code or name, enter its new retail, wholesale and franchise prices (${inclusive ? 'including' : 'before'} GST) and press Enter to save. Changes reach every outlet at once; past bills keep the prices they were made at.`;
  $('#priceNote').textContent = 'Net cost is shown with GST added at the product\'s rate, and margin compares the GST-inclusive price with that cost. Custom blends have no fixed cost, so recent bills are averaged.';
  if (priceProduct) { const fresh = products.find(product => product.id === priceProduct.id); if (!fresh) clearPriceForm(); else priceProduct = fresh; }
  $('#priceLog').innerHTML = priceLog.length ? priceLog.map(entry => `<div class="price-log-row"><span><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.code || '')} · ${entry.time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</small></span><span>${entry.changes.map(escapeHtml).join(' · ')}</span></div>`).join('') : '<div class="purchase-empty">Nothing saved yet in this session</div>';
  $('#priceRows').innerHTML = products.map(product => { const cost = costWithGst(product); return `<div class="plist-row" data-load-price="${product.id}" tabindex="0" role="button" aria-label="Load ${escapeHtml(product.name)}"><span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.code || '')} · ${escapeHtml(product.type)} · GST ${product.gstRate}%</small></span><span class="num" data-label="Cost incl. GST">${cost ? currency(cost) : '—'}</span><span class="num" data-label="Retail">${currency(product.price)}</span><span class="num" data-label="Wholesale">${currency(product.wholesalePrice)}</span><span class="num" data-label="Franchise">${currency(product.franchisePrice)}</span></div>`; }).join('') || '<div class="purchase-empty">No products yet.</div>';
}
const pickPriceRow = event => {
  const row = event.target.closest('[data-load-price]');
  if (!row || (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  loadPriceProduct(products.find(product => product.id === row.dataset.loadPrice));
  window.scrollTo({ top: 0, behavior: 'smooth' });
};
$('#priceRows').addEventListener('click', pickPriceRow);
$('#priceRows').addEventListener('keydown', pickPriceRow);

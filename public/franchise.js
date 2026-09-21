/* ---------- Franchise features: opening stock, transfers, outlets and users ---------- */
const outletLabel = id => id === state.hqOutletId ? 'HQ' : (state.outlets.find(outlet => outlet.id === id)?.code || `#${id}`);
let hqStockList = [];
let networkUsers = [];
let editingOutletId = null;
let editingUserId = null;
let adjustingMaterialId = null;
let royaltyOutletId = null;

function renderFranchiseViews() {
  renderTransfers();
  const visible = id => !$(`#${id}`).classList.contains('hidden');
  if (visible('openingView')) renderOpening();
  if (visible('networkView')) renderNetwork();
  if (visible('manufacturingView') && isAdmin()) renderManufacturing();
  if (visible('verificationView')) renderVerification();
}

/* ---------- Opening stock: saved line by line, with bulk import ---------- */
const openingValue = row => (Number(row.values.qty) || 0) * (Number(row.values.cost) || 0);
const openingSignature = row => JSON.stringify(row.values);
const OPENING_STATE = {
  saving: '<span class="row-state saving">Saving…</span>',
  saved: '<span class="row-state saved">✓ Saved</span>',
  failed: '<span class="row-state failed">Not saved</span>',
  unsaved: '<span class="row-state">Unsaved</span>'
};
// Why a row cannot be saved yet, or '' when it is fine.
function openingProblem(row) {
  const qty = row.values.qty, cost = row.values.cost;
  if (qty === '' || qty === undefined) return `Enter the opening quantity for ${row.item.name}`;
  if (!(Number(qty) >= 0)) return `${row.item.name}: the quantity must be 0 or more`;
  if (row.item.unit === 'pcs' && !Number.isInteger(Number(qty))) return `${row.item.name} is counted in pieces. Enter a whole number`;
  if (cost !== '' && cost !== undefined && !(Number(cost) >= 0)) return `${row.item.name}: the cost must be 0 or more`;
  return '';
}
const openingGrid = createLineGrid($('#openingGrid'), {
  pool: () => rawMaterials,
  accept(item) {
    if (!item.openingLocked) return true;
    showToast(`${item.name} already has stock movements. Use Adjust in the list below`);
    return false;
  },
  columns: [
    { type: 'index', label: '#', width: '40px' },
    { type: 'code', label: 'Item code', width: '170px' },
    { type: 'out', key: 'name', label: 'Description', width: 'minmax(140px, 1fr)', out: row => `<strong>${escapeHtml(row.item.name)}</strong><small>${row.item.type}${row.item.ean ? ` · ${escapeHtml(row.item.ean)}` : ''}</small>` },
    { type: 'out', key: 'unit', label: 'Unit', width: '44px', out: row => row.item.unit },
    { type: 'out', key: 'stock', label: 'Current', width: '84px', align: 'right', out: row => fmtQty(row.item.stock, row.item.unit) },
    { type: 'input', key: 'qty', label: 'Opening qty', width: '100px', align: 'right', placeholder: '0' },
    { type: 'input', key: 'cost', label: 'Cost / unit', width: '100px', align: 'right', placeholder: '0.00' },
    { type: 'out', key: 'value', label: 'Value', width: '90px', align: 'right', out: row => currency(openingValue(row)) },
    { type: 'out', key: 'state', label: 'Status', width: '84px', out: row => OPENING_STATE[row.saving ? 'saving' : row.saved ? 'saved' : row.failed ? 'failed' : 'unsaved'] },
    { type: 'actions', width: '34px' }
  ],
  defaults: item => item.openingQty !== null && !item.openingLocked ? { qty: String(item.openingQty), cost: item.openingCost === null ? '' : String(item.openingCost) } : { qty: '', cost: item.costPerMl > 0 ? String(item.costPerMl) : '' },
  onSelect(row) { row.saved = false; row.failed = false; },
  onEdit(row) { row.saved = false; row.failed = false; },
  // Enter on the cost cell saves that item at once and opens the next line.
  commitRow(row) {
    if (row.saved || row.saving) return true;
    const problem = openingProblem(row);
    if (problem) { showToast(problem); const input = row.el.querySelector('[data-key="qty"]'); input.focus(); input.select(); return false; }
    saveOpeningRows([row]);
    return true;
  },
  onChange(grid) { $('#openingTotal').textContent = currency(round2(grid.itemRows().reduce((sum, row) => sum + openingValue(row), 0))); renderOpeningLists(); },
  fkeys: {
    F3: grid => grid.deleteActive(),
    F6: () => $('#saveOpening').click(),
    F12: grid => { if (!grid.itemRows().some(row => !row.saved) || confirm('Clear the unsaved rows on this sheet?')) grid.clear(); }
  }
});
let openingGridOutlet = null;
// Under the sheet: items saved earlier (editable) and items whose opening stock is locked.
function renderOpeningLists() {
  if (!$('#openingSaved')) return;
  const onSheet = new Set(openingGrid.itemRows().map(row => row.item.id));
  const saved = rawMaterials.filter(material => !material.openingLocked && material.openingQty !== null && !onSheet.has(material.id));
  const locked = rawMaterials.filter(material => material.openingLocked);
  const savedHtml = saved.map(material => `<div class="locked-row saved-row"><span><strong>${escapeHtml(material.name)}</strong><small>${escapeHtml(material.code || '')} · ${material.type}${material.openingDate ? ` · ${formatKey(material.openingDate)}` : ''}</small></span><span class="num" data-label="Opening">${fmtQty(material.openingQty, material.unit)} at ${currency(material.openingCost || 0)}<small>${currency(round2(material.openingQty * (material.openingCost || 0)))}</small></span><span class="row-actions"><button class="link-button accent" data-edit-opening="${material.id}">Edit</button></span></div>`).join('');
  const lockedHtml = locked.map(material => `<div class="locked-row"><span><strong>${escapeHtml(material.name)}</strong><small>${escapeHtml(material.code || '')} · ${material.type}</small></span><span class="num" data-label="Current stock">${fmtQty(material.stock, material.unit)}</span><span class="row-actions"><span class="status-badge status-partial">Locked</span><button class="link-button" data-adjust="${material.id}">Adjust</button></span></div>`).join('');
  $('#openingSavedHead').textContent = `Saved opening stock (${saved.length})`;
  $('#openingSavedBox').classList.toggle('hidden', !saved.length);
  $('#openingLocked').classList.toggle('hidden', !locked.length);
  if ($('#openingSaved').innerHTML !== savedHtml) $('#openingSaved').innerHTML = savedHtml;
  if ($('#openingRows').innerHTML !== lockedHtml) $('#openingRows').innerHTML = lockedHtml;
}
function renderOpening() {
  $('#openingSubtitle').textContent = `Enter the starting quantity and cost of each item for ${state.outlet.name}, then press Save. The sheet then clears for your next entry. Once an item has purchases, transfers or sales, change its stock with an adjustment instead.`;
  if (!$('#openingDate').value) $('#openingDate').value = todayKey();
  if (openingGridOutlet !== state.outlet.id) { openingGridOutlet = state.outlet.id; openingGrid.clear(); }
  else openingGrid.refreshAll();
  renderOpeningLists();
}
// Bring a saved item back onto the sheet to change it.
$('#openingSaved').addEventListener('click', event => {
  const button = event.target.closest('[data-edit-opening]');
  if (!button) return;
  const material = findMaterial(button.dataset.editOpening), row = openingGrid.rows.find(entry => !entry.item);
  if (!material || !row) return;
  openingGrid.choose(row, material);
  openingGrid.refreshAll();
});
// Saves the given rows in one request. The screen stays usable while it runs.
async function saveOpeningRows(rows, quiet = false) {
  const asOf = $('#openingDate').value || todayKey();
  const sent = rows.map(row => ({ row, signature: openingSignature(row), qty: Number(row.values.qty), cost: Number(row.values.cost || 0) }));
  sent.forEach(({ row }) => { row.saving = true; row.failed = false; });
  openingGrid.refreshAll();
  try {
    await api('POST', '/api/opening-stock', { asOf, items: sent.map(({ row, qty, cost }) => ({ materialId: row.item.id, qty, costPerMl: cost })) });
    sent.forEach(({ row, signature, qty, cost }) => {
      row.saving = false; row.saved = openingSignature(row) === signature;
      const material = findMaterial(row.item.id);
      if (material) Object.assign(material, { stock: qty, costPerMl: cost, openingQty: qty, openingCost: cost, openingDate: asOf });
    });
    if (!quiet) showToast(sent.length === 1 ? `${sent[0].row.item.name} saved` : `Opening stock saved for ${sent.length} items`);
  } catch (error) {
    sent.forEach(({ row }) => { row.saving = false; row.saved = false; row.failed = true; openingGrid.flash(row); });
    showToast(error.message);
  }
  networkCache = null;
  openingGrid.refreshAll(); renderInventory(); renderSummary();
  if (!$('#openingView').classList.contains('hidden')) renderOpening();
}
// Save: store everything on the sheet, then open a fresh, empty sheet for the next entry.
$('#saveOpening').addEventListener('click', () => {
  submitting($('#saveOpening'), async () => {
    const rows = openingGrid.itemRows();
    if (!rows.length) { showToast('Add at least one item and its quantity'); openingGrid.focusNew(); return; }
    const bad = rows.find(row => !row.saved && openingProblem(row));
    if (bad) { showToast(openingProblem(bad)); openingGrid.flash(bad); return; }
    const pending = rows.filter(row => !row.saved && !row.saving);
    if (pending.length) await saveOpeningRows(pending, true);
    for (let wait = 0; wait < 100 && rows.some(row => row.saving); wait++) await new Promise(resolve => setTimeout(resolve, 50));
    const failed = rows.find(row => !row.saved);
    if (failed) { if (failed.failed) openingGrid.flash(failed); return; }
    const value = round2(rows.reduce((sum, row) => sum + openingValue(row), 0));
    openingGrid.clear();
    renderOpeningLists();
    openingGrid.focusNew();
    showToast(`Opening stock saved: ${rows.length} item${rows.length === 1 ? '' : 's'}, ${currency(value)}. Ready for the next entry`);
  });
});

/* ----- Bulk import from Excel / CSV ----- */
const IMPORT_HEADERS = {
  ean: ['ean', 'ean code', 'ean / barcode', 'barcode', 'bar code', 'upc'],
  code: ['item code', 'code', 'sku', 'item id'],
  name: ['item name', 'name', 'description', 'item', 'material', 'product'],
  qty: ['opening quantity', 'opening qty', 'quantity', 'qty', 'stock', 'opening stock', 'opening'],
  cost: ['cost per unit', 'cost / unit', 'unit cost', 'cost', 'rate', 'price', 'cost per ml']
};
const importLabel = text => String(text).toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
function findImportColumns(table) {
  let best = null;
  table.slice(0, 15).forEach((row, index) => {
    const map = {}, used = new Set(), labels = row.map(importLabel);
    Object.entries(IMPORT_HEADERS).forEach(([field, names]) => { const at = labels.findIndex((label, i) => !used.has(i) && names.includes(label)); if (at >= 0) { map[field] = at; used.add(at); } });
    const fuzzy = { ean: /ean|barcode/, code: /code/, qty: /qty|quantity/, cost: /cost|rate/, name: /name|description/ };
    Object.entries(fuzzy).forEach(([field, pattern]) => { if (map[field] === undefined) { const at = labels.findIndex((label, i) => !used.has(i) && pattern.test(label)); if (at >= 0) { map[field] = at; used.add(at); } } });
    const score = Object.keys(map).length;
    if (map.qty !== undefined && (map.code !== undefined || map.ean !== undefined || map.name !== undefined) && (!best || score > best.score)) best = { row: index, map, score };
  });
  return best;
}
const importNumber = text => { const clean = String(text).replace(/[₹,\s]/g, ''); return clean === '' ? null : Number(clean); };
// Turns the spreadsheet into one verdict per row. Only items that exist and are not locked can be imported.
function planOpeningImport(table) {
  const found = findImportColumns(table);
  if (!found) throw new Error('Could not find the columns. The sheet needs an Item code (or EAN, or Item name) column and an Opening quantity column. Download the template to see the layout.');
  const { map } = found, cell = (row, field) => map[field] === undefined ? '' : String(row[map[field]] ?? '').trim();
  const byCode = new Map(rawMaterials.map(material => [String(material.code || '').toUpperCase(), material]));
  const byEan = new Map(rawMaterials.filter(material => material.ean).map(material => [material.ean, material]));
  const byName = new Map(rawMaterials.map(material => [material.name.toLowerCase(), material]));
  const seen = new Map(), plan = [];
  table.slice(found.row + 1).forEach((row, offset) => {
    if (!row.some(value => String(value ?? '').trim() !== '')) return;
    const line = found.row + offset + 2;
    const entry = { line, code: cell(row, 'code'), ean: cell(row, 'ean'), name: cell(row, 'name'), qtyText: cell(row, 'qty'), costText: cell(row, 'cost'), status: 'ok', note: '' };
    const byCodeHit = entry.code && byCode.get(entry.code.toUpperCase()), byEanHit = entry.ean && byEan.get(entry.ean), byNameHit = entry.name && byName.get(entry.name.toLowerCase());
    entry.item = byCodeHit || byEanHit || byNameHit || null;
    const fail = note => { entry.status = 'error'; entry.note = note; };
    if (entry.qtyText === '' && entry.costText === '') { entry.status = 'skip'; entry.note = 'No quantity entered'; }
    else if (!entry.item) fail(`No item matches ${entry.code || entry.ean || entry.name || 'this row'}`);
    else if (byCodeHit && byEanHit && byCodeHit !== byEanHit) fail('The code and the barcode belong to different items');
    else if (entry.item.openingLocked) fail('Has stock movements. Use Adjust instead');
    else {
      const qty = importNumber(entry.qtyText), cost = importNumber(entry.costText);
      if (qty === null) fail('Quantity is missing');
      else if (!Number.isFinite(qty) || qty < 0) fail('Quantity must be a number, 0 or more');
      else if (entry.item.unit === 'pcs' && !Number.isInteger(qty)) fail('Counted in pieces: use a whole number');
      else if (cost !== null && (!Number.isFinite(cost) || cost < 0)) fail('Cost must be a number, 0 or more');
      else if (seen.has(entry.item.id)) fail(`Repeats row ${seen.get(entry.item.id)}`);
      else {
        entry.qty = qty;
        entry.cost = cost === null ? (entry.item.costPerMl > 0 ? entry.item.costPerMl : 0) : cost;
        entry.costAssumed = cost === null;
        seen.set(entry.item.id, line);
        if (entry.item.openingQty !== null) entry.note = 'Replaces the saved opening quantity';
      }
    }
    plan.push(entry);
  });
  return plan;
}
let importPlan = [];
function showImportPreview(fileName, plan) {
  importPlan = plan;
  const good = plan.filter(entry => entry.status === 'ok'), bad = plan.filter(entry => entry.status === 'error'), skipped = plan.filter(entry => entry.status === 'skip');
  const value = round2(good.reduce((sum, entry) => sum + entry.qty * entry.cost, 0));
  $('#importSub').textContent = fileName;
  $('#importBody').innerHTML = `<div class="kpi-grid import-kpis"><div class="kpi"><span class="kpi-label">Ready to import</span><strong>${good.length}</strong><span class="kpi-note">${currency(value)} opening value</span></div><div class="kpi"><span class="kpi-label">Need attention</span><strong class="${bad.length ? 'due-text' : ''}">${bad.length}</strong><span class="kpi-note">will be left out</span></div><div class="kpi"><span class="kpi-label">Skipped</span><strong>${skipped.length}</strong><span class="kpi-note">no quantity entered</span></div></div>
    <div class="table-scroll import-scroll"><table class="report-table"><thead><tr><th>Row</th><th>Item</th><th class="num">Quantity</th><th class="num">Cost / unit</th><th class="num">Value</th><th>Result</th></tr></thead><tbody>${plan.map(entry => `<tr class="import-${entry.status}"><td>${entry.line}</td><td>${entry.item ? `${escapeHtml(entry.item.name)}<small>${escapeHtml(entry.item.code || '')}${entry.item.ean ? ' · ' + escapeHtml(entry.item.ean) : ''}</small>` : escapeHtml(entry.code || entry.ean || entry.name || '—')}</td><td class="num">${entry.status === 'ok' ? fmtQty(entry.qty, entry.item.unit) : escapeHtml(entry.qtyText || '—')}</td><td class="num">${entry.status === 'ok' ? `${currency(entry.cost)}${entry.costAssumed ? '<small>current cost</small>' : ''}` : escapeHtml(entry.costText || '—')}</td><td class="num">${entry.status === 'ok' ? currency(round2(entry.qty * entry.cost)) : '—'}</td><td>${entry.status === 'ok' ? `<span class="status-badge status-paid">Ready</span>${entry.note ? `<small>${entry.note}</small>` : ''}` : entry.status === 'skip' ? `<span class="muted-text">${entry.note}</span>` : `<span class="status-badge status-unpaid">Problem</span><small>${escapeHtml(entry.note)}</small>`}</td></tr>`).join('')}</tbody></table></div>
    ${plan.length ? '' : '<p class="report-empty">The sheet has no data rows.</p>'}`;
  $('#confirmImport').textContent = good.length ? `Import ${good.length} item${good.length === 1 ? '' : 's'}` : 'Nothing to import';
  $('#confirmImport').disabled = !good.length;
  $('#importModal').classList.remove('hidden');
}
$('#openingImport').addEventListener('click', () => $('#openingFile').click());
$('#openingFile').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try { showImportPreview(file.name, planOpeningImport(await readSpreadsheet(file))); }
  catch (error) { showToast(error.message); }
});
$('#closeImport').addEventListener('click', () => closeModal('#importModal'));
$('#cancelImport').addEventListener('click', () => closeModal('#importModal'));
$('#confirmImport').addEventListener('click', () => {
  submitting($('#confirmImport'), async () => {
    const good = importPlan.filter(entry => entry.status === 'ok');
    if (!good.length) return;
    await api('POST', '/api/opening-stock', { asOf: $('#openingDate').value || todayKey(), items: good.map(entry => ({ materialId: entry.item.id, qty: entry.qty, costPerMl: entry.cost })) });
    closeModal('#importModal');
    await reloadAll();
    showToast(`Imported opening stock for ${good.length} item${good.length === 1 ? '' : 's'}`);
  });
});
function openingTemplateRows() {
  return [['Item code', 'EAN / barcode', 'Item name', 'Unit', 'Opening quantity', 'Cost per unit'],
    ...rawMaterials.filter(material => !material.openingLocked).map(material => [material.code || '', material.ean || '', material.name, material.unit, material.openingQty ?? '', material.openingCost ?? ''])];
}
$('#openingTemplateXlsx').addEventListener('click', () => downloadXlsx('opening-stock-template.xlsx', openingTemplateRows(), { widths: [14, 18, 32, 8, 18, 16], sheet: 'Opening stock' }));
$('#openingTemplateCsv').addEventListener('click', () => downloadCsv('opening-stock-template.csv', openingTemplateRows()));
$('#openingReportLink').addEventListener('click', () => { reportTab = 'opening'; switchView('reports'); });

/* ---------- Stock adjustment ---------- */
$('#openingRows').addEventListener('click', event => {
  const button = event.target.closest('[data-adjust]');
  if (!button) return;
  adjustingMaterialId = button.dataset.adjust;
  const material = findMaterial(adjustingMaterialId);
  $('#adjustTitle').textContent = `Adjust ${material.name}`;
  $('#adjustHelp').textContent = `Currently ${fmtQty(material.stock, material.unit)} in stock. Every adjustment is recorded with your reason.`;
  $('#adjustUnit').textContent = material.unit; $('#adjustDelta').step = material.unit === 'pcs' ? '1' : '0.01';
  $('#adjustDelta').value = ''; $('#adjustReason').value = '';
  setFieldError('adjustDelta', ''); setFieldError('adjustReason', '');
  $('#adjustModal').classList.remove('hidden');
  $('#adjustDelta').focus();
});
$('#closeAdjust').addEventListener('click', () => closeModal('#adjustModal'));
['adjustDelta', 'adjustReason'].forEach(id => $(`#${id}`).addEventListener('input', () => setFieldError(id, '')));
$('#adjustForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#adjustForm button[type="submit"]'), async () => {
    const delta = Number($('#adjustDelta').value), reason = $('#adjustReason').value.trim();
    const material = findMaterial(adjustingMaterialId);
    setFieldError('adjustDelta', !delta || !Number.isFinite(delta) ? 'Enter a quantity to add or remove' : material.unit === 'pcs' && !Number.isInteger(delta) ? 'Use a whole number of pieces' : delta < 0 && -delta > material.stock ? `Only ${fmtQty(material.stock, material.unit)} in stock` : '');
    setFieldError('adjustReason', reason ? '' : 'Give a reason for the adjustment');
    if ($('#adjustForm .customer-input.invalid')) { $('#adjustForm .customer-input.invalid input').focus(); return; }
    await api('POST', '/api/stock-adjustments', { materialId: adjustingMaterialId, delta, reason });
    closeModal('#adjustModal');
    await reloadAll();
    showToast(`${material.name} stock adjusted`);
  });
});

/* ---------- Transfers ---------- */
const TRANSFER_STATUS = { in_transit: ['In transit', 'status-partial'], received: ['Received', 'status-paid'], cancelled: ['Cancelled', 'status-unpaid'] };
function renderTransfers() {
  const incoming = state.transfers.filter(transfer => transfer.status === 'in_transit' && (isAdmin() || transfer.toOutlet === state.outlet.id)).length;
  $('#navTransferCount').textContent = incoming;
  $('#navTransferCount').classList.toggle('hidden', !incoming);
  $('#transfersSubtitle').textContent = isAdmin() ? 'Dispatch stock from HQ to franchise outlets. It leaves HQ immediately and reaches the outlet when they confirm receipt.' : 'Stock HQ has sent to your outlet. Confirm receipt to add it to your stock.';
  $('#transferRows').innerHTML = state.transfers.length ? state.transfers.map(transfer => {
    const [label, css] = TRANSFER_STATUS[transfer.status];
    const canReceive = transfer.status === 'in_transit' && (isAdmin() || transfer.toOutlet === state.outlet.id);
    return `<div class="transfer-row"><span><strong>${transfer.number}</strong><small>${formatStamp(transfer.date)}</small></span><span data-label="Route">${outletLabel(transfer.fromOutlet)} → ${outletLabel(transfer.toOutlet)}${transfer.note ? `<small>${escapeHtml(transfer.note)}</small>` : ''}</span><span data-label="Materials">${transfer.lines.length} material${transfer.lines.length === 1 ? '' : 's'}<small>${transfer.lines.map(line => `${escapeHtml(line.name)} ${fmtQty(line.qty, line.unit || 'ml')}`).join(' · ')}</small></span><span class="num" data-label="Value">${currency(transfer.value)}</span><span class="row-actions" data-label="Status"><span class="status-badge ${css}">${label}</span>${canReceive ? `<button class="link-button accent" data-receive-transfer="${transfer.id}">Receive</button>` : ''}${isAdmin() && transfer.status === 'in_transit' ? `<button class="link-button" data-cancel-transfer="${transfer.id}">Cancel</button>` : ''}</span></div>`;
  }).join('') : '<div class="purchase-empty">No transfers yet</div>';
}
$('#transferRows').addEventListener('click', event => {
  const receive = event.target.closest('[data-receive-transfer]'), cancel = event.target.closest('[data-cancel-transfer]');
  const button = receive || cancel;
  if (!button) return;
  const transfer = state.transfers.find(entry => entry.id === (receive ? receive.dataset.receiveTransfer : cancel.dataset.cancelTransfer));
  if (cancel && !confirm(`Cancel ${transfer.number}? The stock goes back to HQ.`)) return;
  submitting(button, async () => {
    await api('POST', `/api/transfers/${transfer.id}/${receive ? 'receive' : 'cancel'}`, {});
    await reloadAll();
    showToast(receive ? `${transfer.number} received. Stock added` : `${transfer.number} cancelled`);
  });
});

function transferLineTemplate() {
  return `<div class="transfer-line"><select class="transfer-material" aria-label="Material">${hqStockList.map(material => `<option value="${material.id}">${escapeHtml(material.name)} · ${fmtQty(material.stock, material.unit)} at HQ</option>`).join('')}</select><div class="input-with-unit"><input class="transfer-qty" type="number" min="0.01" step="0.01" placeholder="0.00" aria-label="Quantity" /><span class="transfer-unit">ml</span></div><div class="input-with-unit"><span>₹</span><input class="transfer-rate" type="number" min="0" step="0.01" placeholder="0.00" aria-label="Rate per ml" /></div><strong class="transfer-value">₹0</strong><button class="remove-line" type="button" data-remove-transfer-line aria-label="Remove material">×</button></div>`;
}
function fillTransferRate(line) {
  const material = hqStockList.find(entry => entry.id === line.querySelector('.transfer-material').value);
  line.querySelector('.transfer-rate').value = material ? material.costPerMl : '';
  const unit = material ? material.unit : 'ml';
  line.querySelector('.transfer-unit').textContent = unit;
  line.querySelector('.transfer-qty').step = unit === 'pcs' ? '1' : '0.01';
}
function addTransferLine() {
  $('#transferLines').insertAdjacentHTML('beforeend', transferLineTemplate());
  fillTransferRate($('#transferLines .transfer-line:last-child'));
  updateTransferTotal();
}
function updateTransferTotal() {
  let total = 0;
  $$('.transfer-line').forEach(line => {
    const value = round2((Number(line.querySelector('.transfer-qty').value) || 0) * (Number(line.querySelector('.transfer-rate').value) || 0));
    line.querySelector('.transfer-value').textContent = currency(value);
    total += value;
  });
  $('#transferTotal').textContent = currency(total);
}
$('#newTransferButton').addEventListener('click', async () => {
  const targets = state.outlets.filter(outlet => outlet.type === 'franchise' && outlet.active);
  if (!targets.length) { showToast('Add a franchise outlet first under Outlets & users'); return; }
  try { hqStockList = await api('GET', '/api/hq-stock'); } catch (error) { showToast(error.message); return; }
  $('#transferTo').innerHTML = targets.map(outlet => `<option value="${outlet.id}">${escapeHtml(outlet.name)} (${outlet.code})</option>`).join('');
  $('#transferNote').value = ''; $('#transferLines').innerHTML = ''; $('#transferError').textContent = '';
  addTransferLine();
  $('#transferModal').classList.remove('hidden');
});
$('#closeTransfer').addEventListener('click', () => closeModal('#transferModal'));
$('#addTransferLine').addEventListener('click', addTransferLine);
$('#transferLines').addEventListener('input', () => { $('#transferError').textContent = ''; updateTransferTotal(); });
$('#transferLines').addEventListener('change', event => { if (event.target.classList.contains('transfer-material')) fillTransferRate(event.target.closest('.transfer-line')); updateTransferTotal(); });
$('#transferLines').addEventListener('click', event => { const remove = event.target.closest('[data-remove-transfer-line]'); if (remove && $$('.transfer-line').length > 1) { remove.closest('.transfer-line').remove(); updateTransferTotal(); } });
$('#transferForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#transferSubmit'), async () => {
    const lines = $$('.transfer-line').map(line => ({ materialId: line.querySelector('.transfer-material').value, qty: Number(line.querySelector('.transfer-qty').value), rate: Number(line.querySelector('.transfer-rate').value || 0) }));
    const problem = lines.some(line => !(line.qty > 0)) ? 'Enter a quantity for every material'
      : new Set(lines.map(line => line.materialId)).size !== lines.length ? 'Each material can appear only once'
      : lines.some(line => hqStockList.find(entry => entry.id === line.materialId).unit === 'pcs' && !Number.isInteger(line.qty)) ? 'Pieces must be whole numbers'
      : lines.some(line => line.qty > hqStockList.find(entry => entry.id === line.materialId).stock) ? 'One of the quantities is more than HQ has in stock'
      : lines.some(line => !(line.rate >= 0)) ? 'Rates must be 0 or more' : '';
    $('#transferError').textContent = problem;
    if (problem) return;
    const transfer = await api('POST', '/api/transfers', { toOutletId: Number($('#transferTo').value), note: $('#transferNote').value, lines });
    closeModal('#transferModal');
    await reloadAll();
    showToast(`${transfer.number} dispatched · ${currency(transfer.value)}`);
  });
});

/* ---------- Outlets and users (HQ) ---------- */
async function loadUsers() {
  try { networkUsers = await api('GET', '/api/users'); } catch { networkUsers = []; }
  renderNetwork();
}
function renderNetwork() {
  if (!isAdmin()) return;
  $('#outletRows').innerHTML = state.outlets.map(outlet => `<div class="outlet-row"><span><strong>${escapeHtml(outlet.name)}</strong><small>${outlet.code} · ${outlet.type === 'hq' ? 'Head office' : 'Franchise'}${outlet.address ? ` · ${escapeHtml(outlet.address)}` : ''}</small></span><span data-label="GSTIN">${outlet.gstin || '—'}</span><span class="num" data-label="Royalty">${outlet.type === 'hq' ? '—' : `${outlet.royaltyPct}%`}</span><span data-label="Status"><span class="status-badge ${outlet.active ? 'status-paid' : 'status-unpaid'}">${outlet.active ? 'Active' : 'Inactive'}</span></span><span class="row-actions"><button class="link-button accent" data-switch-outlet="${outlet.id}">Work as</button><button class="link-button" data-edit-outlet="${outlet.id}">Edit</button></span></div>`).join('');
  $('#userRows').innerHTML = networkUsers.length ? networkUsers.map(user => `<div class="user-row"><span><strong>${escapeHtml(user.name)}</strong><small>@${escapeHtml(user.username)}</small></span><span data-label="Role">${{ admin: 'HQ administrator', manager: 'Outlet manager', biller: 'Biller' }[user.role] || user.role}</span><span data-label="Outlet">${user.outletId ? escapeHtml(outletLabel(user.outletId)) : 'All outlets'}</span><span data-label="Status"><span class="status-badge ${user.active ? 'status-paid' : 'status-unpaid'}">${user.active ? 'Active' : 'Disabled'}</span></span><span class="row-actions"><button class="link-button" data-edit-user="${user.id}">Edit</button></span></div>`).join('') : '<div class="purchase-empty">Loading users…</div>';
}
$('#networkView').addEventListener('click', event => {
  const switcher = event.target.closest('[data-switch-outlet]'), editOutlet = event.target.closest('[data-edit-outlet]'), editUser = event.target.closest('[data-edit-user]');
  if (switcher) switchOutlet(switcher.dataset.switchOutlet).then(() => switchView('billing'));
  if (editOutlet) openOutletModal(Number(editOutlet.dataset.editOutlet));
  if (editUser) openUserModal(Number(editUser.dataset.editUser));
});

function openOutletModal(id = null) {
  editingOutletId = id;
  const outlet = id ? state.outlets.find(entry => entry.id === id) : null;
  ['outletCode', 'outletName', 'outletGstin', 'outletRoyalty'].forEach(field => setFieldError(field, ''));
  $('#outletForm').reset();
  $('#outletModalTitle').textContent = outlet ? `Edit ${outlet.name}` : 'Add outlet';
  $('#outletSubmit').textContent = outlet ? 'Save changes' : 'Add outlet';
  $('#outletCodeGroup').classList.toggle('hidden', Boolean(outlet));
  $('#outletActiveRow').classList.toggle('hidden', !outlet || outlet.type === 'hq');
  $('#outletRoyalty').closest('.field-group').classList.toggle('hidden', Boolean(outlet) && outlet.type === 'hq');
  if (outlet) {
    $('#outletName').value = outlet.name; $('#outletGstin').value = outlet.gstin; $('#outletRoyalty').value = outlet.royaltyPct;
    $('#outletPhone').value = outlet.phone; $('#outletAddress').value = outlet.address; $('#outletActive').checked = outlet.active;
  }
  $('#outletModal').classList.remove('hidden');
  (outlet ? $('#outletName') : $('#outletCode')).focus();
}
$('#addOutletButton').addEventListener('click', () => openOutletModal());
$('#closeOutlet').addEventListener('click', () => closeModal('#outletModal'));
['outletCode', 'outletName', 'outletGstin', 'outletRoyalty'].forEach(id => $(`#${id}`).addEventListener('input', () => setFieldError(id, '')));
$('#outletForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#outletSubmit'), async () => {
    const code = $('#outletCode').value.trim().toUpperCase(), name = $('#outletName').value.trim(), gstin = $('#outletGstin').value.trim().toUpperCase();
    const royaltyPct = Number($('#outletRoyalty').value || 0);
    const creating = editingOutletId === null;
    setFieldError('outletCode', creating && !/^[A-Z0-9]{2,8}$/.test(code) ? 'Use 2 to 8 letters or digits' : creating && state.outlets.some(outlet => outlet.code === code) ? 'That code is already used' : '');
    setFieldError('outletName', name ? '' : 'Outlet name is required');
    setFieldError('outletGstin', gstin && !isValidGstin(gstin) ? 'Enter a valid 15-character GSTIN' : '');
    setFieldError('outletRoyalty', !(royaltyPct >= 0 && royaltyPct <= 100) ? 'Enter a percentage between 0 and 100' : '');
    if ($('#outletForm .customer-input.invalid')) { $('#outletForm .customer-input.invalid input').focus(); return; }
    const payload = { code, name, gstin, royaltyPct, phone: $('#outletPhone').value, address: $('#outletAddress').value, active: $('#outletActive').checked };
    if (creating) await api('POST', '/api/outlets', payload); else await api('PUT', `/api/outlets/${editingOutletId}`, payload);
    closeModal('#outletModal');
    await reloadAll();
    showToast(creating ? `${name} added. Create a manager login for it next` : 'Outlet saved');
  });
});

function syncUserRole() { $('#userOutletGroup').classList.toggle('hidden', $('#userRoleSelect').value === 'admin'); }
function openUserModal(id = null) {
  editingUserId = id;
  const user = id ? networkUsers.find(entry => entry.id === id) : null;
  ['userUsername', 'userFullName', 'userPassword'].forEach(field => setFieldError(field, ''));
  $('#userForm').reset();
  const franchises = state.outlets.filter(outlet => outlet.active || (user && user.outletId === outlet.id));
  $('#userOutlet').innerHTML = franchises.map(outlet => `<option value="${outlet.id}">${escapeHtml(outlet.name)} (${outlet.code})</option>`).join('');
  $('#userModalTitle').textContent = user ? `Edit ${user.name}` : 'Add user';
  $('#userSubmit').textContent = user ? 'Save changes' : 'Add user';
  $('#userUsernameGroup').classList.toggle('hidden', Boolean(user));
  $('#userPasswordLabel').innerHTML = user ? 'New password <span class="optional">(leave blank to keep the current one)</span>' : 'Password <span class="req">*</span> <span class="optional">(8+ characters)</span>';
  $('#userActiveRow').classList.toggle('hidden', !user);
  if (user) {
    $('#userFullName').value = user.name; $('#userRoleSelect').value = user.role; $('#userActive').checked = user.active;
    if (user.outletId) $('#userOutlet').value = String(user.outletId);
  }
  syncUserRole();
  $('#userModal').classList.remove('hidden');
  (user ? $('#userFullName') : $('#userUsername')).focus();
}
$('#addUserButton').addEventListener('click', () => openUserModal());
$('#closeUser').addEventListener('click', () => closeModal('#userModal'));
$('#userRoleSelect').addEventListener('change', syncUserRole);
['userUsername', 'userFullName', 'userPassword'].forEach(id => $(`#${id}`).addEventListener('input', () => setFieldError(id, '')));
$('#userForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#userSubmit'), async () => {
    const creating = editingUserId === null;
    const username = $('#userUsername').value.trim().toLowerCase(), name = $('#userFullName').value.trim(), password = $('#userPassword').value;
    setFieldError('userUsername', creating && !/^[a-z0-9._-]{3,30}$/.test(username) ? 'Use 3 to 30 letters, digits, dots or dashes' : '');
    setFieldError('userFullName', name ? '' : 'Name is required');
    setFieldError('userPassword', (creating || password) && password.length < 8 ? 'Use at least 8 characters' : '');
    if ($('#userForm .customer-input.invalid')) { $('#userForm .customer-input.invalid input').focus(); return; }
    const role = $('#userRoleSelect').value;
    const payload = { username, name, role, outletId: role !== 'admin' ? Number($('#userOutlet').value) : null, password, active: $('#userActive').checked };
    if (creating) await api('POST', '/api/users', payload); else await api('PUT', `/api/users/${editingUserId}`, payload);
    closeModal('#userModal');
    await loadUsers();
    showToast(creating ? `${name} can now sign in as @${username}` : 'User saved');
  });
});

/* ---------- Royalty payments (used from the Royalty report) ---------- */
function openRoyaltyModal(outletId, due) {
  royaltyOutletId = outletId;
  $('#royaltyHelp').textContent = `${state.outlets.find(outlet => outlet.id === outletId).name} · outstanding ${currency(due)}`;
  $('#royaltyAmount').value = due > 0 ? due : ''; $('#royaltyDate').value = todayKey(); $('#royaltyNote').value = '';
  setFieldError('royaltyAmount', '');
  $('#royaltyModal').classList.remove('hidden');
  $('#royaltyAmount').focus();
}
$('#closeRoyalty').addEventListener('click', () => closeModal('#royaltyModal'));
$('#royaltyAmount').addEventListener('input', () => setFieldError('royaltyAmount', ''));
$('#royaltyForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#royaltyForm button[type="submit"]'), async () => {
    const amount = round2(Number($('#royaltyAmount').value));
    setFieldError('royaltyAmount', amount > 0 ? '' : 'Enter an amount greater than 0');
    if (!(amount > 0)) return;
    await api('POST', '/api/royalty-payments', { outletId: royaltyOutletId, amount, date: $('#royaltyDate').value, mode: $('#royaltyMode').value, note: $('#royaltyNote').value });
    closeModal('#royaltyModal');
    networkCache = null;
    renderReports();
    showToast(`${currency(amount)} royalty recorded`);
  });
});

/* ---------- Manufacturing (HQ only): signature blends, R&D lab and production runs ---------- */
let mfg = { formulas: [], runs: [] };
let mfgTab = 'signature';
let editor = null;            // { kind, formulaId?, baseVersion? }: what the blend dialog is editing
let detailFormulaId = null;
let runSetup = null;          // { kind: 'batch' | 'sample' }
let promoteFormulaId = null;

const materialName = id => findMaterial(id)?.name || 'Unknown item';
const materialCost = id => findMaterial(id)?.costPerMl || 0;
const currentVersionOf = formula => formula.versions.find(entry => entry.version === formula.currentVersion) || formula.versions[formula.versions.length - 1];
const latestVersionOf = formula => formula.versions[formula.versions.length - 1];
// Cost of one finished bottle at the selected outlet's average material costs.
const bottleCost = version => round2(version.lines.reduce((sum, line) => sum + line.ml * materialCost(line.materialId), 0) + (version.pack ? version.pack.qty * materialCost(version.pack.materialId) : 0));
const blendSummary = version => version.lines.map(line => `${escapeHtml(materialName(line.materialId))} ${line.ml}ml`).join(' · ') + (version.pack ? ` · ${version.pack.qty} × ${escapeHtml(materialName(version.pack.materialId))}` : '');
const netPrice = (price, gstRate) => state.settings.taxMode === 'inclusive' ? round2(price / (1 + gstRate / 100)) : price;
const stars = rating => rating ? '★'.repeat(rating) + '☆'.repeat(5 - rating) : '—';
const STAGE = { idea: ['Idea', 'stock-pill-low'], testing: ['Testing', 'status-partial'], approved: ['Approved', 'status-paid'], launched: ['Launched', 'status-paid'], dropped: ['Dropped', 'status-returned'], active: ['Active', 'status-paid'], retired: ['Retired', 'status-returned'] };
const stagePill = status => `<span class="status-badge ${STAGE[status][1]}">${STAGE[status][0]}</span>`;
const visibleView = id => !$(`#${id}`).classList.contains('hidden');

async function loadManufacturing() {
  if (!isAdmin()) return;
  try { mfg = await api('GET', '/api/manufacturing'); } catch (error) { showToast(error.message); return; }
  renderManufacturing();
  if (detailFormulaId && visibleModal('#detailModal')) renderDetail();
}
const visibleModal = selector => !$(selector).classList.contains('hidden');

/* ---------- Lists ---------- */
function mfgTable(kind, headers, rows, empty) {
  return `<div class="purchase-table mfg-table"><div class="mfg-head ${kind}">${headers.map(label => `<span>${label}</span>`).join('')}</div><div class="mfg-rows">${rows.join('') || `<div class="purchase-empty">${empty}</div>`}</div></div><p class="report-footnote">Costs use the average cost of materials at ${escapeHtml(state.outlet.name)}. Switch outlet in the top bar to cost at another outlet.</p>`;
}
function signatureHtml() {
  const rows = mfg.formulas.filter(formula => formula.kind === 'signature').map(formula => {
    const version = currentVersionOf(formula), product = products.find(entry => entry.id === formula.productId);
    const cost = bottleCost(version), stockItem = product?.stockMaterialId ? findMaterial(product.stockMaterialId) : null;
    const net = product ? netPrice(product.price, product.gstRate) : 0;
    return `<div class="mfg-row sig"><span class="mfg-main"><strong>${escapeHtml(formula.name)}</strong><small>${product ? `Sold as ${escapeHtml(product.name)}` : 'Not linked to a product yet'}${formula.status === 'retired' ? ' · retired' : ''}</small></span><span data-label="Bottle">${version.unitMl}ml<small>version ${formula.currentVersion} of ${formula.versions.length}</small></span><span data-label="Ingredients" class="mfg-ingredients">${blendSummary(version)}</span><span data-label="Cost per bottle">${currency(cost)}${product ? `<small>${currency(product.price)} price · ${percent(net - cost, net)} margin</small>` : ''}</span><span data-label="Finished stock">${stockItem ? fmtQty(stockItem.stock, 'pcs') : '—'}</span><span class="row-actions"><button class="link-button accent" data-mfg-open="${formula.id}">Open</button><button class="link-button" data-mfg-produce="${formula.id}">Produce</button><button class="link-button" data-mfg-newversion="${formula.id}">New version</button></span></div>`;
  });
  return mfgTable('sig', ['Blend', 'Bottle', 'Ingredients', 'Cost per bottle', 'Finished stock', ''], rows, 'No signature blends yet. Use New blend to record the formula of a packed perfume.');
}
function rndHtml() {
  const rows = mfg.formulas.filter(formula => formula.kind === 'rnd').map(formula => {
    const latest = latestVersionOf(formula), cost = bottleCost(latest), net = formula.targetPrice ? netPrice(formula.targetPrice, 18) : 0;
    return `<div class="mfg-row rnd"><span class="mfg-main"><strong>${escapeHtml(formula.name)}</strong><small>${escapeHtml(formula.brief || 'No brief yet')}</small></span><span data-label="Stage">${stagePill(formula.status)}</span><span data-label="Trials">${formula.versions.length}<small>latest ${stars(latest.rating)}</small></span><span data-label="Cost per bottle">${currency(cost)}<small>${formula.targetPrice ? `${currency(formula.targetPrice)} target · ${percent(net - cost, net)} margin` : 'no target price'}</small></span><span data-label="Latest trial" class="mfg-ingredients">${blendSummary(latest)}</span><span class="row-actions"><button class="link-button accent" data-mfg-open="${formula.id}">Open</button><button class="link-button" data-mfg-newversion="${formula.id}">New trial</button><button class="link-button" data-mfg-sample="${formula.id}">Sample</button>${formula.status !== 'launched' ? `<button class="link-button" data-mfg-launch="${formula.id}">Launch</button>` : ''}</span></div>`;
  });
  return mfgTable('rnd', ['Project', 'Stage', 'Trials', 'Cost per bottle', 'Latest trial', ''], rows, 'No R&D projects yet. Use New R&D project to start trialling a fragrance.');
}
function runsHtml() {
  const rows = mfg.runs.map(run => `<div class="mfg-row run"><span class="mfg-main"><strong>${run.number}</strong><small>${formatKey(run.day)}</small></span><span data-label="Blend">${escapeHtml(run.formulaName)}<small>version ${run.version}${run.note ? ` · ${escapeHtml(run.note)}` : ''}</small></span><span data-label="Bottles">${run.units}<small>${run.kind === 'sample' ? 'R&amp;D sample' : 'Production'}</small></span><span data-label="Cost per bottle">${currency(run.unitCost)}</span><span data-label="Total cost">${currency(run.totalCost)}</span><span data-label="Outlet">${outletLabel(run.outletId)}</span><span class="row-actions"><button class="link-button" data-mfg-run-detail="${run.id}">Details</button></span></div>`);
  return mfgTable('run', ['Run', 'Blend', 'Bottles', 'Cost per bottle', 'Total cost', 'Outlet', ''], rows, 'No production runs yet. Use Production run to turn ingredients and bottles into finished perfume.');
}
function renderManufacturing() {
  if (!isAdmin()) return;
  $$('.mfg-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.mfgTab === mfgTab));
  $('#mfgPrimary').textContent = { signature: '＋ New blend', rnd: '＋ New R&D project', runs: '＋ Production run' }[mfgTab];
  $('#mfgSecondary').classList.toggle('hidden', mfgTab !== 'signature');
  $('#mfgSecondary').textContent = '＋ Production run';
  $('#mfgBody').innerHTML = { signature: signatureHtml, rnd: rndHtml, runs: runsHtml }[mfgTab]();
}
$$('.mfg-tab').forEach(tab => tab.addEventListener('click', () => { mfgTab = tab.dataset.mfgTab; renderManufacturing(); }));
$('#mfgPrimary').addEventListener('click', () => {
  if (mfgTab === 'runs') openRunModal({ kind: 'batch' });
  else openFormulaEditor({ kind: mfgTab === 'rnd' ? 'rnd' : 'signature' });
});
$('#mfgSecondary').addEventListener('click', () => openRunModal({ kind: 'batch' }));

/* ---------- Blend editor (new blend, new version, new trial) ---------- */
function blendLineTemplate(materialId = '', ml = '') {
  const options = rawMaterials.filter(material => material.unit === 'ml').map(material => `<option value="${material.id}" ${material.id === materialId ? 'selected' : ''}>${escapeHtml(material.name)}</option>`).join('');
  return `<div class="blend-line"><select class="blend-material" aria-label="Ingredient">${options}</select><div class="input-with-unit"><input class="blend-ml" type="number" min="0" step="0.01" value="${ml}" placeholder="0.00" aria-label="Amount in ml" /><span>ml</span></div><span class="num blend-share">—</span><span class="num blend-cost">₹0</span><button class="remove-line" type="button" data-remove-blend-line aria-label="Remove ingredient">×</button></div>`;
}
const blendLineValues = () => $$('.blend-line').map(row => ({ materialId: row.querySelector('.blend-material').value, ml: round2(Number(row.querySelector('.blend-ml').value) || 0) }));
function updateBlendTotals() {
  const lines = blendLineValues(), total = round2(lines.reduce((sum, line) => sum + line.ml, 0));
  $$('.blend-line').forEach((row, index) => {
    row.querySelector('.blend-share').textContent = total ? `${(lines[index].ml / total * 100).toFixed(1)}%` : '—';
    row.querySelector('.blend-cost').textContent = currency(round2(lines[index].ml * materialCost(lines[index].materialId)));
  });
  const ingredients = round2(lines.reduce((sum, line) => sum + line.ml * materialCost(line.materialId), 0));
  const packId = $('#formulaPack').value, packCost = packId ? round2((Number($('#formulaPackQty').value) || 1) * materialCost(packId)) : 0;
  const cost = round2(ingredients + packCost);
  $('#blendSummary').innerHTML = `<div><span>Bottle size</span><strong>${total.toFixed(2)}ml</strong></div><div><span>Ingredients</span><strong>${currency(ingredients)}</strong></div>${packCost ? `<div><span>Packaging</span><strong>${currency(packCost)}</strong></div>` : ''}<div class="return-refund"><span>Cost per bottle</span><strong>${currency(cost)}</strong></div><div><span>Cost per 100ml</span><strong>${total ? currency(round2(ingredients / total * 100)) : '—'}</strong></div>`;
}
function fillPackChoices(selected = '') {
  const pieces = rawMaterials.filter(material => material.unit === 'pcs' && material.type !== 'Packed product');
  $('#formulaPack').innerHTML = `<option value="">No packaging</option>${pieces.map(material => `<option value="${material.id}">${escapeHtml(material.name)}</option>`).join('')}`;
  $('#formulaPack').value = selected;
}
function openFormulaEditor(setup) {
  editor = setup;
  const formula = setup.formulaId ? mfg.formulas.find(entry => entry.id === setup.formulaId) : null;
  const kind = formula ? formula.kind : setup.kind;
  const base = formula ? (setup.baseVersion ? formula.versions.find(entry => entry.version === setup.baseVersion) : (kind === 'rnd' ? latestVersionOf(formula) : currentVersionOf(formula))) : null;
  $('#formulaForm').reset();
  ['formulaName', 'formulaError'].forEach(id => { const el = $(`#${id}`); if (el.tagName === 'SMALL') el.textContent = ''; });
  setFieldError('formulaName', '');
  $('#formulaError').textContent = '';
  $('#formulaLabel').textContent = kind === 'rnd' ? 'R&D LAB' : 'SIGNATURE BLEND';
  $('#formulaTitle').textContent = formula ? (kind === 'rnd' ? `New trial of ${formula.name}` : `New version of ${formula.name}`) : (kind === 'rnd' ? 'New R&D project' : 'New signature blend');
  $('#formulaHelp').textContent = formula ? 'Changes are saved as a new version; earlier versions are kept so you can go back.' : (kind === 'rnd' ? 'Describe what you are aiming for and record the first trial. Add more trials as you refine it.' : 'Record the exact ingredients for one finished bottle. The bottle size is the total of the ingredients.');
  $('#formulaSubmit').textContent = formula ? (kind === 'rnd' ? 'Save trial' : 'Save new version') : (kind === 'rnd' ? 'Create project' : 'Save blend');
  $('#formulaNameGroup').classList.toggle('hidden', Boolean(formula));
  $('#formulaProductGroup').classList.toggle('hidden', Boolean(formula) || kind !== 'signature');
  $('#formulaBriefGroup').classList.toggle('hidden', Boolean(formula) || kind !== 'rnd');
  $('#formulaRndGroup').classList.toggle('hidden', Boolean(formula) || kind !== 'rnd');
  const linked = new Set(mfg.formulas.filter(entry => entry.kind === 'signature' && entry.productId).map(entry => entry.productId));
  $('#formulaProduct').innerHTML = `<option value="">Link to a product later</option>${products.filter(product => !product.needsRecipe && !linked.has(product.id)).map(product => `<option value="${product.id}">${escapeHtml(product.name)}</option>`).join('')}`;
  $('#blendLines').innerHTML = base && base.lines.length ? base.lines.map(line => blendLineTemplate(line.materialId, line.ml)).join('') : blendLineTemplate();
  fillPackChoices(base && base.pack ? base.pack.materialId : '');
  $('#formulaPackQty').value = base && base.pack ? base.pack.qty : 1;
  if (base && setup.baseVersion) $('#formulaNotes').value = '';
  updateBlendTotals();
  $('#formulaModal').classList.remove('hidden');
  (formula ? $('.blend-ml') : $('#formulaName')).focus();
}
$('#addBlendLine').addEventListener('click', () => { $('#blendLines').insertAdjacentHTML('beforeend', blendLineTemplate()); updateBlendTotals(); });
$('#blendLines').addEventListener('input', () => { $('#formulaError').textContent = ''; updateBlendTotals(); });
$('#blendLines').addEventListener('change', updateBlendTotals);
$('#blendLines').addEventListener('click', event => { const remove = event.target.closest('[data-remove-blend-line]'); if (remove && $$('.blend-line').length > 1) { remove.closest('.blend-line').remove(); updateBlendTotals(); } });
$('#formulaPack').addEventListener('change', updateBlendTotals);
$('#formulaPackQty').addEventListener('input', updateBlendTotals);
$('#formulaName').addEventListener('input', () => setFieldError('formulaName', ''));
$('#closeFormula').addEventListener('click', () => closeModal('#formulaModal'));
$('#formulaForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#formulaSubmit'), async () => {
    const lines = blendLineValues().filter(line => line.ml > 0);
    const name = $('#formulaName').value.trim().replace(/\s+/g, ' ');
    const creating = !editor.formulaId;
    setFieldError('formulaName', creating && !name ? 'Give it a name' : '');
    $('#formulaError').textContent = !lines.length ? 'Add at least one ingredient with an amount' : new Set(lines.map(line => line.materialId)).size !== lines.length ? 'Each ingredient can be listed only once' : '';
    if ($('#formulaError').textContent || $('#formulaForm .customer-input.invalid')) return;
    const packId = $('#formulaPack').value;
    const body = { lines, pack: packId ? { materialId: packId, qty: Number($('#formulaPackQty').value) || 1 } : null, notes: $('#formulaNotes').value };
    let result;
    if (creating) result = await api('POST', '/api/formulas', { ...body, kind: editor.kind, name, productId: $('#formulaProduct').value, brief: $('#formulaBrief').value, status: $('#formulaStatus').value, targetPrice: $('#formulaTarget').value });
    else result = await api('POST', `/api/formulas/${editor.formulaId}/versions`, body);
    closeModal('#formulaModal');
    await loadManufacturing();
    showToast(creating ? `${result.name} saved` : `${result.name} · version ${result.currentVersion} saved`);
  });
});

/* ---------- Detail view: versions, notes, ratings ---------- */
function openDetail(id) { detailFormulaId = id; renderDetail(); $('#detailModal').classList.remove('hidden'); }
function versionCard(formula, entry) {
  const total = entry.unitMl, cost = bottleCost(entry), isCurrent = entry.version === formula.currentVersion, product = products.find(item => item.id === formula.productId);
  const rows = entry.lines.map(line => `<tr><td>${escapeHtml(materialName(line.materialId))}</td><td class="num">${line.ml}ml</td><td class="num">${(line.ml / total * 100).toFixed(1)}%</td><td class="num">${currency(round2(line.ml * materialCost(line.materialId)))}</td></tr>`).join('');
  const pack = entry.pack ? `<tr><td>${escapeHtml(materialName(entry.pack.materialId))} <small>packaging</small></td><td class="num">${entry.pack.qty} pcs</td><td class="num">—</td><td class="num">${currency(round2(entry.pack.qty * materialCost(entry.pack.materialId)))}</td></tr>` : '';
  const margin = product ? `${percent(netPrice(product.price, product.gstRate) - cost, netPrice(product.price, product.gstRate))} margin at ${currency(product.price)}` : formula.targetPrice ? `${percent(netPrice(formula.targetPrice, 18) - cost, netPrice(formula.targetPrice, 18))} margin at ${currency(formula.targetPrice)} target` : '';
  const actions = formula.kind === 'rnd'
    ? `<button class="link-button" data-version-copy="${entry.version}">New trial from this</button><button class="link-button" data-version-sample="${entry.version}">Sample batch</button>${formula.status !== 'launched' ? `<button class="link-button accent" data-version-launch="${entry.version}">Launch this trial</button>` : ''}`
    : `${!isCurrent ? `<button class="link-button accent" data-make-current="${entry.version}">Make current</button>` : ''}<button class="link-button" data-version-copy="${entry.version}">New version from this</button>`;
  return `<section class="version-card ${isCurrent && formula.kind === 'signature' ? 'current' : ''}" data-version="${entry.version}"><div class="version-head"><strong>${formula.kind === 'rnd' ? 'Trial' : 'Version'} ${entry.version}</strong>${isCurrent && formula.kind === 'signature' ? '<span class="status-badge status-paid">In use</span>' : ''}<span class="version-date">${formatKey(dateKey(entry.createdAt))}</span><span class="version-cost">${currency(cost)} per bottle${margin ? ` · ${margin}` : ''}</span></div><table class="report-table version-table"><thead><tr><th>Ingredient</th><th class="num">Amount</th><th class="num">Share</th><th class="num">Cost</th></tr></thead><tbody>${rows}${pack}</tbody><tfoot><tr><td>Bottle</td><td class="num">${total}ml</td><td class="num">100%</td><td class="num">${currency(cost)}</td></tr></tfoot></table><div class="version-notes"><textarea data-version-notes aria-label="Notes for version ${entry.version}" rows="2" placeholder="Notes: how it smells, wears, what to change">${escapeHtml(entry.notes)}</textarea><select data-version-rating aria-label="Rating">${[['', 'No rating'], [1, '★ Poor'], [2, '★★ Fair'], [3, '★★★ Good'], [4, '★★★★ Very good'], [5, '★★★★★ Excellent']].map(([value, label]) => `<option value="${value}" ${entry.rating === value ? 'selected' : ''}>${label}</option>`).join('')}</select><button class="outline-button" type="button" data-save-version="${entry.version}">Save notes</button></div><div class="version-actions">${actions}</div></section>`;
}
function renderDetail() {
  const formula = mfg.formulas.find(entry => entry.id === detailFormulaId);
  if (!formula) return;
  const product = products.find(item => item.id === formula.productId);
  $('#detailLabel').textContent = formula.kind === 'rnd' ? 'R&D PROJECT' : 'SIGNATURE BLEND';
  $('#detailTitle').textContent = formula.name;
  $('#detailSub').textContent = formula.kind === 'rnd' ? (formula.brief || 'No brief yet') : (product ? `Sold as ${product.name}` : 'Not linked to a product yet');
  const stages = formula.kind === 'rnd' ? ['idea', 'testing', 'approved', 'launched', 'dropped'] : ['active', 'retired'];
  const linkable = products.filter(item => !item.needsRecipe && (item.id === formula.productId || !mfg.formulas.some(other => other.kind === 'signature' && other.productId === item.id)));
  const controls = `<div class="detail-controls"><label>Stage <select data-formula-status>${stages.map(stage => `<option value="${stage}" ${formula.status === stage ? 'selected' : ''}>${STAGE[stage][0]}</option>`).join('')}</select></label>${formula.kind === 'signature' ? `<label>Product <select data-formula-product><option value="">Not linked</option>${linkable.map(item => `<option value="${item.id}" ${item.id === formula.productId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label>` : ''}<span class="detail-spacer"></span>${formula.kind === 'rnd' ? `<button class="outline-button" type="button" data-detail-new-trial>＋ New trial</button><button class="outline-button" type="button" data-detail-sample>Sample batch</button>${formula.status !== 'launched' ? '<button class="primary-button small-button" type="button" data-detail-launch>Launch as product</button>' : ''}` : `<button class="outline-button" type="button" data-detail-new-version>＋ New version</button><button class="primary-button small-button" type="button" data-detail-produce>Produce</button>`}</div>`;
  $('#detailBody').innerHTML = controls + [...formula.versions].reverse().map(entry => versionCard(formula, entry)).join('');
}
function openRunDetail(id) {
  const run = mfg.runs.find(entry => entry.id === id);
  detailFormulaId = null;
  $('#detailLabel').textContent = run.kind === 'sample' ? 'R&D SAMPLE' : 'PRODUCTION RUN';
  $('#detailTitle').textContent = run.number;
  $('#detailSub').textContent = `${run.units} bottle${run.units === 1 ? '' : 's'} of ${run.formulaName} (version ${run.version}) · ${formatKey(run.day)} · ${outletLabel(run.outletId)}`;
  $('#detailBody').innerHTML = `<table class="report-table version-table"><thead><tr><th>Used</th><th class="num">Quantity</th><th class="num">Cost</th></tr></thead><tbody>${run.lines.map(line => `<tr><td>${escapeHtml(line.name)}</td><td class="num">${fmtQty(line.qty, line.unit)}</td><td class="num">${currency(line.cost)}</td></tr>`).join('')}</tbody><tfoot><tr><td>Total · ${currency(run.unitCost)} per bottle</td><td></td><td class="num">${currency(run.totalCost)}</td></tr></tfoot></table>${run.note ? `<p class="report-footnote">${escapeHtml(run.note)}</p>` : ''}${run.kind === 'batch' ? `<p class="report-footnote">${run.units} finished bottle${run.units === 1 ? '' : 's'} were added to ${escapeHtml(run.productName)} stock at ${currency(run.unitCost)} each.</p>` : '<p class="report-footnote">Sample runs use materials but do not create sellable stock.</p>'}`;
  $('#detailModal').classList.remove('hidden');
}
$('#closeDetail').addEventListener('click', () => { detailFormulaId = null; closeModal('#detailModal'); });
$('#detailBody').addEventListener('click', event => {
  const hit = selector => event.target.closest(selector);
  const formula = mfg.formulas.find(entry => entry.id === detailFormulaId);
  if (!formula) return;
  const save = hit('[data-save-version]'), current = hit('[data-make-current]'), copy = hit('[data-version-copy]'), sample = hit('[data-version-sample]'), launch = hit('[data-version-launch]');
  if (save) {
    const card = save.closest('.version-card');
    submitting(save, async () => {
      const rating = card.querySelector('[data-version-rating]').value;
      await api('PUT', `/api/formulas/${formula.id}/versions/${save.dataset.saveVersion}`, { notes: card.querySelector('[data-version-notes]').value, rating: rating === '' ? null : Number(rating) });
      await loadManufacturing(); showToast('Notes saved');
    });
  }
  if (current) submitting(current, async () => { await api('POST', `/api/formulas/${formula.id}/current`, { version: Number(current.dataset.makeCurrent) }); await loadManufacturing(); showToast(`Version ${current.dataset.makeCurrent} is now in use`); });
  if (copy) openFormulaEditor({ kind: formula.kind, formulaId: formula.id, baseVersion: Number(copy.dataset.versionCopy) });
  if (sample) openRunModal({ kind: 'sample', formulaId: formula.id, version: Number(sample.dataset.versionSample) });
  if (launch) openPromote(formula.id, Number(launch.dataset.versionLaunch));
  if (hit('[data-detail-new-trial]') || hit('[data-detail-new-version]')) openFormulaEditor({ kind: formula.kind, formulaId: formula.id });
  if (hit('[data-detail-sample]')) openRunModal({ kind: 'sample', formulaId: formula.id });
  if (hit('[data-detail-produce]')) openRunModal({ kind: 'batch', formulaId: formula.id });
  if (hit('[data-detail-launch]')) openPromote(formula.id);
});
$('#detailBody').addEventListener('change', async event => {
  const formula = mfg.formulas.find(entry => entry.id === detailFormulaId);
  if (!formula) return;
  try {
    if (event.target.matches('[data-formula-status]')) await api('PUT', `/api/formulas/${formula.id}`, { status: event.target.value });
    else if (event.target.matches('[data-formula-product]')) await api('PUT', `/api/formulas/${formula.id}`, { productId: event.target.value });
    else return;
    await loadManufacturing(); showToast('Saved');
  } catch (error) { showToast(error.message); await loadManufacturing(); }
});

/* ---------- Production runs and R&D samples ---------- */
function openRunModal(setup) {
  runSetup = setup;
  const choices = mfg.formulas.filter(formula => setup.kind === 'sample' ? formula.status !== 'dropped' : formula.kind === 'signature' && formula.productId && formula.status === 'active');
  if (!choices.length) { showToast(setup.kind === 'sample' ? 'Create a blend or R&D project first' : 'Add a signature blend linked to a packed product first'); return; }
  $('#runForm').reset();
  setFieldError('runUnits', ''); $('#runError').textContent = '';
  $('#runLabel').textContent = setup.kind === 'sample' ? 'R&D SAMPLE' : 'PRODUCTION';
  $('#runTitle').textContent = setup.kind === 'sample' ? 'Sample batch' : 'Production run';
  $('#runHelp').textContent = setup.kind === 'sample' ? 'Uses real material stock for test bottles. Nothing is added to sellable stock.' : `Turns ingredients and packaging into finished bottles at ${state.outlet.name}. They are added to the packed product's stock at their true cost.`;
  $('#runUnitsLabel').innerHTML = `${setup.kind === 'sample' ? 'Sample bottles (1 to 50)' : 'Bottles to make'} <span class="req">*</span>`;
  $('#runSubmit').textContent = setup.kind === 'sample' ? 'Log sample' : 'Start production';
  $('#runFormula').innerHTML = choices.map(formula => `<option value="${formula.id}">${escapeHtml(formula.name)}${formula.kind === 'rnd' ? ' (R&D)' : ''}</option>`).join('');
  $('#runFormula').value = setup.formulaId && choices.some(formula => formula.id === setup.formulaId) ? setup.formulaId : choices[0].id;
  fillRunVersions(setup.version);
  $('#runDate').value = todayKey();
  updateRunPreview();
  $('#runModal').classList.remove('hidden');
  $('#runUnits').focus();
}
function fillRunVersions(preferred) {
  const formula = mfg.formulas.find(entry => entry.id === $('#runFormula').value);
  $('#runVersion').innerHTML = [...formula.versions].reverse().map(entry => `<option value="${entry.version}">${formula.kind === 'rnd' ? 'Trial' : 'Version'} ${entry.version}${entry.version === formula.currentVersion && formula.kind === 'signature' ? ' (in use)' : ''}</option>`).join('');
  $('#runVersion').value = String(preferred || (formula.kind === 'rnd' ? latestVersionOf(formula).version : formula.currentVersion));
}
function runNeeds() {
  const formula = mfg.formulas.find(entry => entry.id === $('#runFormula').value);
  const version = formula.versions.find(entry => entry.version === Number($('#runVersion').value)), units = Math.round(Number($('#runUnits').value)) || 0;
  const needs = version.lines.map(line => ({ id: line.materialId, qty: round2(line.ml * units) }));
  if (version.pack) needs.push({ id: version.pack.materialId, qty: version.pack.qty * units });
  return { formula, version, units, needs };
}
function updateRunPreview() {
  const { formula, version, units, needs } = runNeeds();
  const rows = needs.map(need => { const material = findMaterial(need.id), short = need.qty > material.stock + 1e-9; return `<tr class="${short ? 'short' : ''}"><td>${escapeHtml(material.name)}</td><td class="num">${fmtQty(need.qty, material.unit)}</td><td class="num">${fmtQty(material.stock, material.unit)}</td><td class="num">${short ? '<span class="due-text">Short</span>' : 'OK'}</td></tr>`; }).join('');
  const total = round2(needs.reduce((sum, need) => sum + need.qty * materialCost(need.id), 0));
  const product = products.find(item => item.id === formula.productId);
  $('#runPreview').innerHTML = `<table class="report-table version-table run-preview"><thead><tr><th>Needed</th><th class="num">For ${units || 0} bottle${units === 1 ? '' : 's'}</th><th class="num">In stock</th><th class="num"></th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td>${units ? `${currency(total)} total` : 'Enter the number of bottles'}</td><td class="num" colspan="3">${currency(bottleCost(version))} per bottle${runSetup.kind === 'batch' && product ? ` · adds ${units || 0} to ${escapeHtml(product.name)}` : ''}</td></tr></tfoot></table>`;
}
$('#runFormula').addEventListener('change', () => { fillRunVersions(); updateRunPreview(); });
$('#runVersion').addEventListener('change', updateRunPreview);
$('#runUnits').addEventListener('input', () => { setFieldError('runUnits', ''); $('#runError').textContent = ''; updateRunPreview(); });
$('#closeRun').addEventListener('click', () => closeModal('#runModal'));
$('#runForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#runSubmit'), async () => {
    const { formula, version, units, needs } = runNeeds();
    const max = runSetup.kind === 'sample' ? 50 : 10000;
    setFieldError('runUnits', Number.isInteger(Number($('#runUnits').value)) && units >= 1 && units <= max ? '' : `Enter a whole number from 1 to ${max.toLocaleString('en-IN')}`);
    const short = needs.find(need => need.qty > findMaterial(need.id).stock + 1e-9);
    $('#runError').textContent = short ? `Not enough ${findMaterial(short.id).name} in stock for this run` : '';
    if ($('#runForm .customer-input.invalid') || short) return;
    const run = await api('POST', '/api/production-runs', { formulaId: formula.id, version: version.version, units, kind: runSetup.kind, date: $('#runDate').value, note: $('#runNote').value });
    closeModal('#runModal');
    await reloadAll();
    await loadManufacturing();
    showToast(`${run.number} · ${run.units} bottle${run.units === 1 ? '' : 's'} at ${currency(run.unitCost)} each`);
  });
});

/* ---------- Launch an R&D trial as a product ---------- */
function openPromote(formulaId, version) {
  promoteFormulaId = formulaId;
  const formula = mfg.formulas.find(entry => entry.id === formulaId);
  $('#promoteForm').reset();
  setFieldError('promoteName', ''); setFieldError('promotePrice', '');
  $('#promoteGst').innerHTML = GST_RATES.map(rate => `<option value="${rate}">${rate}%</option>`).join(''); $('#promoteGst').value = '18';
  $('#promoteVersion').innerHTML = [...formula.versions].reverse().map(entry => `<option value="${entry.version}">Trial ${entry.version} · ${currency(bottleCost(entry))} per bottle · ${stars(entry.rating)}</option>`).join('');
  $('#promoteVersion').value = String(version || formula.currentVersion);
  $('#promoteName').value = formula.name; $('#promotePrice').value = formula.targetPrice || '';
  $('#promoteModal').classList.remove('hidden');
  $('#promoteName').focus();
}
['promoteName', 'promotePrice'].forEach(id => $(`#${id}`).addEventListener('input', () => setFieldError(id, '')));
$('#closePromote').addEventListener('click', () => closeModal('#promoteModal'));
$('#promoteForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#promoteSubmit'), async () => {
    const name = $('#promoteName').value.trim(), price = Number($('#promotePrice').value);
    setFieldError('promoteName', name ? '' : 'Give the product a name');
    setFieldError('promotePrice', price > 0 ? '' : 'Enter a selling price');
    if ($('#promoteForm .customer-input.invalid')) return;
    await api('POST', `/api/formulas/${promoteFormulaId}/promote`, { version: Number($('#promoteVersion').value), productName: name, price, gstRate: Number($('#promoteGst').value) });
    closeModal('#promoteModal'); closeModal('#detailModal'); detailFormulaId = null;
    await reloadAll();
    mfgTab = 'signature';
    await loadManufacturing();
    showToast(`${name} launched. Use Produce to make the first batch`);
  });
});

/* ---------- Row actions ---------- */
$('#mfgBody').addEventListener('click', event => {
  const hit = selector => event.target.closest(selector);
  const open = hit('[data-mfg-open]'), produce = hit('[data-mfg-produce]'), newVersion = hit('[data-mfg-newversion]'), sample = hit('[data-mfg-sample]'), launch = hit('[data-mfg-launch]'), run = hit('[data-mfg-run-detail]');
  if (open) openDetail(open.dataset.mfgOpen);
  if (produce) openRunModal({ kind: 'batch', formulaId: produce.dataset.mfgProduce });
  if (newVersion) openFormulaEditor({ kind: mfg.formulas.find(entry => entry.id === newVersion.dataset.mfgNewversion).kind, formulaId: newVersion.dataset.mfgNewversion });
  if (sample) openRunModal({ kind: 'sample', formulaId: sample.dataset.mfgSample });
  if (launch) openPromote(launch.dataset.mfgLaunch);
  if (run) openRunDetail(run.dataset.mfgRunDetail);
});

/* ---------- Stock verification: physical count versus system, then update to physical ---------- */
let countRevealed = false;
let viewingCountId = null;
const openCount = () => stockCounts.find(count => count.status === 'draft');
const countedLines = count => count.lines.filter(line => line.physical !== null);
const COUNT_STATUS = { draft: ['In progress', 'status-partial'], completed: ['Completed', 'status-paid'], cancelled: ['Cancelled', 'status-returned'] };

// The count sheet is a line grid: scan or type an item, then enter what is physically on the shelf.
let countGrid = null, countGridKey = '';
const sheetHidden = count => count.blind && !countRevealed;
const countLine = (count, materialId) => count.lines.find(line => line.materialId === materialId);
function varianceOf(count, row) {
  const raw = row.values.physical;
  if (raw === '' || raw === undefined || !(Number(raw) >= 0)) return null;
  const line = countLine(count, row.item.id), delta = round2(Number(raw) - line.system);
  return { line, delta, value: round2(delta * line.cost) };
}
function buildCountGrid(count) {
  const hide = sheetHidden(count);
  const pool = count.lines.map(line => { const material = findMaterial(line.materialId) || {}; return { id: line.materialId, name: line.name, type: line.type, unit: line.unit, code: material.code || '', ean: material.ean || null, stock: hide ? null : line.system }; });
  const columns = [
    { type: 'index', label: '#', width: '40px' },
    { type: 'code', label: 'Item code', width: '170px' },
    { type: 'out', key: 'name', label: 'Description', width: 'minmax(140px, 1fr)', out: row => `<strong>${escapeHtml(row.item.name)}</strong><small>${row.item.type}${row.item.ean ? ` · ${escapeHtml(row.item.ean)}` : ''}</small>` },
    { type: 'out', key: 'unit', label: 'Unit', width: '44px', out: row => row.item.unit }
  ];
  if (!hide) columns.push({ type: 'out', key: 'system', label: 'System', width: '96px', align: 'right', out: row => { const line = countLine(count, row.item.id), now = findMaterial(row.item.id), moved = now && Math.abs(now.stock - line.system) > 0.001; return `${fmtQty(line.system, line.unit)}${moved ? `<small>now ${fmtQty(now.stock, line.unit)}</small>` : ''}`; } });
  columns.push(
    { type: 'input', key: 'physical', label: 'Physical', width: '100px', align: 'right', placeholder: '0' },
    { type: 'out', key: 'variance', label: 'Variance', width: '100px', align: 'right', always: false, out: row => {
      const result = varianceOf(count, row);
      if (!result) return '—';
      if (hide) return 'Counted';
      const { delta, line, value } = result;
      return delta === 0 ? '<span class="count-variance match">Matches</span>' : `<span class="count-variance ${delta < 0 ? 'short' : 'over'}" title="${delta > 0 ? '+' : ''}${currency(value)}">${delta > 0 ? '+' : ''}${fmtQty(delta, line.unit)}</span>`;
    } },
    { type: 'input', key: 'reason', label: 'Reason, if different', width: 'minmax(120px, 1fr)', text: true, placeholder: 'Optional' },
    { type: 'actions', width: '34px' }
  );
  countGrid = createLineGrid($('#countGrid'), {
    pool: () => pool,
    columns,
    defaults: () => ({ physical: '', reason: '' }),
    onChange: () => updateCountSummary(),
    fkeys: { F3: grid => grid.deleteActive(), F6: () => { const button = $('#saveCount'); if (button) button.click(); } }
  });
  countGrid.setRows(count.lines.filter(line => line.physical !== null || line.reason).map(line => ({ item: pool.find(item => item.id === line.materialId), values: { physical: line.physical === null ? '' : String(line.physical), reason: line.reason || '' } })));
  countGridKey = `${count.id}|${hide}`;
}
function sheetHtml(count) {
  const hide = sheetHidden(count);
  return `<div class="kpi-grid count-summary" id="countSummary"></div>
    <div class="purchase-bill count-sheet"><div class="purchase-lines"><div id="countGrid"></div><div class="fkey-bar"><button type="button" class="fkey" data-fkey="F3"><kbd>F3</kbd>Delete row</button><button type="button" class="fkey" data-fkey="F6"><kbd>F6</kbd>Save progress</button><span class="fkey-tip">Scan or type an item code, EAN or name, then its physical count. Items you never enter are left unchanged.</span></div></div>
    <div class="purchase-bottom"><div class="purchase-note"><span>${count.number} · started ${formatStamp(count.startedAt)}${count.startedBy ? ` by ${escapeHtml(count.startedBy)}` : ''}${count.blind ? ' · blind count' : ''}.</span></div><div class="count-actions"><button class="link-button" id="cancelCount" type="button">Cancel count</button><button class="outline-button" id="addUncounted" type="button">Add all uncounted items</button>${hide ? '' : '<button class="outline-button" id="fillMatching" type="button">Fill matching</button>'}<button class="outline-button" id="saveCount" type="button">Save progress</button>${hide ? '<button class="primary-button small-button" id="revealCount" type="button">Review variances</button>' : '<button class="primary-button small-button" id="finishCount" type="button">Finish &amp; update stock</button>'}</div></div></div>`;
}
function startHtml() {
  return `<div class="report-card count-empty"><p><strong>No count in progress.</strong></p><p>Start a count to record what is physically on the shelves. It freezes today's system quantities so you can compare them, then updates the system to match your physical count. A blind count hides the system quantities while you count, which avoids bias.</p></div>`;
}
function renderVerification() {
  if (!$('#verificationView')) return;
  const draft = openCount();
  $('#verificationSubtitle').textContent = `Count what is physically on the shelves at ${state.outlet.name} and compare it with the system. Finishing updates the system stock to your physical quantities.`;
  $('#startCount').classList.toggle('hidden', Boolean(draft));
  $('#blindOption').classList.toggle('hidden', Boolean(draft));
  if (!draft) { countGrid = null; countGridKey = ''; $('#countSheet').innerHTML = startHtml(); }
  else if (countGridKey !== `${draft.id}|${sheetHidden(draft)}` || !$('#countGrid')) {
    $('#countSheet').innerHTML = sheetHtml(draft);
    lineGrids.splice(0, lineGrids.length, ...lineGrids.filter(grid => document.body.contains(grid.root)));
    buildCountGrid(draft);
  } else countGrid.refreshAll();
  if (draft) updateCountSummary();
  const past = stockCounts.filter(count => count.status !== 'draft');
  $('#countRows').innerHTML = past.length ? past.map(count => {
    const counted = countedLines(count), short = counted.filter(line => line.delta < 0).length, over = counted.filter(line => line.delta > 0).length, [label, css] = COUNT_STATUS[count.status];
    return `<div class="count-hist"><span class="count-main"><strong>${count.number}</strong><small>${formatStamp(count.startedAt)}</small></span><span data-label="Status"><span class="status-badge ${css}">${label}</span></span><span data-label="Items counted">${count.status === 'completed' ? counted.length : '—'}<small>of ${count.lines.length}</small></span><span data-label="Differences">${count.status === 'completed' ? `${short} short · ${over} over` : '—'}</span><span class="num" data-label="Net value">${count.status === 'completed' ? currency(count.varianceValue) : '—'}</span><span data-label="Counted by">${escapeHtml(count.completedBy || count.startedBy || '—')}</span><span class="row-actions"><button class="link-button" data-count-view="${count.id}">View</button></span></div>`;
  }).join('') : '<div class="purchase-empty">No completed counts yet</div>';
}

// Every line of the count is sent: items on the sheet with what was typed, the rest as not counted.
function sheetEntries() {
  const count = openCount(), typed = new Map(countGrid.itemRows().map(row => [row.item.id, row]));
  return count.lines.map(line => {
    const row = typed.get(line.materialId), raw = row ? row.values.physical : '';
    return { materialId: line.materialId, physical: raw === '' || raw === undefined ? null : Number(raw), reason: row ? String(row.values.reason || '').trim() : '' };
  });
}
function entryProblem(count, entries) {
  for (const entry of entries) {
    const line = count.lines.find(item => item.materialId === entry.materialId);
    if (entry.physical === null) continue;
    if (!(entry.physical >= 0)) return `${line.name}: the count cannot be negative`;
    if (line.unit === 'pcs' && !Number.isInteger(entry.physical)) return `${line.name}: count whole pieces`;
  }
  return '';
}
function updateCountSummary() {
  const count = openCount();
  if (!count || !countGrid || !$('#countSummary')) return;
  const hide = sheetHidden(count);
  let counted = 0, match = 0, short = 0, over = 0, net = 0;
  countGrid.itemRows().forEach(row => {
    const result = varianceOf(count, row);
    if (!result) return;
    counted += 1;
    if (hide) return;
    net += result.value;
    if (result.delta === 0) match += 1; else if (result.delta < 0) short += 1; else over += 1;
  });
  $('#countSummary').innerHTML = `<div class="kpi"><span class="kpi-label">Counted</span><strong>${counted} of ${count.lines.length}</strong><span class="kpi-note">items entered</span></div>` + (hide
    ? '<div class="kpi"><span class="kpi-label">Variances</span><strong>Hidden</strong><span class="kpi-note">blind count: review when finished counting</span></div>'
    : `<div class="kpi"><span class="kpi-label">Match</span><strong>${match}</strong><span class="kpi-note">system equals physical</span></div><div class="kpi"><span class="kpi-label">Short</span><strong>${short}</strong><span class="kpi-note">less than the system</span></div><div class="kpi"><span class="kpi-label">Over</span><strong>${over}</strong><span class="kpi-note">more than the system</span></div><div class="kpi"><span class="kpi-label">Net variance</span><strong>${currency(round2(net))}</strong><span class="kpi-note">at average cost</span></div>`);
}

$('#startCount').addEventListener('click', () => {
  submitting($('#startCount'), async () => {
    await api('POST', '/api/stock-counts', { blind: $('#blindCount').checked });
    countRevealed = false;
    await reloadAll();
    showToast('Count started. Enter what you find on the shelves');
  });
});
async function saveSheet(count) {
  const entries = sheetEntries(), problem = entryProblem(count, entries);
  if (problem) { showToast(problem); return false; }
  await api('PUT', `/api/stock-counts/${count.id}`, { lines: entries });
  return true;
}
$('#countSheet').addEventListener('click', event => {
  const hit = selector => event.target.closest(selector);
  const count = openCount();
  if (!count) return;
  if (hit('#fillMatching')) {
    countGrid.itemRows().forEach(row => { if (row.values.physical === '') { row.values.physical = String(countLine(count, row.item.id).system); } });
    countGrid.refreshAll();
  }
  if (hit('#addUncounted')) {
    const onSheet = new Set(countGrid.itemRows().map(row => row.item.id));
    const rows = countGrid.itemRows().map(row => ({ item: row.item, values: row.values }));
    count.lines.filter(line => !onSheet.has(line.materialId)).forEach(line => rows.push({ item: countGrid.config.pool().find(item => item.id === line.materialId), values: { physical: '', reason: '' } }));
    countGrid.setRows(rows); countGrid.dirty = true;
  }
  if (hit('#saveCount')) submitting(hit('#saveCount'), async () => { if (await saveSheet(count)) { await loadState(); renderVerification(); showToast('Progress saved'); } });
  if (hit('#revealCount')) submitting(hit('#revealCount'), async () => { if (await saveSheet(count)) { await loadState(); countRevealed = true; renderVerification(); } });
  if (hit('#cancelCount') && confirm(`Cancel ${count.number}? Nothing will change in your stock.`)) submitting(hit('#cancelCount'), async () => { await api('POST', `/api/stock-counts/${count.id}/cancel`, {}); countRevealed = false; await reloadAll(); showToast('Count cancelled. Stock unchanged'); });
  if (hit('#finishCount')) submitting(hit('#finishCount'), async () => {
    const entries = sheetEntries(), problem = entryProblem(count, entries);
    if (problem) { showToast(problem); return; }
    const filled = entries.filter(entry => entry.physical !== null);
    if (!filled.length) { showToast('Enter the physical quantity for at least one item'); return; }
    const changes = filled.filter(entry => entry.physical !== count.lines.find(line => line.materialId === entry.materialId).system);
    const net = round2(changes.reduce((sum, entry) => { const line = count.lines.find(item => item.materialId === entry.materialId); return sum + (entry.physical - line.system) * line.cost; }, 0));
    if (!confirm(`Update the system stock to your physical count?\n\n${filled.length} item${filled.length === 1 ? '' : 's'} counted, ${changes.length} will change (net ${currency(net)}).\nThis cannot be undone; it is recorded as ${count.number}.`)) return;
    const done = await api('POST', `/api/stock-counts/${count.id}/complete`, { lines: entries });
    countRevealed = false;
    await reloadAll();
    showToast(`${done.number} finished. ${changes.length} item${changes.length === 1 ? '' : 's'} corrected · net ${currency(done.varianceValue)}`);
    openCountDetail(done.id);
  });
});

/* ---------- Past counts ---------- */
function openCountDetail(id) {
  const count = stockCounts.find(entry => entry.id === id);
  if (!count) return;
  viewingCountId = id;
  const [label] = COUNT_STATUS[count.status], counted = countedLines(count);
  $('#countTitle').textContent = count.number;
  $('#countSub').textContent = `${label} · started ${formatStamp(count.startedAt)}${count.startedBy ? ` by ${count.startedBy}` : ''}${count.completedAt ? ` · finished ${formatStamp(count.completedAt)}${count.completedBy ? ` by ${count.completedBy}` : ''}` : ''}${count.note ? ` · ${count.note}` : ''}`;
  $('#exportCount').classList.toggle('hidden', count.status !== 'completed');
  if (count.status !== 'completed') { $('#countBody').innerHTML = `<p class="report-empty">${count.status === 'cancelled' ? 'This count was cancelled. No stock was changed.' : 'This count is still in progress.'}</p>`; }
  else {
    const rows = counted.map(line => `<tr><td>${escapeHtml(line.name)}<small>${line.type}</small></td><td class="num">${fmtQty(line.system, line.unit)}</td><td class="num">${fmtQty(line.physical, line.unit)}</td><td class="num ${line.delta < 0 ? 'count-variance short' : line.delta > 0 ? 'count-variance over' : 'count-variance match'}">${line.delta === 0 ? 'Matches' : `${line.delta > 0 ? '+' : ''}${fmtQty(line.delta, line.unit)}`}</td><td class="num">${line.delta === 0 ? '—' : currency(line.value)}</td><td>${escapeHtml(line.reason || '')}</td></tr>`).join('');
    const skipped = count.lines.length - counted.length;
    $('#countBody').innerHTML = `<table class="report-table version-table"><thead><tr><th>Item</th><th class="num">System</th><th class="num">Counted</th><th class="num">Difference</th><th class="num">Value</th><th>Reason</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td>Net variance</td><td></td><td></td><td></td><td class="num">${currency(count.varianceValue)}</td><td></td></tr></tfoot></table>${skipped ? `<p class="report-footnote">${skipped} item${skipped === 1 ? ' was' : 's were'} not counted and left unchanged.</p>` : ''}<p class="report-footnote">Values use each item's average cost when the count started. Every correction is recorded in the stock ledger.</p>`;
  }
  $('#countModal').classList.remove('hidden');
}
$('#countRows').addEventListener('click', event => { const view = event.target.closest('[data-count-view]'); if (view) openCountDetail(view.dataset.countView); });
$('#closeCount').addEventListener('click', () => closeModal('#countModal'));
$('#exportCount').addEventListener('click', () => {
  const count = stockCounts.find(entry => entry.id === viewingCountId);
  downloadCsv(`${count.number}.csv`, [['Item', 'Unit', 'System', 'Counted', 'Difference', 'Cost per unit', 'Value', 'Reason'], ...countedLines(count).map(line => [line.name, line.unit, line.system, line.physical, line.delta, line.cost, line.value, line.reason])]);
});

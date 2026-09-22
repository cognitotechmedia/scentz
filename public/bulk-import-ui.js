/* Bulk catalog/customer uploads; existing spreadsheet reader supports Excel and CSV. */
(() => {
  const definitions = {
    products: { anchor: '#addProductButton', role: 'role-admin', columns: ['name', 'price', 'gstRate', 'cost', 'wholesalePrice', 'franchisePrice', 'sizeMl', 'trackStock', 'needsRecipe', 'recipeMl', 'packMaterialId', 'packQty', 'fillMaterialId'], sample: ['Example perfume', 500, 18, 200, 450, 400, 50, 'yes', 'no', '', '', '', ''], help: 'Name, price and gstRate are required. Use yes/no for trackStock and needsRecipe. Custom blends require recipeMl; optional packaging/top-up fields use existing material IDs. Stock quantities are entered separately through Opening stock.' },
    customers: { anchor: '#addPartyButton', role: 'role-staff', columns: ['name', 'phone', 'email', 'type', 'gstin', 'address', 'buyerOutletId'], sample: ['Example customer', '9876543210', '', 'retail', '', '', ''], help: 'Name and 10-digit phone are required. Type: retail, wholesale or franchise. Franchise customers require a matching GSTIN and buyerOutletId. Customers are added to the selected outlet. Format phone numbers as text in Excel.' }
  };
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop hidden';
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'bulkTitle');
  modal.innerHTML = '<div class="blend-modal detail-modal import-modal"><div class="modal-heading"><div><h2 id="bulkTitle"></h2><p id="bulkHelp"></p></div><button type="button" class="modal-close" id="bulkClose" aria-label="Close">×</button></div><p>New records only. Existing names or phone numbers are rejected; nothing is overwritten. Maximum 500 rows. Remove the example row before uploading.</p><div class="view-actions"><button type="button" class="outline-button" id="bulkXlsx">Excel template ↓</button><button type="button" class="outline-button" id="bulkCsv">CSV template ↓</button><label class="outline-button">Choose Excel / CSV<input id="bulkFile" type="file" accept=".xlsx,.csv" /></label></div><div id="bulkResults" style="max-height:45vh;overflow:auto" aria-live="polite"></div><div class="detail-controls"><button type="button" class="primary-button small-button" id="bulkSave" disabled>Import all rows</button></div></div>';
  document.body.appendChild(modal);
  let kind, rows = [], outlet, user, busy = false;
  const el = id => document.getElementById(id);
  const lock = value => { busy = value; ['bulkFile', 'bulkClose', 'bulkXlsx', 'bulkCsv'].forEach(id => { el(id).disabled = value; }); el('bulkSave').disabled = true; };
  const sameContext = () => { if (outlet !== state.outlet?.id || user !== state.me?.id) throw new Error('Your user or outlet changed. Close and reopen the import.'); };
  const verdict = result => {
    el('bulkResults').innerHTML = result.errors.length
      ? '<p>No rows saved. Correct these errors and upload again.</p><ul>' + result.errors.map(e => `<li>Row ${e.row}: ${escapeHtml(e.message)}</li>`).join('') + '</ul>'
      : `<p>${result.count} rows validated. Ready to import.</p><table class="data-table"><thead><tr>${definitions[kind].columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, 100).map(r => '<tr>' + definitions[kind].columns.map(c => `<td>${escapeHtml(String(r[c] ?? ''))}</td>`).join('') + '</tr>').join('')}</tbody></table><p>Showing the first ${Math.min(rows.length, 100)} rows.</p>`;
  };
  Object.entries(definitions).forEach(([key, definition]) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'outline-button ' + definition.role; button.textContent = 'Bulk upload';
    $(definition.anchor).insertAdjacentElement('afterend', button);
    button.onclick = () => { if (busy) return; kind = key; rows = []; outlet = state.outlet.id; user = state.me.id; el('bulkTitle').textContent = `Import ${key} · ${state.outlet.name}`; el('bulkHelp').textContent = definition.help; el('bulkResults').textContent = ''; el('bulkFile').value = ''; el('bulkSave').disabled = true; modal.classList.remove('hidden'); };
  });
  el('bulkClose').onclick = () => { if (!busy) { rows = []; modal.classList.add('hidden'); } };
  el('bulkCsv').onclick = () => downloadCsv(`${kind}-template.csv`, [definitions[kind].columns, definitions[kind].sample]);
  el('bulkXlsx').onclick = () => downloadXlsx(`${kind}-template.xlsx`, [definitions[kind].columns, definitions[kind].sample], { sheet: kind });
  el('bulkFile').onchange = async () => {
    rows = []; lock(true);
    let valid = false;
    try {
      sameContext();
      const file = el('bulkFile').files[0]; if (!file) return;
      if (file.size > 2 * 1024 * 1024) throw new Error('Choose a file smaller than 2 MB');
      const sheet = await readSpreadsheet(file);
      const headers = (sheet[0] || []).map(c => String(c).trim());
      const columns = definitions[kind].columns;
      if (headers.some(c => !columns.includes(c)) || new Set(headers).size !== headers.length) throw new Error('Use the template column names without duplicate or extra columns');
      const required = kind === 'products' ? ['name', 'price', 'gstRate'] : ['name', 'phone'];
      if (required.some(c => !headers.includes(c))) throw new Error('Missing required columns: ' + required.join(', '));
      rows = sheet.slice(1).map(cells => Object.fromEntries(headers.map((h, i) => [h, String(cells[i] ?? '').trim()])));
      while (rows.length && Object.values(rows[rows.length - 1]).every(v => !v)) rows.pop();
      if (!rows.length || rows.length > 500) throw new Error('Choose between 1 and 500 rows');
      sameContext();
      const result = await api('POST', `/api/import/${kind}`, { rows, preview: true }); sameContext(); verdict(result); valid = !result.errors.length;
    } catch (error) { rows = []; el('bulkResults').textContent = error.message; }
    finally { lock(false); el('bulkSave').disabled = !valid; }
  };
  el('bulkSave').onclick = async () => {
    lock(true);
    try {
      sameContext();
      const result = await api('POST', `/api/import/${kind}`, { rows, preview: false });
      if (result.errors.length) { verdict(result); return; }
      rows = []; el('bulkResults').textContent = `${result.imported} ${kind} imported successfully.`;
      await reloadAll();
    } catch (error) { el('bulkResults').textContent = error.message + '. Refresh and check the list before uploading again.'; }
    finally { lock(false); }
  };
})();

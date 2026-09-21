/* ---------- Salesmen: pick one on the bill, manage the list ---------- */
const salesmanKey = () => `vv-salesman-${state.me?.id}-${state.outlet?.id}`;
// The picker offers the outlet's active salesmen. The last one used stays selected, because the same person usually keeps selling.
function renderSalesmanPicker() {
  const box = $('#billSalesman');
  if (!box || !state.me) return;
  const active = salesmen.filter(salesman => salesman.active);
  const wanted = box.value || storage.get(salesmanKey()) || '';
  box.innerHTML = `<option value="">No salesman</option>${active.map(salesman => `<option value="${salesman.id}">${escapeHtml(salesman.name)}</option>`).join('')}`;
  box.value = active.some(salesman => String(salesman.id) === String(wanted)) ? String(wanted) : '';
}
$('#billSalesman').addEventListener('change', event => storage.set(salesmanKey(), event.target.value));

function renderSalesmenList() {
  $('#salesmenLabel').textContent = state.outlet.code;
  $('#salesmenList').innerHTML = salesmen.length ? salesmen.map(salesman => `<div class="salesman-row ${salesman.active ? '' : 'off'}" data-salesman="${salesman.id}"><div class="customer-input"><input class="salesman-edit" value="${escapeHtml(salesman.name)}" maxlength="60" aria-label="Salesman name" autocomplete="off" /></div><span class="status-badge ${salesman.active ? 'status-paid' : 'status-unpaid'}">${salesman.active ? 'Active' : 'Off'}</span><button class="link-button" type="button" data-save-salesman>Save name</button><button class="link-button ${salesman.active ? '' : 'accent'}" type="button" data-toggle-salesman>${salesman.active ? 'Switch off' : 'Switch on'}</button></div>`).join('') : '<div class="purchase-empty">No salesmen yet. Add the first one above.</div>';
}
$('#manageSalesmen').addEventListener('click', () => {
  renderSalesmenList();
  $('#salesmanName').value = ''; $('#salesmanNameError').textContent = '';
  $('#salesmenModal').classList.remove('hidden');
  $('#salesmanName').focus();
});
$('#closeSalesmen').addEventListener('click', () => closeModal('#salesmenModal'));
$('#salesmanName').addEventListener('input', () => { $('#salesmanNameError').textContent = ''; });
$('#salesmanForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#salesmanAdd'), async () => {
    const name = $('#salesmanName').value.trim().replace(/\s+/g, ' ');
    if (!name) { $('#salesmanNameError').textContent = "Enter the salesman's name"; return; }
    try { await api('POST', '/api/salesmen', { name }); }
    catch (error) { $('#salesmanNameError').textContent = error.message; return; }
    await loadState(); renderSalesmanPicker(); renderSalesmenList();
    $('#salesmanName').value = ''; $('#salesmanName').focus();
    showToast(`${name} added`);
  });
});
$('#salesmenList').addEventListener('click', event => {
  const row = event.target.closest('[data-salesman]'), save = event.target.closest('[data-save-salesman]'), toggle = event.target.closest('[data-toggle-salesman]');
  if (!row || !(save || toggle)) return;
  const salesman = salesmen.find(entry => String(entry.id) === row.dataset.salesman), name = row.querySelector('.salesman-edit').value.trim().replace(/\s+/g, ' ');
  if (!name) { showToast("Enter the salesman's name"); return; }
  submitting(save || toggle, async () => {
    try { await api('PUT', `/api/salesmen/${salesman.id}`, { name, active: toggle ? !salesman.active : salesman.active }); }
    catch (error) { showToast(error.message); return; }
    await loadState(); renderSalesmanPicker(); renderSalesmenList();
    showToast(toggle ? `${name} switched ${salesman.active ? 'off' : 'on'}` : 'Name saved');
  });
});

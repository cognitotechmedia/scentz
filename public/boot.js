/* ---------- Sign-in, sign-out, outlet switching and start-up ---------- */
function showLogin() {
  $('#appRoot').classList.add('hidden');
  $$('.modal-backdrop').forEach(modal => modal.classList.add('hidden'));
  $('#loginScreen').classList.remove('hidden');
  $('#loginUser').focus();
}
function applyRole() {
  $$('.role-admin').forEach(element => element.classList.toggle('role-hidden', !isAdmin()));
  $$('.role-staff').forEach(element => element.classList.toggle('role-hidden', isBiller()));
}
// Sidebar, user chip and the HQ outlet switcher.
function renderChrome() {
  $('#brandOutlet').textContent = `${state.outlet.type === 'hq' ? 'HEAD OFFICE' : 'FRANCHISE'} · ${state.outlet.code}`;
  $('#userName').textContent = state.me.name;
  $('#userRole').textContent = isAdmin() ? 'HQ administrator' : `${isBiller() ? 'Biller' : 'Manager'} · ${state.outlet.code}`;
  $('#userAvatar').textContent = initialsOf(state.me.name) || '?';
  if (isAdmin()) {
    $('#outletSwitch').innerHTML = state.outlets.filter(outlet => outlet.active || outlet.id === state.outlet.id).map(outlet => `<option value="${outlet.id}">${escapeHtml(outlet.name)}</option>`).join('');
    $('#outletSwitch').value = String(state.outlet.id);
  }
  applyRole();
}
async function switchOutlet(id) {
  selectedOutlet = String(id);
  storage.set('vv-outlet', selectedOutlet);
  resetBillForm();
  await reloadAll();
}
async function boot() {
  try { await loadState(); }
  catch (error) {
    if (error.status !== 401) $('#loginError').textContent = error.message;
    showLogin();
    return;
  }
  $('#loginScreen').classList.add('hidden');
  $('#appRoot').classList.remove('hidden');
  purchaseGrid.clear();
  networkCache = null;
  refreshEverything();
  switchView('billing');
  if (isAdmin()) loadUsers();
}

$('#loginForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#loginSubmit'), async () => {
    $('#loginError').textContent = '';
    if (!$('#loginUser').value.trim() || !$('#loginPass').value) { $('#loginError').textContent = 'Enter your username and password'; return; }
    try { await api('POST', '/api/login', { username: $('#loginUser').value, password: $('#loginPass').value }); }
    catch (error) { $('#loginError').textContent = error.message; return; }
    $('#loginPass').value = '';
    await boot();
  });
});
$('#signOut').addEventListener('click', async () => {
  try { await api('POST', '/api/logout', {}); } catch { /* signing out anyway */ }
  state.me = null; networkCache = null; selectedOutlet = null; loadedCartKey = null;
  storage.remove('vv-outlet');
  fill(sales, []); fill(purchases, []); fill(customers, []); fill(vouchers, []); fill(salesmen, []); fill(dayClosings, []);
  showLogin();
});
$('#outletSwitch').addEventListener('change', event => switchOutlet(event.target.value).then(() => switchView('billing')).catch(error => showToast(error.message)));

boot();

/* ---------- Loyalty points: on the bill, in the customer book, and the program settings ---------- */
const loyaltyCfg = () => state.settings.loyalty || { enabled: false };
let redeemPoints = 0;      // points typed for the open bill
let redeemFor = null;      // the customer they belong to; changing customer clears them

// A customer can use points when the program is on and their type takes part.
function loyaltyCustomer() {
  const customer = billingCustomer(), cfg = loyaltyCfg();
  return cfg.enabled && customer && cfg.types.includes(customer.type || 'retail') ? customer : null;
}
// Points typed for the bill, checked against the conditions HQ set. message is empty when they can be used.
function redeemCheck(bill = currentBill()) {
  const cfg = loyaltyCfg(), customer = loyaltyCustomer(), points = Math.floor(Number(redeemPoints) || 0);
  if (!(points > 0)) return { points: 0, value: 0, message: '' };
  const base = { points, value: 0 };
  if (!cfg.enabled || !customer) return { ...base, message: 'Choose a customer who has loyalty points' };
  if (points > customer.points) return { ...base, message: `Only ${customer.points} points are available` };
  if (points < cfg.minPoints) return { ...base, message: `Use at least ${cfg.minPoints} points at a time` };
  if (bill.total < cfg.minBill) return { ...base, message: `Points can be used on bills of ${currency(cfg.minBill)} or more` };
  const value = round2(points * cfg.pointValue), most = round2(bill.total * cfg.maxPercent / 100);
  if (value > most + 1e-9) return { ...base, message: `Points can pay at most ${cfg.maxPercent}% of this bill (${currency(most)}, ${Math.floor(most / cfg.pointValue)} points)` };
  return { points, value, message: '' };
}
const redeemValue = bill => { const check = redeemCheck(bill); return check.message ? 0 : check.value; };
// What still has to be paid in cash, card or UPI once points are taken off.
const payableNow = (bill = currentBill()) => round2(bill.total - redeemValue(bill));
// The most points this bill allows for this customer.
function maxRedeemable(bill) {
  const cfg = loyaltyCfg(), customer = loyaltyCustomer();
  if (!customer) return 0;
  return Math.max(0, Math.min(customer.points, Math.floor(round2(bill.total * cfg.maxPercent / 100) / cfg.pointValue + 1e-9)));
}
function earnPreview(bill) {
  const cfg = loyaltyCfg();
  return Math.floor(round2(bill.total - redeemValue(bill)) * cfg.earnPoints / cfg.earnAmount + 1e-9);
}
function resetRedeem() { redeemPoints = 0; redeemFor = null; const input = $('#redeemInput'); if (input) input.value = ''; }

function renderLoyaltyBox(bill = currentBill()) {
  const box = $('#loyaltyBox'), cfg = loyaltyCfg();
  const type = billingType(), eligible = cfg.enabled && cfg.types.includes(type), customer = loyaltyCustomer();
  const phone = customer ? customer.phone : null;
  if (redeemFor !== phone) { redeemPoints = 0; redeemFor = phone; $('#redeemInput').value = ''; }
  const show = eligible && db.cart.length > 0;
  box.classList.toggle('hidden', !show);
  const check = redeemCheck(bill), applied = check.message ? 0 : check.value;
  $('#redeemRow').classList.toggle('hidden', !(show && applied > 0)); $('#toPayRow').classList.toggle('hidden', !(show && applied > 0));
  $('#redeemAmount').textContent = `−${currency(applied)}`; $('#toPayAmount').textContent = currency(round2(bill.total - applied));
  if (!show) return;
  const points = customer ? customer.points : 0;
  $('#loyaltyBalance').textContent = customer ? `${points} point${points === 1 ? '' : 's'} · worth ${currency(round2(points * cfg.pointValue))}` : 'New customer';
  $('#loyaltyRedeem').classList.toggle('hidden', !(customer && points > 0));
  $('#redeemError').textContent = check.message;
  $('#redeemInput').closest('.customer-input').classList.toggle('invalid', Boolean(check.message));
  const notes = [];
  const earn = earnPreview(bill);
  notes.push(earn > 0 ? `Earns ${earn} point${earn === 1 ? '' : 's'} on this bill${cfg.paidOnly ? ' when paid in full' : ''}.` : cfg.paidOnly ? 'Points are earned when the bill is paid in full.' : '');
  if (customer && points > 0) {
    notes.push(`1 point = ${currency(cfg.pointValue)} · use ${cfg.minPoints}+ points${cfg.minBill ? ` on bills of ${currency(cfg.minBill)}+` : ''} · up to ${cfg.maxPercent}% of the bill.`);
    if (customer.expiresOn && customer.expiringPoints) notes.push(`${customer.expiringPoints} point${customer.expiringPoints === 1 ? '' : 's'} expire on ${formatKey(customer.expiresOn)}.`);
  }
  $('#loyaltyNote').textContent = notes.filter(Boolean).join(' ');
}
$('#redeemInput').addEventListener('input', event => {
  event.target.value = event.target.value.replace(/\D/g, '');
  redeemPoints = Number(event.target.value) || 0;
  renderTotals();
});
$('#redeemMax').addEventListener('click', () => {
  const bill = currentBill(), most = maxRedeemable(bill), cfg = loyaltyCfg();
  if (most < cfg.minPoints || most <= 0) { showToast(`Not enough points to redeem on this bill (at least ${cfg.minPoints} needed)`); return; }
  redeemPoints = most; $('#redeemInput').value = String(most);
  renderTotals();
});
$('#redeemClear').addEventListener('click', () => { resetRedeem(); redeemFor = loyaltyCustomer()?.phone || null; renderTotals(); });

/* ---------- Program settings (HQ) ---------- */
const loyaltyField = id => $(`#${id}`);
function loyaltyExample() {
  const earnPoints = Number(loyaltyField('loyEarnPoints').value) || 0, earnAmount = Number(loyaltyField('loyEarnAmount').value) || 0, value = Number(loyaltyField('loyPointValue').value) || 0;
  if (!(earnPoints > 0 && earnAmount > 0 && value > 0)) { $('#loyaltyExample').textContent = ''; return; }
  const earned = Math.floor(1000 * earnPoints / earnAmount);
  $('#loyaltyExample').textContent = `Example: a ₹1,000 bill earns ${earned} point${earned === 1 ? '' : 's'}, worth ${currency(round2(earned * value))} on a later bill (${(earned * value / 10).toFixed(1).replace(/\.0$/, '')}% back).`;
}
function openLoyaltySettings() {
  const cfg = loyaltyCfg();
  $('#loyaltyError').textContent = '';
  loyaltyField('loyEnabled').checked = Boolean(cfg.enabled);
  loyaltyField('loyEarnPoints').value = cfg.earnPoints ?? 1; loyaltyField('loyEarnAmount').value = cfg.earnAmount ?? 100;
  $$('input[name="loyType"]').forEach(box => { box.checked = (cfg.types || ['retail']).includes(box.value); });
  loyaltyField('loyPaidOnly').checked = cfg.paidOnly !== false;
  loyaltyField('loyPointValue').value = cfg.pointValue ?? 1; loyaltyField('loyMinPoints').value = cfg.minPoints ?? 0; loyaltyField('loyMinBill').value = cfg.minBill ?? 0;
  loyaltyField('loyMaxPercent').value = cfg.maxPercent ?? 50; loyaltyField('loyExpiry').value = cfg.expiryDays ?? 0;
  loyaltyExample();
  $('#loyaltyModal').classList.remove('hidden');
}
$('#loyaltySettingsButton').addEventListener('click', openLoyaltySettings);
$('#closeLoyalty').addEventListener('click', () => closeModal('#loyaltyModal'));
['loyEarnPoints', 'loyEarnAmount', 'loyPointValue', 'loyMinPoints', 'loyMinBill', 'loyMaxPercent', 'loyExpiry'].forEach(id => loyaltyField(id).addEventListener('input', event => {
  const clean = event.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
  if (clean !== event.target.value) event.target.value = clean;
  $('#loyaltyError').textContent = ''; loyaltyExample();
}));
$('#loyaltyForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#loyaltySave'), async () => {
    const body = {
      enabled: loyaltyField('loyEnabled').checked, earnPoints: Number(loyaltyField('loyEarnPoints').value), earnAmount: Number(loyaltyField('loyEarnAmount').value),
      types: $$('input[name="loyType"]:checked').map(box => box.value), paidOnly: loyaltyField('loyPaidOnly').checked,
      pointValue: Number(loyaltyField('loyPointValue').value), minPoints: Number(loyaltyField('loyMinPoints').value || 0), minBill: Number(loyaltyField('loyMinBill').value || 0),
      maxPercent: Number(loyaltyField('loyMaxPercent').value), expiryDays: Number(loyaltyField('loyExpiry').value || 0)
    };
    try { await api('PUT', '/api/loyalty-settings', body); }
    catch (error) { $('#loyaltyError').textContent = error.message; return; }
    closeModal('#loyaltyModal');
    await reloadAll();
    showToast(body.enabled ? 'Loyalty program saved and on' : 'Loyalty program saved (switched off)');
  });
});

/* ---------- A customer's points: history and staff adjustments ---------- */
let pointsCustomer = null;
const POINT_KINDS = { earn: 'Earned', redeem: 'Used on a bill', adjust: 'Adjusted', return_earn: 'Taken back on a return', return_redeem: 'Given back on a return' };
async function openPoints(phone) {
  pointsCustomer = customers.find(customer => customer.phone === phone);
  if (!pointsCustomer) return;
  $('#pointsTitle').textContent = pointsCustomer.name; $('#pointsSub').textContent = 'Loading…';
  $('#pointsDelta').value = ''; $('#pointsReason').value = ''; $('#pointsError').textContent = ''; $('#pointsHistory').innerHTML = '';
  $('#pointsModal').classList.remove('hidden');
  await renderPointsHistory();
  $('#pointsDelta').focus();
}
async function renderPointsHistory() {
  const info = await api('GET', `/api/loyalty/${pointsCustomer.phone}`), cfg = loyaltyCfg();
  $('#pointsSub').textContent = `${formatPhone(pointsCustomer.phone)} · ${info.points} point${info.points === 1 ? '' : 's'} (worth ${currency(round2(info.points * cfg.pointValue))})${info.expiresOn && info.expiringPoints ? ` · ${info.expiringPoints} expire on ${formatKey(info.expiresOn)}` : ''}`;
  $('#pointsHistory').innerHTML = info.history.length ? `<table class="report-table"><thead><tr><th>When</th><th>What</th><th class="num">Points</th></tr></thead><tbody>${info.history.map(entry => `<tr><td>${formatStamp(entry.date)}</td><td>${POINT_KINDS[entry.kind] || entry.kind}${entry.saleNumber ? ` · #${escapeHtml(entry.saleNumber)}` : ''}${entry.note && entry.kind === 'adjust' ? `<small>${escapeHtml(entry.note)}</small>` : ''}${entry.expiresAt ? `<small>expires ${formatKey(entry.expiresAt.slice(0, 10))}</small>` : ''}</td><td class="num ${entry.points < 0 ? 'due-text' : ''}">${entry.points > 0 ? '+' : '−'}${Math.abs(entry.points)}</td></tr>`).join('')}</tbody></table>` : '<div class="purchase-empty">No points yet</div>';
}
$('#customerList').addEventListener('click', event => { const button = event.target.closest('[data-points-party]'); if (button) openPoints(button.dataset.pointsParty); });
$('#closePoints').addEventListener('click', () => closeModal('#pointsModal'));
$('#pointsForm').addEventListener('submit', event => {
  event.preventDefault();
  submitting($('#pointsSave'), async () => {
    const points = Number($('#pointsDelta').value.replace('−', '-').replace(/[^0-9+-]/g, '')), reason = $('#pointsReason').value.trim();
    if (!points || !Number.isInteger(points)) { $('#pointsError').textContent = 'Enter the points to add (like 50) or remove (like -20)'; return; }
    if (!reason) { $('#pointsError').textContent = 'Give a reason for the adjustment'; return; }
    try { await api('POST', '/api/loyalty/adjust', { phone: pointsCustomer.phone, points, reason }); }
    catch (error) { $('#pointsError').textContent = error.message; return; }
    $('#pointsDelta').value = ''; $('#pointsReason').value = ''; $('#pointsError').textContent = '';
    await loadState(); renderCustomers(); await renderPointsHistory();
    showToast(`${points > 0 ? 'Added' : 'Removed'} ${Math.abs(points)} points`);
  });
});
$('#pointsDelta').addEventListener('input', () => { $('#pointsError').textContent = ''; });

/* ---------- The Loyalty screen: is it on, how it works, who has points ---------- */
function renderLoyaltyView() {
  const cfg = loyaltyCfg(), month = todayKey().slice(0, 7);
  const typeNames = (cfg.types || []).map(type => ({ retail: 'retail customers', wholesale: 'wholesalers', franchise: 'franchisees' }[type])).filter(Boolean).join(', ');
  $('#loyaltySubtitle').textContent = 'Customers earn points on their bills and use them to pay part of later bills. HQ sets the rules for every outlet.';
  $('#loyaltyEditButton').textContent = cfg.enabled ? 'Edit program' : 'Set up program';
  $('#loyaltyStatus').className = `loyalty-status ${cfg.enabled ? 'on' : 'off'}`;
  $('#loyaltyStatus').innerHTML = cfg.enabled
    ? '<span class="status-badge status-paid">On</span><span>The program is running. Eligible customers earn points on every bill and can redeem them on the billing screen.</span>'
    : `<span class="status-badge status-unpaid">Off</span><span>The loyalty program is switched off, so no points are earned or shown on bills. ${isAdmin() ? 'Press <strong>Set up program</strong> to choose the rules and switch it on.' : 'Ask HQ to switch it on.'}</span>`;
  const withPoints = customers.filter(customer => customer.points > 0).sort((a, b) => b.points - a.points);
  const outstanding = withPoints.reduce((sum, customer) => sum + customer.points, 0);
  const monthSales = sales.filter(sale => sale.day.startsWith(month));
  const earned = monthSales.reduce((sum, sale) => sum + (sale.pointsEarned || 0), 0), used = monthSales.reduce((sum, sale) => sum + (sale.pointsRedeemed || 0), 0);
  $('#loyaltyKpis').innerHTML = kpi('Points outstanding', outstanding.toLocaleString('en-IN'), `worth ${currency(round2(outstanding * cfg.pointValue))} to customers`)
    + kpi('Customers with points', withPoints.length, `of ${customers.length} customer${customers.length === 1 ? '' : 's'}`)
    + kpi('Earned this month', earned.toLocaleString('en-IN'), 'points from bills')
    + kpi('Used this month', used.toLocaleString('en-IN'), `worth ${currency(round2(monthSales.reduce((sum, sale) => sum + (sale.pointsValue || 0), 0)))} off bills`);
  const rule = (label, value) => `<div class="loy-rule"><span>${label}</span><strong>${value}</strong></div>`;
  $('#loyaltyRules').innerHTML = `<div class="loy-rules">${rule('Earning', `${cfg.earnPoints} point${cfg.earnPoints === 1 ? '' : 's'} for every ${currency(cfg.earnAmount)} spent`)}${rule('Who earns', typeNames || '—')}${rule('Bills that earn', cfg.paidOnly ? 'Only bills paid in full' : 'Every bill')}${rule('Value of a point', currency(cfg.pointValue))}${rule('Minimum to redeem', `${cfg.minPoints} points`)}${rule('Minimum bill', cfg.minBill ? currency(cfg.minBill) : 'None')}${rule('Points can pay at most', `${cfg.maxPercent}% of a bill`)}${rule('Points expire', cfg.expiryDays ? `after ${cfg.expiryDays} days` : 'Never')}</div>`;
  $('#loyaltyMembersHead').textContent = `Customers with points (${withPoints.length})`;
  $('#loyaltyMembers').innerHTML = withPoints.length ? withPoints.map(customer => `<div class="member-row"><span><strong>${escapeHtml(customer.name)}</strong><small>${formatPhone(customer.phone)}${customer.type && customer.type !== 'retail' ? ` · ${PRICE_LABELS[customer.type]}` : ''}</small></span><span class="num" data-label="Points"><strong>${customer.points}</strong></span><span class="num" data-label="Worth">${currency(round2(customer.points * cfg.pointValue))}</span><span data-label="Expiring">${customer.expiresOn && customer.expiringPoints ? `${customer.expiringPoints} on ${formatKey(customer.expiresOn)}` : '—'}</span><span class="row-actions"><button class="link-button accent" data-points-party="${customer.phone}">History &amp; adjust</button></span></div>`).join('') : '<div class="purchase-empty">No customer has points yet.</div>';
}
$('#loyaltyEditButton').addEventListener('click', openLoyaltySettings);
$('#loyaltyMembers').addEventListener('click', event => { const button = event.target.closest('[data-points-party]'); if (button) openPoints(button.dataset.pointsParty); });

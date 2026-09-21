/* ---------- Day closing: tally the drawer, card and UPI against the system, keep the change float ---------- */
const CLOSING_FACES = [[500, '₹500'], [200, '₹200'], [100, '₹100'], [50, '₹50'], [20, '₹20'], [10, '₹10'], [1, 'Coins (total ₹)']];
const MODE_SOURCE = { UPI: 'your UPI app or QR report', Card: 'the card machine settlement', 'Bank transfer': 'your bank statement' };
let closingData = null;      // the server's summary of the chosen day
let floatTyped = false;      // once the float is typed by hand it stops following the cash counted
const cMoney = value => currency(round2(value));
const cNumber = text => { const clean = String(text ?? '').replace(/,/g, '').trim(); if (clean === '') return null; const value = Number(clean); return Number.isFinite(value) ? value : null; };
const digits = input => { const clean = input.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'); if (clean !== input.value) input.value = clean; };

async function openDayClosing(day) {
  const chosen = day || $('#closingDate').value || todayKey();
  $('#closingDate').value = chosen; $('#closingDate').max = todayKey();
  try { closingData = await api('GET', `/api/day-closing?day=${chosen}`); }
  catch (error) { showToast(error.message); return; }
  floatTyped = false;
  renderClosing();
}

/* ----- The screen ----- */
function renderClosing() {
  const data = closingData, closed = data.closing, editable = !closed, modes = PAYMENT_MODES;
  $('#closingSubtitle').textContent = `${state.outlet.name} · ${formatKey(data.day)}. Count what is physically there and compare it with what the system recorded. The cash kept for change becomes tomorrow's opening cash.`;
  // notice: closed by whom, changes after closing, or earlier days still open
  const changed = closed ? modes.filter(mode => Math.abs(data.modes[mode].tally - closed.system[mode].tally) > 0.005) : [];
  let notice = '';
  if (closed) notice += `<div class="closing-banner done"><span class="status-badge status-paid">Closed</span><span>Closed by <strong>${escapeHtml(closed.closedBy)}</strong> on ${formatStamp(closed.closedAt)}. The figures below are as they were counted.</span></div>`;
  if (closed && changed.length) notice += `<div class="closing-banner warn"><span class="status-badge status-partial">Changed</span><span>Money moved on this day after it was closed (${changed.map(mode => `${mode} now ${cMoney(data.modes[mode].tally)}, was ${cMoney(closed.system[mode].tally)}`).join('; ')}). ${isAdmin() ? 'Reopen the day to count it again.' : 'Ask HQ to reopen the day to count it again.'}</span></div>`;
  if (editable && data.unclosedDays.length) notice += `<div class="closing-banner warn"><span class="status-badge status-partial">Not closed</span><span>Earlier days with sales that were never closed: ${data.unclosedDays.map(day => `<button type="button" class="link-button accent" data-closing-day="${day}">${formatKey(day)}</button>`).join(' · ')}</span></div>`;
  $('#closingNotice').innerHTML = notice;
  const digital = round2(['UPI', 'Card', 'Bank transfer'].reduce((sum, mode) => sum + data.modes[mode].in, 0));
  $('#closingKpis').innerHTML = kpi('Bills', data.bills.count, `${cMoney(data.bills.total)} billed`)
    + kpi('Cash received', cMoney(data.modes.Cash.in), `${cMoney(data.modes.Cash.refunds)} refunded in cash`)
    + kpi('Card, UPI & bank', cMoney(digital), 'received on this day')
    + kpi(data.loyalty > 0 ? 'Paid with points' : 'Returns', data.loyalty > 0 ? cMoney(data.loyalty) : data.returns.count, data.loyalty > 0 ? 'loyalty points, not money' : `${cMoney(data.returns.total)} credited`);
  // the tally
  const opening = closed ? closed.openingCash : (data.previousFloat ? data.previousFloat.amount : 0);
  const counted = mode => closed ? (closed.counted[mode] ?? '') : '';
  const cash = data.modes.Cash;
  const lockAttr = editable ? '' : 'disabled';
  const rows = [`<div class="ct-row ct-cash"><span><strong>Cash in drawer</strong><small>Opening cash + <span class="ct-in">${cMoney(cash.in)}</span> received − <span class="ct-out">${cMoney(cash.refunds)}</span> refunds − <span class="ct-out">${cMoney(cash.paidOut)}</span> paid out (expenses, suppliers)</small><div class="ct-open"><label for="dcOpening">Opening cash</label><div class="input-with-unit"><span>₹</span><input id="dcOpening" type="text" inputmode="decimal" autocomplete="off" value="${opening}" ${lockAttr} aria-label="Opening cash" /></div>${editable && data.previousFloat ? `<small class="ct-hint">Last closing (${formatKey(data.previousFloat.day)}) kept ${cMoney(data.previousFloat.amount)} for change</small>` : editable ? '<small class="ct-hint">No earlier closing: enter what was in the drawer at the start</small>' : ''}</div></span><span class="num" id="dcExpected-Cash">—</span><span class="num"><div class="input-with-unit"><span>₹</span><input class="dc-counted" data-mode="Cash" type="text" inputmode="decimal" autocomplete="off" value="${counted('Cash')}" ${lockAttr} aria-label="Cash counted" /></div></span><span class="num dc-diff" id="dcDiff-Cash">—</span></div>`];
  ['UPI', 'Card', 'Bank transfer'].forEach(mode => {
    const info = data.modes[mode];
    rows.push(`<div class="ct-row"><span><strong>${mode}</strong><small><span class="ct-in">${cMoney(info.in)}</span> received − <span class="ct-out">${cMoney(info.refunds)}</span> refunds${info.paidOut ? ` · ${cMoney(info.paidOut)} paid out this way is not counted` : ''}. Enter the total from ${MODE_SOURCE[mode]}.</small></span><span class="num" id="dcExpected-${mode.replace(/ /g, '_')}">${cMoney(info.tally)}</span><span class="num"><div class="input-with-unit"><span>₹</span><input class="dc-counted" data-mode="${mode}" type="text" inputmode="decimal" autocomplete="off" placeholder="${info.tally === 0 ? 'none' : ''}" value="${counted(mode)}" ${lockAttr} aria-label="${mode} total" /></div></span><span class="num dc-diff" id="dcDiff-${mode.replace(/ /g, '_')}">—</span></div>`);
  });
  $('#closingTable').innerHTML = `<div class="ct-head"><span>Payment mode</span><span class="num">System says</span><span class="num">You counted</span><span class="num">Difference</span></div>${rows.join('')}`;
  // what the system totals are made of
  const lineRows = [['sales', 'Sales and receipts from customers'], ['royalty', 'Royalty received'], ['refunds', 'Refunds for returns'], ['suppliers', 'Paid to suppliers'], ['expenses', 'Expenses paid']];
  $('#closingBreakdown').innerHTML = `<table class="report-table"><thead><tr><th></th>${modes.map(mode => `<th class="num">${mode}</th>`).join('')}</tr></thead><tbody>${lineRows.filter(([key]) => modes.some(mode => data.lines[key][mode])).map(([key, label]) => `<tr><td>${label}</td>${modes.map(mode => `<td class="num">${data.lines[key][mode] ? cMoney(data.lines[key][mode]) : '—'}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${modes.length + 1}">No money moved on this day.</td></tr>`}</tbody></table>`;
  // the drawer: count the notes, keep a float, deposit the rest
  const notes = closed ? closed.cashNotes : {};
  const floatValue = closed ? closed.floatKept : (data.previousFloat ? data.previousFloat.amount : 1000);
  $('#closingDrawer').innerHTML = `<div class="drawer-grid"><div class="drawer-faces"><h4>Count the cash <span>(helps you total it; or type the total above)</span></h4><div class="face-grid">${CLOSING_FACES.map(([face, label]) => `<label class="face"><span>${label}</span>${face === 1 ? '' : '<b>×</b>'}<input class="dc-face" data-face="${face}" type="text" inputmode="numeric" autocomplete="off" value="${notes[face] || ''}" ${lockAttr} aria-label="${label}" /><em id="dcFaceSum-${face}"></em></label>`).join('')}</div></div>
    <div class="drawer-result"><div class="dr-line"><span>Cash counted</span><strong id="dcCashCounted">—</strong></div>
    <div class="dr-line dr-float"><span>Keep in the drawer for change tomorrow</span><div class="float-box"><div class="input-with-unit"><span>₹</span><input id="dcFloat" type="text" inputmode="decimal" autocomplete="off" value="${floatValue}" ${lockAttr} aria-label="Cash kept for change" /></div>${editable ? '<button type="button" class="outline-button" data-float="500">₹500</button><button type="button" class="outline-button" data-float="1000">₹1,000</button>' : ''}</div></div>
    <div class="dr-line dr-deposit"><span>Cash to deposit / take out</span><strong id="dcDeposit">—</strong></div>
    <div class="dr-line"><span>Tomorrow's opening cash</span><strong id="dcTomorrow">—</strong></div></div></div>`;
  $('#closingNotes').value = closed ? closed.notes : ''; $('#closingNotes').disabled = !editable;
  $('#closingError').textContent = '';
  $('#closingActions').innerHTML = editable
    ? '<button class="primary-button" type="submit" id="closingSave">Close the day</button>'
    : `<button class="outline-button" type="button" id="closingPrint">Print report</button>${isAdmin() ? '<button class="link-button" type="button" id="closingReopen">Reopen this day</button>' : ''}`;
  updateClosing();
  renderClosingHistory();
}

// Recomputes every figure from what is typed; nothing is saved until the day is closed.
function updateClosing(fromFace = false) {
  const data = closingData, closed = data.closing;
  const opening = cNumber($('#dcOpening').value);
  // faces add up to the cash counted, unless the total was typed by hand
  const faces = $$('.dc-face'), faceTotal = round2(faces.reduce((sum, input) => { const count = Math.round(cNumber(input.value) || 0), face = Number(input.dataset.face); $(`#dcFaceSum-${face}`).textContent = count ? cMoney(count * face) : ''; return sum + count * face; }, 0));
  const cashBox = $('.dc-counted[data-mode="Cash"]');
  if (!closed && fromFace) cashBox.value = faceTotal > 0 ? String(faceTotal) : '';   // only while the notes are being counted
  const expectedCash = opening === null ? null : round2(opening + data.modes.Cash.net);
  $('#dcExpected-Cash').textContent = expectedCash === null ? '—' : cMoney(expectedCash);
  const diffs = {};
  PAYMENT_MODES.forEach(mode => {
    const key = mode.replace(/ /g, '_'), value = cNumber($(`.dc-counted[data-mode="${mode}"]`).value), expected = mode === 'Cash' ? expectedCash : data.modes[mode].tally;
    const cell = $(`#dcDiff-${key}`);
    cell.className = 'num dc-diff';
    if (value === null || expected === null) { cell.textContent = '—'; return; }
    const diff = round2(value - expected);
    diffs[mode] = diff;
    cell.textContent = Math.abs(diff) < 0.005 ? 'Matches' : `${diff > 0 ? '+' : '−'}${cMoney(Math.abs(diff))} ${diff > 0 ? 'over' : 'short'}`;
    cell.classList.add(Math.abs(diff) < 0.005 ? 'match' : diff < 0 ? 'short' : 'over');
  });
  const counted = cNumber(cashBox.value);
  $('#dcCashCounted').textContent = counted === null ? '—' : cMoney(counted);
  const floatBox = $('#dcFloat');
  if (!closed && !floatTyped && counted !== null) { const wanted = data.previousFloat ? data.previousFloat.amount : 1000; floatBox.value = String(Math.min(wanted, counted)); }
  const kept = cNumber(floatBox.value) ?? 0;
  $('#dcDeposit').textContent = counted === null ? '—' : cMoney(counted - kept);
  $('#dcDeposit').classList.toggle('neg', counted !== null && counted - kept < 0);
  $('#dcTomorrow').textContent = cMoney(kept);
  renderRecon();
  return { opening, counted, kept, diffs };
}
/* ----- Day's sales set against the money submitted ----- */
// Sales side: billed, less returns, credit and points, plus dues collected = money that should have come in.
// Submitted side: what was counted (cash less the opening cash, plus what was paid out of the drawer) and the card, UPI and bank totals.
function reconFigures(data, opening, countedOf) {
  const closed = data.closing, sales = (closed && closed.sales) || data.sales;
  const modeInfo = mode => (closed && closed.system[mode]) || data.modes[mode];
  const cash = countedOf('Cash');
  const royalty = round2(PAYMENT_MODES.reduce((sum, mode) => sum + (sales.royalty[mode] || 0), 0));
  const cashPaidOut = { expenses: (data.lines.expenses.Cash || 0), suppliers: (data.lines.suppliers.Cash || 0) };
  const digital = ['UPI', 'Card', 'Bank transfer'].map(mode => [mode, countedOf(mode) ?? 0]);
  const ready = cash !== null && opening !== null;
  const collected = ready ? round2(cash - opening + modeInfo('Cash').paidOut + digital.reduce((sum, [, value]) => sum + value, 0) - royalty) : null;
  return { sales, cash, opening, cashPaidOut, digital, royalty, collected, difference: collected === null ? null : round2(collected - sales.expected) };
}
function renderRecon() {
  const data = closingData, closed = data.closing;
  const opening = closed ? closed.openingCash : cNumber($('#dcOpening').value);
  const countedOf = mode => closed ? closed.counted[mode] : cNumber($(`.dc-counted[data-mode="${mode}"]`).value);
  const f = reconFigures(data, opening, countedOf), s = f.sales;
  const row = (label, value, cls = '') => `<div class="rc-row ${cls}"><span>${label}</span><span class="num">${value}</span></div>`;
  const other = (label, value) => Math.abs(value) < 0.005 ? '' : row(label, cMoney(value));
  const expensesByMode = PAYMENT_MODES.filter(mode => data.lines.expenses[mode]).map(mode => `${mode} ${cMoney(data.lines.expenses[mode])}`);
  const verdict = f.difference === null ? '<span class="rc-note">Enter the cash counted to compare</span>'
    : Math.abs(f.difference) < 0.005 ? '<span class="dc-diff match">Matches</span>'
    : `<span class="dc-diff ${f.difference < 0 ? 'short' : 'over'}">${f.difference > 0 ? '+' : '−'}${cMoney(Math.abs(f.difference))} ${f.difference > 0 ? 'more than the sales' : 'less than the sales'}</span>`;
  $('#closingRecon').innerHTML = `<div class="recon"><h4>Day's sales against the money you submitted</h4><div class="recon-grid">
    <div class="recon-col"><h5>What the system recorded</h5>
      ${row(`Billed (${data.bills.count} bill${data.bills.count === 1 ? '' : 's'})`, cMoney(s.billed))}
      ${other('− Returns credited', s.returns)}
      ${row('Net sales', cMoney(s.netSales), 'rc-sub')}
      ${other('− Left on credit (not paid yet)', s.onCredit)}
      ${other('− Paid with loyalty points', s.points)}
      ${other('+ Dues collected from earlier bills', s.dueCollected)}
      ${other('+ Returns not paid back in money', s.returnsKept)}
      ${row('Money that should have come in', cMoney(s.expected), 'rc-total')}
    </div>
    <div class="recon-col"><h5>What you submitted</h5>
      ${row('Cash counted', f.cash === null ? '—' : cMoney(f.cash))}
      ${row('− Opening cash', f.opening === null ? '—' : cMoney(f.opening), 'rc-minus')}
      ${other('+ Expenses paid from the drawer', f.cashPaidOut.expenses)}
      ${other('+ Paid to suppliers from the drawer', f.cashPaidOut.suppliers)}
      ${f.digital.map(([mode, value]) => other(`+ ${mode} total`, value)).join('')}
      ${other('− Royalty received (not a sale)', f.royalty)}
      ${row('Money collected per your count', f.collected === null ? '—' : cMoney(f.collected), 'rc-total')}
    </div></div>
    <div class="rc-verdict"><span>Difference</span>${verdict}</div>
    <p class="rc-foot">Expenses paid today: <strong>${cMoney(s.expenses)}</strong>${expensesByMode.length ? ` (${expensesByMode.join(', ')})` : ''}${s.suppliers ? ` · Paid to suppliers: <strong>${cMoney(s.suppliers)}</strong>` : ''}. Only what came out of the cash drawer is added back to the cash count; card, UPI and bank payments never touched the drawer.</p></div>`;
}
function renderClosingHistory() {
  $('#closingHistoryHead').textContent = `Past closings (${dayClosings.length})`;
  $('#closingHistory').innerHTML = dayClosings.length ? dayClosings.map(closing => {
    const total = round2(Object.values(closing.variance).reduce((sum, value) => sum + value, 0));
    return `<div class="closing-hist-row ${closingData && closing.day === closingData.day ? 'current' : ''}" data-closing-day="${closing.day}" tabindex="0" role="button"><span><strong>${formatKey(closing.day)}</strong></span><span class="num" data-label="Opening">${cMoney(closing.openingCash)}</span><span class="num" data-label="Cash expected">${cMoney(closing.system.Cash.expected)}</span><span class="num" data-label="Cash counted">${cMoney(closing.cashCounted)}</span><span class="num ${Math.abs(total) < 0.005 ? '' : total < 0 ? 'due-text' : 'over-text'}" data-label="Difference">${Math.abs(total) < 0.005 ? 'Matches' : `${total > 0 ? '+' : '−'}${cMoney(Math.abs(total))}`}</span><span class="num" data-label="Deposit">${cMoney(closing.deposit)}</span><span data-label="Closed by">${escapeHtml(closing.closedBy || '—')}</span></div>`;
  }).join('') : '<div class="purchase-empty">No day has been closed yet</div>';
}

/* ----- Wiring ----- */
$('#closingDate').addEventListener('change', event => { if (event.target.value) openDayClosing(event.target.value); });
document.addEventListener('click', event => { const link = event.target.closest('[data-closing-day]'); if (link && $('#closingView') && !$('#closingView').classList.contains('hidden')) openDayClosing(link.dataset.closingDay); });
$('#closingHistory').addEventListener('keydown', event => { const row = event.target.closest('[data-closing-day]'); if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openDayClosing(row.dataset.closingDay); } });
$('#closingForm').addEventListener('input', event => {
  const target = event.target;
  if (target.matches('#dcOpening, .dc-counted, #dcFloat')) digits(target);
  if (target.matches('.dc-face')) target.value = target.value.replace(/\D/g, '');
  if (target.id === 'dcFloat') floatTyped = true;
  if (target.matches('.dc-counted[data-mode="Cash"]')) $$('.dc-face').forEach(face => { face.value = ''; });   // a typed total replaces the note count
  $('#closingError').textContent = '';
  updateClosing(target.matches('.dc-face'));
});
$('#closingForm').addEventListener('click', event => {
  const preset = event.target.closest('[data-float]');
  if (preset) { $('#dcFloat').value = preset.dataset.float; floatTyped = true; updateClosing(); return; }
  if (event.target.closest('#closingPrint')) { showClosingDoc(closingData.closing); return; }
  if (event.target.closest('#closingReopen')) {
    if (!confirm(`Reopen ${formatKey(closingData.day)}? The saved count is removed and the day can be counted again.`)) return;
    submitting(event.target.closest('#closingReopen'), async () => {
      await api('POST', `/api/day-closings/${closingData.closing.id}/reopen`, {});
      await loadState();
      await openDayClosing(closingData.day);
      showToast('Day reopened. Count it again');
    });
  }
});
$('#closingForm').addEventListener('submit', event => {
  event.preventDefault();
  if (closingData.closing) return;
  submitting($('#closingSave'), async () => {
    const figures = updateClosing(), problem = text => { $('#closingError').textContent = text; showToast(text); };
    if (figures.opening === null) { problem('Enter the cash that was in the drawer when the day started'); $('#dcOpening').focus(); return; }
    if (figures.counted === null) { problem('Enter the cash you counted in the drawer'); $('.dc-counted[data-mode="Cash"]').focus(); return; }
    const counted = {};
    for (const mode of PAYMENT_MODES) {
      const value = cNumber($(`.dc-counted[data-mode="${mode}"]`).value);
      if (value !== null && value < 0) { problem(`The ${mode} amount cannot be negative`); return; }
      if (mode !== 'Cash' && value === null && Math.abs(closingData.modes[mode].tally) > 0.004) { problem(`Enter the ${mode} total from ${MODE_SOURCE[mode]}`); $(`.dc-counted[data-mode="${mode}"]`).focus(); return; }
      counted[mode] = value;
    }
    if (figures.kept > figures.counted) { problem('The cash kept for change cannot be more than the cash counted'); $('#dcFloat').focus(); return; }
    const notes = $('#closingNotes').value.trim(), off = Object.entries(figures.diffs).filter(([, diff]) => Math.abs(diff) >= 0.005);
    if (off.length && !notes) { problem('Something does not match. Add a note explaining the difference'); $('#closingNotes').focus(); return; }
    if (off.length && !confirm(`These do not match:\n${off.map(([mode, diff]) => `${mode}: ${diff > 0 ? 'over' : 'short'} by ${cMoney(Math.abs(diff))}`).join('\n')}\n\nClose ${formatKey(closingData.day)} anyway?`)) return;
    const cashNotes = {};
    $$('.dc-face').forEach(input => { const count = Math.round(cNumber(input.value) || 0); if (count > 0) cashNotes[input.dataset.face] = count; });
    let closing;
    try { closing = await api('POST', '/api/day-closings', { day: closingData.day, openingCash: figures.opening, counted, floatKept: figures.kept, cashNotes, notes }); }
    catch (error) { problem(error.message); return; }
    await loadState();
    await openDayClosing(closingData.day);
    showToast(`${formatKey(closing.day)} closed · deposit ${cMoney(closing.deposit)}, ${cMoney(closing.floatKept)} kept for tomorrow`);
    showClosingDoc(closing);
  });
});

/* ----- Printable report ----- */
function closingDocHtml(closing) {
  const store = outletById(closing.outletId);
  const rows = PAYMENT_MODES.filter(mode => closing.counted[mode] !== null || Math.abs(closing.system[mode].tally) > 0.004 || mode === 'Cash').map(mode => {
    const expected = closing.system[mode].expected, counted = closing.counted[mode], diff = closing.variance[mode];
    return `<tr><td><strong>${mode}</strong></td><td>${cMoney(expected)}</td><td>${counted === null ? '—' : cMoney(counted)}</td><td>${counted === null || Math.abs(diff) < 0.005 ? '—' : `${diff > 0 ? '+' : '−'}${cMoney(Math.abs(diff))}`}</td></tr>`;
  }).join('');
  const totalRow = (label, value, strong = false) => `<div class="${strong ? 'inv-grand' : ''}"><span>${label}</span><span>${value}</span></div>`;
  const notes = Object.entries(closing.cashNotes).sort((a, b) => b[0] - a[0]).map(([face, count]) => `${face === '1' ? 'coins' : `₹${face}`} × ${count}`).join(' · ');
  return `<div class="inv-head"><div><h2>${escapeHtml(store.name)}</h2>${store.address ? `<p>${escapeHtml(store.address)}</p>` : ''}</div><div class="inv-meta"><span class="bill-label">DAY CLOSING</span><strong>${formatKey(closing.day)}</strong><p>Closed ${formatStamp(closing.closedAt)}</p><p>by ${escapeHtml(closing.closedBy)}</p></div></div>
    <table class="inv-table"><thead><tr><th>Mode</th><th>System</th><th>Counted</th><th>Diff.</th></tr></thead><tbody>${rows}</tbody></table>
    ${closing.sales ? reconDocHtml(closing) : ''}
    <div class="inv-totals">${totalRow('Opening cash', cMoney(closing.openingCash))}${totalRow('Cash counted', cMoney(closing.cashCounted))}${totalRow('Kept for change', cMoney(closing.floatKept))}${totalRow('To deposit', cMoney(closing.deposit), true)}</div>
    ${notes ? `<p class="inv-pay">Notes and coins: ${notes}</p>` : ''}${closing.notes ? `<p class="inv-pay">Note: ${escapeHtml(closing.notes)}</p>` : ''}
    <p class="inv-foot">Signature: ______________________</p>`;
}
function reconDocHtml(closing) {
  const s = closing.sales, countedOf = mode => closing.counted[mode];
  const cashPaid = closing.system.Cash.paidOut || 0;
  const digitalTotal = round2(['UPI', 'Card', 'Bank transfer'].reduce((sum, mode) => sum + (countedOf(mode) ?? 0), 0));
  const royalty = round2(Object.values(s.royalty || {}).reduce((sum, value) => sum + value, 0));
  const collected = round2(closing.cashCounted - closing.openingCash + cashPaid + digitalTotal - royalty), diff = round2(collected - s.expected);
  const line = (label, value, strong = false) => `<tr><td>${strong ? `<strong>${label}</strong>` : label}</td><td>${strong ? `<strong>${value}</strong>` : value}</td></tr>`;
  const verdict = Math.abs(diff) < 0.005 ? 'Matches' : `${diff > 0 ? '+' : '−'}${cMoney(Math.abs(diff))}`;
  return `<table class="inv-table"><thead><tr><th>Day's sales against money submitted</th><th></th></tr></thead><tbody>
    ${line(`Net sales (billed ${cMoney(s.billed)} less returns ${cMoney(s.returns)})`, cMoney(s.netSales))}
    ${line('Left on credit / paid with points', cMoney(s.onCredit + s.points))}
    ${line('Money that should have come in', cMoney(s.expected), true)}
    ${line('Cash counted less opening cash', cMoney(closing.cashCounted - closing.openingCash))}
    ${line('Expenses and supplier payments from the drawer', cMoney(cashPaid))}
    ${line('Card, UPI and bank totals', cMoney(digitalTotal))}
    ${line('Money collected per count', cMoney(collected), true)}
    ${line('Difference', verdict, true)}
    ${line('Expenses paid today (all modes)', cMoney(s.expenses))}</tbody></table>`;
}
function showClosingDoc(closing) {
  if (!closing) return;
  currentDoc = { type: 'closing', id: closing.id };
  $('#invoiceContent').innerHTML = closingDocHtml(closing);
  $('#returnFromInvoice').classList.add('hidden');
  $('#shareInvoice').classList.add('hidden');
  $('#invoiceModal').classList.remove('hidden');
}

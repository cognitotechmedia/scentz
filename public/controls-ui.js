/* Durable bill recovery and HQ review tools. All authorization stays on server. */
const pendingBillKey = () => `scentz-pending-bill-${state.me.id}-${state.outlet.id}`;
function pendingBill() {
  if (!state.me || !state.outlet) return null;
  const raw = localStorage.getItem(pendingBillKey());
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { throw new Error('Saved billing attempt is unreadable. Keep this browser data and contact support before billing again.'); }
}
function billRequestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2, '0')).join('');
}
async function submitSafeBill(body) {
  let request = pendingBill();
  if (!request) {
    request = { ...body, requestId: billRequestId() };
    const encoded = JSON.stringify(request);
    try {
      localStorage.setItem(pendingBillKey(), encoded);
      if (localStorage.getItem(pendingBillKey()) !== encoded) throw new Error('not stored');
    } catch { throw new Error('Allow browser storage before billing, so a lost connection cannot create a duplicate bill.'); }
  }
  renderPendingBill();
  try {
    const sale = await api('POST', '/api/sales', request);
    localStorage.removeItem(pendingBillKey());
    renderPendingBill();
    return sale;
  } catch (error) {
    // These responses are definitive validation/permission failures. A network
    // error, server error or conflict stays recoverable with the same request.
    if ([400, 403, 404, 422].includes(error.status)) localStorage.removeItem(pendingBillKey());
    renderPendingBill();
    throw error;
  }
}
async function recoverPendingBill() {
  const request = pendingBill();
  if (!request) return;
  const sale = await submitSafeBill(request);
  resetBillForm();
  await reloadAll();
  showInvoice(sale.id);
  showToast(`Recovered ${sale.number}. Check this bill before taking any further payment.`);
}
const pendingPanel = document.createElement('div');
pendingPanel.className = 'closing-banner warn hidden';
pendingPanel.innerHTML = '<span>A previous bill needs confirmation. Recover it before starting another bill. Its saved details will be used.</span><button type="button" class="outline-button" id="recoverPending">Recover bill</button><button type="button" class="outline-button" id="cancelPending">Check and discard unsaved attempt</button>';
$('#createBill').before(pendingPanel);
function renderPendingBill() {
  pendingPanel.classList.toggle('hidden', !pendingBill());
}
$('#recoverPending').addEventListener('click', () => submitting($('#recoverPending'), recoverPendingBill));
$('#cancelPending').addEventListener('click', () => submitting($('#cancelPending'), async () => {
  const request = pendingBill();
  if (!request) return;
  if (!confirm('Check with the server and discard this attempt only if it has not been saved? A saved bill will be recovered instead.')) return;
  const result = await api('POST', `/api/sale-requests/${request.requestId}/cancel`, { request });
  if (!result.cancelled) { await recoverPendingBill(); return; }
  localStorage.removeItem(pendingBillKey()); renderPendingBill();
}));

const reviewModal = document.createElement('div');
reviewModal.className = 'modal-backdrop hidden';
reviewModal.id = 'controlReview';
reviewModal.setAttribute('role', 'dialog'); reviewModal.setAttribute('aria-modal', 'true'); reviewModal.setAttribute('aria-labelledby', 'controlReviewTitle');
reviewModal.innerHTML = '<div class="blend-modal invoice-modal"><div class="modal-heading"><h2 id="controlReviewTitle"></h2><button type="button" class="modal-close" id="closeControlReview" aria-label="Close">×</button></div><div id="controlReviewBody"></div><button type="button" class="outline-button hidden" id="auditMore">Older changes</button></div>';
document.body.append(reviewModal);
$('#closeControlReview').addEventListener('click', () => reviewModal.classList.add('hidden'));
function openControlReview(title) {
  closeModal('#settingsModal');
  $('#controlReviewTitle').textContent = title;
  $('#controlReviewBody').textContent = 'Loading…';
  $('#auditMore').classList.add('hidden'); reviewModal.classList.remove('hidden');
  $('#closeControlReview').focus();
}
let auditCursor = null;
async function showAudit(older = false) {
  if (!older) openControlReview('Audit history');
  const data = await api('GET', '/api/audit' + (older && auditCursor ? `?before=${auditCursor}` : ''));
  auditCursor = data.next;
  $('#controlReviewBody').innerHTML = '<p>Changes are retained with their previous and new values. Passwords and session tokens are excluded.</p>' + data.rows.map(row => `<details><summary>${escapeHtml(row.occurred_at)} · ${escapeHtml(row.actor || 'System')} · ${escapeHtml(row.entity)} ${escapeHtml(row.operation)}</summary><p>${escapeHtml(row.action)}</p><pre class="audit-json">${escapeHtml(JSON.stringify({ before: row.before_json ? JSON.parse(row.before_json) : null, after: row.after_json ? JSON.parse(row.after_json) : null }, null, 2))}</pre></details>`).join('');
  $('#auditMore').classList.toggle('hidden', !auditCursor);
}
$('#openAudit').addEventListener('click', () => submitting($('#openAudit'), () => showAudit()));
$('#auditMore').addEventListener('click', () => submitting($('#auditMore'), () => showAudit(true)));
async function showReconciliation() {
  openControlReview('Franchise reconciliation');
  const data = await api('GET', '/api/reconciliation');
  $('#controlReviewBody').innerHTML = `<p>Linked receipts and payments update both outlets automatically. Enter a transfer once. Historical differences below need HQ review; corrections are included in today's closing.</p><div class="table-scroll"><table class="report-table"><thead><tr><th>Invoice / purchase</th><th>Seller net / buyer total</th><th>Seller received / buyer paid</th><th>Review</th></tr></thead><tbody>${data.pairs.map(p => {
    const totalsMatch = Math.abs(p.saleTotal - p.purchaseTotal) < 0.005, paidMatch = Math.abs(p.sellerPaid - p.buyerPaid) < 0.005;
    return `<tr><td>${escapeHtml(p.saleNumber)}<br>${escapeHtml(p.purchaseNumber)}</td><td>${currency(p.saleTotal)} / ${currency(p.purchaseTotal)}</td><td>${currency(p.sellerPaid)} / ${currency(p.buyerPaid)}</td><td>${!totalsMatch ? 'Stock and credit-note review required; settlement blocked' : paidMatch ? 'Matched' : `<button class="outline-button" type="button" data-reconcile="${p.saleId}" data-authority="sale">Use confirmed seller ledger</button><button class="outline-button" type="button" data-reconcile="${p.saleId}" data-authority="purchase">Use confirmed buyer ledger</button>`}</td></tr>`;
  }).join('') || '<tr><td colspan="4">No linked purchases yet.</td></tr>'}</tbody></table></div><h3>Earlier invoices awaiting an outlet link</h3><p>Choose the actual buyer; the GSTIN must match. A link cannot be reassigned after it is saved.</p>${data.unlinked.map(sale => `<div class="field-group"><strong>${escapeHtml(sale.number)} · ${escapeHtml(sale.customer)} · ${escapeHtml(sale.gstin)}</strong><select data-link-select="${sale.id}"><option value="">Choose receiving outlet</option>${state.outlets.filter(o => o.type === 'franchise' && o.active && o.gstin === sale.gstin).map(o => `<option value="${o.id}">${escapeHtml(o.name)} (${escapeHtml(o.code)})</option>`).join('')}</select><button type="button" class="outline-button" data-link-sale="${sale.id}">Confirm outlet</button></div>`).join('') || '<p>None.</p>'}`;
}
$('#openReconciliation').addEventListener('click', () => submitting($('#openReconciliation'), showReconciliation));
$('#controlReviewBody').addEventListener('click', event => {
  const button = event.target.closest('[data-reconcile], [data-link-sale]');
  if (!button) return;
  submitting(button, async () => {
    if (button.dataset.reconcile) {
      const reason = prompt('Explain the historical difference and how you confirmed the correct ledger (at least 5 characters):');
      if (!reason || reason.trim().length < 5) return;
      const mode = prompt('Payment mode to correct: Cash, UPI, Card, or Bank transfer', 'Bank transfer');
      if (!mode) return;
      if (!confirm('Apply this correction to the other outlet? It will be permanently recorded in the audit history and today’s closing.')) return;
      await api('POST', `/api/inter-outlet/${button.dataset.reconcile}/reconcile`, { authority: button.dataset.authority, reason, mode });
    } else {
      const id = button.dataset.linkSale, buyerOutletId = $(`[data-link-select="${id}"]`).value;
      if (!buyerOutletId || !confirm('Confirm this outlet is the buyer of the invoice?')) return;
      await api('POST', `/api/inter-outlet/${id}/link`, { buyerOutletId });
    }
    await reloadAll(); await showReconciliation();
  });
});
const historyButton = document.createElement('button');
historyButton.type = 'button'; historyButton.className = 'outline-button role-staff'; historyButton.textContent = 'Reopened closing history';
$('#settingsForm button[type="submit"]').before(historyButton);
historyButton.addEventListener('click', () => submitting(historyButton, async () => {
  openControlReview('Reopened closing history');
  const rows = await api('GET', '/api/closing-history');
  $('#controlReviewBody').innerHTML = rows.map(row => `<details><summary>${escapeHtml(row.day)} · reopened ${escapeHtml(row.reopened_at)}</summary><p>${escapeHtml(row.reason)}</p><pre class="audit-json">${escapeHtml(JSON.stringify(JSON.parse(row.snapshot), null, 2))}</pre></details>`).join('') || '<p>No reopened closings.</p>';
}));

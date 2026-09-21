/* Client state. Everything of value lives on the server; the browser keeps only
   the unfinished bill (per user and outlet) and which outlet HQ was last viewing. */
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = { me: null, outlet: null, outlets: [], hqOutletId: null, settings: { taxMode: 'inclusive' }, transfers: [] };
// The arrays are refilled in place after every reload so every view can keep using the same references.
const rawMaterials = [], products = [], customers = [], sales = [], purchases = [], expenses = [], creditNotes = [], stockCounts = [], vouchers = [], salesmen = [], dayClosings = [];
const db = { cart: [] };
const isAdmin = () => state.me?.role === 'admin';
const isBiller = () => state.me?.role === 'biller';   // billing counter login: bills, customers and payments only
const BILLER_VIEWS = ['billing', 'sales', 'products', 'customers', 'vouchers'];
const outletById = id => state.outlets.find(outlet => outlet.id === id) || state.outlet;
const findMaterial = id => rawMaterials.find(material => material.id === id);

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } }
};
let selectedOutlet = storage.get('vv-outlet');

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function api(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (selectedOutlet) headers['X-Outlet-Id'] = selectedOutlet;
  let response;
  try { response = await fetch(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }); }
  catch { throw new ApiError(0, 'Cannot reach the server. Check your connection'); }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && url !== '/api/login') showLogin();
  if (!response.ok) throw new ApiError(response.status, data.error || 'Something went wrong');
  return data;
}
const fill = (target, items) => target.splice(0, target.length, ...items);

/* ---------- Loading ---------- */
const cartKey = () => `vv-cart-${state.me.id}-${state.outlet.id}`;
let loadedCartKey = null;
async function loadState() {
  const data = await api('GET', '/api/state');
  Object.assign(state, { me: data.me, outlet: data.outlet, outlets: data.outlets, hqOutletId: data.hqOutletId, settings: data.settings, transfers: data.transfers });
  fill(rawMaterials, data.materials); fill(products, data.products); fill(customers, data.customers);
  fill(sales, data.sales); fill(purchases, data.purchases); fill(expenses, data.expenses); fill(creditNotes, data.creditNotes); fill(stockCounts, data.stockCounts); fill(vouchers, data.vouchers || []); fill(salesmen, data.salesmen || []); fill(dayClosings, data.dayClosings || []);
  if (isAdmin()) { selectedOutlet = String(data.outlet.id); storage.set('vv-outlet', selectedOutlet); }
  // The draft bill is only read back when the user or outlet changed; a plain reload keeps the live cart.
  if (loadedCartKey !== cartKey()) {
    loadedCartKey = cartKey();
    try { db.cart = JSON.parse(storage.get(loadedCartKey)) || []; } catch { db.cart = []; }
  }
}
function persistCart() { storage.set(cartKey(), JSON.stringify(db.cart)); }

/* ---------- CSV export ---------- */
function downloadCsv(filename, rows) {
  const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const blob = new Blob(['﻿' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/* ---------- Shared UI helpers ---------- */
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message; toast.classList.add('show');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}
function setFieldError(inputId, message) {
  const input = $(`#${inputId}`);
  input.closest('.customer-input').classList.toggle('invalid', Boolean(message));
  input.setAttribute('aria-invalid', String(Boolean(message)));
  $(`#${inputId}Error`).textContent = message;
}
const optionList = values => values.map(value => `<option value="${value}">${value}</option>`).join('');
const closeModal = selector => $(selector).classList.add('hidden');
// Runs a server action with a busy button, showing the server's message on failure.
async function submitting(button, action) {
  if (button.dataset.busy) return;
  button.dataset.busy = '1';
  try { return await action(); }
  catch (error) { showToast(error.message); }
  finally { delete button.dataset.busy; }
}

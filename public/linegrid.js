/* ---------- Line-by-line entry grid ----------
   Each row is one item. Type an item code, an EAN/barcode or part of a name in the Code cell,
   press Enter, and the cursor moves across the row. Enter on the last cell starts the next row. */
const lineGrids = [];
let suggestState = null;     // { grid, row, input, list, active }
let suggestEl = null;

// An exact code or EAN wins outright (that is what a barcode scanner sends); otherwise match by name.
function searchItems(query, pool, limit = 8) {
  const raw = query.trim(), q = raw.toLowerCase();
  if (!q) return [];
  const exact = pool.filter(item => (item.code || '').toLowerCase() === q || (item.ean && item.ean === raw));
  if (exact.length) return exact.slice(0, limit);
  const tokens = q.split(/\s+/);
  return pool.map(item => {
    const name = item.name.toLowerCase(), code = (item.code || '').toLowerCase();
    if (!tokens.every(token => `${name} ${code} ${item.ean || ''} ${item.type.toLowerCase()}`.includes(token))) return null;
    const score = code.startsWith(q) ? 0 : (item.ean || '').startsWith(raw) ? 1 : name.startsWith(q) ? 2 : name.includes(q) ? 3 : 4;
    return { item, score };
  }).filter(Boolean).sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name)).slice(0, limit).map(entry => entry.item);
}

function hideSuggest() {
  suggestState = null;
  if (suggestEl) suggestEl.classList.add('hidden');
}
function renderSuggest() {
  if (!suggestEl) {
    suggestEl = document.createElement('div');
    suggestEl.className = 'lg-suggest hidden';
    suggestEl.setAttribute('role', 'listbox');
    document.body.appendChild(suggestEl);
    // mousedown (not click) so the input keeps focus and the choice is made before it blurs
    suggestEl.addEventListener('mousedown', event => {
      const option = event.target.closest('[data-index]');
      if (!option || !suggestState) return;
      event.preventDefault();
      suggestState.grid.choose(suggestState.row, suggestState.list[Number(option.dataset.index)]);
    });
  }
  if (!suggestState) { suggestEl.classList.add('hidden'); return; }
  const { input, list, active } = suggestState, box = input.getBoundingClientRect();
  suggestEl.style.left = `${box.left}px`;
  suggestEl.style.top = `${box.bottom + 4}px`;
  suggestEl.style.minWidth = `${Math.max(box.width, 440)}px`;
  suggestEl.innerHTML = list.length
    ? list.map((item, index) => `<div class="lg-option ${index === active ? 'active' : ''}" role="option" data-index="${index}"><span class="lg-o-code">${escapeHtml(item.code || '')}</span><span class="lg-o-name">${escapeHtml(item.name)}</span><span class="lg-o-meta">${escapeHtml(item.type)}${item.stock == null ? '' : ` · ${fmtQty(item.stock, item.unit)}`}${item.ean ? ` · ${escapeHtml(item.ean)}` : ''}</span></div>`).join('')
    : '<div class="lg-none">No item matches. Check the code, barcode or spelling.</div>';
  suggestEl.classList.remove('hidden');
  // Open above the cell when there is no room below it.
  suggestEl.style.maxHeight = '320px';
  const height = suggestEl.offsetHeight;
  if (box.bottom + 4 + height > innerHeight - 8) {
    if (box.top - 4 - height >= 8) suggestEl.style.top = `${box.top - 4 - height}px`;
    else { suggestEl.style.maxHeight = `${Math.max(120, Math.max(box.top, innerHeight - box.bottom) - 16)}px`; if (box.top > innerHeight - box.bottom) suggestEl.style.top = `${Math.max(8, box.top - 4 - suggestEl.offsetHeight)}px`; }
  }
  const current = suggestEl.querySelector('.active');
  if (current) current.scrollIntoView({ block: 'nearest' });
}
window.addEventListener('resize', hideSuggest);
// Scrolling the page closes the list, but scrolling inside the list itself must not.
window.addEventListener('scroll', event => { if (!(suggestEl && suggestEl.contains(event.target))) hideSuggest(); }, true);

function createLineGrid(root, config) {
  const columns = config.columns;
  const grid = { root, config, rows: [], dirty: false };
  root.classList.add('lg');
  root.style.setProperty('--lg-cols', columns.map(column => column.width || '1fr').join(' '));
  root.innerHTML = `<div class="lg-head" role="row">${columns.map(column => `<div class="lg-hcell ${column.align === 'right' ? 'num' : ''}">${column.label || ''}</div>`).join('')}</div><div class="lg-body"></div>`;
  const body = root.querySelector('.lg-body');
  const pool = () => config.pool();

  const cellHtml = column => {
    const right = column.align === 'right' ? 'num' : '';
    if (column.type === 'index') return '<div class="lg-cell lg-index"></div>';
    if (column.type === 'code') return '<div class="lg-cell"><input class="lg-code" type="text" autocomplete="off" spellcheck="false" placeholder="Code, EAN or name" aria-label="Item code, EAN or name" /></div>';
    if (column.type === 'out') return `<div class="lg-cell lg-out ${right}" data-key="${column.key}"></div>`;
    if (column.type === 'input') return `<div class="lg-cell"><input class="lg-input ${right}" data-key="${column.key}" type="text" inputmode="${column.text ? 'text' : 'decimal'}" autocomplete="off" ${column.text ? 'maxlength="200"' : ''} placeholder="${column.placeholder || ''}" aria-label="${column.label || column.key}" /></div>`;
    return '<div class="lg-cell lg-remove"><button type="button" class="remove-line" tabindex="-1" aria-label="Remove row">×</button></div>';
  };
  const inputsOf = row => [...row.el.querySelectorAll('.lg-input:not(:disabled)')];
  const codeOf = row => row.el.querySelector('.lg-code');
  const flash = row => { row.el.classList.add('lg-flash'); setTimeout(() => row.el.classList.remove('lg-flash'), 900); };

  function refreshRow(row) {
    const code = codeOf(row);
    if (row.item && document.activeElement !== code) code.value = row.item.code || '';
    columns.forEach(column => {
      if (column.type === 'out') row.el.querySelector(`.lg-out[data-key="${column.key}"]`).innerHTML = (row.item || column.always) ? (column.out(row) ?? '') : '';
      if (column.type === 'input') {
        const input = row.el.querySelector(`.lg-input[data-key="${column.key}"]`), value = row.values[column.key] ?? '';
        if (document.activeElement !== input && input.value !== String(value)) input.value = value;
        input.disabled = !row.item || Boolean(column.disabled && column.disabled(row));
      }
    });
    row.el.classList.toggle('lg-filled', Boolean(row.item));
  }
  function renumber() { grid.rows.forEach((row, index) => { const cell = row.el.querySelector('.lg-index'); if (cell) cell.textContent = index + 1; }); }
  function ensureBlank() { const last = grid.rows[grid.rows.length - 1]; if (!last || last.item) addRow(); }
  function changed() { grid.dirty = true; if (config.onChange) config.onChange(grid); }

  function addRow(item = null, values = {}) {
    const row = { item, values, el: document.createElement('div') };
    row.el.className = 'lg-row';
    row.el.innerHTML = columns.map(cellHtml).join('');
    body.appendChild(row.el);
    grid.rows.push(row);
    wire(row);
    refreshRow(row);
    renumber();
    return row;
  }
  function focusFirst(row) {
    const first = inputsOf(row)[0];
    if (first) { first.focus(); first.select(); } else focusCode(nextRow(row));
  }
  function focusCode(row) { if (row) { codeOf(row).focus(); codeOf(row).select(); } }
  function nextRow(row) { const index = grid.rows.indexOf(row); if (index === grid.rows.length - 1) addRow(); return grid.rows[index + 1]; }

  grid.choose = (row, item) => {
    const duplicate = grid.rows.find(other => other !== row && other.item && other.item.id === item.id);
    hideSuggest();
    if (config.accept && config.accept(item) === false) { codeOf(row).value = row.item ? row.item.code || '' : ''; return; }
    if (duplicate) {
      codeOf(row).value = row.item ? row.item.code || '' : '';
      flash(duplicate); focusFirst(duplicate);
      if (config.onDuplicate) config.onDuplicate(item, duplicate);
      return;
    }
    row.item = item;
    codeOf(row).value = item.code || '';
    row.values = config.defaults ? { ...config.defaults(item, row) } : {};
    row.edited = null;
    if (config.compute) config.compute(row);
    ensureBlank();
    refreshRow(row);
    if (config.onSelect) config.onSelect(row);
    changed();
    focusFirst(row);
  };
  grid.removeRow = row => {
    if (grid.rows.length === 1) { row.item = null; row.values = {}; codeOf(row).value = ''; refreshRow(row); }
    else { row.el.remove(); grid.rows.splice(grid.rows.indexOf(row), 1); ensureBlank(); }
    renumber(); changed();
  };
  grid.clear = () => { body.innerHTML = ''; grid.rows = []; addRow(); grid.dirty = false; if (config.onChange) config.onChange(grid); };
  grid.setRows = list => {
    body.innerHTML = ''; grid.rows = [];
    list.forEach(entry => { const row = addRow(entry.item, { ...entry.values }); Object.assign(row, entry.props || {}); if (config.compute) config.compute(row); refreshRow(row); });
    ensureBlank(); renumber(); grid.dirty = false;
    if (config.onChange) config.onChange(grid);
  };
  grid.deleteActive = () => {
    const row = grid.activeRow();
    if (!row) return;
    const index = grid.rows.indexOf(row);
    grid.removeRow(row);
    focusCode(grid.rows[Math.min(index, grid.rows.length - 1)]);
  };
  grid.itemRows = () => grid.rows.filter(row => row.item);
  grid.activeRow = () => grid.rows.find(row => row.el.contains(document.activeElement));
  grid.focusNew = () => focusCode(grid.rows.find(row => !row.item) || (ensureBlank(), grid.rows[grid.rows.length - 1]));
  // Recompute every row (for example after a mode switch or after the item list reloaded).
  grid.refreshAll = () => {
    grid.rows.forEach(row => {
      if (row.item) row.item = pool().find(item => item.id === row.item.id) || row.item;
      if (config.compute) config.compute(row);
      refreshRow(row);
    });
    if (config.onChange) config.onChange(grid);
  };
  grid.flash = flash;
  grid.refreshRow = refreshRow;

  function wire(row) {
    row.el.addEventListener('input', event => {
      const target = event.target, column = columns.find(entry => entry.key === target.dataset.key);
      if (target.classList.contains('lg-code')) {
        const list = searchItems(target.value, pool());
        suggestState = target.value.trim() ? { grid, row, input: target, list, active: 0 } : null;
        renderSuggest();
      } else if (column) {
        if (!column.text) { const clean = target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'); if (clean !== target.value) target.value = clean; }
        row.values[column.key] = target.value;
        row.edited = column.key;
        if (config.compute) config.compute(row);
        if (config.onEdit) config.onEdit(row);
        refreshRow(row);
        changed();
      }
    });
    row.el.addEventListener('focusin', event => { if (event.target.matches('.lg-code, .lg-input')) event.target.select(); });
    row.el.addEventListener('focusout', event => {
      if (!event.target.classList.contains('lg-code')) return;
      setTimeout(() => { if (suggestState && suggestState.input === event.target) hideSuggest(); if (row.item) codeOf(row).value = row.item.code || ''; }, 130);
    });
    row.el.addEventListener('click', event => { if (event.target.closest('.remove-line')) grid.removeRow(row); });
    row.el.addEventListener('keydown', event => {
      const target = event.target, isCode = target.classList.contains('lg-code');
      if (!isCode && !target.classList.contains('lg-input')) return;
      const index = grid.rows.indexOf(row);
      if (event.key === 'Enter') {
        event.preventDefault();
        if (isCode) {
          const list = suggestState && suggestState.row === row ? suggestState.list : searchItems(target.value, pool());
          const choice = list[suggestState && suggestState.row === row ? suggestState.active : 0];
          if (choice) grid.choose(row, choice);
          else if (!target.value.trim() && row.item) focusFirst(row);
          else if (target.value.trim()) { renderSuggest(); suggestState = { grid, row, input: target, list: [], active: 0 }; renderSuggest(); }
        } else {
          const inputs = inputsOf(row), position = inputs.indexOf(target);
          if (position < inputs.length - 1) { inputs[position + 1].focus(); inputs[position + 1].select(); }
          else {
            // The last cell finishes the row: a screen can save it right now (returning false keeps the cursor here).
            if (config.commitRow && config.commitRow(row) === false) return;
            focusCode(nextRow(row));
          }
        }
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        if (isCode && suggestState && suggestState.row === row && suggestState.list.length) {
          event.preventDefault();
          suggestState.active = (suggestState.active + step + suggestState.list.length) % suggestState.list.length;
          renderSuggest();
        } else {
          const other = grid.rows[index + step];
          if (!other) return;
          event.preventDefault();
          const same = isCode ? codeOf(other) : other.el.querySelector(`.lg-input[data-key="${target.dataset.key}"]:not(:disabled)`);
          (same || codeOf(other)).focus(); (same || codeOf(other)).select();
        }
      } else if (event.key === 'Escape' && isCode) {
        hideSuggest(); target.value = row.item ? row.item.code || '' : '';
      } else if (event.key === 'Tab' && !event.shiftKey && isCode && suggestState && suggestState.row === row && suggestState.list.length === 1) {
        event.preventDefault(); grid.choose(row, suggestState.list[0]);
      }
    });
  }
  lineGrids.push(grid);
  addRow();
  return grid;
}

/* ---------- Function keys (F3 delete row, F5, F6 save, F12 clear...) ---------- */
const gridOnScreen = within => lineGrids.find(grid => grid.root.getClientRects().length > 0 && (!within || within.contains(grid.root)));
document.addEventListener('keydown', event => {
  if (!/^F\d{1,2}$/.test(event.key) || event.ctrlKey || event.altKey || event.metaKey) return;
  const grid = gridOnScreen();
  if (!grid || !grid.config.fkeys || !grid.config.fkeys[event.key]) return;
  event.preventDefault();
  grid.config.fkeys[event.key](grid);
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-fkey]');
  if (!button) return;
  const grid = gridOnScreen(button.closest('section') || document);
  if (grid && grid.config.fkeys && grid.config.fkeys[button.dataset.fkey]) grid.config.fkeys[button.dataset.fkey](grid);
});

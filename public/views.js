/* ---------- List / tile layout toggle on every data screen (remembered per screen) ---------- */
const VIEW_DEFAULTS = { billing: 'tiles', products: 'tiles', manufacturing: 'tiles', verification: 'list', sales: 'list', purchases: 'list', expenses: 'list', customers: 'list', transfers: 'list', network: 'list' };
const MODE_ICONS = {
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  tiles: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>'
};
function savedMode(view) {
  const saved = storage.get(`vv-mode-${view}`);
  return saved === 'list' || saved === 'tiles' ? saved : VIEW_DEFAULTS[view];
}
function setViewMode(view, mode, remember = true) {
  const section = $(`#${VIEWS[view]}`);
  section.dataset.mode = mode;
  section.querySelectorAll('.view-toggle button').forEach(button => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (remember) storage.set(`vv-mode-${view}`, mode);
}
function makeToggle(view) {
  const box = document.createElement('div');
  box.className = 'view-toggle';
  box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Layout');
  box.innerHTML = ['list', 'tiles'].map(mode => `<button type="button" data-mode="${mode}" title="${mode === 'list' ? 'List view' : 'Tile view'}" aria-label="${mode === 'list' ? 'List view' : 'Tile view'}">${MODE_ICONS[mode]}</button>`).join('');
  box.addEventListener('click', event => { const button = event.target.closest('button'); if (button) setViewMode(view, button.dataset.mode); });
  return box;
}
Object.keys(VIEW_DEFAULTS).forEach(view => {
  const section = $(`#${VIEWS[view]}`);
  if (view === 'billing') {
    const toggle = makeToggle(view);
    toggle.classList.add('push-right');
    section.querySelector('.filter-row').appendChild(toggle);
  } else {
    // Keep whatever sits on the right of the title (buttons, dates) and put the toggle beside it.
    const title = section.querySelector('.view-title');
    const right = title.children[1];
    const tools = document.createElement('div');
    tools.className = 'title-tools';
    if (right) { title.replaceChild(tools, right); tools.append(makeToggle(view), right); }
    else { tools.append(makeToggle(view)); title.append(tools); }
  }
  setViewMode(view, savedMode(view), false);
});

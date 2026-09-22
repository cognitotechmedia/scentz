'use strict';
// End-to-end API test: starts the server on a temporary database and drives it over HTTP.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = 3100 + Math.floor(Math.random() * 500);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-test-'));
const base = `http://127.0.0.1:${port}`;
let passed = 0, failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name} ${detail}`); }
}
function client() {
  let cookie = '';
  const call = async (method, url, body, outlet) => {
    if (url === '/api/sales') body = { requestId: require('node:crypto').randomUUID(), ...body };
    if (url.includes('/reopen') || method === 'DELETE') body = { reason: 'Automated regression correction', ...body };
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(outlet ? { 'X-Outlet-Id': String(outlet) } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  call.cookie = () => cookie;
  return call;
}
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const approx = (a, b) => Math.abs(a - b) < 0.005;

const todayKeyServer = () => new Date().toISOString().slice(0, 10);
async function run() {
  const admin = client(), anon = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'admin-pass-123' });
  const product = { name: 'Bulk test perfume', price: 100, gstRate: 18, trackStock: 'yes' };
  const send = (kind, rows, preview = false) => admin('POST', '/api/import/' + kind, { rows, preview });
  const count = async () => { const s = (await admin('GET', '/api/state')).json; return [s.products.length, s.materials.length, s.customers.length]; };
  const baseline = await count();
  check('anonymous import denied', (await anon('POST', '/api/import/products', { rows: [product], preview: true })).status === 401);
  check('product preview valid', !(await send('products', [product], true)).json.errors.length);
  check('preview rolls back products and generated stock', JSON.stringify(await count()) === JSON.stringify(baseline));
  check('duplicate batch rejected', (await send('products', [product, product])).json.errors.length === 1);
  check('duplicate rollback leaves no products or stock', JSON.stringify(await count()) === JSON.stringify(baseline));
  check('invalid boolean rejected', (await send('products', [{ ...product, trackStock: 'maybe' }])).json.errors.length === 1);
  check('missing GST rejected', (await send('products', [{ ...product, gstRate: '' }])).json.errors.length === 1);
  check('products saved', (await send('products', [product])).json.imported === 1);
  check('repeated product import rejected', (await send('products', [product])).json.imported === 0);
  const customer = { name: 'Bulk Customer', phone: '9876543201' };
  check('customer preview valid', !(await send('customers', [customer], true)).json.errors.length);
  check('preview leaves customer count unchanged', (await count())[2] === baseline[2]);
  check('bad customer rolls back entire batch', (await send('customers', [customer, { name: 'Bad', phone: '123' }])).json.imported === 0 && (await count())[2] === baseline[2]);
  check('customer batch saved', (await send('customers', [customer])).json.imported === 1);
  check('duplicate customer rejected', (await send('customers', [customer])).json.imported === 0);
  check('empty upload rejected', (await send('products', [])).status === 400);
  check('oversize batch rejected', (await send('products', Array(501).fill(product))).status === 400);
  const s = (await admin('GET', '/api/state')).json;
  await admin('POST', '/api/users', { username: 'importbiller', name: 'Biller', role: 'biller', outletId: s.outlet.id, password: 'test-import-123' });
  const biller = client(); await biller('POST', '/api/login', { username: 'importbiller', password: 'test-import-123' });
  for (const kind of ['products', 'customers']) check('biller denied ' + kind, (await biller('POST', '/api/import/' + kind, { rows: [customer], preview: true })).status === 403);
}

const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_PASSWORD: 'admin-pass-123' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
const started = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 10000);
  child.stdout.on('data', () => { if (output.includes('running at')) { clearTimeout(timer); resolve(); } });
});
started.then(run).catch(error => { failed += 1; console.log(`  FAIL ${error.stack || error}`); }).finally(() => {
  child.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed && /Error/.test(output)) console.log(`\nServer output:\n${output}`);
  setTimeout(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(failed ? 1 : 0); }, 300);
});

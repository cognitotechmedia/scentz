'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const tempRoot = fs.realpathSync(os.tmpdir());
const dir = fs.mkdtempSync(path.join(tempRoot, 'scentz-controls-test-'));
const port = 3700 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, DATA_DIR: dir, DB_FILE: 'velour.db', PORT: String(port), HOST: '127.0.0.1', COOKIE_SECURE: '0', ADMIN_PASSWORD: 'control-admin-123' };
let child, db, checks = 0;
function check(name, value) { assert.ok(value, name); checks++; console.log('  ok   ' + name); }
function client() {
  let cookie = '';
  const call = async (method, route, body, outlet) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(outlet ? { 'X-Outlet-Id': String(outlet) } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, json: await response.json() };
  };
  call.cookie = () => cookie;
  return call;
}
async function start() {
  let output = '';
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Server failed: '+output)), 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('Server exited '+code+': '+output)); });
    child.stderr.on('data', c => { output+=c; });
    child.stdout.on('data', c => { output+=c; if (output.includes('running at')) { clearTimeout(timer); resolve(); } });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit',resolve));
  child.kill(); await exited;
}
const paid = (kind,id) => db.prepare('SELECT COALESCE(SUM(amount),0) n FROM payments WHERE kind=? AND ref_id=?').get(kind,id).n;
async function run() {
  // Create a pre-upgrade fixture using the original schema code, without the
  // controls migration. It never reads or modifies a user's database.
  let legacy = fs.readFileSync(path.join(__dirname,'db.js'),'utf8');
  legacy = legacy.replace("require('./hardening-schema')(db);", '');
  fs.writeFileSync(path.join(dir,'legacy-db.js'),legacy);
  const fixtureScript = `const {db,seedIfEmpty}=require(process.argv[1]); seedIfEmpty();
    db.prepare("INSERT INTO outlets(code,name,type,royalty_pct,gstin) VALUES('LEG','Legacy outlet','franchise',8,'27ABCDE1234F1Z5')").run();
    db.prepare("INSERT INTO sales(id,outlet_id,number,date,day,customer_name,customer_phone,tax_mode,subtotal,discount,taxable,cgst,sgst,round_off,total,lines,created_by,price_type,customer_gstin) VALUES('legacy-sale',2,'LEG-INV-2026-0001','2026-09-01T10:00:00Z','2026-09-01','Legacy Buyer','9111111111','inclusive',118,0,100,9,9,0,118,'[]',1,'retail','')").run(); db.close();`;
  const fixture = spawnSync(process.execPath,['-e',fixtureScript,path.join(dir,'legacy-db.js')],{env,encoding:'utf8'});
  assert.equal(fixture.status,0,fixture.stderr);
  await start();
  db = new DatabaseSync(path.join(dir,'velour.db'));
  const admin=client(), buyer=client(), stranger=client();
  check('existing account survives upgrade',(await admin('POST','/api/login',{username:'admin',password:'control-admin-123'})).status===200);
  const legacySale=db.prepare("SELECT * FROM sales WHERE id='legacy-sale'").get();
  check('historical royalty baseline preserved and marked',legacySale.royalty_pct===8 && legacySale.royalty_legacy===1);
  check('pre-upgrade recovery backup created',fs.readdirSync(path.join(dir,'backups')).some(n=>n.startsWith('pre-controls-')));
  check('migration recorded exactly once',db.prepare("SELECT COUNT(*) n FROM schema_migrations").get().n===1);
  const hq=1;
  const a=(await admin('POST','/api/outlets',{code:'BUY','name':'Buyer outlet',gstin:'07ABCDE1234F1Z5',royaltyPct:7})).json.id;
  const b=(await admin('POST','/api/outlets',{code:'OTHER','name':'Same GSTIN outlet',gstin:'07ABCDE1234F1Z5',royaltyPct:6})).json.id;
  const user=(await admin('POST','/api/users',{username:'buyer',name:'Buyer manager',role:'manager',outletId:a,password:'buyer-pass-123'})).json;
  await admin('POST','/api/users',{username:'other',name:'Other manager',role:'manager',outletId:b,password:'other-pass-123'});
  await buyer('POST','/api/login',{username:'buyer',password:'buyer-pass-123'});
  await stranger('POST','/api/login',{username:'other',password:'other-pass-123'});
  check('manager cannot read HQ audit',(await buyer('GET','/api/audit')).status===403);
  check('manager cannot reconcile HQ ledgers',(await buyer('GET','/api/reconciliation')).status===403);
  await admin('POST','/api/products',{name:'Controlled bottle',price:118,gstRate:18,cost:50,needsRecipe:false,trackStock:true});
  let state=(await admin('GET','/api/state')).json;
  let product=state.products.find(p=>p.name==='Controlled bottle');
  // The existing product API uses stockTracked for packed-stock creation.
  if (!product.stockMaterialId) {
    await admin('PUT','/api/products/'+product.id,{name:product.name,price:118,gstRate:18,cost:50,needsRecipe:false,trackStock:true,stockTracked:true});
    product=(await admin('GET','/api/state')).json.products.find(p=>p.id===product.id);
  }
  check('test product is stock-counted',Boolean(product.stockMaterialId));
  await admin('POST','/api/opening-stock',{items:[{materialId:product.stockMaterialId,qty:30,costPerMl:50}]});
  const linkedCustomer={name:'Franchise Buyer',phone:'9222222222',type:'franchise',gstin:'07ABCDE1234F1Z5',buyerOutletId:a};
  check('only HQ may create an outlet link',(await buyer('POST','/api/customers',{...linkedCustomer,buyerOutletId:b})).status===403);
  check('HQ sets an explicit receiving outlet',(await admin('POST','/api/customers',linkedCustomer)).status===200);
  const request={requestId:randomUUID(),customerName:linkedCustomer.name,customerPhone:linkedCustomer.phone,lines:[{productId:product.id,qty:4}],payment:{mode:'Cash',amount:0}};
  const first=await admin('POST','/api/sales',request);
  check('linked bill created',first.status===200);
  const saleId=first.json.id;
  const qty=db.prepare('SELECT stock FROM outlet_stock WHERE outlet_id=1 AND material_id=?').get(product.stockMaterialId).stock;
  const replay=await admin('POST','/api/sales',request);
  check('lost-response retry returns same bill',replay.status===200 && replay.json.id===saleId && replay.json.number===first.json.number);
  check('retry does not deduct stock twice',db.prepare('SELECT stock FROM outlet_stock WHERE outlet_id=1 AND material_id=?').get(product.stockMaterialId).stock===qty);
  check('changed payload with same ID is rejected',(await admin('POST','/api/sales',{...request,lines:[{productId:product.id,qty:1}]})).status===409);
  check('old browser without request ID is refused',(await admin('POST','/api/sales',{...request,requestId:undefined})).status===400);
  check('recovery lookup is scoped to user and outlet',(await buyer('GET','/api/sale-requests/'+request.requestId)).json.exists===false);
  const unauth=client();
  check('anonymous replay is refused',(await unauth('POST','/api/sales',request)).status===401);
  const cancelled={...request,requestId:randomUUID()};
  check('unsaved attempt can be cancelled atomically',(await admin('POST','/api/sale-requests/'+cancelled.requestId+'/cancel',{request:cancelled})).json.cancelled===true);
  check('late request cannot create a cancelled bill',(await admin('POST','/api/sales',cancelled)).status===409);
  check('saved bill cannot be discarded',(await admin('POST','/api/sale-requests/'+request.requestId+'/cancel',{request})).json.cancelled===false);
  const concurrent={...request,requestId:randomUUID(),lines:[{productId:product.id,qty:1}]};
  const responses=await Promise.all([admin('POST','/api/sales',concurrent),admin('POST','/api/sales',concurrent)]);
  check('simultaneous identical requests create one bill',responses.every(r=>r.status===200) && responses[0].json.id===responses[1].json.id);
  check('same GSTIN does not expose another outlet invoice',!(await stranger('GET','/api/hq-invoices')).json.invoices.some(i=>i.id===saleId));
  check('same GSTIN cannot book another outlet invoice',(await stranger('POST','/api/purchases',{sourceSaleId:saleId,paid:0})).status===404);
  await admin('POST','/api/payments',{kind:'sale',id:saleId,amount:100,mode:'Cash'});
  const booking=await buyer('POST','/api/purchases',{sourceSaleId:saleId,paid:20,mode:'Bank transfer'});
  check('booked purchase carries pre-existing seller payments',booking.status===200 && paid('purchase',booking.json.id)===120 && paid('sale',saleId)===120);
  const purchaseId=booking.json.id;
  check('duplicate purchase blocked',(await buyer('POST','/api/purchases',{sourceSaleId:saleId,paid:0})).status===409);
  await buyer('POST','/api/payments',{kind:'purchase',id:purchaseId,amount:50,mode:'UPI'});
  check('buyer settlement updates seller receivable',paid('sale',saleId)===170 && paid('purchase',purchaseId)===170);
  await admin('POST','/api/payments',{kind:'sale',id:saleId,amount:50,mode:'Card'});
  check('seller receipt updates buyer payable',paid('sale',saleId)===220 && paid('purchase',purchaseId)===220);
  const return1=await admin('POST','/api/credit-notes',{saleId,reason:'Franchise return',lines:[{index:0,qty:1}],refundMode:'Cash'});
  check('partial credit updates purchase and buyer stock',return1.status===200 && db.prepare('SELECT total FROM purchases WHERE id=?').get(purchaseId).total===354 && db.prepare('SELECT stock FROM outlet_stock WHERE outlet_id=? AND material_id=?').get(a,product.stockMaterialId).stock===3);
  const return2=await admin('POST','/api/credit-notes',{saleId,reason:'Remaining franchise return',lines:[{index:0,qty:3}],refundMode:'Cash'});
  check('full return reverses linked money and stock',return2.status===200 && paid('sale',saleId)===0 && paid('purchase',purchaseId)===0 && db.prepare('SELECT total FROM purchases WHERE id=?').get(purchaseId).total===0);
  const second=(await admin('POST','/api/sales',{...request,requestId:randomUUID(),lines:[{productId:product.id,qty:1}]})).json;
  const secondPurchase=(await buyer('POST','/api/purchases',{sourceSaleId:second.id,paid:0})).json;
  await buyer('POST','/api/sales',{requestId:randomUUID(),customerName:'Retail buyer',customerPhone:'9333333333',lines:[{productId:product.id,qty:1}],payment:{mode:'Cash',amount:118}});
  const beforeNotes=db.prepare('SELECT COUNT(*) n FROM credit_notes').get().n;
  const noStockReturn=await admin('POST','/api/credit-notes',{saleId:second.id,reason:'Stock already sold',lines:[{index:0,qty:1}],refundMode:'Cash'});
  check('return without buyer stock rolls back the entire operation',noStockReturn.status===409 && db.prepare('SELECT COUNT(*) n FROM credit_notes').get().n===beforeNotes && db.prepare('SELECT total FROM purchases WHERE id=?').get(secondPurchase.id).total===118);
  // Seed a historical settlement difference directly in this temporary fixture.
  db.prepare("INSERT INTO payments(kind,ref_id,outlet_id,date,mode,amount,created_by) VALUES('purchase',?,?,?,'Cash',10,1)").run(secondPurchase.id,a,new Date().toISOString());
  const report=(await admin('GET','/api/reconciliation')).json;
  check('historical mismatch is visible',report.pairs.some(p=>p.saleId===second.id && p.buyerPaid===10 && p.sellerPaid===0));
  check('mismatched pair blocks new settlement',(await admin('POST','/api/payments',{kind:'sale',id:second.id,amount:1,mode:'Cash'})).status===409);
  check('manager cannot approve correction',(await buyer('POST','/api/inter-outlet/'+second.id+'/reconcile',{authority:'purchase',mode:'Cash',reason:'Verified receipt'})).status===403);
  check('HQ can confirm and reconcile the historic payment',(await admin('POST','/api/inter-outlet/'+second.id+'/reconcile',{authority:'purchase',mode:'Cash',reason:'Verified original cash receipt'})).status===200 && paid('sale',second.id)===10);
  check('repeated reconciliation does not duplicate payment',(await admin('POST','/api/inter-outlet/'+second.id+'/reconcile',{authority:'purchase',mode:'Cash',reason:'Verified original cash receipt'})).status===200 && paid('sale',second.id)===10);
  const royaltyBill=async()=>buyer('POST','/api/sales',{requestId:randomUUID(),customerName:'Royalty customer',customerPhone:'9444444444',lines:[{productId:'signature-oud',qty:1}],payment:{mode:'Cash',amount:0}});
  const old=(await royaltyBill()).json;
  await admin('PUT','/api/outlets/'+a,{name:'Buyer outlet',gstin:'07ABCDE1234F1Z5',royaltyPct:12});
  const fresh=(await royaltyBill()).json;
  check('rate changes apply only to new invoices',db.prepare('SELECT royalty_pct FROM sales WHERE id=?').get(old.id).royalty_pct===7 && fresh.royaltyPct===12);
  const royaltyReturn=(await admin('POST','/api/credit-notes',{saleId:old.id,reason:'Return old-rate invoice',lines:[{index:0,qty:1}]},a)).json;
  check('returns retain original invoice royalty rate',royaltyReturn.royaltyPct===7);
  const expense=(await buyer('POST','/api/expenses',{category:'Rent',amount:50,mode:'Cash'})).json;
  check('void requires explanation',(await buyer('DELETE','/api/expenses/'+expense.id)).status===400);
  await buyer('DELETE','/api/expenses/'+expense.id,{reason:'Duplicate rent entry'});
  check('void retains original expense and author',db.prepare('SELECT voided_by FROM expenses WHERE id=?').get(expense.id).voided_by===user.id);
  check('void excluded from active expenses',!(await buyer('GET','/api/state')).json.expenses.some(e=>e.id===expense.id));
  const closed=(await buyer('POST','/api/day-closings',{day:'2026-01-01',openingCash:0,counted:{Cash:0},floatKept:0})).json;
  check('reopen requires a reason',(await admin('POST','/api/day-closings/'+closed.id+'/reopen',{},a)).status===400);
  await admin('POST','/api/day-closings/'+closed.id+'/reopen',{reason:'Verify original count'},a);
  check('reopened closing has intact historical snapshot',JSON.parse(db.prepare('SELECT snapshot FROM closing_history WHERE closing_id=?').get(closed.id).snapshot).cash_counted===0);
  check('outlet cannot read another closing history',(await stranger('GET','/api/closing-history')).json.length===0);
  let prevented=false; try {db.exec('DELETE FROM audit_events');}catch{prevented=true;}
  check('audit events cannot be deleted',prevented);
  const auditText=db.prepare('SELECT before_json,after_json FROM audit_events').all().map(x=>JSON.stringify(x)).join('');
  check('audit excludes password hashes and plaintext',!auditText.includes('control-admin-123') && !auditText.includes('buyer-pass-123') && !auditText.includes('\\"hash\\"') && !auditText.includes('\\"salt\\"'));
  const buyerOther=client(); await buyerOther('POST','/api/login',{username:'buyer',password:'buyer-pass-123'});
  const oldCookie=buyer.cookie();
  await buyer('POST','/api/change-password',{current:'buyer-pass-123',next:'buyer-new-pass-456'});
  check('password change rotates current session',buyer.cookie()!==oldCookie && (await buyer('GET','/api/state')).status===200);
  check('password change invalidates other sessions',(await buyerOther('GET','/api/state')).status===401);
  await admin('PUT','/api/users/'+user.id,{name:'Buyer manager',role:'manager',outletId:a,password:'reset-pass-789'});
  check('HQ password reset invalidates all sessions',(await buyer('GET','/api/state')).status===401);
  await stop(); db.close(); db=null; await start();
  db=new DatabaseSync(path.join(dir,'velour.db'));
  check('bill replay survives a server restart',(await admin('POST','/api/sales',request)).json.id===saleId);
  check('upgrade is idempotent across restarts',db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n===1 && db.prepare("SELECT royalty_pct FROM sales WHERE id='legacy-sale'").get().royalty_pct===8);
  console.log(`\n${checks} controls checks passed`);
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(db)db.close(); await stop();
  // Never recursively remove anything outside the temp directory created here.
  const resolved=fs.realpathSync(dir);
  if(path.dirname(resolved)!==tempRoot || !path.basename(resolved).startsWith('scentz-controls-test-')) throw Error('Unsafe cleanup path');
  fs.rmSync(resolved,{recursive:true,force:true});
});

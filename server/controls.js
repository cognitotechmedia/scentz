'use strict';
const crypto = require('node:crypto');

module.exports = function controls({ db, tx, bad, conflict, forbid, round2, numbered, now, dateKey, stockRow, removeStock, ledger }) {
  const sumPaid = (kind, id) => round2(db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE kind=? AND ref_id=?').get(kind, id).n);
  const netSale = sale => round2(sale.total - db.prepare('SELECT COALESCE(SUM(total),0) AS n FROM credit_notes WHERE sale_id=?').get(sale.id).n);
  const pair = saleId => db.prepare('SELECT * FROM purchases WHERE source_sale_id=?').get(saleId);
  const saleForPurchase = id => db.prepare('SELECT s.* FROM sales s JOIN purchases p ON p.source_sale_id=s.id WHERE p.id=?').get(id);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const fingerprint = body => crypto.createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');

  function checkPair(sale, purchase) {
    if (!purchase) return;
    if (Math.abs(netSale(sale) - purchase.total) > 0.005 || Math.abs(sumPaid('sale', sale.id) - sumPaid('purchase', purchase.id)) > 0.005)
      conflict('This linked invoice has an earlier reconciliation difference. HQ must resolve it in Store settings → Franchise reconciliation before recording another payment or return.');
  }
  function buyer(body, current, user, sellerId) {
    const value = body.buyerOutletId === undefined ? current?.buyer_outlet_id : body.buyerOutletId;
    const id = value === '' || value === null || value === undefined ? null : Number(value);
    if (id !== (current?.buyer_outlet_id ?? null) && user.role !== 'admin') forbid('Only HQ can link a customer to a franchise outlet');
    if (id !== null) {
      const outlet = db.prepare('SELECT * FROM outlets WHERE id=? AND active=1').get(id);
      if (!outlet || outlet.type !== 'franchise' || id === sellerId) bad('Choose an active receiving franchise outlet');
      if (body.type !== 'franchise') bad('Only franchise customers can be linked to an outlet');
      if (!outlet.gstin || outlet.gstin.toUpperCase() !== String(body.gstin || '').trim().toUpperCase()) bad('The customer GSTIN must match the selected outlet');
    }
    return id;
  }
  function saleBuyer(body, outlet) {
    const customer = db.prepare('SELECT * FROM customers WHERE outlet_id=? AND phone=?').get(outlet.id, String(body.customerPhone || ''));
    if (customer?.type !== 'franchise') return null;
    if (!customer.buyer_outlet_id) bad('HQ must link this franchise customer to a receiving outlet in the Customer book before billing');
    const target = db.prepare('SELECT * FROM outlets WHERE id=? AND active=1').get(customer.buyer_outlet_id);
    if (!target || target.id === outlet.id || target.gstin !== customer.gstin) bad('The receiving outlet is inactive or its GSTIN changed. Ask HQ to check the customer link');
    if (Number(body.redeemPoints) > 0) bad('Use a money payment for an inter-outlet invoice; loyalty points cannot settle it');
    return target.id;
  }
  function mirror(row, kind, ref, outletId, user) {
    if (row.mode === 'Loyalty points') conflict('An older linked invoice uses loyalty points. Review its settlement with HQ before booking it');
    if (db.prepare('SELECT 1 FROM payments WHERE linked_payment_id=?').get(row.id)) return;
    let voucherId = null;
    if (row.voucher_id && row.amount > 0) {
      const target = db.prepare(`SELECT * FROM ${kind === 'sale' ? 'sales' : 'purchases'} WHERE id=?`).get(ref);
      const outlet = db.prepare('SELECT * FROM outlets WHERE id=?').get(outletId);
      const receipt = kind === 'sale';
      voucherId = `vch-${crypto.randomBytes(8).toString('hex')}`;
      db.prepare('INSERT INTO vouchers(id,outlet_id,kind,number,date,day,party_key,party_name,mode,amount,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(voucherId, outletId, receipt ? 'receipt' : 'payment', numbered(outlet, receipt ? 'rct' : 'pay'), row.date, dateKey(row.date), receipt ? target.customer_phone : target.supplier.trim().toLowerCase(), receipt ? target.customer_name : target.supplier, row.mode, row.amount, 'Linked inter-outlet settlement; do not enter again', user.id);
    }
    db.prepare('INSERT INTO payments(kind,ref_id,outlet_id,date,mode,amount,created_by,voucher_id,linked_payment_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(kind, ref, outletId, row.date, row.mode, row.amount, user.id, voucherId, row.id);
  }
  function booking(saleId, purchaseId, user) {
    const purchase = pair(saleId), sale = db.prepare('SELECT * FROM sales WHERE id=?').get(saleId);
    if (!purchase || purchase.id !== purchaseId || sale.buyer_outlet_id !== purchase.outlet_id) conflict('Receiving outlet does not match this invoice');
    for (const row of db.prepare("SELECT * FROM payments WHERE kind='sale' AND ref_id=? ORDER BY id").all(saleId)) mirror(row, 'purchase', purchaseId, purchase.outlet_id, user);
  }
  function syncPayments(afterId, user, oldPairIds) {
    const rows = db.prepare('SELECT * FROM payments WHERE id>? AND linked_payment_id IS NULL ORDER BY id').all(afterId);
    const checked = new Set();
    for (const row of rows) {
      const sale = row.kind === 'sale' ? db.prepare('SELECT * FROM sales WHERE id=?').get(row.ref_id) : saleForPurchase(row.ref_id);
      if (!sale) continue;
      const purchase = pair(sale.id);
      if (!purchase) continue;
      if (Math.abs(netSale(sale) - purchase.total) > 0.005) conflict('Earlier invoice total difference: review stock and credit notes with HQ before settlement');
      if (!checked.has(sale.id) && oldPairIds.has(purchase.id)) {
        const previous = kind => round2(db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE kind=? AND ref_id=? AND id<=?').get(kind, kind === 'sale' ? sale.id : purchase.id, afterId).n);
        if (Math.abs(previous('sale') - previous('purchase')) > 0.005) conflict('Earlier settlement difference: ask HQ to reconcile this invoice first');
        checked.add(sale.id);
      }
      mirror(row, row.kind === 'sale' ? 'purchase' : 'sale', row.kind === 'sale' ? purchase.id : sale.id, row.kind === 'sale' ? purchase.outlet_id : sale.outlet_id, user);
    }
  }
  function syncReturn(note, sale, user) {
    const purchase = pair(sale.id);
    if (!purchase) return;
    const bought = JSON.parse(purchase.lines), original = JSON.parse(sale.lines);
    for (const line of note.lines) {
      const stockItem = original[line.index].stockItem;
      if (!stockItem) continue;
      const stock = stockRow(purchase.outlet_id, stockItem);
      if (!stock || stock.stock + 1e-9 < line.qty) conflict('The receiving outlet lacks stock for this return. Resolve its stock before issuing the credit note');
      let remaining = line.qty;
      for (const entry of bought.filter(entry => entry.materialId === stockItem)) {
        const take = Math.min(remaining, entry.qty), unitCost = entry.qty ? entry.total / entry.qty : 0;
        entry.qty = round2(entry.qty - take); entry.total = round2(entry.total - take * unitCost); remaining -= take;
      }
      if (remaining > 0.001) conflict('The linked purchase quantities need review before this return');
      removeStock(purchase.outlet_id, stockItem, line.qty);
      ledger(purchase.outlet_id, stockItem, 'franchise_return', -line.qty, stock.cost_per_ml, note.number, 'Returned to selling outlet', user.id);
    }
    const total = netSale(sale), lines = bought.filter(line => line.qty > 0);
    db.prepare('UPDATE purchases SET total=?, lines=?, extra_amount=? WHERE id=?').run(total, JSON.stringify(lines), round2(total - lines.reduce((n, line) => n + line.total, 0)), purchase.id);
  }
  function reconciliation() {
    const pairs = db.prepare('SELECT p.id AS purchaseId, p.number AS purchaseNumber, p.total AS purchaseTotal, p.source_sale_id AS saleId, p.outlet_id AS buyerId FROM purchases p WHERE p.source_sale_id IS NOT NULL').all().map(p => {
      const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(p.saleId);
      return { ...p, saleNumber: sale.number, sellerId: sale.outlet_id, saleTotal: netSale(sale), sellerPaid: sumPaid('sale', sale.id), buyerPaid: sumPaid('purchase', p.purchaseId) };
    });
    const unlinked = db.prepare("SELECT id, number, customer_name AS customer, customer_gstin AS gstin FROM sales WHERE price_type='franchise' AND buyer_outlet_id IS NULL").all();
    return { pairs, unlinked };
  }
  function reconcile({ body, params, user }) {
    const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(params.id), purchase = sale && pair(sale.id);
    if (!purchase) bad('Linked purchase not found');
    if (Math.abs(netSale(sale) - purchase.total) > 0.005) conflict('Invoice totals differ. This needs a stock and credit-note review; payment reconciliation cannot change inventory');
    if (!['sale', 'purchase'].includes(body.authority)) bad('Choose the confirmed seller or buyer ledger');
    const reason = String(body.reason || '').trim();
    if (reason.length < 5) bad('Explain the settlement correction');
    if (!['Cash', 'UPI', 'Card', 'Bank transfer'].includes(body.mode)) bad('Choose the payment mode being corrected');
    const targetKind = body.authority === 'sale' ? 'purchase' : 'sale';
    const amount = round2(sumPaid(body.authority, body.authority === 'sale' ? sale.id : purchase.id) - sumPaid(targetKind, targetKind === 'sale' ? sale.id : purchase.id));
    if (Math.abs(amount) < 0.005) return { ok: true };
    // A correction, not a second transfer of cash. The audit event retains both
    // ledgers and the entered explanation; closing reports show the correction.
    const at = now();
    db.prepare('INSERT INTO payments(kind,ref_id,outlet_id,date,mode,amount,created_by) VALUES(?,?,?,?,?,?,?)').run(targetKind, targetKind === 'sale' ? sale.id : purchase.id, targetKind === 'sale' ? sale.outlet_id : purchase.outlet_id, at, body.mode, amount, user.id);
    db.prepare('INSERT INTO audit_events(occurred_at,actor_id,action,entity,operation,after_json) VALUES(?,?,?,?,?,?)').run(at,user.id,'reconcile', 'inter_outlet','CORRECTION',JSON.stringify({saleId:sale.id,authority:body.authority,amount,mode:body.mode,reason}));
    return { ok: true };
  }
  function linkLegacy({ body, params }) {
    const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(params.id), target = db.prepare("SELECT * FROM outlets WHERE id=? AND active=1 AND type='franchise'").get(Number(body.buyerOutletId));
    if (!sale || sale.price_type !== 'franchise' || sale.buyer_outlet_id || pair(sale.id)) bad('Only an unlinked franchise invoice can be assigned');
    if (!target || target.id === sale.outlet_id || !sale.customer_gstin || target.gstin !== sale.customer_gstin) bad('Select the receiving outlet matching the invoice GSTIN');
    db.prepare('UPDATE sales SET buyer_outlet_id=? WHERE id=?').run(target.id, sale.id);
    return { ok: true };
  }
  function run(ctx, handler) {
    if (ctx.method === 'GET') return handler(ctx);
    return tx(() => {
      db.prepare('UPDATE audit_context SET actor_id=?, action=? WHERE id=1').run(ctx.user?.id ?? null, `${ctx.method} ${ctx.pathname}`);
      const isSale = ctx.pathname === '/api/sales', isReturn = ctx.pathname === '/api/credit-notes';
      let key, digest, buyerId, returnedSale;
      if (isSale) {
        key = ctx.body.requestId;
        if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) bad('Refresh this billing screen before saving (a bill request ID is required)');
        digest = fingerprint(ctx.body);
        const prior = db.prepare('SELECT * FROM sale_requests WHERE user_id=? AND outlet_id=? AND request_id=?').get(ctx.user.id, ctx.outlet.id, key);
        if (prior) {
          if (JSON.parse(prior.response).cancelled) conflict('This unsaved attempt was discarded. Start a new bill');
          if (prior.fingerprint !== digest) conflict('This billing attempt already exists with different details. Recover the original bill first');
          db.prepare("UPDATE audit_context SET actor_id=NULL, action='startup' WHERE id=1").run();
          return JSON.parse(prior.response);
        }
        buyerId = saleBuyer(ctx.body, ctx.outlet);
      }
      if (isReturn) {
        returnedSale = db.prepare('SELECT * FROM sales WHERE id=? AND outlet_id=?').get(String(ctx.body.saleId), ctx.outlet.id);
        if (returnedSale) checkPair(returnedSale, pair(returnedSale.id));
      }
      const paymentBefore = db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM payments').get().n;
      const oldPairs = new Set(db.prepare('SELECT id FROM purchases WHERE source_sale_id IS NOT NULL').all().map(p => p.id));
      const result = handler(ctx);
      if (isSale) {
        db.prepare('UPDATE sales SET buyer_outlet_id=?, royalty_pct=? WHERE id=?').run(buyerId, ctx.outlet.royalty_pct, result.id);
        Object.assign(result, { buyerOutletId: buyerId, royaltyPct: ctx.outlet.royalty_pct, royaltyLegacy: false });
      }
      if (isReturn && returnedSale) {
        db.prepare('UPDATE credit_notes SET royalty_pct=? WHERE id=?').run(returnedSale.royalty_pct, result.id);
        result.royaltyPct = returnedSale.royalty_pct;
        syncReturn(result, returnedSale, ctx.user);
      }
      if (ctx.user && !ctx.pathname.endsWith('/reconcile')) syncPayments(paymentBefore, ctx.user, oldPairs);
      if (isSale) db.prepare('INSERT INTO sale_requests VALUES(?,?,?,?,?,?)').run(ctx.user.id, ctx.outlet.id, key, digest, JSON.stringify(result), now());
      db.prepare("UPDATE audit_context SET actor_id=NULL, action='startup' WHERE id=1").run();
      return result;
    });
  }
  function cancelBill({ body, params, user, outlet }) {
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(params.id)) bad('Invalid billing attempt');
    const previous = db.prepare('SELECT response FROM sale_requests WHERE user_id=? AND outlet_id=? AND request_id=?').get(user.id,outlet.id,params.id);
    if (previous) return { cancelled: Boolean(JSON.parse(previous.response).cancelled) };
    if (!body.request || body.request.requestId !== params.id) bad('The saved billing attempt is required');
    db.prepare('INSERT INTO sale_requests VALUES(?,?,?,?,?,?)').run(user.id,outlet.id,params.id,fingerprint(body.request),JSON.stringify({cancelled:true}),now());
    return { cancelled:true };
  }
  return { run, buyer, booking, reconciliation, reconcile, linkLegacy, sumPaid, checkPair, cancelBill };
};

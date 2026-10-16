'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createOdooBoards } = require('../lib/odoo-boards.cjs');

// ORM fixture evaluates the emitted domains, including relational country/currency paths.
function fixtureClient(db) {
  const missingRelation = Symbol('unreachable relational join');
  const relation = { partner_id: 'res.partner', country_id: 'res.country', currency_id: 'res.currency', company_id: 'res.company', order_id: 'purchase.order', product_id: 'product.product', product_tmpl_id: 'product.template', categ_id: 'product.category' };
  const key = value => Array.isArray(value) ? value[0] : value;
  function field(row, path) {
    const [head, ...tail] = path.split('.');
    const value = row && row[head];
    if (!tail.length) return key(value);
    const target = (db[relation[head]] || []).find(r => r.id === key(value));
    // Odoo's chained relational leaf is not itself the absent country relation.
    return target ? field(target, tail.join('.')) : missingRelation;
  }
  function matches(row, domain) {
    let i = 0;
    function term() {
      const item = domain[i++];
      if (item === '|') { const a = term(), b = term(); return a || b; }
      if (item === '&') { const a = term(), b = term(); return a && b; }
      if (item === '!') return !term();
      const [name, op, expected] = item;
      const actual = field(row, name);
      if (actual === missingRelation) return false;
      const empty = actual === false || actual === undefined || actual === null;
      if (op === '=') return expected === false ? empty : actual === expected;
      if (op === '!=') return expected === false ? !empty : actual !== expected;
      if (op === 'in') return expected.includes(actual);
      if (op === 'not in') return !expected.includes(actual);
      if (op === '>=') return !empty && actual >= expected;
      throw Error('Unhandled fixture operator ' + op);
    }
    let result = true;
    while (i < domain.length) { const next = term(); result = result && next; }
    return result;
  }
  function sort(rows, order = 'id asc') {
    return rows.sort((a, b) => {
      for (const part of order.split(',')) {
        const [name, direction] = part.trim().split(/\s+/);
        const av = field(a, name), bv = field(b, name);
        if (av === bv) continue;
        const emptyA = av === false || av == null, emptyB = bv === false || bv == null;
        if (emptyA !== emptyB) return (emptyA ? -1 : 1) * (direction === 'desc' ? 1 : -1);
        return (av < bv ? -1 : 1) * (direction === 'desc' ? -1 : 1);
      }
      return 0;
    });
  }
  return {
    async searchAll(model, domain, fields, options = {}) { return sort((db[model] || []).filter(row => matches(row, domain)), options.order); },
    async searchRead(model, domain, fields, options = {}) { const rows = await this.searchAll(model, domain, fields, options); return rows.slice(options.offset || 0, (options.offset || 0) + (options.limit || rows.length)); },
    async read(model, ids) { return (db[model] || []).filter(row => ids.includes(row.id)); },
  };
}
function fixture() {
  const order = (id, overrides = {}) => ({ id, name: 'PO' + id, company_id: [1, 'Company One'], partner_id: [1, 'Foreign'], currency_id: [1, 'USD'], state: 'purchase', date_order: '2026-10-10 12:00:00', date_planned: false, amount_total: 200, currency_rate: 1, receipt_status: 'partial', origin: false, notes: false, ...overrides });
  return {
    'purchase.order': [order(1), order(2), order(3, { partner_id: [2, 'Unknown'] }), order(4, { currency_id: [2, 'THB'] }), order(5, { partner_id: [3, 'Thai'] }), order(6, { partner_id: [2, 'Unknown'], currency_id: [2, 'THB'] }), order(7, { state: 'cancel' }), order(8, { date_order: '2024-10-16 11:59:59' }), order(9, { company_id: [3, 'Outside'] }), order(10, { date_order: '2024-10-16 12:00:00' })],
    'sale.order': [order(20, { name: 'SO20', state: 'sale', delivery_status: false, invoice_status: 'invoiced' }), order(21, { name: 'SO21', state: 'draft' }), order(22, { name: 'SO22', state: 'sale', partner_id: [3, 'Thai'] })],
    'res.partner': [{ id: 1, name: 'Foreign', country_id: [1, 'China'] }, { id: 2, name: 'Unknown', country_id: false }, { id: 3, name: 'Thai', country_id: [2, 'Thailand'] }],
    'res.country': [{ id: 1, code: 'CN' }, { id: 2, code: 'TH' }],
    'res.company': [{ id: 1, name: 'Company One' }, { id: 2, name: 'Company Two' }, { id: 3, name: 'Outside' }],
    'res.currency': [{ id: 1, name: 'USD' }, { id: 2, name: 'THB' }],
    'purchase.order.line': Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, order_id: [i + 1, 'PO' + (i + 1)], product_id: [1, 'Widget'], price_subtotal: 100, display_type: false })).concat([
      { id: 200, order_id: [2, 'PO2'], product_id: [2, 'Service'], price_subtotal: 300, display_type: false },
      { id: 201, order_id: [1, 'PO1'], product_id: [3, 'Packing'], price_subtotal: 200, display_type: 'line_section' },
    ]),
    'product.product': [{ id: 1, product_tmpl_id: [1, 'Widget'] }, { id: 2, product_tmpl_id: [2, 'Service'] }, { id: 3, product_tmpl_id: [3, 'Packing'] }],
    'product.template': [{ id: 1, name: 'Widget', default_code: 'TEMPLATE-SKU', categ_id: [1, 'Raw Materials'] }, { id: 2, name: 'Service', default_code: false, categ_id: [2, 'Expense'] }, { id: 3, name: 'Packing', default_code: 'PK', categ_id: [3, 'Packaging'] }],
    'product.category': [{ id: 1, complete_name: 'Raw Materials / Other' }, { id: 2, complete_name: 'Expense / Import' }, { id: 3, complete_name: 'Packaging / Cartons' }],
    'stock.picking': [{ id: 1, origin: 'PO1', company_id: [1, 'Company One'], state: 'done', date_done: '2026-10-12 10:00:00' }, { id: 2, origin: 'PO1', company_id: [1, 'Company One'], state: 'assigned', date_done: '2026-10-15 10:00:00' }, { id: 3, origin: 'PO3', company_id: [1, 'Company One'], state: 'done', date_done: '2024-10-16 11:59:59' }],
    'account.move': [{ id: 1, invoice_origin: 'PO1', state: 'posted', invoice_date: '2026-09-01', invoice_currency_rate: 0.03, move_type: 'in_invoice', company_id: [1, 'Company One'], currency_id: [1, 'USD'] }, { id: 2, invoice_origin: 'PO1', state: 'posted', invoice_date: '2026-10-01', invoice_currency_rate: 0.04, move_type: 'out_refund', company_id: [2, 'Other'], currency_id: [1, 'USD'] }, { id: 3, invoice_origin: 'PO1', state: 'draft', invoice_date: '2026-10-14', invoice_currency_rate: 99 }, { id: 4, invoice_origin: 'PO4', state: 'posted', invoice_date: '2026-10-01', invoice_currency_rate: 99 }],
    'uom.uom': [{ id: 1, name: 'Units' }],
  };
}
const now = () => new Date('2026-10-16T12:00:00Z');
test('imports preserve foreign-country OR unknown-country currency filter, weighted category and SQL nulls', async () => {
  const boards = createOdooBoards(fixtureClient(fixture()), { now });
  const rows = await boards.boards('import');
  assert.deepEqual(rows.map(row => row.id), [4, 3, 1, 10]);
  const row = rows.find(row => row.id === 1);
  assert.deepEqual(row, { id: 1, po_number: 'PO1', company_id: 1, company_name: 'Company One', company_code: 'KOB', partner_id: 1, supplier: 'Foreign', odoo_state: 'purchase', date_order: '2026-10-10T12:00:00.000Z', date_planned: null, amount_total: 200, currency: 'USD', currency_rate: 0.03, rate_auto_corrected: 1, receipt_status: 'partial', origin: null, notes: null, source_type: 'oversea', goods_category: 'Packaging', last_receipt_date: '2026-10-12' });
  assert.equal(rows.find(row => row.id === 4).currency_rate, 1);
  assert.equal(rows.find(row => row.id === 4).rate_auto_corrected, 0);
  assert.equal(rows.find(row => row.id === 3).last_receipt_date, null);
});
test('exports exclude drafts and retain raw delivery, invoice, country and company fields', async () => {
  const rows = await createOdooBoards(fixtureClient(fixture()), { now }).boards('export');
  assert.deepEqual(rows, [{ id: 20, so_number: 'SO20', company_id: 1, company_name: 'Company One', company_code: 'KOB', partner_id: 1, customer: 'Foreign', odoo_state: 'sale', date_order: '2026-10-10T12:00:00.000Z', amount_total: 200, currency: 'USD', currency_rate: 1, rate_auto_corrected: 0, delivery_status: null, invoice_status: 'invoiced', origin: null, country_code: 'CN', source_type: 'oversea' }]);
});
test('board cap is applied after full timestamp ordering and goods-category filtering', async () => {
  const db = fixture();
  db['sale.order'] = Array.from({ length: 510 }, (_, i) => ({ ...db['sale.order'][0], id: i + 1, name: 'SO' + i, date_order: i === 509 ? '2026-10-11 01:00:00' : '2026-10-10 12:00:00' }));
  const rows = await createOdooBoards(fixtureClient(db), { now }).boards('export');
  assert.equal(rows.length, 500);
  assert.equal(rows[0].id, 510);
  assert.equal(rows.at(-1).id, 11);
});
test('PO lines omit sections, join template product/SKU/UOM, preserve missing product, and order sequence then ID', async () => {
  const db = fixture();
  db['purchase.order.line'] = [
    { id: 2, sequence: 20, order_id: [1, 'PO1'], product_id: [1, 'Widget variant'], product_uom: [1, 'Units'], product_qty: 4, name: 'Variant label', display_type: false, price_unit: 10, price_subtotal: 40, price_total: 42.8, qty_received: 2, qty_invoiced: 1 },
    { id: 1, sequence: 10, order_id: [1, 'PO1'], product_id: false, product_uom: false, product_qty: 0, name: 'Custom item', display_type: false, price_unit: 0, price_subtotal: 0, price_total: 0, qty_received: 0, qty_invoiced: 0 },
    { id: 3, sequence: 1, order_id: [1, 'PO1'], name: 'Section', display_type: 'line_section' },
  ];
  const boards = createOdooBoards(fixtureClient(db), { now });
  assert.deepEqual(await boards.poLines('import', 'PO1'), [
    { id: 1, sequence: 10, product_name: 'Custom item', sku: null, qty: 0, uom: null, price_unit: 0, price_subtotal: 0, price_total: 0, qty_fulfilled: 0, qty_invoiced: 0 },
    { id: 2, sequence: 20, product_name: 'Widget', sku: 'TEMPLATE-SKU', qty: 4, uom: 'Units', price_unit: 10, price_subtotal: 40, price_total: 42.8, qty_fulfilled: 2, qty_invoiced: 1 },
  ]);
  assert.deepEqual(await boards.poLines('import', 'missing'), []);
  await assert.rejects(boards.boards('invalid'), /board/i);
});
test('SO lines map ordered and delivered quantities rather than purchase quantities', async () => {
  const db = fixture();
  db['sale.order.line'] = [{ id: 40, sequence: 1, order_id: [20, 'SO20'], product_id: [1, 'Widget'], product_uom: [1, 'Units'], product_uom_qty: 7, qty_delivered: 3, qty_invoiced: 2, price_unit: 10, price_subtotal: 70, price_total: 70, display_type: false }];
  const rows = await createOdooBoards(fixtureClient(db), { now }).poLines('export', 'SO20');
  assert.equal(rows[0].qty, 7);
  assert.equal(rows[0].qty_fulfilled, 3);
});
test('inaccessible related product records fail explicitly rather than excluding the import silently', async () => {
  const db = fixture();
  db['product.product'] = [];
  await assert.rejects(createOdooBoards(fixtureClient(db), { now }).boards('import'), /unavailable/i);
});
test('rate repair rejects zero, negative and nonfinite rates rather than marking them corrected', async () => {
  const db = fixture();
  db['account.move'].push(
    ...[0, -1, Infinity, false].map((invoice_currency_rate, i) => ({ id: 5 + i, invoice_origin: 'PO1', state: 'posted', invoice_date: false, invoice_currency_rate, company_id: [1, 'Company One'], currency_id: [1, 'USD'], move_type: 'in_invoice' })),
  );
  const rows = await createOdooBoards(fixtureClient(db), { now }).boards('import');
  const row = rows.find(r => r.id === 1);
  assert.equal(row.currency_rate, 0.03);
  assert.equal(row.rate_auto_corrected, 1);
});
test('two-year interval clamps leap days like PostgreSQL', async () => {
  const db = fixture();
  db['purchase.order'][0].date_order = '2022-02-28 12:00:00';
  db['purchase.order'][1].date_order = '2022-02-28 11:59:59';
  const rows = await createOdooBoards(fixtureClient(db), { now: () => new Date('2024-02-29T12:00:00Z') }).boards('import');
  assert(rows.some(row => row.id === 1));
  assert(!rows.some(row => row.id === 2));
});
test('receipts with the same origin in another company cannot advance the PO receipt date', async () => {
  const db = fixture();
  db['stock.picking'].push({ id: 50, origin: 'PO1', company_id: [2, 'Company Two'], state: 'done', date_done: '2026-10-15 10:00:00' });
  const rows = await createOdooBoards(fixtureClient(db), { now }).boards('import');
  assert.equal(rows.find(row => row.id === 1).last_receipt_date, '2026-10-12');
});

test('import and export FX repairs match company, currency and invoice direction independently', async () => {
  for (const [board, model, correctType, wrongType, name] of [
    ['import', 'purchase.order', 'in_invoice', 'out_invoice', 'PO1'],
    ['export', 'sale.order', 'out_invoice', 'in_invoice', 'SO20'],
  ]) {
    const db = fixture();
    const original = db[model][0];
    db[model] = [original, { ...original, id: 99, company_id: [2, 'Company Two'] }];
    if (board === 'import') db['purchase.order.line'].push({ id: 999, order_id: [99, name], product_id: [1, 'Widget'], price_subtotal: 100 });
    const move = { invoice_origin: name, company_id: [1, 'Company One'], currency_id: [1, 'USD'], state: 'posted', move_type: correctType, invoice_date: '2026-09-01', invoice_currency_rate: 0.03 };
    db['account.move'] = [
      { ...move, id: 1 },
      { ...move, id: 2, company_id: [2, 'Company Two'], invoice_currency_rate: 0.02 },
      { ...move, id: 3, invoice_date: '2026-10-01', currency_id: [2, 'THB'], invoice_currency_rate: 99 },
      { ...move, id: 4, invoice_date: '2026-10-02', move_type: wrongType, invoice_currency_rate: 98 },
      { ...move, id: 5, invoice_date: '2026-10-03', move_type: correctType.replace('invoice', 'refund'), invoice_currency_rate: 97 },
    ];
    const rows = await createOdooBoards(fixtureClient(db), { now }).boards(board);
    assert.equal(rows.find(row => row.id === original.id).currency_rate, 0.03, board);
    assert.equal(rows.find(row => row.id === 99).currency_rate, 0.02, board);
  }
});

test('no matching invoice leaves a missing foreign rate visibly uncorrected', async () => {
  const db = fixture();
  db['purchase.order'][0].currency_rate = false;
  db['account.move'] = db['account.move'].filter(move => move.id !== 1);
  const row = (await createOdooBoards(fixtureClient(db), { now }).boards('import')).find(row => row.id === 1);
  assert.equal(row.currency_rate, null);
  assert.equal(row.rate_auto_corrected, 0);
});

test('same-name PO and SO details require an unambiguous allowed-company record', async () => {
  for (const [board, model] of [['import', 'purchase.order'], ['export', 'sale.order']]) {
    const db = fixture();
    const original = db[model][0];
    db[model] = [original, { ...original, id: 99, company_id: [2, 'Company Two'] }, { ...original, id: 100, company_id: [3, 'Outside'] }];
    const line = { sequence: 1, product_id: false, product_uom: false, name: 'Custom', display_type: false, price_subtotal: 1 };
    db[model + '.line'] = [original.id, 99, 100].map(id => ({ ...line, id, order_id: [id, original.name] }));
    const boards = createOdooBoards(fixtureClient(db), { now });
    await assert.rejects(boards.poLines(board, original.name), /ambiguous/i);
    assert.deepEqual((await boards.poLines(board, original.name, { companyId: 1 })).map(row => row.id), [original.id]);
    assert.deepEqual((await boards.poLines(board, original.name, { orderId: 99 })).map(row => row.id), [99]);
    assert.deepEqual(await boards.poLines(board, original.name, { companyId: 1, orderId: 99 }), []);
    assert.deepEqual(await boards.poLines(board, original.name, { orderId: 100 }), []);
    for (const options of [{ companyId: 3 }, { companyId: '1 OR 1=1' }, { orderId: -1 }, { orderId: 1.5 }]) {
      await assert.rejects(boards.poLines(board, original.name, options), /invalid/i);
    }
  }
});

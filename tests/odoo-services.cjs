'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createOdooServices } = require('../lib/odoo-services.cjs');

const now = () => new Date('2026-10-16T12:00:00Z');
const relations = {
  'res.partner.country_id': 'res.country', 'purchase.order.partner_id': 'res.partner',
  'purchase.order.currency_id': 'res.currency', 'purchase.order.line.order_id': 'purchase.order',
  'purchase.order.line.product_id': 'product.product', 'product.product.product_tmpl_id': 'product.template',
  'product.product.categ_id': 'product.category', 'product.template.categ_id': 'product.category',
  'account.move.partner_id': 'res.partner', 'account.move.currency_id': 'res.currency',
  'account.move.line.move_id': 'account.move', 'account.move.line.product_id': 'product.product',
  'res.currency.rate.currency_id': 'res.currency',
};
function fixture(extra = {}) {
  const models = {
    'res.partner': [
      { id: 1, name: 'DHL', country_id: [1, 'China'], supplier_rank: 1, active: true, is_company: true },
      { id: 2, name: 'Local', country_id: [2, 'Thailand'], supplier_rank: 1, active: true, is_company: true },
      { id: 3, name: 'Unknown', country_id: false, supplier_rank: 1, active: true, is_company: true },
      { id: 4, name: 'DHL', country_id: [1, 'China'], supplier_rank: 1, active: true, is_company: true },
    ],
    'res.country': [{ id: 1, name: 'China', code: 'CN' }, { id: 2, name: 'Thailand', code: 'TH' }],
    'res.currency': [{ id: 1, name: 'USD' }, { id: 2, name: 'THB' }],
    'product.category': [{ id: 1, complete_name: 'Packaging / Bottles' }, { id: 2, complete_name: 'Expense / Import Expenses' }, { id: 3, complete_name: 'Expense / Other' }],
    'product.template': [{ id: 1, name: 'Bottle', categ_id: [1, 'Packaging'] }, { id: 2, name: 'Freight', categ_id: [2, 'Import Expenses'] }, { id: 3, name: 'Other', categ_id: [3, 'Other'] }],
    'product.product': [{ id: 1, product_tmpl_id: [1, 'Bottle'], categ_id: [1, 'Packaging'] }, { id: 2, product_tmpl_id: [2, 'Freight'], categ_id: [2, 'Import Expenses'] }, { id: 3, product_tmpl_id: [3, 'Other'], categ_id: [3, 'Other'] }],
    'purchase.order': [], 'purchase.order.line': [], 'stock.picking': [],
    'account.move': [], 'account.move.line': [], 'res.currency.rate': [], ...extra,
  };
  function path(model, row, field) {
    const [head, ...tail] = field.split('.');
    const value = row[head];
    if (!tail.length) return Array.isArray(value) ? value[0] : value;
    const rel = relations[`${model}.${head}`];
    assert.ok(rel, `Unknown fixture relation ${model}.${head}`);
    return path(rel, (models[rel] || []).find(r => r.id === (Array.isArray(value) ? value[0] : value)) || {}, tail.join('.'));
  }
  function matches(model, row, domain) {
    let i = 0;
    function term() {
      const t = domain[i++];
      if (t === '|') { const a = term(), b = term(); return a || b; }
      if (t === '&') { const a = term(), b = term(); return a && b; }
      if (t === '!') return !term();
      const [field, op, value] = t, raw = path(model, row, field), actual = raw == null ? false : raw;
      if (op === '=') return actual === value;
      if (op === '!=') return actual !== value;
      if (op === 'in') return value.includes(actual);
      if (op === 'not in') return !value.includes(actual);
      if (op === '>') return actual !== false && actual > value;
      if (op === '>=') return actual !== false && actual >= value;
      if (op === '<=') return actual !== false && actual <= value;
      if (op === 'ilike' || op === '=ilike') {
        const pattern = (op === 'ilike' ? '%' + value + '%' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
        return actual !== false && new RegExp('^' + pattern + '$', 'isu').test(String(actual));
      }
      throw Error(`Unhandled fixture operator ${op}`);
    }
    let result = true;
    while (i < domain.length) { const next = term(); result = result && next; }
    return result;
  }
  function select(model, domain, fields, options = {}) {
    assert.ok(models[model], `Unknown model ${model}`);
    let rows = models[model].filter(row => matches(model, row, domain));
    if (options.order) rows.sort((a, b) => {
      for (const clause of options.order.split(',')) {
        const [field, direction] = clause.trim().split(/\s+/), x = path(model, a, field), y = path(model, b, field);
        if (x !== y) return (x < y ? -1 : 1) * (direction?.toLowerCase() === 'desc' ? -1 : 1);
      }
      return 0;
    });
    rows = rows.slice(options.offset || 0, options.limit ? (options.offset || 0) + options.limit : undefined);
    return structuredClone(rows.map(row => Object.fromEntries(['id', ...fields].filter(f => Object.hasOwn(row, f)).map(f => [f, row[f]]))));
  }
  return {
    searchAll: async (model, domain, fields, options) => select(model, domain, fields, options),
    searchRead: async (model, domain, fields, options) => select(model, domain, fields, options),
    searchCount: async (model, domain) => select(model, domain, []).length,
    read: async (model, ids, fields) => select(model, [['id', 'in', ids]], fields),
  };
}
const po = (id, changes = {}) => ({ id, name: 'PO' + id, partner_id: [1, 'DHL'], currency_id: [1, 'USD'], company_id: [1, 'KOB'], date_order: '2026-10-01 00:00:00', state: 'purchase', amount_total: 100, currency_rate: 0.025, invoice_status: 'invoiced', origin: false, ...changes });
const pol = (id, order, product = 1, amount = 100) => ({ id, order_id: [order, 'PO'], product_id: [product, 'Product'], price_subtotal: amount });
const bill = (id, changes = {}) => ({ id, name: 'BILL' + id, invoice_origin: 'PO1', ref: false, partner_id: [1, 'DHL'], currency_id: [1, 'USD'], company_id: [1, 'KOB'], invoice_date: '2026-10-01', state: 'posted', move_type: 'in_invoice', amount_total: 80, amount_tax: 7, inverse_currency_rate: 40, invoice_currency_rate: 0.025, ...changes });

test('vendors ranks by eligible two-year PO count, retains inactive-test SQL filters and total before cap', async () => {
  const partners = Array.from({ length: 3002 }, (_, i) => ({ id: i + 1, name: 'Vendor' + String(i).padStart(4, '0'), country_id: false, supplier_rank: 1, active: true, is_company: true }));
  partners.push({ ...partners[0], id: 5000, active: false });
  const service = createOdooServices(fixture({ 'res.partner': partners, 'purchase.order': [po(1, { partner_id: [3002, 'Vendor'], date_order: '2026-09-01 00:00:00' }), po(2, { partner_id: [3002, 'Vendor'], date_order: '2025-09-01 00:00:00', currency_id: [2, 'THB'] }), po(3, { partner_id: [1, 'Vendor'], state: 'cancel' }), po(4, { partner_id: [1, 'Vendor'], date_order: '2024-10-16 11:59:59' }), po(5, { partner_id: [1, 'Vendor'], company_id: [3, 'Other'] })] }), { now });
  const result = await service.vendors();
  assert.equal(result.total, 3002); assert.equal(result.rows.length, 3000);
  assert.deepEqual(result.rows[0], { id: 3002, name: 'Vendor3001', country: null, country_code: null, po_count: 2, last_currency: 'USD' });
  assert.equal(result.rows[1].po_count, 0); assert.equal(result.rows[1].last_currency, null);
});

test('scorecard preserves duplicate-origin joins, vendor IDs, import categories and completed bounds', async () => {
  const orders = [po(1, { name: 'DUP' }), po(2, { name: 'DUP', company_id: [2, 'BTV'] }), po(3, { partner_id: [4, 'DHL'] }), po(4, { partner_id: [2, 'Local'] }), po(5, { partner_id: [3, 'Unknown'], currency_id: [2, 'THB'] }), po(6), po(7, { name: 'DUP' })];
  const picks = [
    { id: 1, origin: 'DUP', state: 'done', scheduled_date: '2026-10-01 00:00:00', date_done: '2026-10-02 00:00:00' },
    { id: 2, origin: 'PO3', state: 'done', scheduled_date: '2026-10-01 00:00:00', date_done: '2026-10-01 00:00:00' },
    { id: 3, origin: 'PO3', state: 'done', scheduled_date: '2026-10-01 00:00:00', date_done: '2026-09-30 00:00:00' },
    ...['PO4', 'PO5', 'PO6'].flatMap((origin, i) => [1, 2].map(n => ({ id: 10 + i * 2 + n, origin, state: 'done', scheduled_date: '2026-10-01 00:00:00', date_done: '2026-10-02 00:00:00' }))),
    { id: 99, origin: 'DUP', state: 'done', scheduled_date: '2299-01-01 00:00:00', date_done: '2026-10-01 00:00:00' },
  ];
  const rows = await createOdooServices(fixture({ 'purchase.order': orders, 'purchase.order.line': orders.map(p => pol(p.id, p.id, p.id === 6 ? 3 : 1)), 'stock.picking': picks.map(p => ({ company_id: [1, 'KOB'], ...p })) }), { now }).vendorScorecard();
  assert.deepEqual(rows, [ { vendor_id: 1, vendor: 'DHL', deliveries: 2, on_time: 0, avg_delay_days: 1 }, { vendor_id: 4, vendor: 'DHL', deliveries: 2, on_time: 2, avg_delay_days: -0.5 } ]);
});

test('GL nets refunds, exact origins and matching company/currency, ignores zero denominators and non-import POs', async () => {
  const orders = [po(1), po(2, { amount_total: 0 }), po(3), po(4), po(5), po(6)];
  const moves = [bill(1), bill(2, { move_type: 'in_refund', amount_total: 100 }), bill(3, { amount_total: 999, company_id: [2, 'BTV'] }), bill(4, { amount_total: 999, currency_id: [2, 'THB'] }), bill(5, { amount_total: 999, invoice_origin: 'PO1, PO2' }), bill(6, { invoice_origin: 'PO2' }), bill(7, { invoice_origin: 'PO3', amount_total: 100 }), bill(8, { invoice_origin: 'PO3', move_type: 'in_refund', amount_total: 100 }), bill(9, { invoice_origin: 'PO4', amount_total: 85 }), bill(10, { invoice_origin: 'PO5', amount_total: 1 }), bill(11, { invoice_origin: 'PO6', state: 'draft', amount_total: 1 })];
  const rows = await createOdooServices(fixture({ 'purchase.order': orders, 'purchase.order.line': orders.map(p => pol(p.id, p.id, p.id === 5 ? 3 : 1)), 'account.move': moves }), { now }).glReconciliation();
  assert.deepEqual(rows, [ { po_id: 1, po_number: 'PO1', po_total: 100, currency: 'USD', billed_total: -20, diff_pct: -120 }, { po_id: 3, po_number: 'PO3', po_total: 100, currency: 'USD', billed_total: 0, diff_pct: -100 } ]);
});

test('logistics returns raw refunds and lines, import-category selection, independent counts and pages', async () => {
  const orders = [po(1), po(2, { partner_id: [2, 'Local'] }), po(3, { partner_id: [2, 'Local'] }), po(4, { state: 'cancel' }), po(5, { company_id: [2, 'BTV'] })];
  const moves = [bill(1), bill(2, { move_type: 'in_refund', partner_id: [2, 'Local'], invoice_date: '2026-09-29', inverse_currency_rate: 0, invoice_currency_rate: 0.05, ref: 'credit' }), bill(3, { partner_id: [2, 'Local'] }), bill(4, { state: 'draft' }), bill(5, { company_id: [2, 'BTV'] }), bill(6, { invoice_date: '2026-02-16' })];
  const lines = [ { id: 1, move_id: [1, 'BILL'], name: 'Freight', price_subtotal: 60, display_type: 'product', product_id: [2, 'Freight'] }, { id: 2, move_id: [1, 'BILL'], name: false, price_subtotal: -5, display_type: 'product', product_id: false }, { id: 3, move_id: [1, 'BILL'], name: 'Tax', price_subtotal: 900, display_type: 'tax', product_id: false }, { id: 4, move_id: [2, 'BILL'], name: 'Expense', price_subtotal: 80, display_type: 'line_note', product_id: [2, 'Freight'] } ];
  const services = createOdooServices(fixture({ 'purchase.order': orders, 'purchase.order.line': [pol(1, 1), pol(2, 2, 2), pol(3, 3, 3)], 'account.move': moves, 'account.move.line': lines }), { now });
  const result = await services.logisticsBills({ company: 'KOB', months: 8, limit: 1, offset: 1 });
  assert.equal(result.billTotal, 2); assert.equal(result.poTotal, 2);
  assert.deepEqual(result.billRows, [{ id: 2, company_id: 1, move_type: 'in_refund', bill_name: 'BILL2', invoice_origin: 'PO1', ref: 'credit', amount_total: 80, amount_tax: 7, currency: 'USD', rate_thb: 20, partner: 'Local', doc_date: '2026-09-29', lines: [] }]);
  assert.equal(result.poRows[0].id, 2); assert.equal(result.poRows[0].main_product, 'Freight'); assert.equal(result.poRows[0].rate_thb, 40);
  const first = await services.logisticsBills({ company: 'KOB', months: 8, limit: 1 });
  assert.deepEqual(first.billRows[0].lines, [{ name: 'Freight', amount: 60 }, { name: null, amount: -5 }]);
});

test('logistics keeps SQL ILIKE wildcard search and calendar-month timestamp boundary', async () => {
  const services = createOdooServices(fixture({ 'purchase.order': [po(1, { name: 'PO-ABC', origin: 'AxxB', date_order: '2026-02-16 12:00:00', currency_rate: 0 }), po(2, { name: 'PO-ABC', date_order: '2026-02-16 11:59:59' })], 'account.move': [bill(1, { name: 'BILL-ABC', inverse_currency_rate: 0, invoice_currency_rate: 0 })] }), { now });
  const wildcard = await services.logisticsBills({ months: 8, q: '_A%', limit: 100 });
  assert.equal(wildcard.poTotal, 1); assert.equal(wildcard.billTotal, 1);
  assert.equal(wildcard.poRows[0].rate_thb, null); assert.equal(wildcard.billRows[0].rate_thb, null);
  assert.equal((await services.logisticsBills({ months: 8, q: 'absent' })).billTotal, 0);
});

test('FX uses only effective rates and expands global defaults into each company', async () => {
  const rows = await createOdooServices(fixture({ 'res.currency.rate': [ { id: 1, company_id: false, currency_id: [1, 'USD'], rate: 0.025, name: '2026-01-01' }, { id: 2, company_id: [2, 'BTV'], currency_id: [1, 'USD'], rate: 0.03, name: '2027-01-01' }, { id: 3, company_id: false, currency_id: [2, 'THB'], rate: 1, name: '2026-10-01' } ] }), { now }).fxRates();
  assert.deepEqual(rows, [{ currency: 'THB', rate: 1, as_of: '2026-10-01', company_id: 1 }, { currency: 'THB', rate: 1, as_of: '2026-10-01', company_id: 2 }, { currency: 'USD', rate: 0.025, as_of: '2026-01-01', company_id: 1 }, { currency: 'USD', rate: 0.025, as_of: '2026-01-01', company_id: 2 }]);
});

test('required unreadable financial fields fail instead of returning guessed data', async () => {
  const missing = bill(1); delete missing.inverse_currency_rate;
  await assert.rejects(() => createOdooServices(fixture({ 'account.move': [missing] }), { now }).logisticsBills({}), /field/i);
});

test('GL uses the signed SQL denominator and an exact strict decimal 15 percent threshold', async () => {
  const orders = [po(1, { amount_total: -100 }), po(2), po(3)];
  const rows = await createOdooServices(fixture({ 'purchase.order': orders, 'purchase.order.line': orders.map(p => pol(p.id, p.id)), 'account.move': [bill(1, { amount_total: 10 }), bill(2, { invoice_origin: 'PO2', amount_total: 115.00000000001 }), bill(3, { invoice_origin: 'PO3', amount_total: 115 })] }), { now }).glReconciliation();
  assert.deepEqual(rows, [{ po_id: 2, po_number: 'PO2', po_total: 100, currency: 'USD', billed_total: 115.00000000001, diff_pct: 15 }]);
});

test('logistics UPS word boundaries include Unicode letters like PostgreSQL', async () => {
  const partners = ['sups', 'กupsข', 'UPS (Thailand)'].map((name, i) => ({ id: i + 1, name, country_id: false }));
  const rows = await createOdooServices(fixture({ 'res.partner': partners, 'purchase.order': partners.map(p => po(p.id, { partner_id: [p.id, p.name] })) }), { now }).logisticsBills({});
  assert.equal(rows.poTotal, 1); assert.equal(rows.poRows[0].partner, 'UPS (Thailand)');
});

test('inaccessible related records and pagination overflow propagate without partial success', async () => {
  const missing = fixture({ 'res.currency': [], 'account.move': [bill(1)] });
  await assert.rejects(() => createOdooServices(missing, { now }).logisticsBills({}), /related records/i);
  const overflow = fixture();
  overflow.searchAll = async () => { throw Error('Odoo pagination overflow'); };
  await assert.rejects(() => createOdooServices(overflow, { now }).vendors(), /overflow/);
});

test('scorecard never joins another company delivery by the same PO origin', async () => {
  const picks = [1, 2].map(id => ({ id, company_id: [2, 'BTV'], origin: 'PO1', state: 'done', scheduled_date: '2026-10-01 00:00:00', date_done: '2026-10-02 00:00:00' }));
  const rows = await createOdooServices(fixture({ 'purchase.order': [po(1)], 'purchase.order.line': [pol(1, 1)], 'stock.picking': picks }), { now }).vendorScorecard();
  assert.deepEqual(rows, []);
});

test('vendor scope excludes other-company suppliers even when the client can read them', async () => {
  const partners = [false, [1, 'KOB'], [2, 'BTV'], [3, 'Other']].map((company_id, i) => ({ id: i + 1, name: 'Supplier' + i, company_id, country_id: false, supplier_rank: 1, active: true, is_company: true }));
  const result = await createOdooServices(fixture({ 'res.partner': partners }), { now }).vendors();
  assert.equal(result.total, 3); assert.deepEqual(result.rows.map(r => r.id), [1, 2, 3]);
});

test('FX excludes other-company rates even when the client can read them', async () => {
  const rows = await createOdooServices(fixture({ 'res.currency.rate': [
    { id: 1, company_id: false, currency_id: [1, 'USD'], rate: 0.025, name: '2026-01-01' },
    { id: 2, company_id: [2, 'BTV'], currency_id: [1, 'USD'], rate: 0.03, name: '2026-10-01' },
    { id: 3, company_id: [3, 'Other'], currency_id: [1, 'USD'], rate: 99, name: '2027-01-01' },
  ] }), { now }).fxRates();
  assert.deepEqual(rows, [{ currency: 'USD', rate: 0.025, as_of: '2026-01-01', company_id: 1 }, { currency: 'USD', rate: 0.03, as_of: '2026-10-01', company_id: 2 }]);
});

test('FX prefers company-specific effective rates over newer shared rates and resolves same-date ties', async () => {
  const rows = await createOdooServices(fixture({ 'res.currency.rate': [
    { id: 1, company_id: [1, 'KOB'], currency_id: [1, 'USD'], rate: 0.02, name: '2026-10-01' },
    { id: 2, company_id: false, currency_id: [1, 'USD'], rate: 0.04, name: '2026-10-16' },
    { id: 3, company_id: [1, 'KOB'], currency_id: [1, 'USD'], rate: 0.025, name: '2026-10-01' },
    { id: 4, company_id: [2, 'BTV'], currency_id: [1, 'USD'], rate: 0.05, name: '2026-10-17' },
    { id: 5, company_id: false, currency_id: [2, 'THB'], rate: 1, name: '2026-10-17' },
  ] }), { now }).fxRates();
  assert.deepEqual(rows, [
    { currency: 'USD', rate: 0.025, as_of: '2026-10-01', company_id: 1 },
    { currency: 'USD', rate: 0.04, as_of: '2026-10-16', company_id: 2 },
  ]);
});

test('logistics raw rows retain company identity for same-name bill and PO reconciliation', async () => {
  const rows = await createOdooServices(fixture({
    'purchase.order': [po(1), po(2, { name: 'PO1', company_id: [2, 'BTV'] })],
    'account.move': [bill(1), bill(2, { company_id: [2, 'BTV'] })],
  }), { now }).logisticsBills();
  assert.deepEqual(rows.billRows.map(row => row.company_id), [1, 2]);
  assert.deepEqual(rows.poRows.map(row => row.company_id), [1, 2]);
});

test('logistics rejects nonpositive exchange rates while retaining valid invoice-rate fallback', async () => {
  const rows = await createOdooServices(fixture({
    'purchase.order': [po(1, { currency_rate: -0.025 })],
    'account.move': [bill(1, { inverse_currency_rate: -1, invoice_currency_rate: 0.025 }), bill(2, { inverse_currency_rate: 0, invoice_currency_rate: -0.025 })],
  }), { now }).logisticsBills();
  assert.equal(rows.poRows[0].rate_thb, null);
  assert.equal(rows.billRows[0].rate_thb, 40);
  assert.equal(rows.billRows[1].rate_thb, null);
});

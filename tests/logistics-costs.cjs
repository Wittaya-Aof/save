'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
function classify(billRows, poRows = []) {
  const modulePath = path.join(__dirname, '../lib/logistics-costs.cjs');
  if (fs.existsSync(modulePath)) return require(modulePath).classifyLogisticsCosts(billRows, poRows);
  const source = fs.readFileSync(path.join(__dirname, '../api-server.js'), 'utf8');
  const start = source.indexOf('        const INS_RE');
  const end = source.indexOf('\n\n        // via บอกว่า', start);
  const context = { billRows, poRows, module: { exports: {} } };
  vm.runInNewContext(source.slice(start, end) + '\nmodule.exports=out;', context);
  return context.module.exports;
}
const base = { id: 1, company_id: 1, bill_name: 'FIXTURE', move_type: 'in_invoice', currency: 'THB', amount_tax: 0, partner: 'Freight Co', doc_date: '2026-10-16' };
const sum = r => ['freight', 'clearance', 'insurance', 'duty', 'vat'].reduce((n, k) => n + r[k], 0);
test('discount categories reconcile to bill total', () => {
  const r = classify([{ ...base, amount_total: 90, lines: [{ name: 'Freight', amount: 100 }, { name: 'Insurance discount', amount: -10 }] }])[0];
  assert.equal(r.amount, 90); assert.equal(sum(r), 90); assert.equal(r.insurance, -10);
});
test('foreign missing FX remains unknown with original amount retained', () => {
  const r = classify([{ ...base, currency: 'USD', amount_total: 100, rate_thb: null, lines: [] }])[0];
  assert.equal(r.amount, null); assert.equal(r.fxStatus, 'missing'); assert.equal(r.origAmount, 100);
  for (const k of ['freight', 'clearance', 'insurance', 'duty', 'vat']) assert.equal(r[k], null);
});
test('refund preserves negative category allocation', () => {
  const r = classify([{ ...base, move_type: 'in_refund', amount_total: 100, lines: [{ name: 'Freight', amount: 70 }, { name: 'Insurance', amount: 30 }] }])[0];
  assert.equal(r.freight, -70); assert.equal(r.insurance, -30); assert.equal(sum(r), -100);
});
test('same-name expense PO in another company is not suppressed', () => {
  const rows = classify([{ ...base, invoice_origin: 'PO1', amount_total: 10, lines: [] }],
    [{ id: 2, company_id: 2, po_number: 'PO1', amount_total: 20, currency: 'THB' }]);
  assert.equal(rows.length, 2);
});

test('consolidated bill replaces each exact referenced PO without doubling estimates', () => {
  const rows = classify([{ ...base, invoice_origin: ' PO-A, PO-B, PO-A ', amount_total: 100, lines: [] }],
    [{ id: 1, company_id: 1, po_number: 'PO-A', amount_total: 40, currency: 'THB' },
     { id: 2, company_id: 1, po_number: 'PO-B', amount_total: 60, currency: 'THB' }]);
  assert.equal(rows.length, 1); assert.equal(rows[0].amount, 100);
});

test('consolidated reference matching is exact and scoped even when the bill FX is missing', () => {
  const orders = ['PO1', 'PO10', 'PO100'].map((po_number, i) => ({ id: i + 1, company_id: 1, po_number, amount_total: 10, currency: 'THB' }));
  orders.push({ ...orders[0], id: 4, company_id: 2 });
  const rows = classify([{ ...base, ref: 'PO1, PO100', currency: 'USD', amount_total: 100, rate_thb: null, lines: [] }], orders);
  assert.deepEqual(rows.map(r => r.id), [1, 'po_2', 'po_4']);
  assert.equal(rows[0].amount, null);
});
test('rounding categories reconciles exactly at currency precision', () => {
  const r = classify([{ ...base, amount_total: 100.01, lines: [{ name: 'Freight', amount: 33.333 }, { name: 'Insurance', amount: 33.333 }, { name: 'Customs Clearance', amount: 33.333 }] }])[0];
  assert(Math.abs(sum(r) - r.amount) < 1e-8); assert.equal(r.amount, 100.01);
});
test('direct board SQL also scopes repair by company currency and invoice direction', () => {
  const source = fs.readFileSync(path.join(__dirname, '../api-server.js'), 'utf8');
  for (const [name, type] of [['IMPORT', 'in_invoice'], ['EXPORT', 'out_invoice']]) {
    const sql = source.match(new RegExp('const SQL_' + name + ' = `([\\s\\S]*?)`;'))[1];
    const alias = sql.match(/JOIN bad_names ([a-z_]+) ON/)[1];
    assert.match(sql, new RegExp('am\\.company_id\\s*=\\s*' + alias + '\\.company_id'));
    assert.match(sql, new RegExp('am\\.currency_id\\s*=\\s*' + alias + '\\.currency_id'));
    assert(sql.includes("am.move_type = '" + type + "'"));
  }
});

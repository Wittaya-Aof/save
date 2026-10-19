'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { IMPORT_INNER, EXPORT_INNER } = require('../odoo-queries.js');
const fs = require('node:fs');
const path = require('node:path');

test('FX SQL selects an effective company-scoped rate with a shared fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '../api-server.js'), 'utf8');
  const query = source.slice(source.indexOf("if (reqUrl === '/api/fx-rates'"), source.indexOf('// ── Static Files'));
  assert.match(query, /VALUES\s*\(1\),\s*\(2\)/);
  assert.match(query, /r\.company_id = target\.company_id OR r\.company_id IS NULL/);
  assert.match(query, /r\.name <=.*CURRENT_TIMESTAMP.*UTC/);
  assert.match(query, /ORDER BY \(r\.company_id = target\.company_id\) DESC NULLS LAST, r\.name DESC, r\.id DESC/);
  assert.match(query, /target\.company_id/);
});

// These are emitted PostgreSQL query contracts, not database execution tests.
// The companion adapter fixtures exercise the equivalent monetary behavior.
for (const [board, sql, prefix, orderName, moveType] of [
  ['import', IMPORT_INNER, 'po', 'po_number', 'in_invoice'],
  ['export', EXPORT_INNER, 'so', 'so_number', 'out_invoice'],
]) {
  test(`${board} SQL carries order identity through rate lookup and joins on every scope key`, () => {
    const query = sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
    assert.match(query, new RegExp(`${prefix}\\.company_id(?: AS company_id)?[, ]`));
    assert.match(query, new RegExp(`${prefix}\\.currency_id(?: AS currency_id)?[, ]`));
    assert.match(query, new RegExp(`SELECT DISTINCT ${orderName}, company_id, currency_id FROM base`));
    assert.match(query, /DISTINCT ON \(am\.invoice_origin, am\.company_id, am\.currency_id\)/);
    assert.match(query, new RegExp(`am\\.invoice_origin = bad\\.${orderName}`));
    assert.match(query, /am\.company_id = bad\.company_id/);
    assert.match(query, /am\.currency_id = bad\.currency_id/);
    assert.match(query, new RegExp(`am\\.move_type = '${moveType}'`));
    assert.match(query, /am\.invoice_currency_rate > 0/);
    assert.match(query, /am\.invoice_currency_rate::text NOT IN \('NaN', 'Infinity', '-Infinity'\)/);
    assert.match(query, /ORDER BY am\.invoice_origin, am\.company_id, am\.currency_id, am\.invoice_date DESC, am\.id DESC/);
    assert.match(query, new RegExp(`fixed_rates\\.invoice_origin = base\\.${orderName}`));
    assert.match(query, /fixed_rates\.company_id = base\.company_id/);
    assert.match(query, /fixed_rates\.currency_id = base\.currency_id/);
  });
}

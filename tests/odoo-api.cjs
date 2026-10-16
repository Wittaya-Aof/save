'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createOdooClient } = require('../lib/odoo-api.cjs');
const env = { ODOO_API_URL: 'https://odoo.example/odoo', ODOO_DB: 'private-db', ODOO_LOGIN: 'private-login', ODOO_API_KEY: 'private-key' };
function transport(handler) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body, options });
    const value = await handler(body.params, calls.length);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, ...value }) };
  } };
}
test('authentication is deduplicated and all object reads enforce company and translation context', async () => {
  const tx = transport(async p => p.service === 'common' ? { result: 42 } : { result: [{ id: 7 }] });
  const client = createOdooClient(env, tx);
  assert.deepEqual(await Promise.all([client.authenticate(), client.authenticate()]), [42, 42]);
  assert.deepEqual(await client.execute('res.partner', 'search_read', [[]], { context: { allowed_company_ids: [9], lang: 'th_TH', active_test: true, custom: 1 } }), [{ id: 7 }]);
  assert.equal(tx.calls.length, 2);
  assert.equal(tx.calls[0].url, 'https://odoo.example/jsonrpc');
  assert.deepEqual(tx.calls[0].body.params.args, ['private-db', 'private-login', 'private-key', {}]);
  assert.deepEqual(tx.calls[1].body.params.args.slice(0, 6), ['private-db', 42, 'private-key', 'res.partner', 'search_read', [[]]]);
  assert.deepEqual(tx.calls[1].body.params.args[6].context, { custom: 1, allowed_company_ids: [1, 2], lang: 'en_US', active_test: false });
});
test('unsafe URLs and mutation methods fail before any network access', async () => {
  assert.throws(() => createOdooClient({ ...env, ODOO_API_URL: 'http://odoo.example' }), /HTTPS/);
  assert.throws(() => createOdooClient({ ...env, ODOO_API_URL: 'https://user:password@odoo.example' }), /configuration/i);
  const tx = transport(() => { throw Error('network must not run'); });
  const client = createOdooClient(env, tx);
  for (const method of ['create', 'write', 'unlink', 'action_confirm', 'sudo']) await assert.rejects(client.execute('purchase.order', method), /read-only/i);
  assert.equal(tx.calls.length, 0);
});
test('RPC, authentication and transport failures do not leak remote payloads or credentials', async () => {
  for (const value of [{ result: false }, { error: { message: 'private-key private-db', data: { debug: 'business payload' } } }]) {
    const client = createOdooClient(env, transport(() => value));
    await assert.rejects(client.authenticate(), e => !/private|payload/.test(e.message) && /Odoo/.test(e.message));
  }
  const client = createOdooClient(env, { fetchImpl: async () => { throw Error('private-key'); } });
  await assert.rejects(client.authenticate(), e => !e.message.includes('private-key'));
});
test('deadline includes response decoding and rejects a stalled response', async () => {
  const client = createOdooClient(env, { timeoutMs: 15, fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) });
  await assert.rejects(client.authenticate(), /timeout/i);
});
test('searchAll preserves sort ties across pages and detects maxRows overflow', async () => {
  const tx = transport(p => {
    if (p.service === 'common') return { result: 42 };
    const kw = p.args[6];
    return { result: [{ id: 1 }, { id: 2 }, { id: 3 }].slice(kw.offset, kw.offset + kw.limit) };
  });
  const client = createOdooClient(env, tx);
  assert.deepEqual(await client.searchAll('res.partner', [], ['name'], { batchSize: 2, order: 'name desc', maxRows: 3 }), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(tx.calls[1].body.params.args[6].order, 'name desc, id asc');
  await assert.rejects(client.searchAll('res.partner', [], ['name'], { batchSize: 2, maxRows: 2 }), /limit|overflow/i);
});
test('explicit searchRead caps and count/read normalize their RPC arguments', async () => {
  const tx = transport(p => p.service === 'common' ? { result: 42 } : { result: p.args[4] === 'search_count' ? 4 : [] });
  const client = createOdooClient(env, tx);
  await client.searchRead('sale.order', [], ['id'], { limit: 500, offset: 20, order: 'date_order desc' });
  assert.deepEqual(tx.calls[1].body.params.args[6], { fields: ['id'], limit: 500, offset: 20, order: 'date_order desc', context: { allowed_company_ids: [1, 2], lang: 'en_US', active_test: false } });
  assert.equal(await client.searchCount('res.partner', []), 4);
  await client.read('res.partner', [1, 2], ['name']);
  assert.deepEqual(tx.calls.at(-1).body.params.args.slice(3, 6), ['res.partner', 'read', [[1, 2]]]);
  assert.deepEqual(tx.calls.at(-1).body.params.args[6].fields, ['name']);
});
test('pagination rejects repeated rows rather than returning a plausibly complete result', async () => {
  const tx = transport(p => p.service === 'common' ? { result: 42 } : { result: [{ id: 1 }, { id: 2 }] });
  await assert.rejects(createOdooClient(env, tx).searchAll('res.partner', [], ['name'], { batchSize: 2 }), /pagination/i);
});
test('failed authentication can be retried without caching a rejected promise', async () => {
  const tx = transport((p, call) => ({ result: call === 1 ? false : 42 }));
  const client = createOdooClient(env, tx);
  await assert.rejects(client.authenticate(), /authentication/i);
  assert.equal(await client.authenticate(), 42);
});

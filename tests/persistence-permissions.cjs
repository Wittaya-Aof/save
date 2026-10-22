'use strict';
// Real HTTP app, isolated data/port/integrations; never loads the project's .env.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(seed = [{ po_so: 'PO-FIXTURE', _ts: 100, note: 'original', _board: 'import' }]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ie-permissions-'));
  fs.writeFileSync(path.join(dir, 'tracking_data.json'), JSON.stringify(seed));
  const hook = path.join(dir, 'hook.cjs');
  fs.writeFileSync(hook, `
const Module=require('node:module'), real=Module._load, fs=require('node:fs'), path=require('node:path');
Module._load=function(name,...rest){
 if(name.endsWith('/config-env.cjs'))return {loadProjectEnv(){}};
 if(name==='pg')return {Pool:class{on(){}async query(){throw Error('No database in fixture')}}};
 if(name.endsWith('/odoo-api.cjs'))return {createOdooClient:()=>({authenticate:async()=>1,searchCount:async()=>0})};
 if(name.endsWith('/odoo-boards.cjs'))return {createOdooBoards:()=>({boards:async board=>board==='import'?[{id:1,company_id:1,company_code:'KOB',po_number:'PO-FIXTURE',supplier:'Fixture Supplier',currency:'THB',currency_rate:1,amount_total:1000,odoo_state:'purchase'}]:[],poLines:async()=>[]})};
 if(name.endsWith('/odoo-services.cjs'))return {createOdooServices:()=>({vendors:async()=>({rows:[],total:0}),vendorScorecard:async()=>[],glReconciliation:async()=>[],fxRates:async()=>[],logisticsBills:async()=>({billRows:[],poRows:[]})})};
 if(name==='fs')return new Proxy(fs,{get(t,k){if(k==='writeFileSync')return function(file,...args){if(String(file).includes('tracking_data.json')&&fs.existsSync(path.join(process.env.DATA_DIR,'deny-write')))throw Error('fixture disk failure');return fs.writeFileSync(file,...args)};return t[k]}});
 return real.call(this,name,...rest);
};`);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  let logs = '';
  const env = { ...process.env, DATA_DIR: dir, FULL_BACKUP_DIR: path.join(dir, 'full-backups'),
    HOST: '127.0.0.1', PORT: String(port), ODOO_DATA_SOURCE: 'api',
    APP_USER: 'admin', APP_PASSWORD: 'fixture-admin', VIEWER_USER: 'viewer', VIEWER_PASSWORD: 'fixture-viewer',
    DELETE_PASSWORD: 'fixture-delete',
    APP_BACKGROUND_DISABLED: '1', MAIL_DISABLED: '1', ALERT_EMAIL_TO: '', MCP_URL: '', MCP_TOKEN: '' };
  const child = spawn(process.execPath, ['--require', hook, path.join(root, 'api-server.js')], {
    windowsHide: true, cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  const request = async (route, body, user = 'admin', password = user === 'viewer' ? 'fixture-viewer' : 'fixture-admin', extraHeaders = {}) => {
    const r = await fetch('http://127.0.0.1:' + port + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(user + ':' + password).toString('base64'), 'content-type': 'application/json', ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error('Fixture app exited: ' + logs);
    try { if ((await fetch('http://127.0.0.1:' + port + '/api/alive')).ok) break; } catch {}
    await pause(40);
  }
  return { dir, base: 'http://127.0.0.1:' + port, request, async close() {
    if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    assert(dir.startsWith(path.join(os.tmpdir(), 'ie-permissions-')));
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

if (require.main === module) test('isolated persistence and role contracts', async t => {
  const f = await fixture();
  try {
    await t.test('legacy replace-all cannot erase records', async () => {
      const r = await f.request('/api/tracking', []);
      assert.equal(r.status, 405);
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'tracking_data.json'))).length, 1);
    });
    await t.test('forged shared username is rejected', async () => {
      assert.equal((await f.request('/api/tracking', undefined, 'someone-else')).status, 401);
    });
    await t.test('shared viewer can read, identity is explicit and writes forbidden', async () => {
      assert.equal((await f.request('/api/tracking', undefined, 'viewer')).status, 200);
      const who = await f.request('/api/me', undefined, 'viewer');
      assert.equal(who.body.role, 'viewer'); assert.equal(who.body.canWrite, false);
      for (const route of ['/api/tracking/upsert', '/api/tracking/delete', '/api/freight-quotes/upsert', '/api/cache/clear', '/api/freight-extract']) {
        assert.equal((await f.request(route, {}, 'viewer')).status, 403, route);
      }
    });
    await t.test('viewer integrity reads never execute checks or mutate ledgers', async () => {
      assert.equal((await f.request('/api/integrity-check?force=1', undefined, 'viewer')).status, 403);
      assert.equal((await f.request('/api/integrity-check', undefined, 'viewer')).status, 200);
      assert.equal(fs.existsSync(path.join(f.dir, 'integrity_seen.json')), false);
    });
    await t.test('cross-site forms and non-JSON writes cannot modify business data', async () => {
      const body = { po_so: 'PO-FIXTURE', _baseTs: 100, note: 'cross-site' };
      const foreign = await f.request('/api/tracking/upsert', body, 'admin', 'fixture-admin', { origin: 'https://other.invalid', 'sec-fetch-site': 'cross-site' });
      assert.equal(foreign.status, 403);
      const form = await f.request('/api/tracking/upsert', body, 'admin', 'fixture-admin', { 'content-type': 'text/plain' });
      assert.equal(form.status, 415);
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'tracking_data.json')))[0].note, 'original');
    });
    await t.test('future client timestamp and stale/missing base cannot overwrite', async () => {
      const stale = await f.request('/api/tracking/upsert', { po_so: 'PO-FIXTURE', _baseTs: 99, _ts: 9999999999999, note: 'stale' });
      assert.equal(stale.status, 409);
      const missing = await f.request('/api/tracking/upsert', { po_so: 'PO-FIXTURE', note: 'unguarded' });
      assert.equal(missing.status, 409);
      const good = await f.request('/api/tracking/upsert', { po_so: 'PO-FIXTURE', _baseTs: 100, _ts: 1, note: 'saved' });
      assert.equal(good.status, 200); assert.equal(good.body.ok, true);
      assert(good.body.rows[0]._ts > 100);
      const conflict = await f.request('/api/tracking/upsert', { po_so: 'PO-FIXTURE', _baseTs: 100, note: 'old tab' });
      assert.equal(conflict.status, 409);
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'tracking_data.json')))[0].note, 'saved');
    });
    await t.test('failed disk persistence is HTTP failure without success acknowledgements', async () => {
      const row = (await f.request('/api/tracking')).body.rows[0];
      fs.writeFileSync(path.join(f.dir, 'deny-write'), 'fixture');
      const r = await f.request('/api/tracking/upsert', { po_so: row.po_so, _baseTs: row._ts, note: 'not saved' });
      fs.unlinkSync(path.join(f.dir, 'deny-write'));
      assert.equal(r.status, 500); assert.equal(r.body.ok, false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'tracking_data.json')))[0].note, 'saved');
    });
    await t.test('malformed existing file is preserved and not treated as empty', async () => {
      const file = path.join(f.dir, 'tracking_data.json'); const raw = fs.readFileSync(file);
      fs.writeFileSync(file, '{broken fixture');
      const r = await f.request('/api/tracking/upsert', { po_so: 'NEW-FIXTURE', _baseTs: 0 });
      assert.equal(r.status, 500); assert.equal(fs.readFileSync(file, 'utf8'), '{broken fixture');
      fs.writeFileSync(file, raw);
    });
    await t.test('freight quote stale saves do not remove another edit', async () => {
      const base = { id: 'fq_fixture123', type: 'import-sea', head: { ref: 'Q' }, rows: [], options: [] };
      const created = await f.request('/api/freight-quotes/upsert', base);
      assert.equal(created.status, 200);
      const revision = created.body.row.updatedAt;
      assert.equal((await f.request('/api/freight-quotes/upsert', { ...base, updatedAt: revision, head: { ref: 'Q', party: 'saved' } })).status, 200);
      assert.equal((await f.request('/api/freight-quotes/upsert', { ...base, updatedAt: revision, head: { ref: 'stale' } })).status, 409);
      assert.equal((await f.request('/api/freight-quotes/delete', { id: base.id, _baseUpdatedAt: revision })).status, 409);
    });
    await t.test('linked shipment metadata is immutable and stale deletes fail', async () => {
      const a = await f.request('/api/tracking/upsert', { po_so: 'PO-FIXTURE (2)', _baseTs: 0,
        _synthetic: true, _splitBase: 'PO-FIXTURE', _board: 'import', company: 'KOB', dueDate: '2026-10-16', freight: -10 });
      assert.equal(a.status, 200); const original = a.body.rows[0];
      const b = await f.request('/api/tracking/upsert', { ...original, _shipmentId: 'shp_' + 'f'.repeat(32), _baseTs: original._ts, note: 'edit' });
      assert.equal(b.status, 200); assert.equal(b.body.rows[0]._shipmentId, original._shipmentId);
      assert.equal(b.body.rows[0].poRefs[0].poNumber, 'PO-FIXTURE');
      const found = await f.request('/api/shipments?po=PO-FIXTURE');
      assert.equal(found.status, 200); assert(found.body.rows.some(r => r._shipmentId === original._shipmentId));
      assert.equal((await f.request('/api/tracking/delete', { po_so: original.po_so, password: 'fixture-delete', _baseTs: original._ts })).status, 409);
      assert.equal((await f.request('/api/tracking/delete', { po_so: original.po_so, password: 'fixture-delete', _baseTs: b.body.rows[0]._ts })).status, 200);
    });
    await t.test('a numeric-invalid batch cannot partially commit another row', async () => {
      const before = fs.readFileSync(path.join(f.dir, 'tracking_data.json'), 'utf8');
      const row = (await f.request('/api/tracking')).body.rows[0];
      const r = await f.request('/api/tracking/upsert', [{ po_so: row.po_so, _baseTs: row._ts, note: 'partial' }, { po_so: 'INVALID', _baseTs: 0, amount: -1 }]);
      assert.equal(r.status, 400); assert.equal(r.body.applied ?? 0, 0);
      assert.equal(fs.readFileSync(path.join(f.dir, 'tracking_data.json'), 'utf8'), before);
    });
    await t.test('stale freight save cannot resurrect a deleted quote', async () => {
      const q = { id: 'fq_deletedfixture', type: 'import-sea', head: { ref: 'DELETED' }, rows: [], options: [] };
      const a = await f.request('/api/freight-quotes/upsert', q);
      const old = a.body.row.updatedAt;
      assert.equal((await f.request('/api/freight-quotes/delete', { id: q.id, _baseUpdatedAt: old })).status, 200);
      assert.equal((await f.request('/api/freight-quotes/upsert', { ...q, updatedAt: old })).status, 409);
    });
    await t.test('JSON null and primitive input return validation errors rather than hanging', async () => {
      for (const value of [null, 1, 'text', true]) assert.equal((await f.request('/api/tracking/upsert', value)).status, 400);
    });
  } finally { await f.close(); }
});
if (require.main === module) test('same PO across companies updates by verified shipment identity', async () => {
  const f = await fixture([{ po_so: 'SAME-PO', company: 'KOB', _board: 'import', _ts: 100, note: 'KOB original' },
    { po_so: 'SAME-PO', company: 'BTV', _board: 'import', _ts: 100, note: 'BTV original' }]);
  try {
    const rows = (await f.request('/api/tracking')).body.rows;
    assert.equal((await f.request('/api/tracking/upsert', { po_so: 'SAME-PO', _baseTs: 100, note: 'ambiguous' })).status, 409);
    const r = await f.request('/api/tracking/upsert', { ...rows[1], _baseTs: rows[1]._ts, note: 'BTV updated' });
    assert.equal(r.status, 200);
    const saved = (await f.request('/api/tracking')).body.rows;
    assert.equal(saved[0].company, 'KOB'); assert.equal(saved[0].note, 'KOB original');
    assert.equal(saved[1].note, 'BTV updated'); assert.equal(saved[1]._shipmentId, rows[1]._shipmentId);
  } finally { await f.close(); }
});
module.exports = { fixture };

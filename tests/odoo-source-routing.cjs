'use strict';
// Isolated server routing test: fake adapters, temporary data, no external calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ie-api-routing-'));
let child;
let logs = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const hook = path.join(temp, 'hook.cjs');
  fs.writeFileSync(hook, `
const Module = require('node:module'); const original = Module._load; let reads = 0;
Module._load = function(name, ...rest) {
  if (name.endsWith('/config-env.cjs')) return { loadProjectEnv() {} };
  if (name === 'pg') return { Pool: class { on() {} async query() { throw new Error('FORBIDDEN_DIRECT_QUERY'); } } };
  if (name.endsWith('/odoo-api.cjs')) return { createOdooClient: () => ({ authenticate: async () => 1, searchCount: async () => 2 }) };
  if (name.endsWith('/odoo-boards.cjs')) return { createOdooBoards: () => ({
    boards: async board => [{ id: 1, [board === 'import' ? 'po_number' : 'so_number']: 'FIXTURE', probe_read: ++reads }],
    poLines: async () => [{ id: 9, product_name: 'FIXTURE' }],
  }) };
  if (name.endsWith('/odoo-services.cjs')) return { createOdooServices: () => ({
    vendors: async () => ({ rows: [{ id: 3, name: 'FIXTURE' }], total: 1 }),
    vendorScorecard: async () => [], glReconciliation: async () => [],
    fxRates: async () => [{ currency: 'USD', company_id: 1, rate: 0.025, as_of: '2026-10-01' }, { currency: 'USD', company_id: 2, rate: 0.02, as_of: '2026-10-01' }],
    logisticsBills: async () => ({ billRows: [], poRows: [], billTotal: 0, poTotal: 0 }),
  }) };
  return original.call(this, name, ...rest);
};
`);
  try {
    child = spawn(process.execPath, ['--require', hook, path.join(root, 'api-server.js')], {
      cwd: root, env: { ...process.env, ODOO_DATA_SOURCE: 'api',
        ODOO_API_URL: 'https://fixture.invalid', ODOO_DB: 'fixture', ODOO_LOGIN: 'fixture', ODOO_API_KEY: 'fixture-only',
        HOST: '127.0.0.1', PORT: String(port), DATA_DIR: temp,
        DB_HOST: '127.0.0.1', DB_USER: 'fixture', DB_PASS: 'fixture', DB_NAME: 'fixture',
        MCP_URL: '', MCP_TOKEN: '', APP_PASSWORD: 'fixture-only-password', APP_USER: 'fixture',
        MAIL_DISABLED: '1', ALERT_EMAIL_TO: '',
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', b => { logs += b; });
    child.stderr.on('data', b => { logs += b; });
    const get = async route => {
      const response = await fetch('http://127.0.0.1:' + port + route, {
        headers: { authorization: 'Basic ' + Buffer.from('fixture:fixture-only-password').toString('base64') },
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200, route);
      return response.json();
    };
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Fixture server exited: ' + logs);
      try { if ((await fetch('http://127.0.0.1:' + port + '/api/alive')).ok) break; } catch {}
      await pause(50);
    }
    const first = await get('/api/import-pos?force=1');
    assert.equal(first.via, 'api'); assert.equal(first.stale, false);
    const second = await get('/api/import-pos?force=1');
    assert(second.rows[0].probe_read > first.rows[0].probe_read, 'force must read again');
    assert.equal((await get('/api/export-sos?force=1')).via, 'api');
    assert.equal((await get('/api/po-lines?po=FIXTURE')).source, 'api');
    const vendors = await get('/api/vendors'); assert.equal(vendors.total, 1); assert.equal(vendors.rows.length, 1);
    assert.equal((await get('/api/vendor-scorecard')).count, 0);
    assert.equal((await get('/api/gl-reconciliation')).count, 0);
    assert.equal((await get('/api/logistics-bills')).via, 'api');
    assert.deepEqual((await get('/api/fx-rates')).rows.map(r => [r.company_id, r.currency, r.thb_per_unit]), [[1, 'USD', 40], [2, 'USD', 50]]);
    assert.equal((await get('/api/ping')).api, true);
    assert(!logs.includes('FORBIDDEN_DIRECT_QUERY'), 'API mode must never query PostgreSQL');
    console.log('odoo-source-routing: passed (fresh source, force, supporting routes, no PostgreSQL calls)');
  } finally {
    if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    if (!temp.startsWith(path.join(os.tmpdir(), 'ie-api-routing-'))) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });

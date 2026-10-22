'use strict';
// Isolated deployment integration test; run inside the built image without live env/data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const root = process.env.TEST_APP_ROOT || path.resolve(__dirname, '..');
const U = require(path.join(root, 'lib/users.cjs'));
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ie-deploy-test-'));
const password = crypto.randomBytes(24).toString('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));
const env = { ...process.env, DATA_DIR: dir, HOST: '127.0.0.1', DB_HOST: '127.0.0.1', DB_PORT: '1',
  DB_USER: 'isolated-test', DB_PASS: 'isolated-test-not-a-real-credential', DB_NAME: 'isolated-test', MCP_URL: '', MCP_TOKEN: '',
  MAIL_PASS: '', GMAIL_APP_PASSWORD: '', GRAPH_CLIENT_SECRET: '', APP_PASSWORD: '', ALLOW_SHARED_PASSWORD: '' };
let server;
let logs = '';
async function start() {
  server = spawn(process.execPath, [path.join(root, 'api-server.js')], { windowsHide: true, cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => { logs += b; });
  server.stderr.on('data', b => { logs += b; });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('Isolated server exited: ' + logs);
    try { if ((await fetch('http://127.0.0.1:3000/api/alive')).ok) return; } catch {}
    await wait(100);
  }
  throw new Error('Isolated server did not become ready');
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
}
function cli(action) {
  const r = spawnSync(process.execPath, [path.join(root, 'manage-users.mjs'), action, 'deployment_first'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
function request(route, user = 'deployment_first', options = {}) {
  return fetch('http://127.0.0.1:3000' + route, { ...options, headers: {
    authorization: 'Basic ' + Buffer.from(user + ':' + password).toString('base64'),
    'content-type': 'application/json', ...options.headers,
  } });
}
(async () => {
  try {
    U.saveUsers(path.join(dir, 'users.json'), { version: 1, users: {
      deployment_first: U.makeRecord(password, { role: 'admin' }), deployment_second: U.makeRecord(password, { role: 'admin' }),
    } });
    const tracking = path.join(dir, 'tracking_data.json');
    const seed = JSON.stringify([{ po_so: 'DEPLOYMENT-FIXTURE-ONLY', stage: 'received' }]);
    fs.writeFileSync(tracking, seed);
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'odoo_snapshot.json'), JSON.stringify({
      _ts: { import: now, export: now }, import: [], export: [],
    }));
    await start();
    assert.equal(fs.readFileSync(tracking, 'utf8'), seed, 'Startup must preserve pre-existing tracking bytes');
    assert.equal((await fetch('http://127.0.0.1:3000/api/tracking')).status, 401);
    assert.equal((await request('/api/tracking')).status, 200);
    // A recent on-disk snapshot can be stale=false; source must remain explicit.
    for (const route of ['/api/import-pos?force=1', '/api/export-sos?force=1']) {
      const response = await request(route);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.stale, false, 'Recent snapshot freshness is independent of source');
      assert.equal(body.via, 'snapshot', 'API must expose snapshot provenance to the cutover verifier');
    }
    cli('disable');
    await wait(5500);
    assert.equal((await request('/api/tracking')).status, 401, 'Server must observe CLI DATA_DIR account disable');
    assert.equal((await request('/api/tracking', 'deployment_second')).status, 200);
    cli('enable');
    await wait(5500);
    assert.equal((await request('/api/tracking')).status, 200);
    const current = (await (await request('/api/tracking')).json()).rows[0];
    const changed = { po_so: 'DEPLOYMENT-FIXTURE-ONLY', _baseTs: current._ts ?? 0, stage: 'received', deploymentTest: true };
    const write = await request('/api/tracking/upsert', 'deployment_first', { method: 'POST', body: JSON.stringify(changed) });
    assert.equal(write.status, 200);
    assert.equal((await write.json()).ok, true);
    const stored = JSON.parse(fs.readFileSync(tracking, 'utf8'));
    assert.equal(stored[0].deploymentTest, true);
    assert.match(stored[0]._shipmentId, /^shp_[a-f0-9]{32}$/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(tracking).mode & 0o777, 0o600, 'Atomic replacement must have private mode');
      assert.equal(fs.statSync(path.join(dir, 'tracking_audit.jsonl')).mode & 0o777, 0o600);
    }
    await stop();
    await start();
    const read = await request('/api/tracking');
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()).rows, stored, 'Restart must preserve saved tracking');
    assert(!/EBUSY/.test(logs));
    assert(!fs.readdirSync(dir).some(n => n.endsWith('.tmp')));
    console.log('deployment-runtime: passed (startup preservation, auth, CLI reload, atomic writes, modes, restart persistence)');
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });

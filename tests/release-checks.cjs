'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
let checks;
try { checks = require('../tools/verify-staging.cjs'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
async function fixture(t, { brokenViewer = false, staleBoard = false, boardOverrides = {}, overrideBoard } = {}) {
  const visits = [];
  const server = http.createServer((req, res) => {
    const auth = Buffer.from((req.headers.authorization || '').replace('Basic ', ''), 'base64').toString();
    visits.push({ method: req.method, path: req.url, auth });
    let status = 200, value = { ok: true };
    if (req.url !== '/api/alive' && !['admin:fixture-password', 'viewer:fixture-viewer-password'].includes(auth)) status = 401;
    else if (req.url === '/api/me') value = { ok: true, user: auth.split(':')[0], role: auth.startsWith('admin:') ? 'admin' : 'viewer', canWrite: auth.startsWith('admin:') || brokenViewer };
    else if (req.method === 'POST') status = brokenViewer ? 200 : 403;
    else if (req.url === '/api/tracking') value = { ok: true, rows: [] };
    else if (req.url.startsWith('/api/import-pos') || req.url.startsWith('/api/export-sos')) {
      value = { ok: true, rows: [], stale: staleBoard, via: 'api' };
      if (!overrideBoard || req.url.startsWith('/api/' + overrideBoard)) Object.assign(value, boardOverrides);
    }
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base: 'http://127.0.0.1:' + server.address().port, visits,
    env: { APP_USER: 'admin', APP_PASSWORD: 'fixture-password', VIEWER_USER: 'viewer', VIEWER_PASSWORD: 'fixture-viewer-password' } };
}
test('staging gates verify both roles, denied viewer write, and current Odoo boards', async t => {
  assert.equal(typeof checks?.verifyStaging, 'function', 'staging verification API must exist');
  const f = await fixture(t); const result = await checks.verifyStaging(f);
  assert.equal(result.ok, true);
  assert.ok(f.visits.some(v => v.method === 'POST' && v.auth.startsWith('viewer:')));
  assert.ok(f.visits.some(v => v.path.startsWith('/api/import-pos')) && f.visits.some(v => v.path.startsWith('/api/export-sos')));
});
test('staging fails when viewer has write permission or Odoo boards are stale', async t => {
  for (const options of [{ brokenViewer: true }, { staleBoard: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(checks.verifyStaging(f));
  }
});
test('production verification uses GET requests only and requires configured private credentials', async t => {
  const f = await fixture(t);
  await checks.verifyStaging({ ...f, production: true });
  assert.ok(f.visits.every(v => v.method === 'GET'));
  await assert.rejects(checks.verifyStaging({ ...f, env: {} }), /credential|password/);
});
for (const production of [false, true]) {
  for (const [label, boardOverrides] of [
    ['snapshot fallback', { via: 'snapshot' }],
    ['MCP fallback', { via: 'mcp' }],
    ['missing source', { via: undefined }],
    ['missing freshness', { stale: undefined }],
  ]) {
    test((production ? 'production' : 'staging') + ' rejects ' + label + ' on either Odoo board', async t => {
      for (const overrideBoard of ['import-pos', 'export-sos']) {
        const f = await fixture(t, { boardOverrides, overrideBoard });
        await assert.rejects(checks.verifyStaging({ ...f, production }), /Odoo API|current/);
      }
    });
  }
}

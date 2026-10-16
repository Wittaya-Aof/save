'use strict';
// Explicitly mocked verifier tests; no real credentials, integrations or HTTP calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../tools/verify-deployment.cjs'), 'utf8');
async function run({ remote = false, via = 'direct', stale = false, db = true, mail = true, mailDisabled = false, omitStale = false, apiMode = false, apiAuth = true, supportingFailure = false } = {}) {
  const output = [];
  const env = { APP_PASSWORD: 'fixture-only-not-real' };
  if (remote) env.VERIFY_BASE_URL = 'http://verifier-fixture.invalid';
  if (apiMode) env.ODOO_DATA_SOURCE = 'api';
  const processStub = { env, exitCode: 0 };
  const fakeFetch = async (url, options = {}) => {
    const route = new URL(url).pathname;
    if (route === '/api/alive') return Response.json({ ok: true });
    if (route === '/api/tracking') {
      const a = options.headers?.authorization;
      if (!a || Buffer.from(a.slice(6), 'base64').toString().startsWith('invalid:')) return Response.json({}, { status: 401 });
      return Response.json({ ok: true, rows: [] });
    }
    if (route.startsWith('/api/')) {
      if (supportingFailure && route === '/api/vendors') return Response.json({ ok: false }, { status: 503 });
      const payload = { ok: true, rows: [], bills: [], zeroBilled: [], partialMismatch: [], via };
      if (!omitStale) payload.stale = stale;
      return Response.json(payload);
    }
    return new Response('<!doctype html>', { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } });
  };
  const context = {
    process: processStub, Buffer, AbortSignal,
    console: { log: x => output.push(x), error: (...args) => { throw new Error(args.join(' ')); } },
    fetch: fakeFetch,
    require: name => {
      if (name === '/app/lib/odoo-api.cjs') return { createOdooClient: () => ({
        authenticate: async () => { if (!apiAuth) throw new Error('fixture auth failure'); return 1; },
      }) };
      if (name === '/app/node_modules/pg') return { Client: class {
        async connect() { if (!db) throw new Error('fixture connection failure'); }
        async query() { return { rows: [] }; }
        async end() {}
      } };
      if (name === '/app/lib/mailer.cjs') return { verifyMail: async () => mailDisabled
        ? { ok: true, mode: 'disabled', disabled: true }
        : { ok: mail, mode: 'smtp', error: mail ? undefined : '535 fixture authentication failure' } };
      return require(name);
    },
  };
  await vm.runInNewContext(script, context, { timeout: 5000 });
  assert.equal(processStub.exitCode, 0);
  return JSON.parse(output.at(-1));
}
(async () => {
  let failures = 0;
  for (const [name, options, expected] of [
    ['remote mode cannot skip DB/mail gates', { remote: true }, false],
    ['recent snapshot is not live even when stale=false', { via: 'snapshot', stale: false }, false],
    ['missing source is not evidence of live connectivity', { via: null }, false],
    ['missing staleness flag is not fresh evidence', { omitStale: true }, false],
    ['mail authentication failure blocks cutover', { mail: false }, false],
    ['direct connectivity failure without working bridge blocks cutover', { db: false }, false],
    ['fully checked direct source can pass', {}, true],
    ['fully checked live MCP can replace failed direct connection', { db: false, via: 'mcp' }, true],
    ['explicitly disabled mail permits otherwise healthy deployment', { mailDisabled: true }, true],
    ['disabled mail does not permit snapshots', { mailDisabled: true, via: 'snapshot' }, false],
    ['disabled mail does not waive remote verification limits', { mailDisabled: true, remote: true }, false],
    ['authenticated API source can replace unreachable direct DB', { apiMode: true, via: 'api', db: false, mailDisabled: true }, true],
    ['API authentication failure blocks cutover', { apiMode: true, via: 'api', apiAuth: false, mailDisabled: true }, false],
    ['API authentication cannot make snapshot live', { apiMode: true, via: 'snapshot', mailDisabled: true }, false],
    ['remote API source cannot skip server-side checks', { apiMode: true, via: 'api', remote: true, mailDisabled: true }, false],
    ['API deployment requires healthy supporting data routes', { apiMode: true, via: 'api', supportingFailure: true, mailDisabled: true }, false],
  ]) {
    try { assert.equal((await run(options)).readyForCutover, expected); console.log('PASS ' + name); }
    catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); }
  }
  assert.equal((await run({ mailDisabled: true })).integrations.mail.code, 'explicitly-disabled');
  if (failures) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });

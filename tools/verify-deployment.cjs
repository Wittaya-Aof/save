'use strict';
// Diagnostic only: never prints credentials or shipment payloads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const auth = 'Basic ' + Buffer.from((process.env.APP_USER || 'admin') + ':' + (process.env.APP_PASSWORD || '')).toString('base64');
const base = process.env.VERIFY_BASE_URL || 'http://127.0.0.1:3000';
async function get(route, authenticated = true) {
  return fetch(base + route, { headers: authenticated ? { authorization: auth } : {}, signal: AbortSignal.timeout(70000) });
}
(async () => {
  const report = { runtime: [], integrations: {}, readyForCutover: false };
  let r = await get('/api/alive', false);
  assert.equal(r.status, 200);
  report.runtime.push('alive=200');
  r = await get('/api/tracking', false);
  assert.equal(r.status, 401);
  report.runtime.push('unauthenticated=401');
  r = await fetch(base + '/api/tracking', { headers: { authorization: 'Basic ' + Buffer.from('invalid:' + crypto.randomBytes(24).toString('hex')).toString('base64') } });
  assert.equal(r.status, 401);
  report.runtime.push('wrong_credentials=401');
  r = await get('/api/tracking');
  assert.equal(r.status, 200);
  const tracking = await r.json();
  assert.equal(tracking.ok, true);
  report.runtime.push('tracking_count=' + tracking.rows.length);
  for (const route of ['/', '/container-loading-calculator.html', '/freight-comparison.html', '/lib/worklist.js']) {
    r = await get(route);
    assert.equal(r.status, 200, route);
    if (route === '/' || route.endsWith('.html')) {
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.equal(r.headers.get('cache-control'), 'no-cache');
    }
    report.runtime.push(route + '=200');
  }
  for (const [key, route] of [['import', '/api/import-pos?force=1'], ['export', '/api/export-sos?force=1']]) {
    r = await get(route);
    const j = await r.json();
    report.integrations[key] = { status: r.status, ok: j.ok === true,
      rows: Array.isArray(j.rows) ? j.rows.length : null,
      stale: typeof j.stale === 'boolean' ? j.stale : null,
      via: ['direct', 'mcp', 'api', 'snapshot'].includes(j.via) ? j.via : 'unknown' };
  }
  if (process.env.ODOO_DATA_SOURCE === 'api') {
    report.integrations.supporting_routes = [];
    for (const [route, fields] of [
      ['/api/vendors', ['rows']], ['/api/vendor-scorecard', ['rows']],
      ['/api/gl-reconciliation', ['zeroBilled', 'partialMismatch']],
      ['/api/logistics-bills', ['bills']], ['/api/fx-rates', ['rows']],
    ]) {
      try {
        r = await get(route);
        const j = await r.json();
        report.integrations.supporting_routes.push({ route, status: r.status,
          ok: r.status === 200 && j.ok === true && fields.every(field => Array.isArray(j[field])) });
      } catch { report.integrations.supporting_routes.push({ route, ok: false }); }
    }
  }
  if (!process.env.VERIFY_BASE_URL) {
    if (process.env.ODOO_DATA_SOURCE === 'api') {
      report.integrations.direct_db = { ok: false, skipped: true };
      try {
        const client = require('/app/lib/odoo-api.cjs').createOdooClient(process.env);
        const uid = await client.authenticate();
        report.integrations.odoo_api = { ok: Number.isInteger(uid) && uid > 0 };
      } catch { report.integrations.odoo_api = { ok: false }; }
    } else {
    const { Client } = require('/app/node_modules/pg');
    const c = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER,
      password: process.env.DB_PASS, database: process.env.DB_NAME, connectionTimeoutMillis: 10000,
      ssl: process.env.DB_SSL_CA ? { ca: fs.readFileSync(process.env.DB_SSL_CA, 'utf8'), rejectUnauthorized: true } : undefined });
    try { await c.connect(); await c.query('SELECT 1'); report.integrations.direct_db = { ok: true }; }
    catch (e) { report.integrations.direct_db = { ok: false, code: e.code || 'connection-failed' }; }
    finally { await c.end().catch(() => {}); }
    }
    const mail = await require('/app/lib/mailer.cjs').verifyMail();
    report.integrations.mail = { ok: mail.ok, mode: mail.mode,
      code: mail.disabled === true ? 'explicitly-disabled' : mail.ok ? 'verified' : (/535/.test(mail.error || '') ? 'SMTP_AUTH_535' : 'not-verified') };
  }
  const boards = [report.integrations.import, report.integrations.export];
  const liveBoards = boards.every(x => x && x.status === 200 && x.ok === true
    && x.rows !== null && x.stale === false && ['direct', 'mcp', 'api'].includes(x.via));
  // Remote HTTP checks cannot verify the server's DB/mail environment.
  // A recent snapshot may be stale=false, but is never live evidence.
  const checkedLocally = !process.env.VERIFY_BASE_URL
    && typeof report.integrations.direct_db?.ok === 'boolean'
    && typeof report.integrations.mail?.ok === 'boolean';
  const workingDataPath = report.integrations.direct_db?.ok === true
    || boards.every(x => x?.via === 'mcp')
    || (report.integrations.odoo_api?.ok === true && boards.every(x => x?.via === 'api'));
  report.readyForCutover = checkedLocally && liveBoards && workingDataPath
    && report.integrations.mail.ok === true
    && (process.env.ODOO_DATA_SOURCE !== 'api' || report.integrations.supporting_routes.every(x => x.ok === true));
  console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error('verification failed:', e.code || e.message); process.exitCode = 1; });

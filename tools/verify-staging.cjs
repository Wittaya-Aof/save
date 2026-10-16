#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
async function verifyStaging({ base = 'http://127.0.0.1:3000', env = process.env, production = false } = {}) {
  assert.ok(env.APP_PASSWORD && env.VIEWER_PASSWORD, 'Private admin/viewer passwords must be configured for release verification');
  const identities = [
    { user: env.APP_USER || 'admin', password: env.APP_PASSWORD, canWrite: true },
    { user: env.VIEWER_USER || 'viewer', password: env.VIEWER_PASSWORD, canWrite: false },
  ];
  async function request(route, identity, options = {}) {
    const headers = identity ? { authorization: 'Basic ' + Buffer.from(identity.user + ':' + identity.password).toString('base64') } : {};
    return fetch(base + route, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(90000) });
  }
  assert.equal((await request('/api/alive')).status, 200, 'alive endpoint');
  assert.equal((await request('/api/tracking')).status, 401, 'anonymous data access must be denied');
  const counts = {};
  for (const identity of identities) {
    const response = await request('/api/me', identity); assert.equal(response.status, 200, 'identity endpoint');
    const me = await response.json();
    assert.equal(me.ok, true); assert.equal(me.user, identity.user); assert.equal(me.canWrite, identity.canWrite, 'effective write permission');
    const tracking = await request('/api/tracking', identity); assert.equal(tracking.status, 200);
    const payload = await tracking.json(); assert.equal(payload.ok, true); assert.ok(Array.isArray(payload.rows));
    counts[identity.canWrite ? 'adminTracking' : 'viewerTracking'] = payload.rows.length;
  }
  assert.equal(counts.adminTracking, counts.viewerTracking, 'both roles see the same tracking data');
  if (!production) {
    const denied = await request('/api/tracking/upsert', identities[1], { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"rows":[]}' });
    assert.equal(denied.status, 403, 'viewer mutation must be denied');
  }
  for (const board of ['import-pos', 'export-sos']) {
    const response = await request('/api/' + board + '?force=1', identities[0]);
    assert.equal(response.status, 200, board + ' HTTP result');
    const payload = await response.json(); assert.equal(payload.ok, true, board + ' read-only Odoo result');
    assert.ok(Array.isArray(payload.rows));
    assert.equal(payload.via, 'api', board + ' must come from the Odoo API');
    assert.equal(payload.stale, false, board + ' must be explicitly current');
    counts[board] = payload.rows.length;
  }
  return { ok: true, mode: production ? 'production-get-only' : 'isolated-staging', counts };
}
if (require.main === module) verifyStaging().then(result => console.log(JSON.stringify(result))).catch(e => { console.error('Staging check failed: ' + e.message); process.exitCode = 1; });
module.exports = { verifyStaging };

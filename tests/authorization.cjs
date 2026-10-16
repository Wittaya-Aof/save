'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const U = require('../lib/users.cjs');
const A = require('../lib/authorization.cjs');
const basic = (user, password) => 'Basic ' + Buffer.from(user + ':' + password).toString('base64');
test('account roles are explicit and default read-only', () => {
  assert.equal(U.makeRecord('fixture-password', { role: 'admin' }).role, 'admin');
  assert.equal(U.makeRecord('fixture-password').role, 'viewer');
  assert.throws(() => U.makeRecord('fixture-password', { role: 'superuser' }), /role|สิทธิ์/);
});
test('individual admin/developer roles permit writes but missing legacy role does not', () => {
  const store = U.emptyStore();
  for (const role of ['admin', 'developer', 'viewer']) store.users[role] = U.makeRecord('fixture-password', { role });
  for (const role of ['admin', 'developer', 'viewer']) {
    const result = A.resolveAccess({ authorization: basic(role, 'fixture-password'), env: {}, store, requireUsers: true });
    assert.equal(result.role, role); assert.equal(result.canWrite, role !== 'viewer');
  }
  delete store.users.admin.role;
  assert.equal(A.resolveAccess({ authorization: basic('admin', 'fixture-password'), env: {}, store, requireUsers: true }).canWrite, false);
});
test('configured users missing/empty cannot fall into anonymous or shared mode', () => {
  const result = A.resolveAccess({ authorization: basic('admin', 'fixture-admin'), env: { APP_USER: 'admin', APP_PASSWORD: 'fixture-admin' }, store: U.emptyStore(), requireUsers: true });
  assert.equal(result, null);
});
test('last writer cannot be deactivated while viewer remains', () => {
  const store = { version: 1, users: { admin: U.makeRecord('fixture-password', { role: 'admin' }), viewer: U.makeRecord('fixture-password') } };
  assert.equal(U.canDeactivate(store, 'admin'), false);
  assert.equal(U.canDeactivate(store, 'viewer'), true);
  store.users.developer = U.makeRecord('fixture-password', { role: 'developer' });
  assert.equal(U.canDeactivate(store, 'admin'), true);
});

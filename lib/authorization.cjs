'use strict';
const crypto = require('node:crypto');
const users = require('./users.cjs');
const ROLES = new Set(['admin', 'developer', 'viewer']);
function roleOf(record) { return ROLES.has(record && record.role) ? record.role : 'viewer'; }
function canWrite(role) { return role === 'admin' || role === 'developer'; }
function equal(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function credentials(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  try {
    const text = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at < 1) return null;
    return { user: text.slice(0, at).trim(), password: text.slice(at + 1) };
  } catch { return null; }
}
function resolveAccess({ authorization, env, store, requireUsers = false, localNoAuth = false }) {
  const c = credentials(authorization);
  if (!c) return localNoAuth ? { user: 'local', role: 'developer', canWrite: true } : null;
  if (store && users.activeCount(store)) {
    const verified = users.verify(store, c.user, c.password);
    if (verified.ok) {
      const role = roleOf(store.users[verified.user]);
      return { user: verified.user, role, canWrite: canWrite(role) };
    }
  }
  if (env.VIEWER_PASSWORD && equal(c.user, env.VIEWER_USER || 'viewer') && equal(c.password, env.VIEWER_PASSWORD)) {
    return { user: env.VIEWER_USER || 'viewer', role: 'viewer', canWrite: false };
  }
  if ((!requireUsers || env.ALLOW_SHARED_PASSWORD === '1') && env.APP_PASSWORD &&
      equal(c.user, env.APP_USER || 'admin') && equal(c.password, env.APP_PASSWORD)) {
    return { user: env.APP_USER || 'admin', role: 'admin', canWrite: true };
  }
  return null;
}
module.exports = { roleOf, canWrite, credentials, resolveAccess };

'use strict';

const READ_METHODS = new Set(['search', 'search_read', 'search_count', 'read', 'read_group', 'fields_get', 'name_get']);
const LOCKED_CONTEXT = { allowed_company_ids: [1, 2], lang: 'en_US', active_test: false };

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Odoo invalid read limit');
  return value;
}

function createOdooClient(env, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  let base;
  try { base = new URL(env.ODOO_API_URL); } catch { throw new Error('Odoo invalid API configuration'); }
  if (base.protocol !== 'https:') throw new Error('Odoo API requires HTTPS');
  if (base.username || base.password || base.search || base.hash || !env.ODOO_DB || !env.ODOO_LOGIN || !env.ODOO_API_KEY || typeof fetchImpl !== 'function') {
    throw new Error('Odoo invalid API configuration');
  }
  positiveInteger(timeoutMs, 30000);
  const endpoint = new URL('/jsonrpc', base).href;
  let requestId = 0;
  let uid;
  let authPending;

  async function rpc(service, method, args) {
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    try {
      const task = (async () => {
        const response = await fetchImpl(endpoint, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: ++requestId }),
        });
        if (!response || !response.ok) throw new Error('request');
        const data = await response.json();
        if (!data || data.error || !Object.hasOwn(data, 'result')) throw new Error('response');
        return data.result;
      })();
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('deadline')); }, timeoutMs);
      });
      return await Promise.race([task, deadline]);
    } catch {
      // Remote exceptions may contain credentials, arguments and business records.
      throw new Error(timedOut ? 'Odoo API timeout' : 'Odoo API read failed');
    } finally { clearTimeout(timer); }
  }

  async function authenticate() {
    if (uid) return uid;
    if (!authPending) {
      authPending = (async () => {
        const value = await rpc('common', 'authenticate', [env.ODOO_DB, env.ODOO_LOGIN, env.ODOO_API_KEY, {}]);
        if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Odoo authentication failed');
        uid = value;
        return uid;
      })().finally(() => { authPending = undefined; });
    }
    return authPending;
  }

  async function execute(model, method, args = [], kwargs = {}) {
    if (!READ_METHODS.has(method)) throw new Error('Odoo read-only method required');
    if (typeof model !== 'string' || !/^[a-z][a-z0-9_.]*$/.test(model) || !Array.isArray(args) || !kwargs || typeof kwargs !== 'object' || Array.isArray(kwargs)) throw new Error('Odoo invalid read arguments');
    const user = await authenticate();
    const context = { ...kwargs.context, ...LOCKED_CONTEXT, allowed_company_ids: [1, 2] };
    return rpc('object', 'execute_kw', [env.ODOO_DB, user, env.ODOO_API_KEY, model, method, args, { ...kwargs, context }]);
  }

  async function searchRead(model, domain, fields, options = {}) {
    const kwargs = { fields };
    for (const key of ['order', 'limit', 'offset', 'context']) if (options[key] !== undefined) kwargs[key] = options[key];
    if (kwargs.limit !== undefined) positiveInteger(kwargs.limit);
    if (kwargs.offset !== undefined && (!Number.isSafeInteger(kwargs.offset) || kwargs.offset < 0)) throw new Error('Odoo invalid read offset');
    const rows = await execute(model, 'search_read', [domain], kwargs);
    if (!Array.isArray(rows)) throw new Error('Odoo invalid read response');
    return rows;
  }

  async function searchAll(model, domain, fields, options = {}) {
    const batchSize = positiveInteger(options.batchSize, 500);
    const maxRows = positiveInteger(options.maxRows, 100000);
    const initialOffset = options.offset === undefined ? 0 : options.offset;
    if (!Number.isSafeInteger(initialOffset) || initialOffset < 0) throw new Error('Odoo invalid read offset');
    if (options.limit !== undefined) throw new Error('Odoo searchAll requires maxRows, not a truncating limit');
    let order = options.order || 'id asc';
    if (!/(^|,)\s*id(?:\s+(?:asc|desc))?\s*(,|$)/i.test(order)) order += ', id asc';
    const out = [];
    const seen = new Set();
    for (;;) {
      // Read one record beyond the bound so an exact full page is not silently truncated.
      const limit = Math.min(batchSize, maxRows - out.length + 1);
      const rows = await searchRead(model, domain, fields, { order, offset: initialOffset + out.length, limit, context: options.context });
      if (rows.length > limit) throw new Error('Odoo invalid pagination response');
      for (const row of rows) {
        if (!Number.isSafeInteger(row.id) || seen.has(row.id)) throw new Error('Odoo inconsistent pagination');
        seen.add(row.id);
      }
      if (out.length + rows.length > maxRows) throw new Error('Odoo read limit overflow');
      out.push(...rows);
      if (rows.length < limit) return out;
    }
  }

  async function searchCount(model, domain) {
    const count = await execute(model, 'search_count', [domain]);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Odoo invalid count response');
    return count;
  }

  async function read(model, ids, fields) {
    if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Odoo invalid record IDs');
    if (!ids.length) return [];
    const rows = await execute(model, 'read', [ids], { fields });
    if (!Array.isArray(rows)) throw new Error('Odoo invalid read response');
    return rows;
  }

  return { authenticate, execute, searchRead, searchAll, searchCount, read };
}
module.exports = { createOdooClient };

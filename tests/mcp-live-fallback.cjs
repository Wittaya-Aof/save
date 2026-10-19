'use strict';
// Actual API helper source, simulated MCP replies; no network or real runtime files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../api-server.js'), 'utf8');
const section = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, start);
  return source.slice(a, b);
};
const helperCode = [
  section('async function mcpConnect()', '// SELECT ที่คืน'),
  section('function mcpParseTable(', '// maxRows (ถ้าใส่)'),
  section('async function mcpPull(', '// inner SELECT สำหรับ'),
  section('async function liveOrSnapshot(', '// ─── Postgres connection'),
].join('\n');
async function checkReply(body, expectSuccess, expectedRows) {
  let saved = 0;
  const snapshot = { import: [{ fixture: 'retained-on-error' }], _ts: { import: '2000-01-01T00:00:00.000Z' } };
  const context = vm.createContext({
    Buffer, Date, Math, JSON, API_MODE: false, integrationErrors:{},integrationFailedAt:{},
    console: { log() {}, error() {} },
    mcpRpc: async () => ({ status: 200, sid: 'fixture', body }),
    mcpWrap: () => 'fixture SQL, never executed', MCP_PAGE: 120, MCP_NCOLS: 24,
    MCP_URL: 'https://fixture.invalid', MCP_TOKEN: 'fixture-not-a-real-token',
    MCP_RETRY_INTERVAL: 1, SNAPSHOT_FRESH_WINDOW: 60000, mcpNextTry: {}, snapshot,
    cachedQuery: async () => { throw new Error('fixture direct DB failure'); },
    saveSnapshot: () => { saved++; },
  });
  vm.runInContext(helperCode + '\nasync function mcpFetch() { return mcpPull("fixture", "", "", 2000); }', context);
  const result = await vm.runInContext('liveOrSnapshot("import", "fixture", true)', context);
  if (expectSuccess) {
    assert.equal(result.via, 'mcp');
    assert.deepEqual(JSON.parse(JSON.stringify(result.rows)), expectedRows);
    assert.equal(saved, 1);
    assert.equal(context.integrationErrors.import,undefined,'successful bridge clears failed direct readiness');
  } else {
    assert.equal(result.via, 'snapshot', 'MCP errors must retain snapshot provenance');
    assert.equal(saved, 0, 'MCP errors must never overwrite the saved snapshot');
    assert.equal(context.integrationErrors.import,'UPSTREAM_READ_FAILED');
    assert.deepEqual(snapshot.import, [{ fixture: 'retained-on-error' }]);
    assert.equal(snapshot._ts.import, '2000-01-01T00:00:00.000Z', 'Error must not refresh snapshot timestamp');
  }
}
(async () => {
  let failures = 0;
  const table = row => '┌────┐\n│ c0 │\n├────┤\n' + (row ? '│ ' + row + ' │\n' : '') + '└────┘\n';
  const tool = text => ({ jsonrpc: '2.0', result: { content: [{ type: 'text', text }] } });
  for (const [name, body, success, rows] of [
    ['JSON-RPC error over HTTP200', { jsonrpc: '2.0', error: { code: -32000, message: 'fixture failure' } }, false],
    ['tool isError over HTTP200', { result: { isError: true, content: [{ type: 'text', text: table('') }] } }, false],
    ['missing result content', { result: {} }, false],
    ['malformed content item', { result: { content: [{ type: 'image', data: 'fixture' }] } }, false],
    ['unrecognized plain text', tool('SQL execution failed'), false],
    ['header followed by error text', tool('│ c0 │\nSQL execution failed'), false],
    ['header followed by truncated row', tool('│ c0 │\neyJmaXh0dXJlIjoibGl2ZSJ9'), false],
    ['header followed by blank data row', tool('│ c0 │\n│    │'), false],
    ['header only is incomplete, not proof of zero rows', tool('│ c0 │'), false],
    ['complete table followed by error text', tool(table('') + 'SQL execution failed'), false],
    ['empty row inside complete table', tool('┌────┐\n│ c0 │\n├────┤\n│    │\n└────┘'), false],
    ['mismatched row column count', tool('┌────┐\n│ c0 │\n├────┤\n│ abc │ def │\n└────┘'), false],
    ['row-count metadata mismatch', tool(table('') + '(1 rows)'), false],
    ['valid explicit row-count completion', tool('│ c0 │\n(0 rows)'), true, []],
    ['invalid encoded JSON row', tool(table(Buffer.from('not JSON').toString('base64'))), false],
    ['encoded non-object row', tool(table(Buffer.from('null').toString('base64'))), false],
    ['genuine empty table result', tool(table('')), true, []],
    ['explicit successful zero rows', tool('No rows returned.'), true, []],
    ['genuine populated table', tool(table(Buffer.from(JSON.stringify({ fixture: 'live-result' })).toString('base64'))), true, [{ fixture: 'live-result' }]],
  ]) {
    try { await checkReply(body, success, rows); console.log('PASS ' + name); }
    catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); }
  }
  if (failures) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });

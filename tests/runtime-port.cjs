'use strict';
const assert = require('node:assert/strict');
const { resolveRuntimePort } = require('../lib/runtime-paths.cjs');
assert.equal(resolveRuntimePort(), 3000);
assert.equal(resolveRuntimePort('3002'), 3002);
assert.equal(resolveRuntimePort(''), 3000);
for (const value of ['0', '-1', '65536', '3002abc', '3002.5', 'NaN']) {
  assert.throws(() => resolveRuntimePort(value), /PORT/);
}
console.log('runtime-port: passed');

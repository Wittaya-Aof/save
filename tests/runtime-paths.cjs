'use strict';

const assert = require('assert');
const path = require('path');
const { resolveRuntimePaths } = require('../lib/runtime-paths.cjs');

const root = path.resolve('/app');
const data = path.resolve('/data');
const p = resolveRuntimePaths(root, data);

assert.strictEqual(p.root, root);
assert.strictEqual(p.dataDir, data);
assert.strictEqual(p.trackingFile, path.join(data, 'tracking_data.json'));
assert.strictEqual(p.auditFile, path.join(data, 'tracking_audit.jsonl'));
assert.strictEqual(p.snapshotFile, path.join(data, 'odoo_snapshot.json'));
assert.strictEqual(p.backupDir, path.join(data, 'backups'));
assert.strictEqual(p.usersFile, path.join(data, 'users.json'));
assert.strictEqual(resolveRuntimePaths(root).dataDir, root);

console.log('runtime-paths: passed');

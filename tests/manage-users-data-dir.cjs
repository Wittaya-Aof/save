'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const U = require('../lib/users.cjs');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ie-users-test-'));
const file = path.join(dir, 'users.json');
try {
  U.saveUsers(file, { version: 1, users: { data_dir_first: { disabled: false }, data_dir_second: { disabled: false } } });
  const result = spawnSync(process.execPath, [path.join(root, 'manage-users.mjs'), 'disable', 'data_dir_first'], {
    env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(U.loadUsers(file).users.data_dir_first.disabled, true, 'CLI must update the user in DATA_DIR');
  assert.equal(U.loadUsers(file).users.data_dir_second.disabled, false);
  assert.equal(fs.existsSync(file + '.tmp'), false);
  console.log('manage-users DATA_DIR: passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

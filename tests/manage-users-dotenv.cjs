'use strict';
// Fixture-only regression: CLI configuration must match API dotenv behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const U = require('../lib/users.cjs');
const source = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ie-cli-dotenv-'));
try {
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.mkdirSync(path.join(dir, 'data'));
  for (const name of ['manage-users.mjs', 'lib/users.cjs', 'lib/runtime-paths.cjs', 'lib/config-env.cjs']) {
    if (fs.existsSync(path.join(source, name))) fs.copyFileSync(path.join(source, name), path.join(dir, name));
  }
  fs.writeFileSync(path.join(dir, '.env'), 'DATA_DIR=' + path.join(dir, 'data').replace(/\\/g, '/') + '\n');
  const dataFile = path.join(dir, 'data/users.json');
  U.saveUsers(dataFile, { version: 1, users: { dotenv_first: { disabled: false }, dotenv_second: { disabled: false } } });
  const env = { ...process.env };
  delete env.DATA_DIR;
  const result = spawnSync(process.execPath, [path.join(dir, 'manage-users.mjs'), 'disable', 'dotenv_first'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(U.loadUsers(dataFile).users.dotenv_first.disabled, true);
  assert.equal(fs.existsSync(path.join(dir, 'users.json')), false);
  console.log('manage-users dotenv DATA_DIR: passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

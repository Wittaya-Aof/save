'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
let backup;
try { backup = require('../lib/runtime-backup.cjs'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const FIXTURES = {
  'tracking_data.json': '[{"po_so":"FIXTURE","note":"สินค้า"}]\r\n',
  'freight_quotes.json': '[{"id":"fixture","updatedAt":"2026-10-16"}]\n',
  'users.json': '{"version":1,"users":{"fixture":{"salt":"' + 'a'.repeat(32) + '","hash":"' + 'b'.repeat(128) + '","disabled":false,"role":"admin"}}}\n',
  'tracking_audit.jsonl': '{"action":"fixture"}\n{"action":"second"}\n',
  'shipment_runs.jsonl': '{"fixture":true}\n',
  'shipment_runs.jsonl.1': '{"fixture":"prior run"}\n',
  'tracking_audit.jsonl.1': '{"fixture":"prior audit"}\n',
  'ai_usage.jsonl.1': '{"fixture":"prior usage"}\n',
  'ai_usage.jsonl': '{"fixture":true}\n',
  'doc_scan_seen.json': '{"fixture":true}\n',
  'integrity_seen.json': '["fixture"]\n',
  'integrity_digest.json': '{"lastDigestAt":0}\n',
  'odoo_snapshot.json': '{"import":[],"export":[],"_ts":{}}\n',
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ie-backup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir);
  for (const [name, bytes] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(dataDir, name), bytes);
  return { root, dataDir, backupDir: path.join(root, 'backups') };
}
test('full backup restores every runtime byte including users and JSONL histories', t => {
  assert.equal(typeof backup?.createRuntimeBackup, 'function', 'full runtime backup API must exist');
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dataDir, 'backups')); fs.writeFileSync(path.join(f.dataDir, '.env'), 'MUST_NOT_COPY');
  const result = backup.createRuntimeBackup(f);
  assert.equal(result.manifest.files.length, 13);
  assert.equal(result.manifest.missing.length, 0);
  const targetDir = path.join(f.root, 'restore');
  backup.restoreRuntimeBackup({ backupPath: result.backupPath, targetDir });
  assert.deepEqual(fs.readdirSync(targetDir).sort(), Object.keys(FIXTURES).sort());
  for (const [name, bytes] of Object.entries(FIXTURES)) assert.deepEqual(fs.readFileSync(path.join(targetDir, name)), Buffer.from(bytes));
  const history = fs.readFileSync(path.join(f.backupDir, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(history[0].event, 'backup');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(targetDir, 'users.json')).mode & 0o777, 0o600);
  }
});
test('missing optional files are explicit and are not synthesized on restore', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.dataDir, 'users.json'));
  const result = backup.createRuntimeBackup(f);
  assert.deepEqual(result.manifest.missing, ['users.json']);
  const targetDir = path.join(f.root, 'restore');
  backup.restoreRuntimeBackup({ backupPath: result.backupPath, targetDir });
  assert.equal(fs.existsSync(path.join(targetDir, 'users.json')), false);
});
test('tampered bytes, size, malformed JSON, traversal and extra entries fail before restore writes', t => {
  const f = fixture(t);
  const cases = [
    p => fs.appendFileSync(path.join(p, 'users.json'), ' '),
    p => { const m = JSON.parse(fs.readFileSync(path.join(p, 'manifest.json'))); m.files[0].size++; fs.writeFileSync(path.join(p, 'manifest.json'), JSON.stringify(m)); },
    p => fs.writeFileSync(path.join(p, 'manifest.json'), '{'),
    p => { const m = JSON.parse(fs.readFileSync(path.join(p, 'manifest.json'))); m.files[0].name = '../outside.json'; fs.writeFileSync(path.join(p, 'manifest.json'), JSON.stringify(m)); },
    p => fs.writeFileSync(path.join(p, 'unexpected.json'), '{}'),
    p => { const m = JSON.parse(fs.readFileSync(path.join(p, 'manifest.json'))); m.files.pop(); fs.writeFileSync(path.join(p, 'manifest.json'), JSON.stringify(m)); },
    p => { const m = JSON.parse(fs.readFileSync(path.join(p, 'manifest.json'))); const entry = m.files.find(e => e.name === 'tracking_data.json'); const bytes = Buffer.from('{}'); fs.writeFileSync(path.join(p, entry.name), bytes); entry.size = bytes.length; entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); fs.writeFileSync(path.join(p, 'manifest.json'), JSON.stringify(m)); },
  ];
  for (const [i, mutate] of cases.entries()) {
    const { backupPath } = backup.createRuntimeBackup(f); mutate(backupPath);
    const targetDir = path.join(f.root, 'invalid-restore-' + i);
    assert.throws(() => backup.restoreRuntimeBackup({ backupPath, targetDir }));
    assert.equal(fs.existsSync(targetDir), false);
  }
});
test('refuses populated target, live target, overlapping paths and symlinks', t => {
  const f = fixture(t); const { backupPath } = backup.createRuntimeBackup(f);
  assert.throws(() => backup.restoreRuntimeBackup({ backupPath, targetDir: f.dataDir }), /empty|isolated/);
  assert.throws(() => backup.restoreRuntimeBackup({ backupPath, targetDir: '/srv/import-export-control-cloud-data' }), /live|production/);
  assert.throws(() => backup.createRuntimeBackup({ ...f, backupDir: f.dataDir }), /separate|overlap/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(f.dataDir, 'users.json'), path.join(f.root, 'linked-file'));
    fs.unlinkSync(path.join(f.dataDir, 'users.json')); fs.symlinkSync(path.join(f.root, 'linked-file'), path.join(f.dataDir, 'users.json'));
    assert.throws(() => backup.createRuntimeBackup(f), /symbolic|symlink/);
  }
});
test('invalid source fails without publishing partial backup or pruning previous backup', t => {
  const f = fixture(t); const previous = backup.createRuntimeBackup(f);
  fs.writeFileSync(path.join(f.dataDir, 'tracking_audit.jsonl'), '{"valid":true}\ninvalid\n');
  assert.throws(() => backup.createRuntimeBackup({ ...f, retain: 1 }), /JSON|schema/);
  assert.ok(fs.existsSync(previous.backupPath));
  assert.equal(fs.readdirSync(f.backupDir).filter(n => n.startsWith('.partial-')).length, 0);
});
test('write failure removes partial output and leaves completed backups usable', t => {
  const f = fixture(t); const previous = backup.createRuntimeBackup(f);
  const disk = Object.create(fs);
  disk.writeFileSync = (file, ...args) => { if (path.basename(file) === 'manifest.json') throw new Error('fixture disk full'); return fs.writeFileSync(file, ...args); };
  assert.throws(() => backup.createRuntimeBackup({ ...f, fsImpl: disk, retain: 1 }), /fixture disk full/);
  assert.ok(backup.verifyRuntimeBackup({ backupPath: previous.backupPath }));
  assert.equal(fs.readdirSync(f.backupDir).filter(n => n.startsWith('.partial-')).length, 0);
});
test('retention removes only old valid completed backups after a successful new backup', t => {
  const f = fixture(t);
  const first = backup.createRuntimeBackup({ ...f, now: new Date('2026-10-14T00:00:00Z'), retain: 2 });
  const second = backup.createRuntimeBackup({ ...f, now: new Date('2026-10-15T00:00:00Z'), retain: 2 });
  const unknown = path.join(f.backupDir, 'unrelated'); fs.mkdirSync(unknown);
  const latest = backup.createRuntimeBackup({ ...f, now: new Date('2026-10-16T00:00:00Z'), retain: 2 });
  assert.equal(fs.existsSync(first.backupPath), false);
  assert.ok(fs.existsSync(second.backupPath) && fs.existsSync(latest.backupPath) && fs.existsSync(unknown));
});
test('interrupted restore leaves the empty target empty and never publishes partial contents', t => {
  const f = fixture(t); const { backupPath } = backup.createRuntimeBackup(f);
  const targetDir = path.join(f.root, 'restore'); fs.mkdirSync(targetDir);
  const disk = Object.create(fs);
  disk.writeFileSync = (file, ...args) => { if (path.basename(file) === 'users.json') throw new Error('fixture restore disk full'); return fs.writeFileSync(file, ...args); };
  assert.throws(() => backup.restoreRuntimeBackup({ backupPath, targetDir, fsImpl: disk }), /fixture restore disk full/);
  assert.deepEqual(fs.readdirSync(targetDir), []);
  assert.equal(fs.readdirSync(f.root).some(n => n.startsWith('.restore-')), false);
});

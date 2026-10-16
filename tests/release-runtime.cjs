'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let release;
try { release = require('../tools/release-runtime.cjs'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const IMAGE = 'registry.example/ie@sha256:' + 'a'.repeat(64);
const OLD = 'sha256:' + 'b'.repeat(64);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ie-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { image: IMAGE, sourceDir: path.resolve(__dirname, '..'), productionProject: 'fixture-production',
    stagingEnvFile: path.join(root, 'staging.env'), stateDir: path.join(root, 'releases') };
}
function dockerFixture(options = {}) {
  const operations = [];
  return { operations, run(command, args, extra) {
    operations.push({ command, args, extra });
    const text = args.join(' ');
    if (options.fail && options.fail(text)) throw new Error('fixture operation failed');
    if (text.includes(' ps -q app')) return 'fixture-container\n';
    if (args[0] === 'inspect') return OLD + '\n';
    if (text.includes('backup-runtime.cjs create')) return JSON.stringify({ ok: true, backupPath: '/backups/runtime-fixture' });
    return '';
  } };
}
test('dry run is side-effect free and selects same immutable image with isolated staging', t => {
  assert.equal(typeof release?.planRelease, 'function', 'release API must exist');
  const config = fixture(t);
  const plan = release.planRelease(config);
  assert.equal(plan.image, IMAGE);
  assert.equal(plan.productionDataDir, '/srv/import-export-control-cloud-data');
  assert.equal(plan.stagingDataDir, '/srv/import-export-control-cloud-staging-data');
  assert.notEqual(plan.productionProject, plan.stagingProject);
  assert.equal(fs.existsSync(config.stateDir), false);
  for (const image of ['latest', 'ie:v1', 'sha256:nope']) assert.throws(() => release.planRelease({ ...config, image }), /immutable|digest/);
  assert.throws(() => release.planRelease({ ...config, productionProject: plan.stagingProject }), /separate|staging/);
  assert.throws(() => release.planRelease({ ...config, stagingEnvFile: path.join(config.sourceDir, '.env.hostinger') }), /separate|production/);
});
test('promotion freezes writer, backs up, restore-drills and promotes staged image serially', t => {
  const config = fixture(t); const docker = dockerFixture();
  const result = release.executeRelease(config, { run: docker.run });
  assert.equal(result.status, 'promoted');
  const calls = docker.operations.map(o => o.args.join(' '));
  const stop = calls.findIndex(s => s.includes(' stop app'));
  const backup = calls.findIndex(s => s.includes('backup-runtime.cjs create'));
  const drill = calls.findIndex(s => s.includes('backup-runtime.cjs restore'));
  const promotion = calls.findIndex(s => s.includes('production-override.json') && s.includes(' up '));
  assert.ok(stop >= 0 && stop < backup && backup < drill && drill < promotion);
  for (const o of docker.operations.filter(o => o.args[0] === 'compose' && o.args.includes('up'))) assert.equal(o.extra.env.CONTROL_RELEASE_IMAGE, IMAGE);
  const override = JSON.parse(fs.readFileSync(path.join(result.releaseDir, 'production-override.json')));
  assert.equal(override.services.app.image, IMAGE);
  assert.equal(fs.existsSync(path.join(config.stateDir, '.release-lock')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.stateDir, 'history.jsonl'), 'utf8').trim()).previousImage, OLD);
});
test('failed staging never stops production or creates a production backup', t => {
  const config = fixture(t);
  const docker = dockerFixture({ fail: s => s.includes('verify-staging.cjs') });
  assert.throws(() => release.executeRelease(config, { run: docker.run }), /fixture/);
  assert.equal(docker.operations.some(o => o.args.includes('stop')), false);
  assert.equal(docker.operations.some(o => o.args.join(' ').includes('backup-runtime.cjs create')), false);
});
test('failed production verification rolls back exact previous image without restoring production data', t => {
  const config = fixture(t);
  const docker = dockerFixture({ fail: s => s.includes('verify-release.cjs') });
  assert.throws(() => release.executeRelease(config, { run: docker.run }), /rolled back/);
  const calls = docker.operations;
  const rollback = calls.filter(o => o.args.join(' ').includes('rollback-override.json') && o.args.includes('up'));
  assert.equal(rollback.length, 1);
  const rollbackPath = rollback[0].args.find(a => a.endsWith('rollback-override.json'));
  assert.equal(JSON.parse(fs.readFileSync(rollbackPath)).services.app.image, OLD);
  assert.equal(calls.some(o => o.args.join(' ').includes('backup-runtime.cjs restore') && o.args[o.args.length - 1] === '/data'), false);
});
test('failed frozen backup restarts old service and release lock rejects concurrent execution', t => {
  const config = fixture(t);
  const docker = dockerFixture({ fail: s => s.includes('backup-runtime.cjs create') });
  assert.throws(() => release.executeRelease(config, { run: docker.run }), /rolled back/);
  assert.ok(docker.operations.some(o => o.args.includes('up') && o.args.join(' ').includes('rollback-override.json')));
  const lock = path.join(config.stateDir, '.release-lock'); fs.mkdirSync(lock);
  assert.throws(() => release.executeRelease(config, { run: docker.run }), /locked|progress/);
  assert.ok(fs.existsSync(lock));
});
test('history failure after successful promotion reports the promoted image with a warning', t => {
  const config = fixture(t); fs.mkdirSync(config.stateDir);
  fs.mkdirSync(path.join(config.stateDir, 'history.jsonl'));
  const docker = dockerFixture();
  const result = release.executeRelease(config, { run: docker.run });
  assert.equal(result.status, 'promoted');
  assert.ok(result.warnings.length > 0);
});

#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const IMMUTABLE = /^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9._/:+-]*@sha256:[a-f0-9]{64})$/;
function planRelease(config) {
  if (!config || !IMMUTABLE.test(config.image)) throw new Error('Release requires an immutable sha256 image digest/id');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(config.productionProject || '') || config.productionProject === 'import-export-control-cloud-staging') throw new Error('Production project must be explicit and separate from staging');
  if (!path.isAbsolute(config.stagingEnvFile || '')) throw new Error('Provide an absolute private stagingEnvFile');
  const sourceDir = path.resolve(config.sourceDir || path.join(__dirname, '..'));
  if (path.resolve(config.stagingEnvFile) === path.join(sourceDir, '.env.hostinger')) throw new Error('Staging environment must be separate from production');
  return { image: config.image, sourceDir, productionProject: config.productionProject,
    stagingProject: 'import-export-control-cloud-staging', productionDataDir: '/srv/import-export-control-cloud-data',
    stagingDataDir: '/srv/import-export-control-cloud-staging-data', backupDir: '/srv/import-export-control-cloud-backups',
    stagingEnvFile: config.stagingEnvFile, stateDir: path.resolve(config.stateDir || '/srv/import-export-control-cloud-releases'),
    phases: ['inspect previous image', 'stage immutable image', 'verify staging identities and read-only Odoo',
      'stop production writer', 'full backup', 'isolated restore drill', 'promote same image', 'verify production', 'rollback previous image on failure'] };
}
function runDocker(command, args, options) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Docker operation failed (' + (result.error?.code || result.status) + '): ' + args[0]);
  return result.stdout;
}
function writePrivate(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
function executeRelease(config, { run = runDocker } = {}) {
  const plan = planRelease(config);
  // Writable operational state is outside source, runtime data, and image inputs.
  if ([plan.sourceDir, plan.productionDataDir, plan.stagingDataDir, plan.backupDir].some(p => plan.stateDir === p || plan.stateDir.startsWith(p + path.sep))) throw new Error('Release state must be isolated from source and data');
  // Refuse link-based aliases before creating lock/state. noSymlinks is also enforced on backup inputs.
  let ancestor = plan.stateDir;
  for (;;) {
    if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Release state cannot use symbolic links');
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  fs.mkdirSync(plan.stateDir, { recursive: true, mode: 0o700 });
  const lockDir = path.join(plan.stateDir, '.release-lock');
  try { fs.mkdirSync(lockDir, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw new Error('Another release is locked/in progress; inspect lock before manual recovery'); throw e; }
  const releaseId = new Date().toISOString().replace(/[-:.]/g, '') + '-' + crypto.randomBytes(6).toString('hex');
  const releaseDir = path.join(plan.stateDir, releaseId);
  const env = { ...process.env, CONTROL_RELEASE_IMAGE: plan.image, CONTROL_STAGING_ENV_FILE: plan.stagingEnvFile };
  const docker = args => run('docker', args, { cwd: plan.sourceDir, env });
  const productionBase = ['compose', '--project-name', plan.productionProject, '-f', path.join(plan.sourceDir, 'docker-compose.hostinger.yml')];
  const stagingBase = ['compose', '--project-name', plan.stagingProject, '-f', path.join(plan.sourceDir, 'docker-compose.staging.yml')];
  let previousImage, frozen = false, backupPath;
  function composeWith(override) { return [...productionBase, '-f', path.join(releaseDir, override)]; }
  function audit(record) {
    const file = path.join(plan.stateDir, 'history.jsonl');
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error('Unsafe release history');
    fs.appendFileSync(file, JSON.stringify({ releaseId, image: plan.image, previousImage, backupPath, ...record }) + '\n', { mode: 0o600 });
  }
  try {
    fs.mkdirSync(releaseDir, { mode: 0o700 });
    writePrivate(path.join(lockDir, 'owner.json'), { pid: process.pid, releaseId });
    docker(['image', 'inspect', plan.image]); // Caller builds/pulls once; promotion never silently pulls/rebuilds.
    const containerId = docker([...productionBase, 'ps', '-q', 'app']).trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(containerId)) throw new Error('Expected exactly one existing production app container');
    previousImage = docker(['inspect', '--format', '{{.Image}}', containerId]).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(previousImage)) throw new Error('Cannot establish immutable previous image for rollback');
    writePrivate(path.join(releaseDir, 'production-override.json'), { services: { app: { image: plan.image } } });
    writePrivate(path.join(releaseDir, 'rollback-override.json'), { services: { app: { image: previousImage } } });
    docker([...stagingBase, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120']);
    docker([...stagingBase, 'exec', '-T', 'app', 'node', '/app/tools/verify-staging.cjs']);
    // Compose stop must finish before the read-only backup container sees production data.
    frozen = true;
    docker([...productionBase, 'stop', 'app']);
    const backupResult = docker(['run', '--rm', '--network', 'none', '--user', '1000:1000',
      '--mount', 'type=bind,src=' + plan.productionDataDir + ',dst=/data,readonly',
      '--mount', 'type=bind,src=' + plan.backupDir + ',dst=/backups',
      '--entrypoint', 'node', plan.image, '/app/tools/backup-runtime.cjs', 'create', '/data', '/backups']);
    const backup = JSON.parse(backupResult.trim());
    if (!backup.ok || !/^\/backups\/runtime-[a-zA-Z0-9-]+$/.test(backup.backupPath)) throw new Error('Frozen runtime backup did not produce a valid result');
    backupPath = backup.backupPath;
    if (backup.warnings?.length) throw new Error('Frozen backup maintenance requires attention before promotion');
    fs.mkdirSync(path.join(releaseDir, 'restore-drill'), { mode: 0o700 });
    // Host ownership must let the image's UID 1000 write this fresh isolated directory.
    if (process.platform !== 'win32' && process.getuid?.() === 0) fs.chownSync(path.join(releaseDir, 'restore-drill'), 1000, 1000);
    docker(['run', '--rm', '--network', 'none', '--user', '1000:1000',
      '--mount', 'type=bind,src=' + plan.backupDir + ',dst=/backups,readonly',
      '--mount', 'type=bind,src=' + path.join(releaseDir, 'restore-drill') + ',dst=/restore',
      '--entrypoint', 'node', plan.image, '/app/tools/backup-runtime.cjs', 'restore', backupPath, '/restore/data']);
    docker([...composeWith('production-override.json'), 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120']);
    docker([...composeWith('production-override.json'), 'exec', '-T', 'app', 'node', '/app/tools/verify-release.cjs']);
    frozen = false;
    const warnings = [];
    try { audit({ status: 'promoted' }); } catch (e) { warnings.push('Release promoted; history requires attention: ' + e.message); }
    return { status: 'promoted', releaseDir, previousImage, image: plan.image, backupPath, warnings };
  } catch (cause) {
    let status = 'staging-failed';
    if (frozen && previousImage) {
      try {
        docker([...composeWith('rollback-override.json'), 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120']);
        status = 'rolled-back';
      } catch { status = 'rollback-failed'; }
    }
    try { audit({ status }); } catch { /* Preserve original operational failure. */ }
    throw new Error(status === 'rolled-back' ? 'Release failed; rolled back previous image, data untouched: ' + cause.message : 'Release ' + status + ': ' + cause.message);
  } finally { fs.rmSync(lockDir, { recursive: true }); }
}
if (require.main === module) {
  try {
    const [action, configFile, ...rest] = process.argv.slice(2);
    if (!['plan', 'deploy'].includes(action) || !configFile || rest.length) throw new Error('Usage: release-runtime.cjs plan|deploy PRIVATE_CONFIG.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    console.log(JSON.stringify(action === 'plan' ? planRelease(config) : executeRelease(config), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { planRelease, executeRelease };

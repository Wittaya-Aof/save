'use strict';
// All default tests use pure functions, temporary data or their own ephemeral server.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const unit = [
  'authorization', 'persistence-permissions', 'import-workflow', 'logistics-costs',
  'login-sessions', 'session-store', 'client-session',
  'availability', 'local-supervisor', 'service-guardian', 'http-probe', 'operation-lock',
  'odoo-api', 'odoo-boards', 'odoo-services', 'odoo-financial-sql',
  'frontend-regressions', 'tracking-correctness', 'loading-weight', 'runtime-backup', 'release-runtime', 'release-checks',
].map(name => 'tests/' + name + '.cjs');
const scripts = [
  'runtime-port', 'runtime-paths', 'users', 'shipment-stage', 'scan-policy', 'worklist',
  'container-cleanup', 'mail-disabled', 'manage-users-data-dir', 'manage-users-dotenv',
  'mcp-live-fallback', 'verify-deployment', 'odoo-source-routing',
  'container-correctness', 'pallet-loading-review', 'ets-arrival', 'eta-ata-http', 'legacy-scope', 'freight-correctness',
].map(name => 'tests/' + name + '.cjs');
const tasks = [['isolated unit and HTTP regression tests', ['--test', ...unit]],
  ...scripts.map(file => [file, [file]])];
if (process.argv.includes('--packing')) for (const name of ['pack-invariants', 'pack-capacity', 'pack-plan', 'pack-lanes', 'pack-fuzz']) tasks.push([name, ['tests/' + name + '.mjs']]);
if (process.argv.includes('--browser')) tasks.push(['isolated browser journeys', ['tests/frontend-browser.cjs']], ['browser against real fixture API', ['tests/browser-real-api.cjs']], ['login and logout browser journeys', ['tests/login-browser.cjs']], ['data availability browser status', ['tests/availability-browser.cjs']]);
if (process.argv.includes('--browser')) {
  tasks.push(['container correctness browser journeys', ['tests/container-correctness-browser.cjs']]);
  tasks.push(['pallet loading browser journeys', ['tests/pallet-loading-browser.cjs']]);
  tasks.push(['ETA and ATA browser journeys', ['tests/eta-ata-browser.cjs']]);
  tasks.push(['legacy PO save and sync browser journey', ['tests/legacy-scope-browser.cjs']]);
  tasks.push(['centered PO details browser journey', ['tests/po-dialog-browser.cjs']]);
  tasks.push(['freight correctness browser journeys', ['tests/freight-browser-isolated.cjs']]);
  for (const name of ['freight-ui', 'freight-pdf', 'freight-review']) tasks.push([name + ' isolated fixtures', ['tests/freight-browser-isolated.cjs', '--legacy=' + name]]);
}
const failures = [];
for (const [label, args] of tasks) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write((result.stdout || '') + (result.stderr || ''));
  if (result.status !== 0 || result.error) failures.push({ task: label, status: result.status, error: result.error && result.error.message });
}
console.log(JSON.stringify({ testGroups: tasks.length, failures }));
if (failures.length) process.exitCode = 1;

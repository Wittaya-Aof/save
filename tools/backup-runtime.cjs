#!/usr/bin/env node
'use strict';
const { createRuntimeBackup, restoreRuntimeBackup, verifyRuntimeBackup } = require('../lib/runtime-backup.cjs');
function main(args) {
  const [command, source, target, ...extra] = args;
  if (!source || extra.length || !['create', 'verify', 'restore'].includes(command) || (command !== 'verify' && !target) || (command === 'verify' && target)) {
    throw new Error('Usage: backup-runtime.cjs create DATA_DIR BACKUP_DIR | verify BACKUP_PATH | restore BACKUP_PATH EMPTY_ISOLATED_DIR');
  }
  const result = command === 'create' ? createRuntimeBackup({ dataDir: source, backupDir: target }) :
    command === 'restore' ? restoreRuntimeBackup({ backupPath: source, targetDir: target }) : { manifest: verifyRuntimeBackup({ backupPath: source }) };
  // Print paths and counts only. Account hashes and business records never enter the console.
  console.log(JSON.stringify({ ok: true, backupPath: result.backupPath, targetDir: result.targetDir,
    id: result.manifest.id, files: result.manifest.files.length, missing: result.manifest.missing, warnings: result.warnings || [] }));
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { console.error('Backup failed: ' + e.message); process.exitCode = 1; } }
module.exports = { main };

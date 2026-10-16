'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Deliberately flat: neither old backups, environment files nor arbitrary source enter a backup.
const RUNTIME_FILES = Object.freeze([
  'tracking_data.json', 'freight_quotes.json', 'users.json', 'tracking_audit.jsonl',
  'shipment_runs.jsonl', 'ai_usage.jsonl', 'doc_scan_seen.json', 'integrity_seen.json',
  'integrity_digest.json', 'odoo_snapshot.json', 'shipment_runs.jsonl.1',
  'tracking_audit.jsonl.1', 'ai_usage.jsonl.1',
]);
const FORMAT = 'import-export-runtime-v1';
const BACKUP_NAME = /^runtime-\d{8}T\d{9}Z-[a-f0-9]{16}$/;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
function noSymlinks(location, disk) {
  let current = path.resolve(location);
  for (;;) {
    try { if (disk.lstatSync(current).isSymbolicLink()) throw new Error('Unsafe symbolic link: ' + current); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function directory(location, disk, create = false) {
  noSymlinks(location, disk);
  if (create) disk.mkdirSync(location, { recursive: true, mode: 0o700 });
  if (!disk.lstatSync(location).isDirectory()) throw new Error('Expected a directory: ' + location);
}
function readFile(file, disk) {
  noSymlinks(file, disk);
  if (!disk.lstatSync(file).isFile()) throw new Error('Expected a regular file: ' + file);
  const fd = disk.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { return disk.readFileSync(fd); } finally { disk.closeSync(fd); }
}
function validateData(name, bytes) {
  try {
    if (/\.jsonl(?:\.1)?$/.test(name)) {
      for (const line of bytes.toString('utf8').split('\n')) if (line.trim() && !plain(JSON.parse(line))) throw new Error('record must be an object');
      return;
    }
    const data = JSON.parse(bytes.toString('utf8'));
    if (name === 'tracking_data.json' || name === 'freight_quotes.json') {
      if (!Array.isArray(data) || data.some(v => !plain(v))) throw new Error('rows must be an array of objects');
    } else if (name === 'users.json') {
      if (!plain(data) || data.version !== 1 || !plain(data.users)) throw new Error('invalid account store');
      for (const rec of Object.values(data.users)) {
        if (!plain(rec) || !/^[a-f0-9]{32}$/i.test(rec.salt) || !/^[a-f0-9]{128}$/i.test(rec.hash)) throw new Error('invalid account record');
      }
    } else if (name === 'integrity_seen.json') {
      if (!Array.isArray(data) || data.some(v => typeof v !== 'string')) throw new Error('seen keys must be strings');
    } else if (name === 'doc_scan_seen.json') {
      if (!plain(data) && !Array.isArray(data)) throw new Error('invalid document scanner state');
    } else if (!plain(data)) throw new Error('expected an object');
  } catch { throw new Error('Invalid JSON/schema for ' + name); } // Never echo account hashes or business payloads in parser errors.
}
function writeDurable(file, bytes, disk) {
  disk.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  const fd = disk.openSync(file, 'r+');
  try { disk.fsyncSync(fd); } finally { disk.closeSync(fd); }
}
function syncDir(dir, disk) {
  // Windows cannot open directories for fsync. Linux release hosts can and must.
  if (process.platform === 'win32') return;
  const fd = disk.openSync(dir, 'r');
  try { disk.fsyncSync(fd); } finally { disk.closeSync(fd); }
}
function validateManifest(manifest) {
  if (!plain(manifest) || manifest.format !== FORMAT || !BACKUP_NAME.test(manifest.id) ||
      typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !Array.isArray(manifest.files) || !Array.isArray(manifest.missing)) throw new Error('Malformed backup manifest');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!plain(entry) || !RUNTIME_FILES.includes(entry.name) || seen.has(entry.name) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Unsafe or malformed manifest entry');
    seen.add(entry.name);
  }
  for (const name of manifest.missing) {
    if (!RUNTIME_FILES.includes(name) || seen.has(name)) throw new Error('Unsafe or duplicate missing manifest entry');
    seen.add(name);
  }
  if (seen.size !== RUNTIME_FILES.length) throw new Error('Manifest omits runtime files');
}
function loadBackup(backupPath, disk) {
  backupPath = path.resolve(backupPath); directory(backupPath, disk);
  const manifest = JSON.parse(readFile(path.join(backupPath, 'manifest.json'), disk).toString('utf8'));
  validateManifest(manifest);
  const expected = new Set(['manifest.json', ...manifest.files.map(e => e.name)]);
  for (const name of disk.readdirSync(backupPath)) if (!expected.has(name)) throw new Error('Unexpected backup entry: ' + name);
  const contents = new Map();
  for (const entry of manifest.files) {
    const bytes = readFile(path.join(backupPath, entry.name), disk);
    if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error('Backup checksum/size mismatch: ' + entry.name);
    validateData(entry.name, bytes); contents.set(entry.name, bytes);
  }
  return { manifest, contents };
}
function verifyRuntimeBackup({ backupPath, fsImpl = fs }) { return loadBackup(backupPath, fsImpl).manifest; }
function appendHistory(backupDir, event, disk) {
  const file = path.join(backupDir, 'history.jsonl');
  noSymlinks(file, disk);
  const fd = disk.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { disk.fchmodSync(fd, 0o600); disk.writeFileSync(fd, JSON.stringify(event) + '\n'); disk.fsyncSync(fd); } finally { disk.closeSync(fd); }
}
function prune(backupDir, retain, current, disk) {
  const backups = [];
  for (const name of disk.readdirSync(backupDir)) {
    if (!BACKUP_NAME.test(name)) continue;
    const backupPath = path.join(backupDir, name);
    try { const manifest = verifyRuntimeBackup({ backupPath, fsImpl: disk }); backups.push({ backupPath, createdAt: manifest.createdAt }); }
    catch { /* Invalid/unrecognized directories are never deleted by retention. */ }
  }
  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.backupPath.localeCompare(a.backupPath));
  const keep = new Set([current, ...backups.filter(b => b.backupPath !== current).slice(0, retain - 1).map(b => b.backupPath)]);
  for (const item of backups) if (!keep.has(item.backupPath)) disk.rmSync(item.backupPath, { recursive: true });
}
function createRuntimeBackup({ dataDir, backupDir, retain = 14, now = new Date(), fsImpl: disk = fs }) {
  dataDir = path.resolve(dataDir); backupDir = path.resolve(backupDir);
  if (!Number.isInteger(retain) || retain < 1) throw new Error('Retention must be a positive integer');
  if (within(backupDir, dataDir) || within(dataDir, backupDir)) throw new Error('Backup and runtime directories must be separate without overlap');
  directory(dataDir, disk); directory(backupDir, disk, true); disk.chmodSync(backupDir, 0o700);
  const createdAt = now.toISOString();
  const id = 'runtime-' + createdAt.replace(/[-:.]/g, '') + '-' + crypto.randomBytes(8).toString('hex');
  const partial = path.join(backupDir, '.partial-' + id);
  const backupPath = path.join(backupDir, id);
  const manifest = { format: FORMAT, id, createdAt, files: [], missing: [] };
  const contents = new Map();
  // Capture synchronously in one event-loop turn; external writers must be stopped by the caller.
  for (const name of RUNTIME_FILES) {
    let bytes;
    try { bytes = readFile(path.join(dataDir, name), disk); }
    catch (e) { if (e.code === 'ENOENT') { manifest.missing.push(name); continue; } throw e; }
    validateData(name, bytes); contents.set(name, bytes);
    manifest.files.push({ name, size: bytes.length, sha256: hash(bytes) });
  }
  disk.mkdirSync(partial, { mode: 0o700 });
  try {
    for (const [name, bytes] of contents) writeDurable(path.join(partial, name), bytes, disk);
    writeDurable(path.join(partial, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', disk);
    syncDir(partial, disk); disk.renameSync(partial, backupPath); syncDir(backupDir, disk);
  } catch (e) { if (disk.existsSync(partial)) disk.rmSync(partial, { recursive: true }); throw e; }
  // Once finalized, maintenance failure must not pretend the valid backup failed to publish.
  const warnings = [];
  try { appendHistory(backupDir, { event: 'backup', id, createdAt, files: manifest.files.length }, disk); }
  catch (e) { warnings.push('Backup history: ' + e.message); }
  try { prune(backupDir, retain, backupPath, disk); } catch (e) { warnings.push('Backup retention: ' + e.message); }
  return { backupPath, manifest, warnings };
}
function restoreRuntimeBackup({ backupPath, targetDir, liveDataDir, fsImpl: disk = fs }) {
  backupPath = path.resolve(backupPath); targetDir = path.resolve(targetDir);
  const forbidden = ['/data', '/srv/import-export-control-cloud-data', ...(liveDataDir ? [liveDataDir] : [])].map(p => path.resolve(p));
  if (forbidden.some(p => within(targetDir, p))) throw new Error('Restore into a live/production path is forbidden');
  if (within(targetDir, backupPath) || within(backupPath, targetDir)) throw new Error('Restore target must be isolated from backup');
  noSymlinks(targetDir, disk);
  if (disk.existsSync(targetDir) && (!disk.lstatSync(targetDir).isDirectory() || disk.readdirSync(targetDir).length)) throw new Error('Restore target must be absent or an empty isolated directory');
  const { manifest, contents } = loadBackup(backupPath, disk);
  directory(path.dirname(targetDir), disk);
  const partial = path.join(path.dirname(targetDir), '.restore-' + crypto.randomBytes(12).toString('hex'));
  disk.mkdirSync(partial, { mode: 0o700 });
  try {
    for (const [name, bytes] of contents) writeDurable(path.join(partial, name), bytes, disk);
    syncDir(partial, disk);
    noSymlinks(targetDir, disk);
    if (disk.existsSync(targetDir)) disk.rmdirSync(targetDir); // rmdir refuses a concurrently populated target.
    disk.renameSync(partial, targetDir); syncDir(path.dirname(targetDir), disk);
  } catch (e) { if (disk.existsSync(partial)) disk.rmSync(partial, { recursive: true }); throw e; }
  return { targetDir, manifest };
}
module.exports = { RUNTIME_FILES, createRuntimeBackup, restoreRuntimeBackup, verifyRuntimeBackup };

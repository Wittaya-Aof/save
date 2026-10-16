'use strict';

const path = require('path');

function resolveRuntimePaths(root, dataDir) {
  const appRoot = path.resolve(root);
  const runtimeDir = path.resolve(dataDir || appRoot);
  return Object.freeze({
    root: appRoot,
    dataDir: runtimeDir,
    usersFile: path.join(runtimeDir, 'users.json'),
    trackingFile: path.join(runtimeDir, 'tracking_data.json'),
    auditFile: path.join(runtimeDir, 'tracking_audit.jsonl'),
    shipmentRunsFile: path.join(runtimeDir, 'shipment_runs.jsonl'),
    freightFile: path.join(runtimeDir, 'freight_quotes.json'),
    backupDir: path.join(runtimeDir, 'backups'),
    integritySeenFile: path.join(runtimeDir, 'integrity_seen.json'),
    integrityDigestFile: path.join(runtimeDir, 'integrity_digest.json'),
    snapshotFile: path.join(runtimeDir, 'odoo_snapshot.json'),
    aiUsageFile: path.join(runtimeDir, 'ai_usage.jsonl'),
  });
}

function resolveRuntimePort(value) {
  const text = value == null || value === '' ? '3000' : String(value);
  if (!/^\d+$/.test(text)) throw new Error('PORT must be an integer from 1 to 65535');
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  return port;
}

module.exports = { resolveRuntimePaths, resolveRuntimePort };

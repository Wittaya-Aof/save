// watchdog.js -- Logistics API process manager (replaces pm2)
// Lives at:  C:\Users\User\logistics-api\watchdog.js   (simple path, no Thai, no comma)
// Launches:  api-server.js from its actual location on OneDrive
// Strategy:  spawn api-server as child; restart after crash (5 s delay); no daemon, no IPC.
'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
// Runtime files all live in __dirname (logistics-api). OneDrive is no longer
// in the runtime path — it was unreliable (spaces+comma in path, plus sync
// conflicts could remove files while the server was running).
const NODE     = process.execPath;                          // same node.exe that runs this
const API      = path.join(__dirname, 'api-server.js');    // local copy, no OneDrive
const WORK_DIR = __dirname;
const LOG_FILE = path.join(__dirname, 'watchdog.log');      // C:\Users\User\logistics-api\watchdog.log
const RESTART_DELAY_MS = 5000;
const LOG_MAX_BYTES    = 1 * 1024 * 1024;                  // 1 MB rotate

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}\n`;
  process.stdout.write(line);
  try {
    // Rotate if too large
    let size = 0;
    try { size = fs.statSync(LOG_FILE).size; } catch (_) {}
    if (size > LOG_MAX_BYTES) fs.writeFileSync(LOG_FILE, line);
    else fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
}

// ─── Child management ────────────────────────────────────────────────────────
let restartCount = 0;

function start() {
  log(`[watchdog] Starting api-server.js (restart #${restartCount})`);
  log(`[watchdog] node: ${NODE}`);
  log(`[watchdog] api:  ${API}`);

  const child = spawn(NODE, [API], {
    cwd:      WORK_DIR,
    stdio:    'inherit',
    detached: false,
    env:      { ...process.env, NODE_ENV: 'production' },
  });

  child.on('error', (err) => {
    log(`[watchdog] spawn error: ${err.message}`);
    setTimeout(start, RESTART_DELAY_MS);
  });

  child.on('exit', (code, signal) => {
    restartCount++;
    log(`[watchdog] api-server exited (code=${code} signal=${signal} restart=#${restartCount}) — restarting in ${RESTART_DELAY_MS / 1000}s`);
    setTimeout(start, RESTART_DELAY_MS);
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
log('[watchdog] === Watchdog starting ===');
log(`[watchdog] PID: ${process.pid}`);
start();

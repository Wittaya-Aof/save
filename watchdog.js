// watchdog.js -- Logistics API process manager (replaces pm2)
// Lives at:  C:\Users\User\logistics-api\watchdog.js
// Launches:  api-server.js from the same directory (no OneDrive dependency).
// Strategy:  spawn api-server as child; restart after crash (5 s delay);
//            also write a heartbeat file every 30s so external monitors can
//            detect a hung watchdog (not just a hung api-server).
'use strict';

const { spawn } = require('child_process');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
// Runtime files all live in __dirname (logistics-api). OneDrive is no longer
// in the runtime path — it was unreliable (spaces+comma in path, plus sync
// conflicts could remove files while the server was running).
const NODE     = process.execPath;                          // same node.exe that runs this
const API      = path.join(__dirname, 'api-server.js');    // local copy, no OneDrive
const WORK_DIR = __dirname;
const LOG_FILE = path.join(__dirname, 'watchdog.log');     // C:\Users\User\logistics-api\watchdog.log
const PID_FILE = path.join(__dirname, 'watchdog.pid');     // for external monitors
const HB_FILE  = path.join(__dirname, 'watchdog.heartbeat'); // updated every 30 s
const RESTART_DELAY_MS = 5000;
const LOG_MAX_BYTES    = 1 * 1024 * 1024;                  // 1 MB rotate
const HEALTH_PORT = 3000;
const HEALTH_PATH = '/api/alive';        // lightweight — does NOT touch the DB
const HEALTH_INTERVAL_MS = 60 * 1000;   // check api-server every 60 s
const HEALTH_TIMEOUT_MS  = 10 * 1000;   // generous — avoid false positives
const HEALTH_MAX_STRIKES = 3;           // kill only after 3 consecutive failures
const HEARTBEAT_INTERVAL_MS = 30 * 1000; // touch heartbeat file every 30 s

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
let currentChild = null;

function start() {
  log(`[watchdog] Starting api-server.js (restart #${restartCount})`);

  const child = spawn(NODE, [API], {
    cwd:      WORK_DIR,
    stdio:    'inherit',
    detached: false,
    env:      { ...process.env, NODE_ENV: 'production' },
  });
  currentChild = child;

  child.on('error', (err) => {
    log(`[watchdog] spawn error: ${err.message}`);
    setTimeout(start, RESTART_DELAY_MS);
  });

  child.on('exit', (code, signal) => {
    currentChild = null;
    restartCount++;
    log(`[watchdog] api-server exited (code=${code} signal=${signal} restart=#${restartCount}) — restarting in ${RESTART_DELAY_MS / 1000}s`);
    setTimeout(start, RESTART_DELAY_MS);
  });
}

// ─── Health probe (catches a truly hung api-server that won't exit) ──────────
// Conservative: probes a DB-free endpoint, tolerates transient failures, and
// only restarts after HEALTH_MAX_STRIKES consecutive misses. This avoids the
// restart storm caused by an earlier probe that hit a DB-backed endpoint.
let healthStrikes = 0;

function onProbeFail(reason) {
  healthStrikes++;
  log(`[watchdog] health probe miss ${healthStrikes}/${HEALTH_MAX_STRIKES} (${reason})`);
  if (healthStrikes >= HEALTH_MAX_STRIKES && currentChild) {
    log(`[watchdog] ${HEALTH_MAX_STRIKES} consecutive misses; killing api-server PID ${currentChild.pid}`);
    try { currentChild.kill('SIGKILL'); } catch (_) {}
    healthStrikes = 0;
  }
}

function healthProbe() {
  const req = http.get({ host: '127.0.0.1', port: HEALTH_PORT, path: HEALTH_PATH, timeout: HEALTH_TIMEOUT_MS }, (res) => {
    // Any HTTP response means the server's event loop is alive — reset strikes
    res.resume();
    res.on('end', () => { healthStrikes = 0; });
  });
  req.on('error', (err) => onProbeFail(err.code || err.message));
  req.on('timeout', () => { req.destroy(); onProbeFail('timeout'); });
}

// ─── Heartbeat file (so external scripts can detect a dead watchdog) ─────────
function writeHeartbeat() {
  try {
    fs.writeFileSync(HB_FILE, `${new Date().toISOString()} pid=${process.pid} restarts=${restartCount}\n`);
  } catch (_) {}
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
log('[watchdog] === Watchdog starting ===');
log(`[watchdog] PID: ${process.pid}`);
log(`[watchdog] node: ${NODE}`);
log(`[watchdog] api:  ${API}`);

// Write pid file for diagnostics
try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (_) {}

writeHeartbeat();
setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);

// Wait a bit before first health check so api-server has time to bind port
setTimeout(() => {
  setInterval(healthProbe, HEALTH_INTERVAL_MS);
}, 15 * 1000);

// Cleanup on exit
process.on('exit', () => {
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));

start();

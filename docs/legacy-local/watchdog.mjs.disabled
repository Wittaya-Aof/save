// ─── Watchdog: เฝ้าสุขภาพ api-server ผ่าน GET /api/alive ─────────────────────────────────────
// ปัญหาที่แก้: pm2/start-server.vbs รีสตาร์ทเฉพาะตอน process "exit" เท่านั้น ถ้า event loop "ค้าง"
// (process ยังอยู่แต่ไม่ตอบ) จะไม่มีอะไรกู้ — watchdog นี้ตรวจสุขภาพจริงแล้วสั่งรีสตาร์ทเมื่อค้าง
//
// ออกแบบให้ "รันครั้งเดียวจบ" เหมือน scan-shipment-docs.mjs — ตั้ง Windows Scheduled Task เรียกทุก
// 3-5 นาที (ExecutionTimeLimit = 0 ไม่จำกัดเวลา เพื่อไม่ให้ Task Scheduler ฆ่าเองระหว่างรอ — เคยเจอ
// เคสนี้ในโปรเจกต์พี่น้อง logistics-api)
//
// ⚠️ ความปลอดภัย (ตาม node-process-safety): watchdog นี้ "ไม่" kill node.exe แบบเหมารวมเด็ดขาด และ
// "ไม่" bind port 3000 เอง โหมด default เป็น "ตรวจ+log อย่างเดียว" ต้องส่ง --restart จึงจะสั่งรีสตาร์ท
// การรีสตาร์ทมี 2 ทางตาม setup จริง:
//   1. ถ้ามี pm2 จัดการ app นี้ → `pm2 restart <ชื่อ>` (by-name, ปลอดภัยสุด)
//   2. ไม่งั้น (setup ปัจจุบันใช้ start-server.vbs) → หา PID ที่ listen 127.0.0.1:3000 "เจาะจงตัวเดียว"
//      แล้วยืนยันว่า command line คือ api-server.js ก่อน taskkill — จากนั้น vbs (loop รออยู่) respawn เอง
//      *ไม่* ใช้ `taskkill /IM node.exe` (เหมารวม) เด็ดขาด
'use strict';

import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(ROOT, 'watchdog.log');
const HEARTBEAT_FILE = path.join(ROOT, 'watchdog.heartbeat');
const PM2_APP_NAME = 'import-export-os';   // ตรงกับ ecosystem.config.js
const CHECKS = 3;                          // ตรวจกี่ครั้งก่อนสรุปว่า "ค้าง"
const CHECK_TIMEOUT_MS = 8000;
const GAP_MS = 5000;                       // เว้นช่วงระหว่างครั้ง
const DO_RESTART = process.argv.includes('--restart');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {}
}

function checkAlive() {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port: 3000, path: '/api/alive', method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.setTimeout(CHECK_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end();
  });
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { shell: true, timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

// หา PID ที่ listen 127.0.0.1:3000 แล้วยืนยันว่าเป็น api-server.js จริง (กัน kill ผิดตัว)
async function findApiServerPid() {
  const ns = await run('netstat', ['-ano', '-p', 'TCP']);
  for (const line of ns.stdout.split(/\r?\n/)) {
    if (!/:3000\b/.test(line) || !/LISTENING/i.test(line)) continue;
    const pid = line.trim().split(/\s+/).pop();
    if (!/^\d+$/.test(pid)) continue;
    // ยืนยัน command line ของ PID นี้ก่อน (ต้องเป็น api-server.js) — ไม่งั้นข้าม
    const wql = await run('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\").CommandLine`]);
    if (/api-server\.js/i.test(wql.stdout)) return pid;
  }
  return null;
}

async function restartServer() {
  // 1) ลอง pm2 (ถ้าใช้ pm2 จัดการ app นี้)
  const pm2 = await run('pm2', ['restart', PM2_APP_NAME]);
  if (pm2.ok) { log(`[Restart] pm2 restart ${PM2_APP_NAME} สำเร็จ`); return true; }
  // 2) fallback: kill PID ที่ถือ port 3000 เจาะจงตัวเดียว (ยืนยัน api-server.js แล้ว) → vbs respawn
  const pid = await findApiServerPid();
  if (!pid) { log('[Restart] หา PID ของ api-server (port 3000) ไม่เจอ — ไม่ได้ทำอะไร'); return false; }
  const kill = await run('taskkill', ['/PID', pid, '/F']);
  if (kill.ok) { log(`[Restart] kill PID ${pid} (api-server.js) แล้ว — start-server.vbs จะ respawn เอง`); return true; }
  log(`[Restart] taskkill PID ${pid} ล้มเหลว: ${kill.stderr || kill.err?.message}`);
  return false;
}

// ─── เตือนเมื่อ server.log ใหญ่เกิน ────────────────────────────────────────────────────────
// ⚠ ตัว **หมุนไฟล์จริงอยู่ใน `start-server.vbs`** ไม่ใช่ที่นี่ — ลองทำที่นี่แล้ววัดได้ว่าทำไม่ได้:
// `cmd /c node … >> server.log` ถือ handle ไว้ตลอดอายุ process โดยไม่เปิด FILE_SHARE_WRITE
// → `copy` ผ่าน (อ่านได้) แต่ `truncate` ได้ **EBUSY: resource busy or locked** และ rename ก็ไม่ได้
// ที่เดียวที่ handle ว่างจริงคือหลัง `sh.Run … wait=True` คืนค่าใน vbs จึงย้ายไปทำตรงนั้น
// ที่นี่เหลือหน้าที่แค่ "บอกให้รู้" เผื่อเครื่องไม่ได้ restart นาน ๆ
const SERVER_LOG = path.join(ROOT, 'server.log');
const SERVER_LOG_WARN = Number(process.env.SERVER_LOG_MAX) || 5 * 1024 * 1024;
function warnIfServerLogBig() {
  try {
    if (!fs.existsSync(SERVER_LOG)) return;
    const size = fs.statSync(SERVER_LOG).size;
    if (size > SERVER_LOG_WARN) log(`[Log] server.log ${(size / 1048576).toFixed(1)} MB — จะถูกหมุนอัตโนมัติตอน start-server.vbs เริ่มรอบถัดไป`);
  } catch (e) {}
}

(async () => {
  warnIfServerLogBig();
  for (let i = 0; i < CHECKS; i++) {
    if (await checkAlive()) {
      try { fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString(), 'utf8'); } catch (e) {}
      process.exit(0); // สุขภาพดี — จบเงียบ
    }
    if (i < CHECKS - 1) await new Promise(r => setTimeout(r, GAP_MS));
  }
  // ไม่ตอบครบทุกครั้ง = ค้าง/ล่ม
  log(`[ALERT] api-server ไม่ตอบ /api/alive ${CHECKS} ครั้งติดต่อกัน — น่าจะค้าง/ล่ม`);
  if (DO_RESTART) await restartServer();
  else log('[NOTE] โหมดตรวจอย่างเดียว (ไม่ส่ง --restart) — ไม่ได้สั่งรีสตาร์ท');
  process.exit(1);
})();

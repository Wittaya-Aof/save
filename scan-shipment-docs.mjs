// ─── สแกนโฟลเดอร์เอกสาร shipment ขาเข้า → ดึงข้อมูลด้วย AI → อัปเดต tracking ────────────────
// สแกน D:\Aof\1. Shipment\1. Import\PO <year> (year >= MIN_YEAR, เจอปีใหม่เพิ่มก็สแกนอัตโนมัติ)
// PO 2024 ลงไปไม่แตะ (ตาม MIN_YEAR) แต่ละ subfolder ชื่อจะมีเลข PO ฝังอยู่ (เช่น
// "1. KOBPO2511-05509 SHI JIA ZHUANG GAOOU TRADE (Done 22.1.2026)") ใช้ regex ดึงเลข PO
// map เข้า tracking record — ไฟล์ที่ไม่เปลี่ยน (mtime+size ตรงกับที่เคยประมวลผลแล้ว) จะข้าม
// ไม่เรียก AI ซ้ำ (ดู doc_scan_seen.json) รันครั้งเดียวจบแล้ว exit — ตั้งใจให้ Windows Scheduled
// Task เรียกซ้ำทุก 15-30 นาที ไม่ใช่ daemon ค้างใน process เดียวกับ api-server.js (กันไม่ให้
// AI call ที่ค้าง/error กระทบ availability ของ server หลักที่เสิร์ฟ production อยู่)
'use strict';

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import OpenAI from 'openai';
import XLSX from 'xlsx';
import { openEtsSession, closeEtsSession, searchVesselActualDate } from './lib/ets-lookup.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

(function loadEnv() {
  try {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !m[1].startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    });
  } catch (e) { console.error('[Config] .env load error:', e.message); }
})();

const IMPORT_ROOT = 'D:\\Aof\\1. Shipment\\1. Import';
const MIN_YEAR = 2025;
const SEEN_FILE = path.join(ROOT, 'doc_scan_seen.json');
const LOG_FILE = path.join(ROOT, 'doc_scan.log');
const LOCK_FILE = path.join(ROOT, 'scan.lock');
const ALLOWED_EXT = new Set(['.pdf', '.xlsx', '.xls', '.png', '.jpg', '.jpeg']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// เพดานรวม raw ของไฟล์ที่ส่งให้ AI — base64 บวม ~1.33x จึงตั้ง 24MB ให้อยู่ใต้เพดาน 32MB ของ request
// (เดิมไม่มี cap รวม โฟลเดอร์ PDF หลายไฟล์รวมเกิน → API call ล้มทุกรอบ → retry ไม่รู้จบ + เปลือง cost/memory)
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_FOLDERS_PER_RUN = 20; // กันรันแรกที่มี backlog เยอะกินเวลา/ค่าใช้จ่าย AI ทีเดียวมากเกินไป
const MODEL = process.env.VERIFY_MODEL || 'gpt-5.4-mini';
// OpenAI จำกัดจำนวนหน้า PDF ต่อ 1 request — โฟลเดอร์จริงที่หนาสุดที่วัดได้มี 107 หน้า จึงต้องมี guard
// (ฝั่ง Anthropic เดิมไม่มีเพดานนี้ มีแต่เพดานขนาดไบต์)
const MAX_PDF_PAGES = 100;
// --dry-run   : วางแผนอย่างเดียว ไม่เรียก AI ไม่ upsert ไม่แตะ doc_scan_seen.json
// --no-write  : รันของจริงทุกขั้น (AI + ETS) แต่ไม่เขียนอะไรเลย — ใช้ทดสอบ/backtest
// --only=<คำ> : จำกัดเฉพาะโฟลเดอร์ที่ชื่อมีคำนี้ (ไม่สนตัวพิมพ์ใหญ่เล็ก)
const DRY_RUN = process.argv.includes('--dry-run');
const NO_WRITE = process.argv.includes('--no-write');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).toUpperCase();
// --overwrite : ยอมให้ทับค่าที่มีอยู่แล้ว (default = เติมเฉพาะช่องว่าง ปลอดภัยกว่า)
const OVERWRITE = process.argv.includes('--overwrite');
// --overwrite-fields=forwarder,bl_awb : ทับเฉพาะฟิลด์ที่ระบุ ฟิลด์อื่นยังเติมเฉพาะช่องว่างตามเดิม
// ใช้ตอนกฎการสกัดเปลี่ยนแล้วค่าเดิมในการ์ด "ถูกตามกฎเก่า" — ปลอดภัยกว่า --overwrite ทั้งก้อนมาก
// (เทียบเอกสารกับการ์ด 2026-08-13: เลขตู้ในการ์ดถูกกว่าเอกสาร 4 จาก 7 เคส จึงห้ามทับเหมาทุกฟิลด์)
const OVERWRITE_FIELDS = ((process.argv.find(a => a.startsWith('--overwrite-fields=')) || '').slice(19) || '')
  .split(',').map(s => s.trim()).filter(Boolean);
// --resume-from-log=<ไฟล์> : ข้ามโฟลเดอร์ที่ log รอบก่อนประมวลผลไปแล้ว ใช้รันต่อจากที่ค้าง
// จำเป็นเพราะ --force ไม่สนใจ ledger จะเริ่มใหม่ทั้งหมด = จ่ายค่า AI ซ้ำของที่ทำไปแล้ว
// (เจอจริง 2026-08-13: ต้องหยุดรอบสแกนกลางคันที่โฟลเดอร์ 45/198 เพื่อแก้บั๊ก)
// ⚠ ตัดโฟลเดอร์สุดท้ายใน log ออกจากรายการข้ามเสมอ — ตัวนั้นอาจถูกฆ่ากลางคันจึงยังไม่ครบ
const RESUME_LOG = (process.argv.find(a => a.startsWith('--resume-from-log=')) || '').slice(18).trim();
const SKIP_FOLDERS = new Set();
if (RESUME_LOG) {
  try {
    const done = [];
    for (const line of fs.readFileSync(RESUME_LOG, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\[[^\]]+\] \[(.+?)\] PO: /);
      if (m) done.push(m[1]);
    }
    done.slice(0, -1).forEach(f => SKIP_FOLDERS.add(f));
  } catch (e) { console.error('[Config] อ่าน --resume-from-log ไม่ได้:', e.message); }
}
// --year=2026 : จำกัดเฉพาะโฟลเดอร์ปีนั้น (ใช้ตอนอยากไล่เก็บ backlog ทีละปี)
const ONLY_YEAR = (process.argv.find(a => a.startsWith('--year=')) || '').slice(7).trim();
// --force  : ไม่สนใจ doc_scan_seen.json สแกนซ้ำทุกโฟลเดอร์ (ใช้ตอนโค้ดสกัดดีขึ้นแล้วอยากเก็บของเก่าใหม่)
// --max=N  : เปลี่ยนเพดานโฟลเดอร์ต่อรอบ (default MAX_FOLDERS_PER_RUN = 20)
const FORCE = process.argv.includes('--force');
const MAX_FOLDERS = parseInt((process.argv.find(a => a.startsWith('--max=')) || '').slice(6), 10) || MAX_FOLDERS_PER_RUN;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
// จับเลข PO พร้อม "เลขลำดับชุด" ที่ต่อท้ายในชื่อโฟลเดอร์ เช่น "KOBPO2605-09063 (2)"
// วัดจริง: 30 จาก 198 โฟลเดอร์ใช้รูปแบบนี้ และตรงกับ key ที่ปุ่มแยก shipment ในแอปสร้าง
// (import-export-os.html splitShipment → po_so = "<PO> (n)" · strip() = ตัด " (n)" ท้ายออก)
const PO_MATCH_RE = /((?:KOB|BTV)PO\d{4}-\d{5})(?:\s*\((\d+)\))?/gi;
const stripPoIndex = (k) => (k || '').replace(/\s*\(\d+\)\s*$/, '').trim(); // ให้ตรงกับ strip() ฝั่งหน้าเว็บ

const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate เมื่อเกิน 5MB (เดิม doc_scan.log โตไม่จำกัด)
function rotateLogIfNeeded() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1'); // เก็บรอบก่อนหน้าไว้ 1 ไฟล์ (.1 ถูกทับรอบถัดไป)
    }
  } catch (e) {}
}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { rotateLogIfNeeded(); fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
}

// ─── บันทึกการใช้ token ของ AI ────────────────────────────────────────────────────────────
// เดิมไม่เก็บเลย → ตอบไม่ได้ว่าใช้ไปเท่าไหร่ ต้องเปิด platform.openai.com/usage ดูเอง
// (project key `sk-proj-` เรียก /v1/organization/costs ไม่ได้ — ตอบ 403 missing scope api.usage.read
//  ต้องเป็น Admin key เท่านั้น จึงดึงยอดจริงจาก API ในสคริปต์นี้ไม่ได้)
const USAGE_FILE = path.join(ROOT, 'ai_usage.jsonl'); // append-only 1 บรรทัด/รอบสแกน
// เรตต่อ 1 ล้าน token — ต้องกรอกเองใน .env จาก platform.openai.com/pricing
// *จงใจไม่ใส่ค่าเริ่มต้น*: เดาเรตแล้วรายงานเป็นบาทคือการสร้างตัวเลขที่ไม่มีที่มา
// ไม่ตั้ง = รายงานเฉพาะจำนวน token (ซึ่งเป็นค่าที่วัดได้จริงเสมอ)
const PRICE_IN = parseFloat(process.env.OPENAI_PRICE_IN || '') || 0;
const PRICE_CACHED_IN = parseFloat(process.env.OPENAI_PRICE_CACHED_IN || '') || 0;
const PRICE_OUT = parseFloat(process.env.OPENAI_PRICE_OUT || '') || 0;
const USD_THB = parseFloat(process.env.USD_THB || '') || 0;

const usage = { calls: 0, input: 0, cachedInput: 0, output: 0, reasoning: 0 };
function addUsage(u) {
  if (!u) return null;
  const one = {
    input: u.input_tokens || 0,
    cachedInput: u.input_tokens_details?.cached_tokens || 0,
    output: u.output_tokens || 0,
    reasoning: u.output_tokens_details?.reasoning_tokens || 0,
  };
  usage.calls++;
  for (const k of Object.keys(one)) usage[k] += one[k];
  return one;
}
// cached input คิดถูกกว่า input ปกติ จึงต้องหักออกก่อน ไม่งั้นตีราคาสูงเกิน
function costUsd(u) {
  if (!PRICE_IN && !PRICE_OUT) return null;
  const fresh = Math.max(0, (u.input || 0) - (u.cachedInput || 0));
  return (fresh * PRICE_IN + (u.cachedInput || 0) * (PRICE_CACHED_IN || PRICE_IN) + (u.output || 0) * PRICE_OUT) / 1e6;
}
function fmtCost(u) {
  const usd = costUsd(u);
  if (usd == null) return '';
  return ` · $${usd.toFixed(4)}` + (USD_THB ? ` ≈ ${(usd * USD_THB).toFixed(2)} บาท` : '');
}
function fmtUsage(u) {
  return `in=${u.input.toLocaleString()}` + (u.cachedInput ? ` (cached ${u.cachedInput.toLocaleString()})` : '')
    + ` out=${u.output.toLocaleString()}` + (u.reasoning ? ` (reasoning ${u.reasoning.toLocaleString()})` : '')
    + fmtCost(u);
}
// เขียนแม้ในโหมด --no-write ด้วย: token ถูกใช้ไปจริงแล้ว ค่าใช้จ่ายเกิดขึ้นจริง
// การไม่บันทึกจะทำให้ยอดสะสมต่ำกว่าความจริง (ไฟล์นี้เป็นบัญชีค่าใช้จ่าย ไม่ใช่ข้อมูล shipment)
function saveUsage() {
  if (!usage.calls) return;
  const rec = { ts: new Date().toISOString(), model: MODEL, ...usage };
  if (NO_WRITE) rec.noWrite = true;
  const usd = costUsd(usage);
  if (usd != null) rec.usd = +usd.toFixed(6);
  try { fs.appendFileSync(USAGE_FILE, JSON.stringify(rec) + '\n', 'utf8'); } catch (e) {}
  log(`[Usage] รอบนี้เรียก AI ${usage.calls} ครั้ง — ${fmtUsage(usage)}`);
}
// --usage : สรุปยอดสะสมทั้งหมดจาก ai_usage.jsonl แล้วจบ (ไม่สแกน ไม่เรียก AI)
function reportUsage() {
  let lines = [];
  try { lines = fs.readFileSync(USAGE_FILE, 'utf8').split('\n').filter(Boolean); } catch (e) {
    console.log('ยังไม่มี ai_usage.jsonl — ยังไม่เคยบันทึกการใช้ token (เริ่มบันทึกตั้งแต่รอบสแกนถัดไป)');
    return;
  }
  const total = { calls: 0, input: 0, cachedInput: 0, output: 0, reasoning: 0 };
  const byDay = new Map();
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch (e) { continue; }
    for (const k of Object.keys(total)) total[k] += r[k] || 0;
    const d = String(r.ts || '').slice(0, 10);
    const g = byDay.get(d) || { calls: 0, input: 0, cachedInput: 0, output: 0, reasoning: 0 };
    for (const k of Object.keys(g)) g[k] += r[k] || 0;
    byDay.set(d, g);
  }
  console.log(`=== การใช้ AI สะสม (${lines.length} รอบสแกน) ===`);
  for (const [d, g] of [...byDay].sort()) console.log(`  ${d}  เรียก ${String(g.calls).padStart(4)} ครั้ง · ${fmtUsage(g)}`);
  console.log(`  ${'รวม'.padEnd(10)}  เรียก ${String(total.calls).padStart(4)} ครั้ง · ${fmtUsage(total)}`);
  if (costUsd(total) == null) {
    console.log('\n(ยังไม่ได้ตั้งเรตราคาใน .env จึงบอกเป็นบาทไม่ได้ — ดู .env.example หัวข้อ OPENAI_PRICE_*)');
  }
}

// ─── Lock ───────────────────────────────────────────────────────────────────────────────
// ป้องกันรันซ้อน — Scheduled Task ยิงทุก 20 นาที ถ้า run รอบก่อนยังไม่จบ (เช่น backlog เยอะ/
// ETS lookup ช้า) กับมีคนสั่งรันมือพร้อมกันด้วย จะเกิด 2 process แข่งกันเขียน doc_scan_seen.json
// (เจอจริงระหว่างทดสอบ 2026-07-22 — เผลอรันมือทับกับรอบที่ Scheduled Task ยิงเอง) MultipleInstances
// ของ Task Scheduler เองป้องกันได้แค่ instance ที่ Task Scheduler ยิงเอง ไม่ครอบคลุมเวลารันมือ
// จึงต้อง lock ในระดับสคริปต์เองด้วย
let lockHeldByMe = false;
// process.kill(pid,0) บน Windows: ESRCH = ไม่มี process นี้ (ตายจริง) แต่ EPERM = process ยังอยู่แต่ไม่มีสิทธิ์
// ส่ง signal (ยังทำงานอยู่!) — เดิม catch รวมเป็น "ตาย" แล้วเขียนทับ lock ของ process ที่ยังรันจริง จึงต้องแยก
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = ยังอยู่; ESRCH/อื่นๆ = ถือว่าตาย
}
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // flag 'wx' = สร้างแบบ exclusive (atomic) — ถ้าไฟล์มีอยู่แล้วจะ throw EEXIST กัน TOCTOU race
      // (สอง process เริ่มพร้อมกันแล้วผ่าน existsSync ทั้งคู่แบบเดิม)
      fs.writeFileSync(LOCK_FILE, String(process.pid), { encoding: 'utf8', flag: 'wx' });
      lockHeldByMe = true;
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = parseInt((() => { try { return fs.readFileSync(LOCK_FILE, 'utf8').trim(); } catch { return ''; } })(), 10);
      if (isPidAlive(pid)) return false; // มี process อื่นถืออยู่จริง
      log(`[Lock] เจอ lock ค้างจาก PID ${pid} ที่ไม่ทำงานแล้ว (crash รอบก่อน?) — ลบแล้วลองจับใหม่`);
      try { fs.unlinkSync(LOCK_FILE); } catch (e2) {}
      // วนลูปลองจับใหม่ด้วย wx (ถ้ามี process อื่นชิงจับไปก่อน จะได้ EEXIST อีกแล้วคืน false)
    }
  }
  return false;
}
// release เฉพาะตอนที่ process นี้เป็นคนถือ lock จริง — กัน process ที่แค่มาเช็คแล้วเจอว่ามีคนถืออยู่
// (acquireLock คืน false) ไปลบ lock ของอีก process ที่กำลังทำงานจริงอยู่โดยไม่ได้ตั้งใจ
function releaseLock() {
  if (!lockHeldByMe) return;
  try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
}

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); }
  catch (e) {
    // ไม่มีไฟล์ครั้งแรก = ปกติ; แต่ถ้ามีไฟล์แล้ว parse ไม่ได้ (corrupt) ต้องเตือน ไม่งั้นทุกไฟล์กลายเป็น
    // "ใหม่" แล้วเรียก AI ซ้ำทั้ง backlog (มีค่าใช้จ่ายจริง) โดยไม่มีใครรู้
    if (fs.existsSync(SEEN_FILE)) log('[Seen] ⚠️  อ่าน doc_scan_seen.json ไม่ได้ (corrupt?) — เริ่มจากว่าง อาจ re-scan ทั้ง backlog: ' + e.message);
    return {};
  }
}
function saveSeen(seen) {
  // atomic write: กันไฟล์ถูกตัดครึ่งถ้า process ตายกลางเขียน (จะทำให้รอบหน้า loadSeen พังแล้ว re-scan หมด)
  try {
    const tmp = SEEN_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(seen), 'utf8');
    fs.renameSync(tmp, SEEN_FILE);
  } catch (e) { log('[Seen] save error: ' + e.message); }
}

// คืน [{ key, base, idx }] — key คือ po_so ที่จะเขียนจริง
// "(1)" = การ์ดตัวหลักของ PO นั้น (ตรงกับแอป: การ์ดแรกใช้เลข PO เปล่า ตัวที่แยกออกมาเริ่มที่ "(2)")
// "(2)" ขึ้นไป = การ์ดชิปเม้นย่อย ต้องมี _splitBase ชี้กลับไปที่ PO ฐาน
function extractPoNumbers(name) {
  const out = new Map();
  for (const m of name.matchAll(PO_MATCH_RE)) {
    const base = m[1].toUpperCase();
    const idx = m[2] ? parseInt(m[2], 10) : null;
    const key = (idx && idx > 1) ? `${base} (${idx})` : base;
    if (!out.has(key)) out.set(key, { key, base, idx });
  }
  return [...out.values()];
}

// ─── artifact: บันทึกทุก shipment ที่สแกนเจอ แบบ append-only ────────────────────────────
// เหตุผล: การ์ด 1 ใบเก็บได้ชิปเม้นเดียว แต่ PO เดียวแบ่งส่งได้หลายชิปเม้น — ข้อมูลของชิปเม้นที่
// ไม่ตรงกับการ์ดจะถูกปฏิเสธตอน upsert (ถูกต้องแล้ว) แต่ต้องไม่หายไปเฉยๆ เก็บไว้ที่นี่เพื่อให้
// หน้าเว็บเอาไปแสดง และให้ปุ่ม "แยก shipment" ดึงไปกรอกการ์ดใหม่ได้โดยไม่ต้องพิมพ์เอง
// (แบบแผนเดียวกับ verify_runs.jsonl — append-only + หมุนไฟล์เมื่อโต)
const SHIPMENT_RUNS_FILE = path.join(ROOT, 'shipment_runs.jsonl');
const SHIPMENT_RUNS_MAX_BYTES = 5 * 1024 * 1024;
function appendShipmentRun(rec) {
  try {
    if (fs.existsSync(SHIPMENT_RUNS_FILE) && fs.statSync(SHIPMENT_RUNS_FILE).size > SHIPMENT_RUNS_MAX_BYTES) {
      fs.renameSync(SHIPMENT_RUNS_FILE, SHIPMENT_RUNS_FILE + '.1');
    }
    fs.appendFileSync(SHIPMENT_RUNS_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) { log('[ShipmentRuns] เขียนไม่สำเร็จ: ' + e.message); }
}

// อ่าน tracking_data.json ตรงจากดิสก์ (สคริปต์นี้รันบนเครื่องเดียวกับ server และไฟล์เขียนแบบ atomic)
// ใช้ดูว่าการ์ดเป้าหมายมีอยู่แล้วหรือยัง และดึงข้อมูลบริษัท/คู่ค้า/สกุลเงิน จากการ์ดฐานมาตั้งต้น
function loadTrackingLocal() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'tracking_data.json'), 'utf8')); }
  catch (e) { log('[WARN] อ่าน tracking_data.json ไม่ได้: ' + e.message); return []; }
}

function discoverYearFolders() {
  return fs.readdirSync(IMPORT_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => {
      const m = /^PO\s*(\d{4})$/i.exec(name.trim());
      if (!m || parseInt(m[1], 10) < MIN_YEAR) return false;
      return !ONLY_YEAR || m[1] === ONLY_YEAR;
    });
}

function discoverShipmentFolders(yearFolder) {
  const dir = path.join(IMPORT_ROOT, yearFolder);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && extractPoNumbers(d.name).length > 0)
    .map(d => d.name);
}

// เก็บไฟล์เอกสารทุกไฟล์ในโฟลเดอร์ shipment แบบ recursive (บาง shipment มี subfolder ย่อย
// เช่น "Submit TISI") จำกัดความลึกกันโครงสร้างผิดปกติ/ลิงก์วนลึกเกินจำเป็น
function walkFiles(dir, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, depth + 1, out);
    else if (ALLOWED_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

const PDF_WORKER = path.join(ROOT, 'lib', 'pdf-extract-worker.cjs');

// ดึงข้อความ PDF ผ่าน child process แยกต่างหาก (ต่อไฟล์) — pdf-parse มี resource leak สะสม
// ข้ามการเรียกในโปรเซสเดียวกัน (ยืนยันแล้ว 2026-07-22: สแกนสะสมไปเรื่อยๆ จะค้างสนิทหลังไฟล์ที่
// ราวๆ 50-100+ ทั้งที่แต่ละไฟล์แยกทดสอบเดี่ยวๆ ไม่เคยค้างเลย, ลอง .destroy() แล้วก็ยังไม่พอ)
// แยก process ทำให้ยิง SIGKILL ทิ้งได้ถ้าค้างเกิน timeout โดยไม่กระทบไฟล์อื่น และ process หลัก
// ไม่สะสม resource รั่วเลยเพราะงานหนักทั้งหมดอยู่ใน child ที่ถูกเก็บกวาดตอน exit
function extractPdfTextIsolated(filePath) {
  try {
    const out = execFileSync(process.execPath, [PDF_WORKER, filePath], {
      timeout: 20000, maxBuffer: 50 * 1024 * 1024, encoding: 'utf8',
    });
    return JSON.parse(out);
  } catch (e) {
    return { ok: false, error: e.killed ? 'timeout/killed' : e.message };
  }
}

// ws['!ref'] บางไฟล์ (เจอจริง 2026-07-22: OXY清单.xlsx) ถูก format ทั้งชีตจน !ref บวมไปถึง
// เกือบสุดขอบ Excel (เช่น A1:XFC1048565) ทั้งที่ข้อมูลจริงมีแค่ไม่กี่เซลล์ — sheet_to_csv เชื่อ
// !ref ตรงๆ แล้ววนสร้าง CSV ทั้งกริดนั้นจนค้างสนิท (ยืนยันแล้วว่าไม่จบใน 15 วิ) ต้องคำนวณขอบเขต
// จากเซลล์ที่มีข้อมูลจริงเองแทนการเชื่อ !ref
function computeUsedRange(ws) {
  let maxR = 0, maxC = 0, found = false;
  for (const key of Object.keys(ws)) {
    if (key[0] === '!') continue;
    const dec = XLSX.utils.decode_cell(key);
    if (dec.r > maxR) maxR = dec.r;
    if (dec.c > maxC) maxC = dec.c;
    found = true;
  }
  return found ? { s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } } : null;
}

function dumpExcelText(name, buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const parts = [`=== FILE: ${name} ===`];
  wb.SheetNames.forEach((sheetName) => {
    const ws = wb.Sheets[sheetName];
    parts.push(`--- SHEET: ${sheetName} ---`);
    // sheet_to_csv (xlsx 0.18.5) อ่าน ws['!ref'] ตรงๆ ไม่รับ opts.range — ต้องเขียนทับ !ref
    // ด้วยขอบเขตจริงก่อนเรียก แล้วคืนค่าเดิมกลับหลังจบ กันกระทบ workbook ส่วนอื่น
    const originalRef = ws['!ref'];
    const usedRange = computeUsedRange(ws);
    if (usedRange) ws['!ref'] = XLSX.utils.encode_range(usedRange);
    try {
      parts.push(XLSX.utils.sheet_to_csv(ws, { blankrows: false }).trim());
    } finally {
      ws['!ref'] = originalRef;
    }
  });
  return parts.join('\n');
}

// pdfText คือข้อความดิบที่ดึงได้จาก PDF (สำหรับ free regex fallback) — เอกสารจริงที่ทดสอบ
// (B/L, CI) มีตัวอักษรให้ดึงจริง ไม่ใช่รูปสแกน แต่ label ของฟิลด์ (เช่น "Port of Loading")
// มักเป็นภาพ/template คงที่ ไม่ใช่ text จึงดึงมาได้แต่ "ค่า" ไม่มี label กำกับ
// needDocumentBlocks: เข้ารหัส base64 เก็บไว้ส่งให้ AI เฉพาะตอนมี AI ใช้งานจริงเท่านั้น —
// โหมดฟรีไม่เคยแตะ documentBlocks เลย เข้ารหัส/เก็บไว้เฉยๆ เปลืองความจำโดยเปล่าประโยชน์ (เจอจริง
// 2026-07-22: โฟลเดอร์ที่มี PDF ~16 ไฟล์พร้อมกัน เข้ารหัส base64 ทั้งหมดโดยไม่จำเป็นทำให้
// process ใช้ความจำหนักจนดูเหมือนค้าง)
// นับหน้า PDF จาก buffer โดยไม่ต้อง parse เต็มรูปแบบ — ใช้แค่กัน request เกินเพดานหน้าของ OpenAI
// นับเกินจริงได้บ้าง (ปลอดภัยกว่านับขาด เพราะนับขาดแล้ว request จะถูกปฏิเสธทั้งก้อน)
function countPdfPages(buffer) {
  try {
    const s = buffer.toString('latin1');
    const m = s.match(/\/Type\s*\/Page[^s]/g);
    if (m && m.length) return m.length;
    const c = s.match(/\/Count\s+(\d+)/);
    return c ? parseInt(c[1], 10) : 1;
  } catch (e) { return 1; }
}

// ─── ประมาณค่าใช้จ่าย AI ก่อนกดรันจริง (ใช้ใน --dry-run) ──────────────────────────────────
// วัดจริง 2 จุด (2026-08-12): 1 หน้า → 4,515 token · 63 หน้า → 75,727 token
// แก้สมการเชิงเส้นได้ token ≈ 3,366 + 1,149 × จำนวนหน้า
//   ค่าคงที่ = system prompt (~710) + JSON schema + boilerplate ที่ส่งทุกครั้ง
// ⚠ มีแค่ 2 จุดจึงลากเส้นผ่านทั้งคู่พอดีโดยปริยาย — ยังไม่ได้ทดสอบกับจุดที่สาม ถือเป็นค่าประมาณ
//   ตัวเลขจริงสะสมใน ai_usage.jsonl ทุกรอบแล้ว ปรับสองค่านี้ให้ตรงขึ้นได้เมื่อมีข้อมูลพอ
const EST_FIXED_TOKENS = 3400;
const EST_TOKENS_PER_PAGE = 1150;
// นับ "หน้า" ที่จะถูกส่งเข้า AI จริง — ต้องใช้เพดานชุดเดียวกับ convertFiles ไม่งั้นประมาณเกิน
// (PDF นับหน้าจริงแล้วตัดที่ MAX_PDF_PAGES · รูป 1 ไฟล์ = 1 หน้า · Excel ส่งเป็นข้อความ ≈ 1)
function estimatePagesForFolder(files) {
  let pdfPages = 0, other = 0;
  for (const fp of files) {
    const ext = path.extname(fp).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    if (ext === '.pdf') {
      if (pdfPages >= MAX_PDF_PAGES) continue;
      try { pdfPages += countPdfPages(fs.readFileSync(fp)); } catch (e) {}
    } else other++;
  }
  return Math.min(pdfPages, MAX_PDF_PAGES) + other;
}

async function convertFiles(filePaths, needDocumentBlocks) {
  const documentBlocks = [];
  const excelTextParts = [];
  const pdfTextParts = [];
  const usedNames = [];
  let totalDocBytes = 0; // นับ raw ของไฟล์ที่ใส่ documentBlocks (ส่งให้ AI) — กันรวมเกินเพดาน
  let totalPdfPages = 0; // นับหน้า PDF รวม — OpenAI มีเพดานหน้าต่อ request แยกจากเพดานไบต์
  for (const fp of filePaths) {
    const ext = path.extname(fp).toLowerCase();
    let stat;
    try { stat = fs.statSync(fp); } catch (e) { continue; }
    if (stat.size > MAX_FILE_BYTES) { log(`  [skip] ${fp} ใหญ่เกิน ${MAX_FILE_BYTES / 1024 / 1024}MB`); continue; }
    try {
      const buffer = fs.readFileSync(fp);
      if (ext === '.pdf') {
        if (!buffer.slice(0, 5).toString('latin1').startsWith('%PDF-')) continue;
        if (needDocumentBlocks) {
          const pages = countPdfPages(buffer);
          if (totalDocBytes + buffer.length > MAX_TOTAL_BYTES) {
            log(`  [skip-ai] ${path.basename(fp)} — รวมไฟล์ส่ง AI เกิน ${MAX_TOTAL_BYTES / 1024 / 1024}MB ข้ามไฟล์นี้ (ยังดึงข้อความ PDF ต่อได้)`);
          } else if (totalPdfPages + pages > MAX_PDF_PAGES) {
            log(`  [skip-ai] ${path.basename(fp)} — รวมหน้า PDF เกิน ${MAX_PDF_PAGES} หน้า (ไฟล์นี้ ${pages} หน้า) ข้ามไฟล์นี้ (ยังดึงข้อความ PDF ต่อได้)`);
          } else {
            documentBlocks.push({
              type: 'input_file',
              filename: path.basename(fp),
              file_data: `data:application/pdf;base64,${buffer.toString('base64')}`,
            });
            totalDocBytes += buffer.length;
            totalPdfPages += pages;
          }
        }
        const pdfResult = extractPdfTextIsolated(fp);
        if (pdfResult.ok && pdfResult.text) pdfTextParts.push(`=== FILE: ${path.basename(fp)} ===\n${pdfResult.text}`);
        else if (!pdfResult.ok) log(`  [WARN] pdf-parse อ่านข้อความไม่ได้ ${path.basename(fp)}: ${pdfResult.error}`);
        usedNames.push(path.basename(fp));
      } else if (IMAGE_MIME[ext]) {
        if (needDocumentBlocks) {
          if (totalDocBytes + buffer.length > MAX_TOTAL_BYTES) {
            log(`  [skip-ai] ${path.basename(fp)} — รวมไฟล์ส่ง AI เกิน ${MAX_TOTAL_BYTES / 1024 / 1024}MB ข้ามรูปนี้`);
          } else {
            documentBlocks.push({ type: 'input_image', image_url: `data:${IMAGE_MIME[ext]};base64,${buffer.toString('base64')}` });
            totalDocBytes += buffer.length;
          }
        }
        usedNames.push(path.basename(fp));
      } else if (ext === '.xlsx' || ext === '.xls') {
        excelTextParts.push(dumpExcelText(path.basename(fp), buffer));
        usedNames.push(path.basename(fp));
      }
    } catch (e) { log(`  [skip] อ่านไฟล์ไม่สำเร็จ ${fp}: ${e.message}`); }
  }
  return { documentBlocks, excelText: excelTextParts.join('\n\n'), pdfText: pdfTextParts.join('\n\n'), usedNames };
}

// โครงเดิมคืน shipment เดียวต่อโฟลเดอร์ แล้วเขียนค่าชุดนั้นลงทุก PO ในชื่อโฟลเดอร์ — ผิดกับของจริง
// (ยืนยันจากข้อมูลจริง 2026-08-11: โฟลเดอร์ "10. KOBPO2501-00008 (2), KOBPO2501-00085 (1)" มี
//  3 shipment คนละ B/L กันหมด) ตอนนี้คืนเป็น "รายการ shipment" แล้วจับคู่เข้า PO ทีละใบ
const SHIPMENT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    poNumbers: { type: 'array', items: { type: 'string' }, description: 'เลข PO ที่ shipment นี้ครอบคลุม (KOBPOxxxx-xxxxx / BTVPOxxxx-xxxxx) — array ว่างถ้าระบุไม่ได้' },
    invoiceNo: { type: ['string', 'null'], description: 'เลข Commercial Invoice ของผู้ขายสำหรับ shipment นี้ — ใช้ยืนยันว่าเป็นคนละ shipment' },
    etd: { type: ['string', 'null'], description: "YYYY-MM-DD วันที่ Shipped on Board (B/L) หรือวันเที่ยวบิน (AWB) — null ถ้าเป็น draft ที่ยังไม่มีวันที่จริง" },
    vessel: { type: ['string', 'null'], description: 'ชื่อเรือจาก B/L — null ถ้าขนส่งทางอากาศ' },
    voyage: { type: ['string', 'null'], description: "เลข voyage (มักติดกับชื่อเรือ เช่น 'V.2627S')" },
    forwarder: { type: ['string', 'null'], description: "ชื่อตัวแทนขนส่งในไทย — เอาจากช่อง 'For delivery of goods please apply to' (บางใบเขียน 'Delivery Agent' / 'Notify Agent') ใน B/L หรือ AWB เป็นหลักเสมอ นี่คือเจ้าที่ผู้นำเข้าติดต่อรับของจริง ห้ามใช้ชื่อผู้ออก B/L หรือชื่อ forwarder ต้นทางจีนถ้าช่องนี้มีชื่ออื่น · ถ้าไม่มีช่องนี้ในเอกสารเลย ค่อยใช้ชื่อผู้ออก B/L/AWB แทน" },
    blNumber: { type: ['string', 'null'], description: 'เลข B/L — ใช้ House B/L (HBL) เป็นหลักถ้ามีทั้ง MBL และ HBL เพราะ forwarder อ้างเลข House ในการติดต่อ · ใช้ MBL ต่อเมื่อไม่มี HBL' },
    awbNumber: { type: ['string', 'null'], description: 'เลข AWB ถ้าขนส่งทางอากาศ — ใช้ House AWB (HAWB) เป็นหลักถ้ามีทั้ง MAWB และ HAWB · ใช้ MAWB ต่อเมื่อไม่มี HAWB' },
    containerNumbers: { type: 'array', items: { type: 'string' }, description: 'เลขตู้คอนเทนเนอร์ทั้งหมดที่พบ — array ว่างถ้าไม่มี' },
    portOfLoading: { type: ['string', 'null'], description: "ท่าเรือ/สนามบินต้นทางที่สินค้าลงเรือ (Port of Loading ใน B/L หรือ Airport of Departure ใน AWB) รูปแบบ 'ชื่อท่าเรือ, ประเทศ' เช่น 'SHANTOU, CHINA'" },
    portOfDischarge: { type: ['string', 'null'], description: "ท่าเรือ/สนามบินปลายทางที่สินค้าขึ้นจากเรือ (Port of Discharge หรือ Port of Delivery ใน B/L, Airport of Destination ใน AWB) รูปแบบ 'ชื่อท่าเรือ, ประเทศ' เช่น 'LAEM CHABANG, THAILAND'" },
    mode: { type: 'string', enum: ['sea', 'air', 'unknown'] },
  },
  required: ['poNumbers', 'invoiceNo', 'etd', 'vessel', 'voyage', 'forwarder', 'blNumber', 'awbNumber', 'containerNumbers', 'portOfLoading', 'portOfDischarge', 'mode'],
  additionalProperties: false,
};

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    shipments: { type: 'array', items: SHIPMENT_ITEM_SCHEMA, description: 'รายการ shipment ที่แยกจากกันในโฟลเดอร์นี้ — ปกติมี 1 รายการ แต่ถ้าเลข B/L หรือ AWB ต่างกันให้แยกเป็นคนละรายการ' },
  },
  required: ['shipments'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `คุณช่วยดึงข้อมูล shipment จากเอกสารนำเข้า (Commercial Invoice, Packing List, Bill of
Lading/AWB, Purchase Order ฯลฯ) ที่แนบมา ดึงเฉพาะข้อมูลที่ระบุไว้ชัดเจนในเอกสารเท่านั้น ห้ามเดา/
ประมาณค่าใดๆ — ถ้าเอกสารไม่มีข้อมูลนั้นให้ส่ง null (หรือ array ว่างสำหรับ containerNumbers) เสมอ

**สำคัญที่สุด: โฟลเดอร์เดียวอาจมีเอกสารของหลาย shipment ที่ถูกส่งแยกกันคนละรอบ**
(เช่น PO ใบเดียวเร่งบางส่วนมาทางอากาศ ที่เหลือมาทางเรือ หรือแบ่งส่งหลายล็อต)
ให้แยกกลุ่มเอกสารเป็น shipment แล้วคืนมาเป็นรายการใน shipments โดยใช้หลักนี้:
- **เกณฑ์หลักคือ "เที่ยวเรือ/เที่ยวบิน"**: ชื่อเรือ + เลข voyage ต่างกัน (หรือเลขเที่ยวบินต่างกัน)
  = คนละ shipment · ถ้าเรือ/voyage/ตู้เดียวกัน = **shipment เดียวกันเสมอ** แม้เอกสารจะมีหลายฉบับ
- ⚠ **ห้ามแยกเพราะเลข B/L ต่างกันเพียงอย่างเดียว** — shipment เดียวปกติมีทั้ง Master B/L (ของสายเรือ)
  และ House B/L (ของ freight forwarder) ซึ่งเลขคนละเลขกันเป็นเรื่องปกติ ให้ถือเป็น shipment เดียว
  แล้วรายงาน **House B/L (HBL)** · draft กับ final ของเลขเดียวกันก็ shipment เดียวกัน ใช้ฉบับ final
- ถ้าเอกสารทั้งโฟลเดอร์เป็น shipment เดียว ให้คืน shipments ที่มีสมาชิกเพียง 1 รายการ (กรณีปกติที่พบบ่อยสุด)
- **ห้ามคืน shipment ซ้ำ** — แต่ละเที่ยวเรือ/เที่ยวบินต้องปรากฏเพียงรายการเดียวเท่านั้น

**ตัวแทนขนส่ง (forwarder) — ใช้ช่อง "For delivery of goods please apply to" เป็นหลักเสมอ**
ช่องนี้ใน B/L และ AWB คือชื่อ**ตัวแทนขนส่งในไทย**ที่ผู้นำเข้าต้องติดต่อเพื่อรับของจริง
(บางแบบฟอร์มใช้คำว่า "Delivery Agent", "Notify Agent" หรือ "Also notify") ให้เอาชื่อบริษัทจากช่องนี้
**ห้ามใช้ชื่อผู้ออก B/L (ที่อยู่หัวกระดาษ) หรือ forwarder ต้นทางในจีน ถ้าช่องนี้ระบุบริษัทอื่นไว้**
ใช้ชื่อผู้ออก B/L/AWB ได้ต่อเมื่อเอกสารไม่มีช่องนี้เลยเท่านั้น

**เลข B/L และ AWB — ใช้เลข House (HBL / HAWB) เป็นหลัก**
เพราะ forwarder อ้างเลข House ในการติดต่อและหัวข้ออีเมล ค้นหาย้อนหลังได้ง่ายกว่า
ใช้เลข Master (MBL / MAWB) ต่อเมื่อเอกสารไม่มีเลข House

แต่ละ shipment ให้ระบุ poNumbers = เลข PO ที่ shipment นั้นครอบคลุม (รูปแบบ KOBPOxxxx-xxxxx หรือ
BTVPOxxxx-xxxxx ที่ปรากฏใน Commercial Invoice / Packing List / PO ของ shipment นั้น) ถ้าระบุไม่ได้ให้ส่ง array ว่าง
⚠ **ห้ามใส่ PO ค่าขนส่ง/ค่าใช้จ่ายลงใน poNumbers** — โฟลเดอร์มักมี PO อีกใบที่เปิดไว้จ่ายค่าขนส่ง
ค่าพิธีการ หรือค่าภาษีของชิปเม้นนี้ (สังเกตจากคู่ค้าเป็นบริษัทขนส่ง/ชิปปิ้ง และรายการเป็นค่าบริการ
ไม่ใช่สินค้า) PO แบบนี้ **ไม่ใช่** PO สั่งซื้อสินค้าของชิปเม้น ให้ใส่เฉพาะ PO ที่สั่งซื้อตัวสินค้าเท่านั้น`;

// API ตอบ 400 เมื่อมีไฟล์แนบที่อ่านไม่ออก แต่ "ไม่บอกว่าไฟล์ไหน" — เจอจริงตอน backtest 2026-08-11
// (BTVPO2510-01940: "The file you uploaded is badly formatted or corrupted")
// ผลเดิมคือทั้งโฟลเดอร์ล้มแล้ววนลองใหม่ทุกรอบไม่จบ เพราะไฟล์เสียก็ยังเสียอยู่วันยังค่ำ
function isBadFileError(e) {
  const msg = String(e && (e.message || e)) || '';
  return (e?.status === 400 || /\b400\b/.test(msg))
    && /badly formatted|corrupt|unsupported (file|image)|could not (be )?process|invalid.*(file|image|pdf)/i.test(msg);
}

async function extractFields(openai, documentBlocks, excelText, pdfText) {
  // ใช้ Responses API + structured output (strict) แทน forced tool-use ของ Anthropic เดิม —
  // RESPONSE_SCHEMA เดิมเข้าเงื่อนไข strict อยู่แล้ว (required ครบทุกฟิลด์ + additionalProperties:false)
  // max_output_tokens ต้องเผื่อ reasoning token ของโมเดลตระกูล gpt-5 ด้วย จึงตั้งสูงกว่า 2000 เดิม
  const callOnce = async (blocks, extraText) => {
    const content = [...blocks];
    if (extraText) content.push({ type: 'input_text', text: extraText });
    if (excelText) content.push({ type: 'input_text', text: excelText });
    if (!content.length) throw new Error('ไม่มีเนื้อหาให้ส่งเข้า AI เลย');
    content.push({ type: 'input_text', text: 'ดึงข้อมูล shipment จากเอกสารข้างต้น แล้วตอบเป็น JSON ตาม schema ที่กำหนด' });
    const response = await openai.responses.create({
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      input: [{ role: 'user', content }],
      text: { format: { type: 'json_schema', name: 'report_fields', strict: true, schema: RESPONSE_SCHEMA } },
      max_output_tokens: 4000,
    });
    // นับ token ก่อนเช็ค incomplete — ตอบไม่จบก็จ่ายเงินไปแล้ว ต้องเข้าบัญชีด้วย
    const one = addUsage(response.usage);
    if (one) log(`  [AI] ${fmtUsage(one)}`);
    if (response.status === 'incomplete') {
      throw new Error(`AI ตอบไม่จบ (${response.incomplete_details?.reason || 'ไม่ทราบสาเหตุ'}) — ลองเพิ่ม max_output_tokens`);
    }
    const out = response.output_text;
    if (!out) throw new Error('AI ไม่ได้ส่งผลลัพธ์กลับมา (output_text ว่าง)');
    try { return JSON.parse(out); }
    catch (e) { throw new Error('AI ตอบกลับไม่ใช่ JSON ที่อ่านได้: ' + out.slice(0, 200)); }
  };

  try {
    return await callOnce(documentBlocks, null);
  } catch (e) {
    if (!isBadFileError(e) || !documentBlocks.length) throw e;

    // ชั้นที่ 1 — ตัดไฟล์ทีละใบเพื่อหาว่าใบไหนเสีย (ทำเฉพาะตอนไฟล์ไม่เยอะ ไม่งั้นเปลืองเกินคุ้ม)
    if (documentBlocks.length <= 8) {
      for (let i = 0; i < documentBlocks.length; i++) {
        const kept = documentBlocks.filter((_, j) => j !== i);
        if (!kept.length) break;
        try {
          const r = await callOnce(kept, null);
          const bad = documentBlocks[i];
          log(`  [BADFILE] ตัด "${bad.filename || 'รูปภาพ'}" ออกแล้วสำเร็จ — ไฟล์นี้เสีย/อ่านไม่ออก`);
          return r;
        } catch (e2) { if (!isBadFileError(e2)) throw e2; }
      }
    }

    // ชั้นที่ 2 — ยังไม่ผ่าน ถอยไปใช้ข้อความที่ดึงจาก PDF/Excel แทนการแนบไฟล์ทั้งหมด
    // ได้ข้อมูลน้อยลง (ไม่เห็นเลย์เอาต์/ตราประทับ) แต่ดีกว่าทั้งโฟลเดอร์ล้มแล้ว retry ไม่รู้จบ
    if (pdfText || excelText) {
      log('  [BADFILE] มีไฟล์แนบที่ AI อ่านไม่ออก — ถอยไปใช้เฉพาะข้อความที่ดึงได้จากเอกสาร (ความแม่นลดลง)');
      return await callOnce([], pdfText);
    }
    throw e;
  }
}

// ─── Free fallback (regex-based, ไม่เรียก AI เลย) ──────────────────────────────────────
// ใช้ตอนไม่มี OPENAI_API_KEY จริง — ตรวจเอกสารจริงหลายฉบับ (24 ก.ค. 2569: HBL ของ Freight Links
// Express, Marine Cargo Policy ฯลฯ) พบว่า vessel/voyage/B/L no./forwarder ส่วนใหญ่เป็นค่าลอยไม่มี
// label กำกับ (label เป็นภาพ/template คงที่ ไม่ใช่ text) และตำแหน่งต่างกันไปตาม forwarder แต่ละเจ้า
// จึงใช้ pattern เชิงโครงสร้างที่พบซ้ำในเอกสารจริงแทน label ตรงๆ:
//   - B/L no.: โค้ด alnum เปล่าๆ (มีทั้งตัวอักษร+ตัวเลข) ที่ซ้ำกัน 2 ครั้งใกล้ต้นเอกสาร
//   - Vessel+Voyage: บรรทัดที่เป็นคำตัวพิมพ์ใหญ่ 1-4 คำ ตามด้วยโค้ด voyage สั้นๆ ท้ายบรรทัด
//   - Forwarder: บรรทัดชื่อบริษัท (ลงท้าย CO.,LTD/LIMITED) ที่มีคำใบ้ธุรกิจขนส่งเท่านั้น
//
// **เจอ false positive จริงในการทดสอบรอบแรก (24 ก.ค. 2569)** — รันจริงแล้วพบ 2 เคส:
//   1. โฟลเดอร์ที่มีแค่ PO (ไม่มี B/L จริง) — "Purchase Order #KOBPO2605-09165" ถูกตัดเหลือ
//      "KOBPO2605" (ก่อนขีด) แล้วเข้าใจผิดว่าเป็นเลข B/L → แก้ด้วย PO_PREFIX_RE กรองทิ้ง
//   2. โฟลเดอร์ที่มีแค่ CI (ไม่มี B/L จริง) — ที่อยู่ผู้ซื้อ "...Bangkok 10110" ถูกจับเป็น
//      vessel="BANGKOK" voyage="10110" (จริงๆ คือชื่อเมือง+รหัสไปรษณีย์) และชื่อบริษัทตัวเอง
//      "KISS OF BEAUTY COMPANY LIMITED" ถูกจับเป็น forwarder (เพราะไม่มีบรรทัดไหนมี keyword
//      ขนส่งเลย โค้ดเดิม fallback ไปเอา "บรรทัดสุดท้าย" ซึ่งดันเป็นชื่อตัวเอง) — ทั้งสองเคส
//      upsert เข้า production จริงก่อนจะจับได้และ revert คืน — แก้โดย (ก) เพิ่ม city/country
//      exclude list + ปฏิเสธ voyage ที่เป็นเลขล้วน 5 หลัก (รูปแบบรหัสไปรษณีย์) (ข) เอาชื่อบริษัท
//      ตัวเอง (KOB) ออกจาก candidate เสมอ (ค) **เอา fallback ไปเอา "บรรทัดสุดท้าย" ออกทั้งหมด** —
//      ถ้าไม่เจอ keyword ขนส่งชัดเจน ให้ปล่อย forwarder เป็น null ดีกว่าเดาผิด (ตรงตามหลักการเดิม
//      ของไฟล์นี้ทั้งหมด: ไม่มีข้อมูล ดีกว่าข้อมูลผิดที่เข้า production เงียบๆ)
// ทั้งหมดนี้ยังเป็น best-effort ไม่ใช่ label-anchored แบบ ETD — ผิดได้บ้างในเอกสารที่โครงสร้างต่างไปมาก
const BL_HEAD_RE = /\b(?=[A-Z0-9]{8,18}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{8,18}\b/g;
const PO_PREFIX_RE = /^(?:KOB|BTV)(?:PO|SO)/i; // กัน "Purchase Order #KOBPO2605-09165" โดนตัดเหลือ "KOBPO2605" แล้วเข้าใจผิดเป็นเลข B/L
const VESSEL_LINE_RE = /^([A-Z][A-Z]+(?:\s[A-Z]+){0,3})\s+(\d{2,6}[A-Z]{0,3})\s*$/;
const VESSEL_EXCLUDE_RE = /^(SAID TO CONTAIN|SHIPPING TERMS|FREIGHT COLLECT|FREIGHT PREPAID|SAME AS ABOVE|SHIPPER LOAD|PORT OF|PLACE OF|BILL OF LADING|NUMBER OF|TOTAL NUMBER|CY CY|CFS CFS)/;
// ชื่อเมือง/ประเทศที่ปรากฏบ่อยในที่อยู่ผู้ซื้อ/ผู้ขาย — กันจับที่อยู่ผิดเป็นชื่อเรือ (เจอเคสจริง: "BANGKOK 10110")
const CITY_EXCLUDE_RE = /^(BANGKOK|LAEM CHABANG|LAT KRABANG|SHANGHAI|NINGBO|SHENZHEN|GUANGZHOU|QINGDAO|XIAMEN|PUSAN|BUSAN|INCHEON|HONG KONG|SINGAPORE|THAILAND|CHINA|KOREA|VIETNAM|TOTAL|AMOUNT)$/;
const COMPANY_LINE_RE = /(?:CO\.,?\s*LTD\.?|LIMITED|LLC|INC\.?)\.?\s*$/i;
const FORWARDER_KEYWORD_RE = /LOGISTICS|EXPRESS|LINKS|CARGO|FORWARDING|SHIPPING|TRANS|FREIGHT/;
const OWN_COMPANY_RE = /KISS\s*OF\s*BEAUTY|\bKOB\b|BEAUTIVILLE/i; // กันจับชื่อบริษัทตัวเองเป็น forwarder (เจอเคสจริง)

// หา B/L no. ต้อง "ต้นเอกสาร" ของ "แต่ละไฟล์" ไม่ใช่ต้นของข้อความรวมทั้งโฟลเดอร์ — เจอจริงว่าถ้ามีหลาย
// ไฟล์ใน pdfText ที่ต่อกันด้วย marker "=== FILE: x ===" (ดู convertFiles) ไฟล์ HBL จริงมักไม่ใช่ไฟล์
// แรกตามลำดับตัวอักษร ทำให้เนื้อหาของมันหลุดจาก 600 ตัวอักษรแรกของข้อความรวมไปเลย ต้องตัดเป็นท่อนต่อไฟล์ก่อน
function findBlNumberFree(upperText) {
  const sections = upperText.split(/=== FILE: [^=]*? ===/).filter(Boolean);
  for (const section of (sections.length ? sections : [upperText])) {
    const found = findBlNumberInSection(section);
    if (found) return found;
  }
  return null;
}
function findBlNumberInSection(sectionUpperText) {
  const head = sectionUpperText.slice(0, 600);
  const candidates = [...head.matchAll(BL_HEAD_RE)].map((m) => m[0]).filter((c) => !PO_PREFIX_RE.test(c));
  const counts = {};
  candidates.forEach((c) => { counts[c] = (counts[c] || 0) + 1; });
  const repeated = Object.keys(counts).find((c) => counts[c] >= 2);
  return repeated || candidates[0] || null;
}
function findVesselVoyageFree(upperText) {
  for (const line of upperText.split(/\r?\n/)) {
    const m = VESSEL_LINE_RE.exec(line.trim());
    if (!m || VESSEL_EXCLUDE_RE.test(m[1]) || CITY_EXCLUDE_RE.test(m[1]) || m[1].split(' ').length > 4) continue;
    if (/^\d{5}$/.test(m[2])) continue; // เลขล้วน 5 หลัก น่าจะเป็นรหัสไปรษณีย์ ไม่ใช่ voyage
    return { vessel: m[1].trim(), voyage: m[2].trim() };
  }
  return { vessel: null, voyage: null };
}
function findForwarderFree(text) {
  const companyLines = text.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && l.length < 70 && COMPANY_LINE_RE.test(l) && !OWN_COMPANY_RE.test(l));
  const withKeyword = companyLines.filter((l) => FORWARDER_KEYWORD_RE.test(l.toUpperCase()));
  // ไม่ fallback ไปเอา "บรรทัดสุดท้าย" อีกต่อไป — ถ้าไม่เจอ keyword ขนส่งชัดเจน ปล่อย null ดีกว่าเดาผิด
  return withKeyword.length ? withKeyword[withKeyword.length - 1] : null;
}
const CONTAINER_RE = /\b([A-Z]{3}[UJZR]\d{7})\b/g; // ISO 6346: owner code 3 ตัว + category 1 ตัว + serial 6 หลัก + check digit 1 หลัก
const AWB_RE = /\b(\d{3})[\s-]?(\d{8})\b/g;
// AWB มี check digit: หลักสุดท้ายของ serial 8 หลัก = (serial 7 หลักแรก) mod 7 — ตรวจกัน false positive
// (เดิม regex 3+8 หลักใดๆ จับเบอร์โทร/เลข ref มั่ว → ตีเป็น air → บล็อก B/L + ข้าม ETA ผิดๆ)
function isValidAwb(serial8) {
  if (!/^\d{8}$/.test(serial8)) return false;
  const first7 = parseInt(serial8.slice(0, 7), 10);
  const check = parseInt(serial8[7], 10);
  return first7 % 7 === check;
}
const THAI_PORTS = ['LAEM CHABANG', 'BANGKOK', 'LAT KRABANG', 'MAP TA PHUT', 'SURAT THANI', 'SONGKHLA'];
const ORIGIN_COUNTRIES = ['CHINA', 'KOREA', 'SOUTH KOREA', 'VIETNAM', 'TAIWAN', 'HONG KONG', 'JAPAN', 'MALAYSIA', 'INDONESIA', 'SINGAPORE'];

const MONTHS_ABBR = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
// ปีไทยมักเป็น พ.ศ. (ค.ศ. + 543) — ปี >= 2400 ให้ถือว่าเป็น พ.ศ. แล้วแปลงเป็น ค.ศ. เสมอก่อนบันทึก
function beToCe(year) { return year >= 2400 ? year - 543 : year; }
function pad2(n) { return String(n).padStart(2, '0'); }
// ประกอบ ISO เฉพาะเมื่อ เดือน 1-12 / วัน 1-31 สมเหตุสมผล — กันได้ค่าเพี้ยน เช่น "2026-13-45" upsert เข้า production
function isoIfValid(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${beToCe(year)}-${pad2(month)}-${pad2(day)}`;
}
// วันที่ในเอกสารจริงเจอหลายรูปแบบ: "02/07/2026", "18-JUL-2026", "JUL.02,2026" — ลองทั้ง 3 แบบ
// สมมติ DD/MM (ไม่ใช่ US MM/DD) ตามรูปแบบเอกสารที่ใช้จริง — เป็น best-effort ตาม documented
function parseFlexibleDate(s) {
  if (!s) return null;
  let m = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/.exec(s);
  if (m) return isoIfValid(+m[3], +m[2], +m[1]);
  m = /([A-Za-z]{3})[.,\s\-]+(\d{1,2})\s*,?\s*(\d{4})/.exec(s); // MMM.DD,YYYY
  if (m && MONTHS_ABBR[m[1].toUpperCase()]) return isoIfValid(+m[3], MONTHS_ABBR[m[1].toUpperCase()], +m[2]);
  m = /(\d{1,2})[\s\-]([A-Za-z]{3})[\s\-.]+(\d{4})/.exec(s); // DD-MMM-YYYY
  if (m && MONTHS_ABBR[m[2].toUpperCase()]) return isoIfValid(+m[3], MONTHS_ABBR[m[2].toUpperCase()], +m[1]);
  return null;
}
function findEtdFree(text) {
  const m = /(?:SHIPPED\s*ON\s*BOARD|ON\s*BOARD\s*DATE|LADEN\s*ON\s*BOARD|FLIGHT\s*DATE)\s*[:\-]?\s*\n?\s*([A-Za-z0-9.,\/\- ]{6,20})/i.exec(text);
  return m ? parseFlexibleDate(m[1]) : null;
}

// ISO 6346 check digit — กัน false positive จากสตริง 4 ตัวอักษร+7 หลักที่บังเอิญหน้าตาคล้าย
// เลขตู้แต่ไม่ใช่ (เช่น เลข invoice/reference อื่นในเอกสาร)
function iso6346CheckDigit(code) {
  const LETTER_VALUES = 'A10B12C13D14E15F16G17H18I19J20K21L23M24N25O26P27Q28R29S30T31U32V34W35X36Y37Z38'.match(/[A-Z]\d+/g)
    .reduce((acc, s) => { acc[s[0]] = parseInt(s.slice(1), 10); return acc; }, {});
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = code[i];
    const value = /[0-9]/.test(ch) ? parseInt(ch, 10) : LETTER_VALUES[ch];
    sum += value * Math.pow(2, i);
  }
  const mod = (sum % 11) % 10;
  return mod === parseInt(code[10], 10);
}

function extractFieldsFree(text) {
  const upper = (text || '').toUpperCase();

  const containerCandidates = [...new Set([...upper.matchAll(CONTAINER_RE)].map(m => m[1]))];
  const containerNumbers = containerCandidates.filter(c => { try { return iso6346CheckDigit(c); } catch (e) { return false; } });

  // กรองด้วย check digit — เอาเฉพาะที่เป็น AWB จริง ไม่ใช่เลข 3+8 หลักที่บังเอิญหน้าตาคล้าย
  const awbMatches = [...upper.matchAll(AWB_RE)].filter(m => isValidAwb(m[2])).map(m => `${m[1]}-${m[2]}`);
  const awbNumber = awbMatches[0] || null;

  let portOfDischarge = null;
  for (const port of THAI_PORTS) {
    if (new RegExp(port + '[,\\s]*THAILAND', 'i').test(upper)) { portOfDischarge = `${port}, THAILAND`; break; }
  }

  let portOfLoading = null;
  const countryAlt = ORIGIN_COUNTRIES.join('|');
  const cityCountryMatch = new RegExp(`([A-Z][A-Z '.\\-]{2,30}),\\s*(${countryAlt})\\b`).exec(upper);
  if (cityCountryMatch) portOfLoading = `${cityCountryMatch[1].trim()}, ${cityCountryMatch[2]}`;

  const vesselVoyage = findVesselVoyageFree(upper);

  return {
    etd: findEtdFree(text), // "SHIPPED ON BOARD"/"ON BOARD DATE" เป็น label มาตรฐานจริง — ดึงได้ปลอดภัย
    vessel: vesselVoyage.vessel,
    voyage: vesselVoyage.voyage,
    forwarder: findForwarderFree(text), // best-effort — เอาบริษัทท้ายเอกสารที่มีคำใบ้ธุรกิจขนส่ง
    blNumber: awbNumber ? null : findBlNumberFree(upper), // ใช้เฉพาะ sea (air มี awbNumber อยู่แล้ว)
    awbNumber,
    containerNumbers,
    portOfLoading,
    portOfDischarge,
    mode: awbNumber ? 'air' : (containerNumbers.length ? 'sea' : 'unknown'),
  };
}

// ─── แยกเลขเที่ยว (voyage) ที่ติดมากับชื่อเรือ ─────────────────────────────────────────
// B/L จำนวนมากพิมพ์ชื่อเรือกับเลขเที่ยวติดกันในช่องเดียว ("JARU BHUM 175S", "KANWAY FORTUNE 76S",
// "CA SAIGON V.2506S") → AI คืน voyage=null แล้ว ETS หาไม่เจอ (ETS ต้องการชื่อเรือเปล่าๆ)
// แยกเฉพาะเมื่อ (1) ยังไม่มี voyage (2) ชื่อมี ≥2 คำ (3) คำท้ายเป็นรูปเลขเที่ยว "ตัวเลข+ตัวอักษรท้าย"
// ⚠ ห้ามแยกเลขล้วน — ชื่อเรือจริงลงท้ายด้วยเลขได้ ("XIN MING ZHOU 108") ตัดเลขออกแล้วจะไปชนเรือ
// ลำอื่นในตระกูลเดียวกัน (XIN MING ZHOU 102/106/...) ใน ETS
function splitVesselVoyage(vessel, voyage) {
  if (!vessel || voyage) return { vessel, voyage };
  const tokens = String(vessel).trim().split(/\s+/);
  if (tokens.length < 2) return { vessel, voyage };
  const last = tokens[tokens.length - 1];
  // รูปแบบเลขเที่ยวที่เจอจริง: 2507S / 76S (ตัวเลขนำ) และ S023 (ตัวอักษรนำ เช่น "ANBIEN SKY V.S023")
  const m = /^[\/]?V?\.?(\d{2,4}[A-Z]{1,2}|[A-Z]{1,2}\d{2,4}[A-Z]?)$/i.exec(last);
  if (!m) return { vessel, voyage };
  return { vessel: tokens.slice(0, -1).join(' '), voyage: m[1].toUpperCase() };
}

// ─── ชี้ขาดว่าโฟลเดอร์นี้เป็นชิปเม้นทางอากาศหรือทางเรือ ──────────────────────────────────
// AOF ยืนยัน 2026-08-11: PO เดียวกันแบ่งส่งได้ทั้ง air และ sea และถือเป็น "คนละชิปเม้น"
// ลำดับความน่าเชื่อถือ: ชื่อโฟลเดอร์ > ชนิดเอกสารที่มีในโฟลเดอร์ > ที่ AI เดามาจากเนื้อเอกสาร
// วัดจริงจากโฟลเดอร์ทั้งหมด: 185 PO · 27 PO กระจายหลายโฟลเดอร์ · 5 PO มีทั้ง air และ sea
function detectModeFromFolder(folderName) {
  const u = folderName.toUpperCase();
  if (/\bBY\s*AIR\b|\bAIR\s*FREIGHT\b|\bAIR\b/.test(u)) return 'air';
  if (/\bBY\s*SEA\b|\bSEA\s*FREIGHT\b|\bSEA\b/.test(u)) return 'sea';
  return null; // 22 จาก 27 PO ที่ซ้ำ มีอย่างน้อย 1 โฟลเดอร์ที่ชื่อไม่ระบุ → ตกไปดูเอกสารแทน
}
// ดูจาก "ชนิดเอกสารที่มีอยู่ในโฟลเดอร์" ไม่ใช่เนื้อความ — Air Waybill = ทางอากาศ, Bill of Lading = ทางเรือ
// ใช้ทั้งชื่อไฟล์และเนื้อ PDF เพราะบางชุดตั้งชื่อไฟล์เป็นเลขเอกสารล้วน ไม่มีคำว่า B/L หรือ AWB
function detectModeFromDocs(fileNames, pdfText) {
  const hay = (fileNames.join(' ') + ' ' + (pdfText || '')).toUpperCase();
  const hasAwb = /AIR\s*WAY\s*-?\s*BILL|AIRWAYBILL|\bAWB\b|\bHAWB\b|\bMAWB\b/.test(hay);
  const hasBl  = /BILL\s*OF\s*LADING|SEA\s*WAY\s*-?\s*BILL|\bHBL\b|\bMBL\b|\bB\/L\b/.test(hay);
  if (hasAwb && !hasBl) return 'air';
  if (hasBl && !hasAwb) return 'sea';
  return null; // เจอทั้งคู่ หรือไม่เจอเลย = ตัดสินไม่ได้ ไม่เดา
}

function upsertTracking(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (process.env.APP_PASSWORD) {
      headers['Authorization'] = 'Basic ' + Buffer.from('scan:' + process.env.APP_PASSWORD).toString('base64');
    }
    const req = http.request({ hostname: '127.0.0.1', port: 3000, path: '/api/tracking/upsert', method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`upsert ${payload.po_so}: server ตอบไม่ใช่ JSON — ${e.message}`)); }
        } else reject(new Error(`upsert ${payload.po_so} ล้มเหลว: HTTP ${res.statusCode} ${data}`));
      });
    });
    // กัน hang ค้างไม่จำกัดถ้า server รับ connection แต่ไม่ตอบ (เช่นกำลังยุ่งกับ MCP proxy)
    req.setTimeout(15000, () => req.destroy(new Error(`upsert ${payload.po_so} timeout (15s)`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!acquireLock()) {
    log('[Lock] มี process อื่นกำลังสแกนอยู่แล้ว (เห็น scan.lock ที่ยังไม่ตาย) — ข้ามรอบนี้ กันรันซ้อน');
    return;
  }
  log('=== เริ่มสแกน ===');
  const seen = loadSeen();
  const yearFolders = discoverYearFolders();
  log(`ปีที่สแกน: ${yearFolders.join(', ')}`);

  // ── โหมด --dry-run: วางแผนอย่างเดียว ไม่เรียก AI ไม่เขียนอะไรทั้งสิ้น ──────────────────
  // การตัดสินใจว่าจะ "สร้างการ์ดใหม่หรือไม่" ขึ้นกับชื่อโฟลเดอร์ (เลข PO + ลำดับชุด) กับชนิดเอกสาร
  // เท่านั้น ไม่ต้องพึ่ง AI เลย → dry-run จึงฟรีและเร็ว และตอบคำถามได้ตรงว่าจะเกิดการ์ดอะไรบ้าง
  // *สำคัญ*: ห้ามแตะ doc_scan_seen.json ในโหมดนี้ ไม่งั้นรอบจริงจะข้ามโฟลเดอร์ที่ยังไม่ได้ประมวลผล
  if (DRY_RUN) {
    const tracking = loadTrackingLocal();
    const byPo = new Map(tracking.map(r => [(r.po_so || '').toUpperCase(), r]));
    const plan = { update: 0, create: 0, noBase: 0, folders: 0 };
    // ประมาณค่าใช้จ่าย: นับเฉพาะโฟลเดอร์ที่ "รอบจริงจะเรียก AI" — ต้องใช้เงื่อนไขชุดเดียวกับ
    // ตัวสแกนจริง (ไฟล์เปลี่ยน/--only/--force + เพดาน MAX_FOLDERS ต่อรอบ) ไม่งั้นตัวเลขจะไม่ตรง
    const est = { folders: 0, pages: 0, skipped: 0, heaviest: [] };
    log('=== DRY RUN — ไม่เขียนข้อมูลใดๆ ทั้งสิ้น ===');
    for (const yearFolder of yearFolders) {
      let folders = [];
      try { folders = discoverShipmentFolders(yearFolder); } catch (e) { continue; }
      for (const folderName of folders) {
        const targets = extractPoNumbers(folderName);
        if (!targets.length) continue;
        const dir = path.join(IMPORT_ROOT, yearFolder, folderName);
        const allPaths = walkFiles(dir);
        const files = allPaths.map(f => path.basename(f));

        if ((!ONLY || folderName.toUpperCase().includes(ONLY)) && !SKIP_FOLDERS.has(folderName)) {
          const changed = allPaths.some(fp => {
            let st; try { st = fs.statSync(fp); } catch (e) { return false; }
            const prev = seen[fp];
            return !prev || prev.mtimeMs !== st.mtimeMs || prev.size !== st.size;
          });
          if (changed || ONLY || FORCE) {
            if (est.folders >= MAX_FOLDERS) est.skipped++;
            else {
              const p = estimatePagesForFolder(allPaths);
              est.folders++; est.pages += p;
              est.heaviest.push({ name: folderName, pages: p });
            }
          }
        }

        const mode = detectModeFromFolder(folderName) || detectModeFromDocs(files, '') || '?';
        const lines = [];
        for (const t of targets) {
          const exists = byPo.has(t.key.toUpperCase());
          const baseExists = byPo.has(t.base.toUpperCase());
          if (exists) { plan.update++; lines.push(`      อัปเดตการ์ดเดิม  ${t.key}`); }
          else if (t.key !== t.base && baseExists) {
            plan.create++;
            const b = byPo.get(t.base.toUpperCase());
            lines.push(`   ⭐ สร้างการ์ดใหม่   ${t.key}  (_splitBase=${t.base} · ${b.company || '?'}/${b.party || '?'} · ค่าใช้จ่ายเริ่มที่ 0)`);
          } else if (t.key !== t.base) { plan.noBase++; lines.push(`   ⚠️  ข้าม ${t.key} — ไม่มีการ์ดฐาน ${t.base} ในระบบ`); }
          else { plan.noBase++; lines.push(`   ⚠️  ข้าม ${t.key} — ไม่มีการ์ดนี้ในระบบ และไม่ใช่ชิปเม้นย่อย`); }
        }
        if (lines.some(l => l.includes('⭐') || l.includes('⚠️'))) {
          plan.folders++;
          log(`[${mode}] ${folderName}`);
          lines.forEach(l => log(l));
        }
      }
    }
    log(`=== สรุป DRY RUN: อัปเดตการ์ดเดิม ${plan.update} · สร้างการ์ดใหม่ ${plan.create} · ข้าม ${plan.noBase} ===`);

    // ── ประมาณค่าใช้จ่าย AI ของ "รอบจริง" ที่จะรันด้วย flag ชุดเดียวกันนี้ ──────────────────
    if (!est.folders) {
      log('=== ค่าใช้จ่าย AI: ไม่มีโฟลเดอร์ไหนต้องเรียก AI (ไฟล์ไม่เปลี่ยนตั้งแต่รอบก่อน) = 0 บาท ===');
    } else {
      const tokens = est.folders * EST_FIXED_TOKENS + est.pages * EST_TOKENS_PER_PAGE;
      const money = fmtCost({ input: tokens, cachedInput: 0, output: est.folders * 150 });
      log(`=== ประมาณค่าใช้จ่าย AI ของรอบจริง (flag ชุดเดียวกันนี้) ===`);
      log(`  เรียก AI ${est.folders} ครั้ง · ${est.pages.toLocaleString()} หน้า → ~${tokens.toLocaleString()} token${money}`);
      if (est.skipped) log(`  (อีก ${est.skipped} โฟลเดอร์เกินเพดาน ${MAX_FOLDERS}/รอบ จะยกไปรอบถัดไป — ยังไม่รวมในตัวเลขข้างบน)`);
      est.heaviest.sort((a, b) => b.pages - a.pages);
      if (est.heaviest.length > 1) {
        log('  โฟลเดอร์ที่กินเงินมากสุด:');
        est.heaviest.slice(0, 5).forEach(h => log(`    ${String(h.pages).padStart(4)} หน้า  ${h.name.slice(0, 64)}`));
      }
      if (!costUsd({ input: 1 })) log('  (ตั้ง OPENAI_PRICE_* กับ USD_THB ใน .env แล้วจะบอกเป็นบาทให้ด้วย)');
      log('  ⚠ เป็นค่าประมาณจากจำนวนหน้า (สอบเทียบจากการวัดจริง 2 จุด) ยอดจริงดูได้จาก --usage หลังรัน');
    }
    return;
  }

  let openai = null;
  if (process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.includes('...')) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120000, maxRetries: 2 });
    log(`ใช้โหมด AI (OPENAI_API_KEY ตั้งค่าแล้ว, โมเดล ${MODEL}) — ดึงได้ครบทุกฟิลด์`);
  } else {
    log('[NOTE] ไม่มี OPENAI_API_KEY จริง — ใช้โหมดฟรี (regex+heuristic เท่านั้น) container/AWB/port/ETD แม่นยำสูง ส่วน vessel/voyage/B-L/forwarder เป็น best-effort (จับ pattern โครงสร้างเอกสาร ไม่ใช่ label) อาจผิดได้ในบางเอกสารที่โครงสร้างต่างไปมาก');
  }

  let etsSession = null;
  let processed = 0;
  let skippedBacklog = 0;
  const writtenThisRun = new Map(); // po → { folder, mode } กันสองโฟลเดอร์ของ PO เดียวกันทับกันในรอบเดียว

  try {
  for (const yearFolder of yearFolders) {
    let shipmentFolders;
    try { shipmentFolders = discoverShipmentFolders(yearFolder); }
    catch (e) { log(`[WARN] อ่านโฟลเดอร์ปี ${yearFolder} ไม่ได้ (${e.message}) — ข้ามปีนี้`); continue; }
    for (const folderName of shipmentFolders) {
      if (ONLY && !folderName.toUpperCase().includes(ONLY)) continue;
      if (SKIP_FOLDERS.has(folderName)) continue; // ทำไปแล้วในรอบก่อน (--resume-from-log)
      const poNumbers = extractPoNumbers(folderName);
      const fullDir = path.join(IMPORT_ROOT, yearFolder, folderName);
      const allFiles = walkFiles(fullDir);
      const newFiles = allFiles.filter(fp => {
        let stat;
        try { stat = fs.statSync(fp); } catch (e) { return false; }
        const prev = seen[fp];
        return !prev || prev.mtimeMs !== stat.mtimeMs || prev.size !== stat.size;
      });
      // ไฟล์ไม่เปลี่ยน ข้าม ไม่เรียก AI ซ้ำ — ยกเว้นตอนเจาะจงโฟลเดอร์ด้วย --only (สั่งทดสอบเอง)
      if (!newFiles.length && !ONLY && !FORCE) continue;

      // จำกัดจำนวนโฟลเดอร์/รอบเฉพาะตอนใช้ AI (มีค่าใช้จ่ายจริง) — โหมดฟรี (regex local) เร็ว/ไม่มี
      // ค่าใช้จ่าย ประมวลผล backlog ทั้งหมดในรอบเดียวได้เลย ไม่ต้องจำกัด
      if (openai && processed >= MAX_FOLDERS) { skippedBacklog++; continue; }
      processed++;

      log(`[${folderName}] PO: ${poNumbers.map(t => t.key).join(', ')} — ไฟล์ใหม่/เปลี่ยน ${newFiles.length}/${allFiles.length}`);
      try {
        // แปลงไฟล์ "ทั้งหมด" ในโฟลเดอร์เสมอ (ไม่ใช่แค่ไฟล์ใหม่) เพราะต้องเห็นเอกสารครบชุด
        // ถึงจะตัดสินใจถูก (เช่น B/L เดิมที่ไม่เปลี่ยน + CI ใหม่ที่เพิ่งมา)
        const { documentBlocks, excelText, pdfText, usedNames } = await convertFiles(allFiles, !!openai);
        if (!documentBlocks.length && !excelText && !pdfText) { log('  ไม่มีไฟล์ที่อ่านได้เลย ข้าม'); continue; }

        const raw = openai
          ? await extractFields(openai, documentBlocks, excelText, pdfText)
          : { shipments: [extractFieldsFree(pdfText + '\n' + excelText)] };
        // กันซ้ำระดับโค้ดอีกชั้น — prompt สั่งห้ามคืนซ้ำแล้วแต่ยังเจอจริง (2026-08-11: โฟลเดอร์ "23."
        // คืน B/L NBXCF2503021B มาสองรอบเหมือนกันเป๊ะ) คีย์ = เที่ยวเรือ+ตู้+invoice ตามเกณฑ์แยก shipment
        const dedupKey = s => [s.vessel, s.voyage, (s.containerNumbers || []).join('|'), s.invoiceNo, s.blNumber || s.awbNumber]
          .map(x => String(x || '').toUpperCase().replace(/[^A-Z0-9|]/g, '')).join('~');
        // ── ตัด shipment ของบริษัทอื่นออกก่อนทุกขั้น ────────────────────────────────────
        // ผู้ขายรายเดียวกันมักรวมของหลายบริษัทขึ้นเรือลำเดียวเที่ยวเดียว แล้วออก B/L แยกใบต่อบริษัท
        // (AOF ยืนยัน 2026-08-11: โฟลเดอร์ "23." มี NBXCF2503021A ของ KOB กับ NBXCF2503021B ของ
        //  Cosmonation ซึ่งไม่เกี่ยวกับ KOB เลย) ระบบนี้ติดตามเฉพาะ KOB กับ BTV เท่านั้น
        // *ต้องตัดก่อนขั้นรวมเที่ยว* ไม่งั้น B/L ของบริษัทอื่นอาจถูกรวมแล้วชนะขึ้นมาเป็นค่าที่บันทึก
        const isOwnPo = p => /^(KOB|BTV)PO/i.test(String(p || '').trim());
        const ownShipments = (Array.isArray(raw.shipments) ? raw.shipments : []).filter(Boolean)
          .map(s => ({ ...s, poNumbers: (s.poNumbers || []).filter(isOwnPo), _origPo: s.poNumbers || [] }))
          .filter(s => {
            if (s._origPo.length && !s.poNumbers.length) {
              log(`  [SKIP-OTHER] B/L ${s.blNumber || s.awbNumber || '?'} เป็นของบริษัทอื่น (${s._origPo.join(', ')}) — ระบบนี้ติดตามเฉพาะ KOB/BTV`);
              return false;
            }
            return true;
          });

        const seenShip = new Set();
        const rawShipments = ownShipments.filter(Boolean)
          .filter(s => { const k = dedupKey(s); if (seenShip.has(k)) { log(`  [DEDUP] ตัด shipment ซ้ำ (B/L ${s.blNumber || s.awbNumber || '?'})`); return false; } seenShip.add(k); return true; });

        // ── รวม shipment ที่เป็น "เที่ยวเดียวกัน" เข้าด้วยกัน (บังคับด้วยโค้ด ไม่พึ่ง prompt) ──────
        // ของขึ้นเรือลำเดียว เที่ยวเดียว = shipment เดียวเสมอ ต่อให้เอกสารจะมี B/L หลายฉบับ
        // (MBL ของสายเรือ + HBL ของ forwarder เลขคนละเลข เป็นเรื่องปกติ) — เจอจริง 2026-08-11:
        // โฟลเดอร์ "23." ถูกแยกเป็น 5 shipment ทั้งที่ทุกใบเป็น CA SAIGON เที่ยว V.2506S เหมือนกันหมด
        // สั่งใน prompt แล้วโมเดลยังแยกอยู่ จึงต้องรวมเองหลังได้ผลลัพธ์
        const tripKey = s => {
          const n = x => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^V(?=\d)/, '');
          if (s.mode === 'air' || (!s.vessel && s.awbNumber)) return 'AIR~' + n(s.awbNumber);
          if (s.vessel && s.voyage) return 'SEA~' + n(s.vessel) + '~' + n(s.voyage);
          return 'BL~' + n(s.blNumber || s.awbNumber) || Math.random().toString(36);
        };
        const merged = new Map();
        for (const s of rawShipments) {
          const k = tripKey(s);
          const prev = merged.get(k);
          if (!prev) { merged.set(k, { ...s, poNumbers: [...(s.poNumbers || [])], containerNumbers: [...(s.containerNumbers || [])] }); continue; }
          prev.poNumbers = [...new Set([...prev.poNumbers, ...(s.poNumbers || [])])];
          prev.containerNumbers = [...new Set([...prev.containerNumbers, ...(s.containerNumbers || [])])];
          for (const f of ['etd', 'forwarder', 'blNumber', 'awbNumber', 'invoiceNo', 'portOfLoading', 'portOfDischarge']) {
            if (!prev[f] && s[f]) prev[f] = s[f];
          }
        }
        const shipments = [...merged.values()];
        if (shipments.length < rawShipments.length) {
          log(`  [MERGE] รวม ${rawShipments.length} รายการที่ AI แยกมา เหลือ ${shipments.length} shipment จริง (เที่ยวเรือ/เที่ยวบินเดียวกัน)`);
        }
        if (!shipments.length) { log('  ไม่พบข้อมูล shipment ในเอกสารชุดนี้'); continue; }
        if (shipments.length > 1) log(`  ⚠ โฟลเดอร์นี้มี ${shipments.length} shipment แยกกัน (เลข B/L ต่างกัน) — จะแยกเขียนคนละการ์ด`);

        const folderMode = detectModeFromFolder(folderName);
        const claimedTargets = new Set(); // กัน shipment สองตัวเขียนลงการ์ดใบเดียวกัน

        for (const result of shipments) {
        // แยกเลขเที่ยวที่ติดมากับชื่อเรือ ก่อนใช้ทั้งตอนเขียนการ์ดและตอนค้น ETS
        {
          const sv = splitVesselVoyage(result.vessel, result.voyage);
          if (sv.vessel !== result.vessel) log(`  [SPLIT-VOY] "${result.vessel}" → เรือ "${sv.vessel}" เที่ยว "${sv.voyage}"`);
          result.vessel = sv.vessel; result.voyage = sv.voyage;
        }
        log(`  ดึงได้: inv=${result.invoiceNo} etd=${result.etd} vessel=${result.vessel} voyage=${result.voyage} bl=${result.blNumber} forwarder=${result.forwarder} mode=${result.mode} pol=${result.portOfLoading} pod=${result.portOfDischarge} container=${(result.containerNumbers||[]).join('/')} awb=${result.awbNumber} po=${(result.poNumbers||[]).join('/')}`);

        const fields = {};
        if (result.etd) fields.etd = result.etd;
        if (result.vessel) fields.vessel = result.vessel;
        if (result.voyage) fields.voyage = result.voyage;
        if (result.forwarder) fields.forwarder = result.forwarder;
        const blOrAwb = result.blNumber || result.awbNumber;
        if (blOrAwb) fields.bl_awb = blOrAwb;
        if (result.containerNumbers && result.containerNumbers.length) fields.container = result.containerNumbers.join(', ');
        if (result.portOfLoading) fields.origin = result.portOfLoading;
        if (result.portOfDischarge) fields.dest = result.portOfDischarge;

        // mode: ชื่อโฟลเดอร์ชี้ขาดก่อน แล้วค่อยดูชนิดเอกสาร ท้ายสุดจึงใช้ที่ AI เดา
        // (โฟลเดอร์ที่มีทั้งขาเรือและขาอากาศปนกัน ชื่อโฟลเดอร์จะระบุไม่ได้ → ต้องเชื่อ AI รายชิปเม้น)
        const docMode = (shipments.length > 1 && result.mode && result.mode !== 'unknown' ? result.mode : null)
          || folderMode || detectModeFromDocs(usedNames, pdfText)
          || (result.mode && result.mode !== 'unknown' ? result.mode : null);
        if (docMode) fields.mode = docMode;
        if (folderMode && result.mode && result.mode !== 'unknown' && result.mode !== folderMode) {
          log(`  [NOTE] ชื่อโฟลเดอร์บอก ${folderMode} แต่ AI อ่านเอกสารได้ ${result.mode} — ใช้ตามชื่อโฟลเดอร์`);
        }

        // ETS "Vessel Arrival" เป็นระบบของเรือเท่านั้น — ชิปเม้นทางอากาศจะเอาเลขเที่ยวบิน
        // (VZ3525, CK273, HT3859 …) ไปค้นเป็นชื่อเรือ ซึ่งไม่มีวันเจอ วัดจริงรอบสแกน 2026:
        // air/not_found 13 ครั้ง sea/found 58 — ทางอากาศไม่เคยสำเร็จสักครั้ง
        // ข้ามไปเลยดีกว่า: ประหยัดเวลา ~20 วิ/ครั้ง และไม่ทิ้ง not_found ปลอมไว้ใน log
        if (result.vessel && docMode === 'air') {
          log(`  ข้าม ETA lookup — ชิปเม้นทางอากาศ (ETS Vessel Arrival ค้นได้เฉพาะเรือ)`);
        } else if (result.vessel) {
          try {
            if (!etsSession) { log('  เปิด ETS session ครั้งแรก...'); etsSession = await openEtsSession(); }
            // ส่ง etd ไปด้วยเพื่อให้ค้นในช่วงวันที่ของ shipment นี้จริงๆ ไม่ใช่ช่วงรอบ "วันนี้"
            // ⚠ ต้องมีเพดานเวลา — วัดจริง 2026-08-13: ETS ค้างไป 48 นาทีในการค้นครั้งเดียว
            // (XIN MING ZHOU 98 voy=2505S) เพราะ waitFor ภายในบางจุดไม่มี timeout กำกับ
            // ครั้งเดียวกินเวลามากกว่าทั้งรอบสแกน 45 โฟลเดอร์รวมกัน จึงตัดที่ 90 วิแล้วไปต่อ
            const etaResult = await Promise.race([
              searchVesselActualDate(etsSession.page, result.vessel, result.mode === 'air' ? 'air' : 'sea', result.voyage, result.etd),
              new Promise((_, rej) => setTimeout(() => rej(new Error('ETS ไม่ตอบใน 90 วินาที')), 90000)),
            ]).catch(async (e) => {
              // หมดเวลาแล้วหน้าเว็บค้างอยู่กลางทาง ใช้ session เดิมต่อไม่ได้ — ปิดทิ้งให้เปิดใหม่รอบหน้า
              if (/90 วินาที/.test(e.message)) {
                try { await closeEtsSession(etsSession); } catch (e2) {}
                etsSession = null;
              }
              throw e;
            });
            log(`  ETA lookup (${result.vessel} voy=${result.voyage} etd=${result.etd}): status=${etaResult.status} eta=${etaResult.eta} matchedVoyage=${etaResult.matchedVoyage} ของทั้งหมด ${etaResult.totalVoyagesFound} เที่ยว${etaResult.reason ? ' — ' + etaResult.reason : ''}`);
            if (etaResult.eta) fields.eta = etaResult.eta;
          } catch (e) {
            log(`  [WARN] ETA lookup ล้มเหลว: ${e.message}`);
          }
        }

        // ── เลือกว่า shipment นี้ต้องเขียนลงการ์ดใบไหน ──────────────────────────────────
        // shipment เดียว = เขียนลงทุก PO ในชื่อโฟลเดอร์ (ของทั้งชุดมาด้วย B/L ใบเดียวกัน)
        // หลาย shipment = จับคู่ตามเลข PO ที่ AI ระบุว่า shipment นั้นครอบคลุม จับคู่ไม่ได้ = ไม่เขียน
        // (เดาแล้วเขียนผิดการ์ด อันตรายกว่าไม่เขียน — เป็นบทเรียนจากรอบที่ข้อมูลจริงเสียไปแล้ว)
        let targets = poNumbers;
        if (shipments.length > 1) {
          const claims = (result.poNumbers || []).map(p => stripPoIndex(String(p).toUpperCase()));
          targets = poNumbers.filter(t => !claimedTargets.has(t.key) && claims.includes(t.base));
          if (!targets.length) {
            log(`  [SKIP] shipment B/L ${result.blNumber || result.awbNumber || '?'} — จับคู่กับ PO ในโฟลเดอร์ไม่ได้ (AI ระบุ: ${claims.join(', ') || 'ไม่ระบุ'})`);
            continue;
          }
        }
        targets.forEach(t => claimedTargets.add(t.key));

        // บันทึก shipment นี้ลง artifact ก่อนเขียนการ์ด — เก็บทุกใบไม่ว่าจะเขียนลงการ์ดได้หรือไม่
        // (ชิปเม้นที่ upsert ปฏิเสธเพราะเป็นคนละชิปเม้น จะยังหาเจอที่นี่แล้วเอาไปสร้างการ์ดใหม่ได้)
        if (!NO_WRITE) {
          for (const t of targets) {
            appendShipmentRun({
              ts: new Date().toISOString(), po: t.key, base: t.base, folder: folderName,
              invoiceNo: result.invoiceNo || null, bl_awb: result.blNumber || result.awbNumber || null,
              vessel: result.vessel || null, voyage: result.voyage || null,
              etd: result.etd || null, eta: fields.eta || null,
              container: (result.containerNumbers || []).join(', ') || null,
              origin: result.portOfLoading || null, dest: result.portOfDischarge || null,
              mode: docMode || null, forwarder: result.forwarder || null,
              shipmentsInFolder: shipments.length,
            });
          }
        }

        if (Object.keys(fields).length) {
          for (const t of targets) {
            const po = t.key;
            // การ์ดชิปเม้นย่อยที่ยังไม่มีในระบบ → สร้างให้ในรูปแบบเดียวกับปุ่ม "แยก shipment" ในแอป
            // (_synthetic + _splitBase + ค่าใช้จ่ายเริ่มที่ 0) โดยรับ บริษัท/คู่ค้า/สกุลเงิน จากการ์ดฐาน
            // ไม่มีการ์ดฐาน = ไม่สร้าง เพราะจะได้การ์ดลอยที่ไม่รู้ว่าเป็นของใคร
            // ⚠ ต้องเป็น payload ต่อ PO เสมอ ห้าม Object.assign ทับ `fields` ที่ใช้ร่วมกันทั้งโฟลเดอร์
            // (บั๊กจริง 2026-08-11: โฟลเดอร์ที่มี 2 PO ทำให้ PO ใบที่สองรับ _synthetic/_splitBase/id
            //  ของ PO ใบแรกไปด้วย → PO จริงจาก Odoo ถูกทำเป็นการ์ดชิปเม้นย่อยของ PO อื่น)
            const payload = { ...fields };
            if (t.key !== t.base) {
              const tracking = loadTrackingLocal();
              const has = tracking.some(r => (r.po_so || '').toUpperCase() === po.toUpperCase());
              if (!has) {
                const b = tracking.find(r => (r.po_so || '').toUpperCase() === t.base.toUpperCase());
                if (!b) { log(`  [SKIP] ${po} — ไม่มีการ์ดฐาน ${t.base} ในระบบ ยังไม่สร้างชิปเม้นย่อย`); continue; }
                Object.assign(payload, {
                  id: 't_' + po, _board: b._board || 'import', _synthetic: true, _splitBase: t.base,
                  _rateIsThb: true, type: b.type || 'import', company: b.company || 'KOB', party: b.party || '—',
                  cur: b.cur || b.currency || 'THB', rate: b.rate || 1, amount: 0, stage: 'po',
                  freight: 0, clearance: 0, insurance: 0, duty: 0, vat: 0, containerQty: 0, bills: [],
                  note: `แยกจาก PO ${t.base} — ชุดที่ ${t.idx} (สร้างอัตโนมัติจากโฟลเดอร์ "${folderName}")`,
                });
                log(`  [CREATE] สร้างการ์ดชิปเม้นย่อย ${po} จากฐาน ${t.base}`);
              }
            }
            // ── กันสองโฟลเดอร์ของ PO เดียวกันเขียนทับกัน ──────────────────────────────
            // tracking_data.json เก็บ 1 record ต่อ 1 PO (ยืนยันแล้ว: 1,041 record ไม่มี po_so ซ้ำเลย
            // และ /api/tracking/upsert หา record ด้วย po_so ตรงๆ) แต่ของจริงมี 5 PO ที่แบ่งส่ง
            // ทั้ง air และ sea = คนละชิปเม้น ถ้าปล่อยไว้จะทับกันไปมาทุกรอบสแกน
            // ระหว่างยังไม่ได้ตัดสินใจเรื่องแยก record → โฟลเดอร์แรกที่เขียนได้เป็นเจ้าของ
            // ตัวถัดมาที่คนละ mode จะ "ไม่เขียนทับ" แต่ log ไว้ให้เห็นชัด (ไม่มีข้อมูล ดีกว่าข้อมูลผิด)
            const prev = writtenThisRun.get(po);
            if (prev && docMode && prev.mode && prev.mode !== docMode) {
              log(`  [CONFLICT] ${po} เขียนไปแล้วจากโฟลเดอร์ "${prev.folder}" (${prev.mode}) — โฟลเดอร์นี้เป็น ${docMode} ซึ่งเป็นคนละชิปเม้น จึงไม่เขียนทับ`);
              continue;
            }
            try {
              if (NO_WRITE) { log(`  [NO-WRITE] จะ upsert ${po}: ${JSON.stringify(payload)}`); continue; }
              // _fillEmptyOnly: การเขียนอัตโนมัติเติมได้เฉพาะช่องที่ยังว่าง ห้ามทับค่าที่มีอยู่แล้ว
              // (ปิดโหมดนี้ได้ด้วย --overwrite เมื่อมั่นใจแล้ว — ดู OVERWRITE)
              await upsertTracking({ po_so: po, ...payload, _origin: `scan:${folderName}`,
                ...(OVERWRITE ? {} : { _fillEmptyOnly: true }),
                ...(OVERWRITE_FIELDS.length ? { _overwriteFields: OVERWRITE_FIELDS } : {}) });
              writtenThisRun.set(po, { folder: folderName, mode: docMode });
              log(`  upsert ${po} สำเร็จ: ${JSON.stringify(payload)}`);
            } catch (e) {
              log(`  [ERROR] upsert ${po} ล้มเหลว: ${e.message}`);
            }
          }
        } else {
          log('  ไม่พบข้อมูลใหม่ที่ดึงได้เลย');
        }
        } // จบลูป shipment ต่อโฟลเดอร์

        // mark seen เฉพาะตอนประมวลผลสำเร็จ (ไม่ throw) กันไฟล์ที่ error ค้างไม่ถูก retry รอบหน้า
        if (NO_WRITE) continue; // โหมดทดสอบ: ห้ามแตะ ledger ไม่งั้นรอบจริงจะข้ามโฟลเดอร์นี้ไปเลย
        for (const fp of allFiles) {
          try { const st = fs.statSync(fp); seen[fp] = { mtimeMs: st.mtimeMs, size: st.size }; } catch (e) {}
        }
        saveSeen(seen);
      } catch (e) {
        log(`  [ERROR] ประมวลผลโฟลเดอร์นี้ล้มเหลว: ${e.message} — จะลองใหม่รอบหน้า`);
      }
    }
  }
  } finally {
    // ปิด ETS session เสมอแม้ error โผล่นอก per-folder try (เช่น readdir ล้ม) — กัน chromium ค้าง zombie
    if (etsSession) await closeEtsSession(etsSession);
  }
  if (skippedBacklog) log(`[NOTE] เหลือ ${skippedBacklog} โฟลเดอร์ที่ยังไม่ได้สแกน (เกิน ${MAX_FOLDERS} โฟลเดอร์/รอบ) จะสแกนต่อรอบหน้า`);

  // ── เก็บกวาด ledger: ตัด entry ของไฟล์ที่ไม่มีอยู่แล้ว (โฟลเดอร์ถูกเปลี่ยนชื่อ/ลบ) ─────────
  // doc_scan_seen.json โตทางเดียว (891KB ณ 2026-08-12) — การเปลี่ยนชื่อโฟลเดอร์ทิ้ง entry ตายไว้
  // ⚠ guard สำคัญ: ทำเฉพาะเมื่อ IMPORT_ROOT เข้าถึงได้จริง — ถ้าไดรฟ์ D: หลุดชั่วคราวแล้วเผลอ
  // ตัดทั้ง ledger รอบถัดไปจะ re-scan ทั้ง backlog (เสียเงิน AI ซ้ำทั้งชุด)
  if (!DRY_RUN && !NO_WRITE && fs.existsSync(IMPORT_ROOT)) {
    let pruned = 0;
    for (const fp of Object.keys(seen)) {
      if (!fp.startsWith(IMPORT_ROOT)) continue; // ไม่ใช่ไฟล์ใต้ root นี้ ไม่ตัดสิน
      if (!fs.existsSync(fp)) { delete seen[fp]; pruned++; }
    }
    if (pruned) { saveSeen(seen); log(`[Seen] ตัด entry ของไฟล์ที่ไม่มีอยู่แล้ว ${pruned} รายการออกจาก ledger`); }
  }

  log(`=== จบการสแกน — ประมวลผล ${processed} โฟลเดอร์ ===`);
}

// --usage: อ่านบัญชีสะสมแล้วจบ ไม่แตะ lock/ไม่สแกน (เรียกซ้อนกับรอบที่กำลังรันอยู่ได้)
if (process.argv.includes('--usage')) {
  reportUsage();
} else {
  // saveUsage ต้องทำงานแม้ main() โยน error กลางทาง — token ที่ใช้ไปแล้วต้องไม่หายจากบัญชี
  main()
    .catch(e => { log('[FATAL] ' + e.stack); process.exitCode = 1; })
    .finally(() => { saveUsage(); releaseLock(); });
}

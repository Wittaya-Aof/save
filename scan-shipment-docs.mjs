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
import Anthropic from '@anthropic-ai/sdk';
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
const MAX_FOLDERS_PER_RUN = 20; // กันรันแรกที่มี backlog เยอะกินเวลา/ค่าใช้จ่าย AI ทีเดียวมากเกินไป
const MODEL = process.env.VERIFY_MODEL || 'claude-sonnet-5';
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const PO_MATCH_RE = /(?:KOB|BTV)PO\d{4}-\d{5}/gi;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
}

// ─── Lock ───────────────────────────────────────────────────────────────────────────────
// ป้องกันรันซ้อน — Scheduled Task ยิงทุก 20 นาที ถ้า run รอบก่อนยังไม่จบ (เช่น backlog เยอะ/
// ETS lookup ช้า) กับมีคนสั่งรันมือพร้อมกันด้วย จะเกิด 2 process แข่งกันเขียน doc_scan_seen.json
// (เจอจริงระหว่างทดสอบ 2026-07-22 — เผลอรันมือทับกับรอบที่ Scheduled Task ยิงเอง) MultipleInstances
// ของ Task Scheduler เองป้องกันได้แค่ instance ที่ Task Scheduler ยิงเอง ไม่ครอบคลุมเวลารันมือ
// จึงต้อง lock ในระดับสคริปต์เองด้วย
let lockHeldByMe = false;
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; }
    if (alive) return false;
    log(`[Lock] เจอ lock ค้างจาก PID ${pid} ที่ไม่ทำงานแล้ว (crash รอบก่อน?) — เขียนทับแล้วรันต่อ`);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
  lockHeldByMe = true;
  return true;
}
// release เฉพาะตอนที่ process นี้เป็นคนถือ lock จริง — กัน process ที่แค่มาเช็คแล้วเจอว่ามีคนถืออยู่
// (acquireLock คืน false) ไปลบ lock ของอีก process ที่กำลังทำงานจริงอยู่โดยไม่ได้ตั้งใจ
function releaseLock() {
  if (!lockHeldByMe) return;
  try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
}

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveSeen(seen) {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify(seen), 'utf8'); } catch (e) { log('[Seen] save error: ' + e.message); }
}

function extractPoNumbers(name) {
  const matches = [...name.matchAll(PO_MATCH_RE)];
  return [...new Set(matches.map(m => m[0].toUpperCase()))];
}

function discoverYearFolders() {
  return fs.readdirSync(IMPORT_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => {
      const m = /^PO\s*(\d{4})$/i.exec(name.trim());
      return m && parseInt(m[1], 10) >= MIN_YEAR;
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

function dumpExcelText(name, buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const parts = [`=== FILE: ${name} ===`];
  wb.SheetNames.forEach((sheetName) => {
    const ws = wb.Sheets[sheetName];
    parts.push(`--- SHEET: ${sheetName} ---`);
    parts.push(XLSX.utils.sheet_to_csv(ws, { blankrows: false }).trim());
  });
  return parts.join('\n');
}

// pdfText คือข้อความดิบที่ดึงได้จาก PDF (สำหรับ free regex fallback) — เอกสารจริงที่ทดสอบ
// (B/L, CI) มีตัวอักษรให้ดึงจริง ไม่ใช่รูปสแกน แต่ label ของฟิลด์ (เช่น "Port of Loading")
// มักเป็นภาพ/template คงที่ ไม่ใช่ text จึงดึงมาได้แต่ "ค่า" ไม่มี label กำกับ
// needDocumentBlocks: เข้ารหัส base64 เก็บไว้ส่งให้ Claude เฉพาะตอนมี AI ใช้งานจริงเท่านั้น —
// โหมดฟรีไม่เคยแตะ documentBlocks เลย เข้ารหัส/เก็บไว้เฉยๆ เปลืองความจำโดยเปล่าประโยชน์ (เจอจริง
// 2026-07-22: โฟลเดอร์ที่มี PDF ~16 ไฟล์พร้อมกัน เข้ารหัส base64 ทั้งหมดโดยไม่จำเป็นทำให้
// process ใช้ความจำหนักจนดูเหมือนค้าง)
async function convertFiles(filePaths, needDocumentBlocks) {
  const documentBlocks = [];
  const excelTextParts = [];
  const pdfTextParts = [];
  const usedNames = [];
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
          documentBlocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } });
        }
        const pdfResult = extractPdfTextIsolated(fp);
        if (pdfResult.ok && pdfResult.text) pdfTextParts.push(`=== FILE: ${path.basename(fp)} ===\n${pdfResult.text}`);
        else if (!pdfResult.ok) log(`  [WARN] pdf-parse อ่านข้อความไม่ได้ ${path.basename(fp)}: ${pdfResult.error}`);
        usedNames.push(path.basename(fp));
      } else if (IMAGE_MIME[ext]) {
        if (needDocumentBlocks) {
          documentBlocks.push({ type: 'image', source: { type: 'base64', media_type: IMAGE_MIME[ext], data: buffer.toString('base64') } });
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

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    etd: { type: ['string', 'null'], description: "YYYY-MM-DD วันที่ Shipped on Board (B/L) หรือวันเที่ยวบิน (AWB) — null ถ้าเป็น draft ที่ยังไม่มีวันที่จริง" },
    vessel: { type: ['string', 'null'], description: 'ชื่อเรือจาก B/L — null ถ้าขนส่งทางอากาศ' },
    voyage: { type: ['string', 'null'], description: "เลข voyage (มักติดกับชื่อเรือ เช่น 'V.2627S')" },
    forwarder: { type: ['string', 'null'], description: 'ชื่อบริษัท freight forwarder ผู้ออก B/L หรือ AWB' },
    blNumber: { type: ['string', 'null'], description: 'เลข B/L — ใช้ Master B/L (MBL) ถ้ามีทั้ง MBL และ HBL' },
    awbNumber: { type: ['string', 'null'], description: 'เลข AWB ถ้าขนส่งทางอากาศ' },
    containerNumbers: { type: 'array', items: { type: 'string' }, description: 'เลขตู้คอนเทนเนอร์ทั้งหมดที่พบ — array ว่างถ้าไม่มี' },
    portOfLoading: { type: ['string', 'null'], description: "ท่าเรือ/สนามบินต้นทางที่สินค้าลงเรือ (Port of Loading ใน B/L หรือ Airport of Departure ใน AWB) รูปแบบ 'ชื่อท่าเรือ, ประเทศ' เช่น 'SHANTOU, CHINA'" },
    portOfDischarge: { type: ['string', 'null'], description: "ท่าเรือ/สนามบินปลายทางที่สินค้าขึ้นจากเรือ (Port of Discharge หรือ Port of Delivery ใน B/L, Airport of Destination ใน AWB) รูปแบบ 'ชื่อท่าเรือ, ประเทศ' เช่น 'LAEM CHABANG, THAILAND'" },
    mode: { type: 'string', enum: ['sea', 'air', 'unknown'] },
  },
  required: ['etd', 'vessel', 'voyage', 'forwarder', 'blNumber', 'awbNumber', 'containerNumbers', 'portOfLoading', 'portOfDischarge', 'mode'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `คุณช่วยดึงข้อมูล shipment จากเอกสารนำเข้า (Commercial Invoice, Packing List, Bill of
Lading/AWB, Purchase Order ฯลฯ) ที่แนบมา ดึงเฉพาะข้อมูลที่ระบุไว้ชัดเจนในเอกสารเท่านั้น ห้ามเดา/
ประมาณค่าใดๆ — ถ้าเอกสารไม่มีข้อมูลนั้นให้ส่ง null (หรือ array ว่างสำหรับ containerNumbers) เสมอ
ถ้าเอกสารในชุดนี้มีหลาย B/L (เช่น shipment แยกส่ง) ให้เลือกฉบับที่ล่าสุด/สมบูรณ์ที่สุด (surrendered/
final ดีกว่า draft) ตอบกลับผ่าน tool ที่กำหนดเท่านั้น`;

async function extractFields(anthropic, documentBlocks, excelText) {
  const content = [...documentBlocks];
  if (excelText) content.push({ type: 'text', text: excelText });
  content.push({ type: 'text', text: 'ดึงข้อมูล shipment จากเอกสารข้างต้น แล้วเรียก tool report_fields พร้อมผลลัพธ์' });
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    tools: [{ name: 'report_fields', description: 'รายงานข้อมูล shipment ที่ดึงได้', input_schema: RESPONSE_SCHEMA }],
    tool_choice: { type: 'tool', name: 'report_fields' },
    messages: [{ role: 'user', content }],
  });
  const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'report_fields');
  if (!toolUse) throw new Error('AI ไม่ได้ส่งผลลัพธ์ในรูปแบบที่คาดไว้');
  return toolUse.input;
}

// ─── Free fallback (regex-based, ไม่เรียก AI เลย) ──────────────────────────────────────
// ใช้ตอนไม่มี ANTHROPIC_API_KEY จริง — ดึงเฉพาะฟิลด์ที่มี "รูปแบบมาตรฐานสากล" ที่ทายได้แม่นโดย
// ไม่ต้องมี label กำกับ (เอกสารจริงที่ตรวจแล้วพบว่า label เป็นภาพ/template คงที่ ไม่ใช่ text จึง
// แยกไม่ออกว่าค่าไหนคือ B/L no. / vessel / voyage / ETD โดยไม่เดา — ปล่อยเป็น null ตามที่ user
// รับทราบแล้วว่ายอมรับได้ ดีกว่าเขียนข้อมูลผิดเข้า production tracking)
const CONTAINER_RE = /\b([A-Z]{3}[UJZR]\d{7})\b/g; // ISO 6346: owner code 3 ตัว + category 1 ตัว + serial 6 หลัก + check digit 1 หลัก
const AWB_RE = /\b(\d{3})[\s-]?(\d{8})\b/g;
const THAI_PORTS = ['LAEM CHABANG', 'BANGKOK', 'LAT KRABANG', 'MAP TA PHUT', 'SURAT THANI', 'SONGKHLA'];
const ORIGIN_COUNTRIES = ['CHINA', 'KOREA', 'SOUTH KOREA', 'VIETNAM', 'TAIWAN', 'HONG KONG', 'JAPAN', 'MALAYSIA', 'INDONESIA', 'SINGAPORE'];

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

  const awbMatches = [...upper.matchAll(AWB_RE)].map(m => `${m[1]}-${m[2]}`);
  const awbNumber = awbMatches[0] || null;

  let portOfDischarge = null;
  for (const port of THAI_PORTS) {
    if (new RegExp(port + '[,\\s]*THAILAND', 'i').test(upper)) { portOfDischarge = `${port}, THAILAND`; break; }
  }

  let portOfLoading = null;
  const countryAlt = ORIGIN_COUNTRIES.join('|');
  const cityCountryMatch = new RegExp(`([A-Z][A-Z '.\\-]{2,30}),\\s*(${countryAlt})\\b`).exec(upper);
  if (cityCountryMatch) portOfLoading = `${cityCountryMatch[1].trim()}, ${cityCountryMatch[2]}`;

  return {
    etd: null, vessel: null, voyage: null, forwarder: null, blNumber: null, // ไม่มี label กำกับ — ทายไม่ได้แม่นพอ ปล่อย null
    awbNumber,
    containerNumbers,
    portOfLoading,
    portOfDischarge,
    mode: awbNumber ? 'air' : (containerNumbers.length ? 'sea' : 'unknown'),
  };
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
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`upsert ${payload.po_so} ล้มเหลว: HTTP ${res.statusCode} ${data}`));
      });
    });
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

  let anthropic = null;
  if (process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('...')) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    log('ใช้โหมด AI (ANTHROPIC_API_KEY ตั้งค่าแล้ว) — ดึงได้ครบทุกฟิลด์');
  } else {
    log('[NOTE] ไม่มี ANTHROPIC_API_KEY จริง — ใช้โหมดฟรี (regex เท่านั้น) ดึงได้แค่ container/AWB/port ที่มีรูปแบบมาตรฐาน ฟิลด์อื่น (vessel/voyage/ETD/BL/forwarder) จะเป็น null เสมอ');
  }

  let etsSession = null;
  let processed = 0;
  let skippedBacklog = 0;

  for (const yearFolder of yearFolders) {
    const shipmentFolders = discoverShipmentFolders(yearFolder);
    for (const folderName of shipmentFolders) {
      const poNumbers = extractPoNumbers(folderName);
      const fullDir = path.join(IMPORT_ROOT, yearFolder, folderName);
      const allFiles = walkFiles(fullDir);
      const newFiles = allFiles.filter(fp => {
        let stat;
        try { stat = fs.statSync(fp); } catch (e) { return false; }
        const prev = seen[fp];
        return !prev || prev.mtimeMs !== stat.mtimeMs || prev.size !== stat.size;
      });
      if (!newFiles.length) continue; // ไฟล์ไม่เปลี่ยน ข้าม ไม่เรียก AI ซ้ำ

      // จำกัดจำนวนโฟลเดอร์/รอบเฉพาะตอนใช้ AI (มีค่าใช้จ่ายจริง) — โหมดฟรี (regex local) เร็ว/ไม่มี
      // ค่าใช้จ่าย ประมวลผล backlog ทั้งหมดในรอบเดียวได้เลย ไม่ต้องจำกัด
      if (anthropic && processed >= MAX_FOLDERS_PER_RUN) { skippedBacklog++; continue; }
      processed++;

      log(`[${folderName}] PO: ${poNumbers.join(', ')} — ไฟล์ใหม่/เปลี่ยน ${newFiles.length}/${allFiles.length}`);
      try {
        // แปลงไฟล์ "ทั้งหมด" ในโฟลเดอร์เสมอ (ไม่ใช่แค่ไฟล์ใหม่) เพราะต้องเห็นเอกสารครบชุด
        // ถึงจะตัดสินใจถูก (เช่น B/L เดิมที่ไม่เปลี่ยน + CI ใหม่ที่เพิ่งมา)
        const { documentBlocks, excelText, pdfText } = await convertFiles(allFiles, !!anthropic);
        if (!documentBlocks.length && !excelText && !pdfText) { log('  ไม่มีไฟล์ที่อ่านได้เลย ข้าม'); continue; }

        const result = anthropic
          ? await extractFields(anthropic, documentBlocks, excelText)
          : extractFieldsFree(pdfText + '\n' + excelText);
        log(`  ดึงได้: etd=${result.etd} vessel=${result.vessel} voyage=${result.voyage} mode=${result.mode} pol=${result.portOfLoading} pod=${result.portOfDischarge} container=${(result.containerNumbers||[]).join('/')} awb=${result.awbNumber}`);

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
        if (result.mode && result.mode !== 'unknown') fields.mode = result.mode;

        if (result.vessel) {
          try {
            if (!etsSession) { log('  เปิด ETS session ครั้งแรก...'); etsSession = await openEtsSession(); }
            const etaResult = await searchVesselActualDate(etsSession.page, result.vessel, result.mode === 'air' ? 'air' : 'sea');
            log(`  ETA lookup (${result.vessel}): status=${etaResult.status} eta=${etaResult.eta}`);
            if (etaResult.eta) fields.eta = etaResult.eta;
          } catch (e) {
            log(`  [WARN] ETA lookup ล้มเหลว: ${e.message}`);
          }
        }

        if (Object.keys(fields).length) {
          for (const po of poNumbers) {
            try {
              await upsertTracking({ po_so: po, ...fields });
              log(`  upsert ${po} สำเร็จ: ${JSON.stringify(fields)}`);
            } catch (e) {
              log(`  [ERROR] upsert ${po} ล้มเหลว: ${e.message}`);
            }
          }
        } else {
          log('  ไม่พบข้อมูลใหม่ที่ดึงได้เลย');
        }

        // mark seen เฉพาะตอนประมวลผลสำเร็จ (ไม่ throw) กันไฟล์ที่ error ค้างไม่ถูก retry รอบหน้า
        for (const fp of allFiles) {
          try { const st = fs.statSync(fp); seen[fp] = { mtimeMs: st.mtimeMs, size: st.size }; } catch (e) {}
        }
        saveSeen(seen);
      } catch (e) {
        log(`  [ERROR] ประมวลผลโฟลเดอร์นี้ล้มเหลว: ${e.message} — จะลองใหม่รอบหน้า`);
      }
    }
  }

  if (etsSession) await closeEtsSession(etsSession);
  if (skippedBacklog) log(`[NOTE] เหลือ ${skippedBacklog} โฟลเดอร์ที่ยังไม่ได้สแกน (เกิน ${MAX_FOLDERS_PER_RUN} โฟลเดอร์/รอบ) จะสแกนต่อรอบหน้า`);
  log(`=== จบการสแกน — ประมวลผล ${processed} โฟลเดอร์ ===`);
}

main().catch(e => { log('[FATAL] ' + e.stack); process.exitCode = 1; }).finally(releaseLock);

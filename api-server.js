// ─── Logistics Tracking API Server ──────────────────────────────
// Serves: http://localhost:3000/  (web app)
// API:    http://localhost:3000/api/*
// DB:     kiss-production (AWS RDS, read-only)
// ─────────────────────────────────────────────────────────────────
'use strict';
const http  = require('http');
const { Pool } = require('pg');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

const PORT = 3000;
const ROOT = __dirname;
const { autoStage, stageWriteNeeded } = require('./lib/shipment-rules.cjs');
const TRACKING_FILE = path.join(ROOT, 'tracking_data.json');
const AUDIT_FILE    = path.join(ROOT, 'tracking_audit.jsonl');
const SHIPMENT_RUNS_FILE = path.join(ROOT, 'shipment_runs.jsonl'); // เขียนโดย scan-shipment-docs.mjs
const FREIGHT_FILE = path.join(ROOT, 'freight_quotes.json'); // ใบเปรียบเทียบค่าเฟรท (freight-comparison.html)
const BACKUP_DIR    = path.join(ROOT, 'backups');
const INTEGRITY_SEEN_FILE = path.join(ROOT, 'integrity_seen.json');
const INTEGRITY_DIGEST_FILE = path.join(ROOT, 'integrity_digest.json');

// ─── .env loader (ไม่ใช้ dependency) ─────────────────────────────
// อ่าน key=value จากไฟล์ .env — ค่าใน environment จริงมีสิทธิ์เหนือกว่า
(function loadEnv() {
  try {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !m[1].startsWith('#') && process.env[m[1]] === undefined)
        process.env[m[1]] = m[2];
    });
  } catch (e) { console.error('[Config] .env load error:', e.message); }
})();

// ─── Helpers ที่ใช้ร่วมกันทั้งไฟล์ ────────────────────────────────
// เขียนไฟล์แบบ atomic: เขียนลง .tmp ก่อนแล้ว rename ทับ — rename บน filesystem เดียวกันเป็น
// atomic operation ระดับ OS ทำให้ไฟล์ปลายทางไม่มีทางเป็น JSON ที่ถูกตัดครึ่งแม้ process ตาย/ไฟดับ
// ระหว่างเขียน (กันไฟล์ข้อมูลหลัก เช่น tracking_data.json corrupt แล้วแอปมองเป็น [] ข้อมูลหายหมด)
function writeFileAtomic(file, contents) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

// เปรียบเทียบรหัสผ่านแบบ constant-time — กัน timing attack (สำคัญเมื่อ server วิ่งบน HTTP/เปิดสู่เครือข่าย)
// เทียบความยาวก่อนด้วย timingSafeEqual บน buffer ที่ pad ให้เท่ากัน เพื่อไม่ให้ความยาวรั่วผ่านเวลา
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // เทียบ dummy ความยาวเท่ากันเพื่อคงเวลาให้ใกล้เคียง แล้วคืน false เสมอ
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_PASS) {
  console.error('[Config] ไม่พบค่าเชื่อมต่อฐานข้อมูล — สร้างไฟล์ .env จาก .env.example ก่อน');
  process.exit(1);
}

// ─── Tracking data (server-side JSON file) ───────────────────────
function loadTracking() {
  try {
    if (fs.existsSync(TRACKING_FILE))
      return JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8'));
  } catch(e) { console.error('[Tracking] load error:', e.message); }
  return [];
}
function saveTracking(data) {
  try {
    writeFileAtomic(TRACKING_FILE, JSON.stringify(data));
    return true;
  } catch(e) { console.error('[Tracking] save error:', e.message); return false; }
}

// ─── ใบเปรียบเทียบค่าเฟรท (freight-comparison.html) — เก็บทั้งใบเป็น JSON ไฟล์เดียว ──
// แทนการ copy ชีทใน Import/Export Charges Comparison.xlsx ทีละใบ · ใบหนึ่งไม่กี่ KB จึงเก็บทั้ง object
// key = id ที่ client สร้าง (fq_<base36>) · เพดาน 2,000 ใบ / 200KB ต่อใบ กันไฟล์บวมจาก client ที่ผิดปกติ
const FREIGHT_MAX_QUOTES = 2000;
const FREIGHT_MAX_QUOTE_BYTES = 200 * 1024;
const FREIGHT_ID_RE = /^fq_[a-z0-9]{6,40}$/;

// ─── อ่านใบเสนอราคา PDF ด้วย OpenAI ─────────────────────────────────────────
// ท่อเดียวกับ scan-shipment-docs.mjs (Responses API + input_file + strict json_schema)
// วัดจริงกับใบเสนอราคา 18 ใบ 15 เจ้า: อ่านตัวเลข/หน่วยถูกเกือบทั้งหมด · แมปเข้าแม่แบบ 86% ·
// "At actual" ไม่เคยถูกแปลงเป็น 0 · แต่ **ค่าระวางหลักจับได้แค่ ~59%** เพราะแต่ละเจ้าจัดตารางคนละแบบ
// → ฝั่ง client จึงต้องให้คนยืนยันเสมอ และห้ามตัดสินว่าเจ้าไหนถูกสุดจากข้อมูลที่ยังไม่ยืนยัน
const FREIGHT_PDF_MAX_BYTES = 6 * 1024 * 1024;
const FREIGHT_EXTRACT_RATE = 40;                      // ครั้ง/ชั่วโมง/IP
const FREIGHT_TEMPLATE_ROWS = {
  'import-sea': ['O/F  (Ocean Freight)', 'EXW Charge / Origin Handling', 'D/O  (Delivery Order)',
    'THC  (Terminal Handling Charge)', 'CFS  (Container Freight Station)', 'Status', 'Facilities',
    'Cleaning Fee', 'DG Surcharge', 'DG Handling', 'PCS', 'Equipment Transfer Fee', 'IMO Admin', 'EMC',
    'LSS  (Low Sulphur Fuel Surcharge)', 'CIS', 'PSS  (Peak Season Surcharge)', 'Port Charge',
    'EIR  (Equipment Interchange Receipt)', 'Seal Fee', 'Handling', 'Container Maintenance',
    'Inspection Fee', 'Paperless Registration', 'Customs Clearance', 'Transportation  (4 wheels)',
    'Transportation  (6 wheels)', "Transportation  (FCL 20' / 40')", 'Service Charge', 'Clearance  (FDA)',
    'Form E / Form AK  (Certificate of Origin)', 'Courier Fee  (ส่งเอกสาร/ฟอร์ม)', 'Documentation Fee',
    'Surrender Fee / Telex Release', 'Insurance', 'Other Charges'],
  'import-air': ['A/F  (Air Freight)', 'Local Charge @ Origin / EXW Charge', 'D/O  (Delivery Order)',
    'AWB Document', 'Customs Clearance', 'Transportation  (4 wheels)', 'Transportation  (6 wheels)',
    'Service Charge', 'Inspection Charge', 'DG Surcharge', 'DG Handling', 'Clearance  (FDA)',
    'THC  (Terminal Handling Charge)', 'Handling', 'Documentation Fee', 'Paperless Registration / EDI',
    'Form E / Form AK  (Certificate of Origin)', 'Courier Fee  (ส่งเอกสาร/ฟอร์ม)', 'Insurance', 'Other Charges'],
  'export-sea': ['Sea Freight', 'THC', 'CFS', 'Seal Fee', 'B/L Fee', 'Surrender Fee', 'Handling Charge',
    'DG Surcharge @ BKK', 'DG Surcharge @ SIN', 'DG Handling', 'DG Sticker', 'Customs Clearance',
    'Form D / CO', "Transportation (20'/40')", 'Transportation 4-Wheel', 'Transportation 6-Wheel',
    'Documentation', 'X-Ray Charge', 'Inspection Charge', 'Lashing Charge', 'Cleaning Fee',
    'VGM  (Verified Gross Mass)', 'EIR  (Equipment Interchange Receipt)', 'Port Charge',
    'Courier Fee  (ส่งเอกสาร/ฟอร์ม)', 'Insurance', 'Other Charges',
    'Customs Clearance (Dest.)', 'D/O', 'THC (Dest.)', 'CFS (Dest.)', 'Seal Fee (Dest.)',
    'Surrender Fee (Dest.)', 'CIC', 'LSS', 'Handling Charge (Dest.)', 'DG Fee (Dest.)'],
};
const FREIGHT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['forwarder', 'quoteDate', 'validUntil', 'incoterm', 'mode', 'pol', 'pod', 'transitDays',
    'currencyNote', 'freightTiers', 'lines', 'conditions', 'unreadable'],
  properties: {
    forwarder: { type: ['string', 'null'] },
    quoteDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    validUntil: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    incoterm: { type: ['string', 'null'] },
    mode: { type: ['string', 'null'], enum: ['sea', 'air', null] },
    pol: { type: ['string', 'null'] }, pod: { type: ['string', 'null'] },
    transitDays: { type: ['number', 'null'] },
    currencyNote: { type: ['string', 'null'] },
    unreadable: { type: 'boolean' },
    freightTiers: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['min', 'max', 'currency', 'price', 'unit', 'loadType'],
        properties: {
          min: { type: ['number', 'null'] }, max: { type: ['number', 'null'] },
          currency: { type: ['string', 'null'] }, price: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'] },
          loadType: { type: ['string', 'null'], enum: ['lcl', 'fcl20', 'fcl40hq', 'air', null] },
        },
      },
    },
    lines: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['sourceLabel', 'currency', 'amount', 'atActual', 'unit', 'basis', 'loadType', 'mappedTo', 'confidence'],
        properties: {
          sourceLabel: { type: 'string' },
          currency: { type: ['string', 'null'] },
          amount: { type: ['number', 'null'] },
          atActual: { type: 'boolean' },
          unit: { type: ['string', 'null'] },
          basis: { type: ['string', 'null'], enum: ['cbm', 'kgs', 'flat', null] },
          loadType: { type: ['string', 'null'], enum: ['lcl', 'fcl20', 'fcl40hq', 'air', null] },
          mappedTo: { type: ['string', 'null'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    conditions: { type: 'array', items: { type: 'string' } },
  },
};
let _openaiClient = null;
async function extractFreightQuote(dataBase64, filename, qType) {
  if (!_openaiClient) {
    const OpenAI = require('openai');
    _openaiClient = new (OpenAI.default || OpenAI)({ apiKey: process.env.OPENAI_API_KEY, timeout: 120000, maxRetries: 1 });
  }
  const rows = FREIGHT_TEMPLATE_ROWS[qType] || FREIGHT_TEMPLATE_ROWS['import-sea'];
  const system = `คุณคือผู้ช่วยอ่านใบเสนอราคาค่าขนส่งระหว่างประเทศ (freight quotation)
หน้าที่: สกัดรายการค่าใช้จ่ายทุกบรรทัดตามที่เขียนในเอกสาร แล้วแมปเข้าแถวของแม่แบบที่ให้มา

กฎเด็ดขาด
- ห้ามเดาตัวเลขที่ไม่ได้เขียนไว้ ไม่มีตัวเลข = amount null
- "At actual" / "As per receipt" / "ตามจริง" → amount null และ atActual true **ห้ามใส่ 0**
- หนึ่งบรรทัดที่มีหลายราคา (4 ล้อ/6 ล้อ, 20'/40') ให้แยกเป็นหลาย line พร้อมระบุ loadType ถ้าระบุได้
- ค่าระวางที่เป็นขั้นบันไดตามช่วงปริมาตร/น้ำหนัก ให้ใส่ freightTiers เท่านั้น **ห้ามใส่ซ้ำใน lines**
- basis: /RT /cbm /CBM = cbm · /kg /kgs = kgs · /entry /set /shpt /trip /wheel /cntr /container = flat
- mappedTo ต้องคัดลอกข้อความจากรายการแม่แบบให้ตรงตัวอักษร ถ้าไม่มีแถวที่ตรงจริง ๆ ให้ null (ห้ามสร้างชื่อใหม่)
- เงื่อนไขที่ทำให้ราคาเปลี่ยน (EBS/CIC, VAT, peak surcharge, lift on-off, ข้อจำกัด, วันหมดอายุ) → conditions ห้ามบวกเข้าราคา
- ถ้าอ่านไม่ออกหรือไม่ใช่ใบเสนอราคา → unreadable true

รายการแม่แบบที่แมปได้:
${rows.map(r => '- ' + r).join('\n')}`;
  const t0 = Date.now();
  const resp = await _openaiClient.responses.create({
    model: process.env.VERIFY_MODEL || 'gpt-5.4-mini',
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [
        { type: 'input_text', text: 'สกัดข้อมูลจากใบเสนอราคานี้' },
        { type: 'input_file', filename, file_data: `data:application/pdf;base64,${dataBase64}` },
      ] },
    ],
    text: { format: { type: 'json_schema', name: 'freight_quote', strict: true, schema: FREIGHT_SCHEMA } },
    max_output_tokens: 8000,
  });
  if (resp.status === 'incomplete') throw new Error('AI ตอบไม่จบ: ' + (resp.incomplete_details?.reason || 'ไม่ทราบสาเหตุ'));
  const parsed = JSON.parse(resp.output_text);
  // กันไม่ให้ชื่อแถวที่โมเดลกุขึ้นมาหลุดไปถึง client — แมปได้เฉพาะแถวที่มีอยู่จริงในแม่แบบ
  const set = new Set(rows);
  (parsed.lines || []).forEach(l => { if (l.mappedTo && !set.has(l.mappedTo)) l.mappedTo = null; });
  const u = resp.usage || {};
  const usage = { input: u.input_tokens || 0, cachedInput: u.input_tokens_details?.cached_tokens || 0,
    output: u.output_tokens || 0, ms: Date.now() - t0 };
  try {
    fs.appendFileSync(path.join(ROOT, 'ai_usage.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), model: process.env.VERIFY_MODEL || 'gpt-5.4-mini', calls: 1,
      input: usage.input, cachedInput: usage.cachedInput, output: usage.output, reasoning: 0,
      source: 'freight-extract', file: filename,
    }) + '\n', 'utf8');
  } catch (e) { console.error('[freight-extract usage]', e.message); }
  return { parsed, usage };
}
function loadFreight() {
  try {
    if (fs.existsSync(FREIGHT_FILE)) {
      const d = JSON.parse(fs.readFileSync(FREIGHT_FILE, 'utf8'));
      if (Array.isArray(d)) return d;
    }
  } catch(e) { console.error('[Freight] load error:', e.message); }
  return [];
}
function saveFreight(rows) {
  try { writeFileAtomic(FREIGHT_FILE, JSON.stringify(rows)); return true; }
  catch(e) { console.error('[Freight] save error:', e.message); return false; }
}

// ─── Audit log: บันทึกทุกการแก้ไข (append-only, ดูย้อนหลังได้) ────
function auditLog(action, poSo, fields, ip) {
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({
      ts: new Date().toISOString(), action, po_so: poSo, fields, ip: ip || '',
    }) + '\n', 'utf8');
  } catch(e) { console.error('[Audit]', e.message); }
}


// ─── Provenance: บันทึกว่า "ค่าแต่ละฟิลด์มาจากไหน" ───────────────────────────
// ที่มาของปัญหา (วัดจริง 2026-07-31): tracking_data.json มี 1,040 record แต่ 1,027 record (98.8%)
// ไม่มี _ts เลย และมี 181 เลข BL / 139 ETD / 131 ชื่อเรือ ที่ "ไม่มีที่ไหนบอกว่าค่านั้นมาจากไหน" —
// คนกรอกมือ? สกัดจาก B/L PDF? seed มาจากชุดข้อมูลเก่า? แยกไม่ออก เวลาตัวเลขไม่ตรงกับเอกสารจึงไม่รู้
// ว่าควรเชื่ออันไหน ต้องเปิดไฟล์เทียบมือทุกครั้ง
// หลักที่ใช้: invariant ข้อ 1 ของ graph engineering — "ทุก claim ต้องมี source หรือถูกทำเครื่องหมาย
// ว่าเป็น inference" (ดู CLAUDE.md หัวข้อรีวิว loop/graph engineering)
// เก็บเป็นสตริงสั้นต่อฟิลด์ `<origin>[:<ref>]@<iso>` ไม่ใช่ object ซ้อน — ไฟล์นี้ 550KB แล้ว
// และ **stamp เฉพาะฟิลด์ที่เปลี่ยนจริงในรอบนั้น** (ใช้ผลจาก changed ที่คำนวณไว้แล้วสำหรับ audit)
// จึงโตตามการแก้จริงของผู้ใช้ ไม่ใช่โตตามจำนวน record
// origin ที่ใช้จริง: manual (คนกรอกผ่านหน้าเว็บ) · verify:<ชื่อไฟล์> (ข้อมูลเก่าจากโมดูลตรวจเอกสารที่ถอดออกแล้ว)
// ค่าที่ไม่มี _src เลย = ไม่ทราบที่มา (ข้อมูลก่อนเริ่มเก็บ provenance) — หน้าเว็บแสดงตามนั้นตรงๆ ไม่เดา
const PROVENANCE_FIELDS = new Set([
  'etd', 'eta', 'actualDate', 'bl', 'bl_awb', 'container', 'vessel', 'voyage', 'forwarder',
  'origin', 'dest', 'mode', 'seaType', 'containerQty', 'courierCo',
  'freight', 'clearance', 'insurance', 'duty', 'vat', 'other', 'expectedCost',
  'amount', 'cur', 'rate', 'stage', 'note', 'overReceipt',
]);
// origin ต้องสะอาดก่อนเอาไปต่อสตริง — กันชื่อไฟล์ที่มี @ หรือขึ้นบรรทัดใหม่ทำให้ parse ฝั่งอ่านเพี้ยน
function sanitizeOrigin(v) {
  const s = String(v == null ? '' : v).replace(/[@\r\n]+/g, ' ').trim().slice(0, 120);
  return s || 'manual';
}
// คืน _src ชุดใหม่: ของเดิมที่ยังใช้ได้ + ฟิลด์ที่เปลี่ยนในรอบนี้ (ฟิลด์ที่ไม่ได้แตะคงที่มาเดิมไว้)
function stampProvenance(prevSrc, changedFields, origin, iso) {
  const src = (prevSrc && typeof prevSrc === 'object' && !Array.isArray(prevSrc)) ? { ...prevSrc } : {};
  const tag = sanitizeOrigin(origin) + '@' + iso;
  changedFields.forEach(f => { if (PROVENANCE_FIELDS.has(f)) src[f] = tag; });
  return src;
}

// ─── Backup อัตโนมัติ: สำเนา tracking_data.json วันละไฟล์ เก็บ 14 วัน ──
function backupTracking() {
  try {
    if (!fs.existsSync(TRACKING_FILE)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    const stamp = new Date().toISOString().slice(0, 10);
    const dest  = path.join(BACKUP_DIR, `tracking-${stamp}.json`);
    if (!fs.existsSync(dest)) {
      // กัน backup ไฟล์ที่ corrupt/ว่างทับสำเนาดี — ตรวจว่า parse เป็น array ได้ก่อนค่อย copy
      const raw = fs.readFileSync(TRACKING_FILE, 'utf8');
      let valid = false;
      try { valid = Array.isArray(JSON.parse(raw)); } catch (e) {}
      if (!valid) { console.error('[Backup] ข้าม — tracking_data.json อ่านเป็น array ไม่ได้ (อาจ corrupt) ไม่ทับ backup'); return; }
      fs.copyFileSync(TRACKING_FILE, dest);
      console.log('[Backup] saved', path.basename(dest));
    }
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^tracking-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > 14) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch(e) { console.error('[Backup]', e.message); }
}
backupTracking();
setInterval(backupTracking, 6 * 60 * 60 * 1000).unref(); // เช็คทุก 6 ชม.

// ─── Snapshot ข้อมูล Odoo ล่าสุดลงดิสก์ ──────────────────────────
// เก็บผล import-pos/export-sos/fx ที่ดึงสำเร็จครั้งล่าสุด เพื่อ:
//   1) เปิดหน้าเว็บได้ทันทีแม้ Odoo หลุด (ไม่ต้องรอ timeout)
//   2) ข้อมูลไม่หายเมื่อ restart server
const SNAPSHOT_FILE = path.join(ROOT, 'odoo_snapshot.json');
let snapshot = { _ts: {} };
try {
  if (fs.existsSync(SNAPSHOT_FILE)) snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  if (!snapshot._ts) snapshot._ts = {};
} catch (e) { console.error('[Snapshot] load error:', e.message); snapshot = { _ts: {} }; }
let _snapSaveTimer = null;
function saveSnapshot() {
  clearTimeout(_snapSaveTimer);
  _snapSaveTimer = setTimeout(() => {
    try { writeFileAtomic(SNAPSHOT_FILE, JSON.stringify(snapshot)); }
    catch (e) { console.error('[Snapshot] save error:', e.message); }
  }, 500);
}

// ─── Circuit breaker: จำว่า DB เพิ่งล่ม เพื่อไม่ให้ทุก request เสียเวลา
// รอ timeout 6 วินาทีซ้ำๆ — ระหว่างที่ยังล่ม เสิร์ฟ snapshot ทันที ───
let dbDownUntil = 0;
// window ต้องยาวกว่ารอบ AutoProbe (2 นาที) เพื่อให้ breaker เปิดต่อเนื่องตลอดช่วง DB ล่ม
// (probe ทุก 2 นาทีจะรีเฟรช window ก่อนหมดอายุ) → ทุก request เสิร์ฟ snapshot ทันที ไม่มีช่วงค้าง 15 วิ
const DB_DOWN_WINDOW = 150000; // 2.5 นาที
const dbLikelyDown = () => Date.now() < dbDownUntil;
const markDbDown   = () => { dbDownUntil = Date.now() + DB_DOWN_WINDOW; };
const markDbUp     = () => { dbDownUntil = 0; };

// ─── MCP proxy bridge (HTTPS) — fallback อัตโนมัติเมื่อต่อ RDS ตรง (5432) ไม่ได้ ──────
// สาเหตุที่ direct หลุดบ่อย: IP เครื่องนี้เป็น dynamic ไม่อยู่ใน security-group allowlist
// ตลอด (ดู memory data-load-resilience) — MCP proxy คนละ path (443) ไม่ติดปัญหานี้
// เดิมต้องรัน build-snapshot.mjs มือ + restart server เอง ทุกครั้งที่ direct หลุด
// ย้าย logic เดียวกันมาไว้ใน server เอง ให้ดึงเองอัตโนมัติ ไม่ต้องมีคนมาสั่งอีก
const MCP_URL = process.env.MCP_URL, MCP_TOKEN = process.env.MCP_TOKEN;
// ── Landed Cost service (โปรเจกต์แยก port 3100) ────────────────────────────────────────
// แตกบิลจริงจาก Odoo เป็นต้นทุนราย shipment แล้วจัดหมวด 15 ประเภท ผูกกับ "โฟลเดอร์เอกสาร"
// ซึ่งเป็นคีย์เดียวกับที่ scan-shipment-docs.mjs เดิน จึงเชื่อมเข้าการ์ดในบอร์ดได้ตรงๆ
// ⚠ เป็น service คนละตัว — ห้ามให้บอร์ดพังเมื่อมันไม่รัน ทุก endpoint ที่นี่ต้องตอบ
// { ok:true, unavailable:true } แทนการโยน error เพื่อให้หน้าเว็บแสดงว่า "ยังไม่มีข้อมูลต้นทุน"
const LANDED_URL = process.env.LANDED_COST_URL || 'http://127.0.0.1:3100';
const LANDED_MONTHS = 24;
// ชื่อโฟลเดอร์ท้ายสุด — Landed Cost เก็บ path เต็ม ("1. Import\PO 2026\68. …") ส่วน
// scan-shipment-docs.mjs เก็บเฉพาะชื่อโฟลเดอร์ชั้นล่างสุด จึงต้องตัดให้เทียบกันได้
const leafName = f => String(f || '').split(/[\\/]/).pop().trim();
function landedFetch(pathname, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, LANDED_URL);
    const req = http.get(u, { headers: { Accept: 'application/json' } }, r => {
      let d = ''; r.setEncoding('utf8');
      r.on('data', c => { d += c; });
      r.on('end', () => {
        if (r.statusCode !== 200) return reject(new Error('HTTP ' + r.statusCode));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('ตอบกลับไม่ใช่ JSON')); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Landed Cost ไม่ตอบใน ${timeoutMs / 1000} วินาที`)));
    req.on('error', reject);
  });
}
// NCOLS*CHUNK = งบ base64 ต่อแถว (24*50=1200 ตัว ≈ 900 byte JSON ดิบ) — เผื่อแถวที่มีชื่อผู้ขาย/สินค้ายาว
// หรือ currency_rate ทศนิยมเยอะ ไม่ให้ตัดขาดจน parse ไม่ผ่าน (เดิม 16 คอลัมน์ = 600 byte เสี่ยงพอดีกับแถวยาวๆ)
const MCP_NCOLS = 24, MCP_CHUNK = 50, MCP_PAGE = 120;
// แถวที่ JSON ใหญ่กว่า import/export (เช่น bill picker ที่มี lines[] ต่อบิล) — บิลหมวด Import Expenses มี
// line เยอะ วัดจริงแล้วสูงสุด ~3360 base64 chars (ไม่ใช่ 1440 ที่วัดครั้งแรกจาก query แคบ — 14 บิลเคยเกิน 40
// คอลัมน์แล้วถูกตัดหายเงียบๆ) → 100 คอลัมน์ (5000) มี headroom ~49% ทดสอบผ่าน MCP tool จริงแล้วว่า render
// ครบ ~67 คอลัมน์ได้ไม่ถูกตัดแนวนอน ถ้าอนาคตมีบิล line เยอะกว่านี้จนเกิน จะเห็น log "[MCP] แถวเสีย" (ไม่หายเงียบ)
const MCP_NCOLS_WIDE = 100;
// กันยิง MCP ถี่เกินไปตอน direct หลุดยาว (ทุก request ที่ไม่ force จะเช็คก่อน) — ลองใหม่ได้ทุก 1 นาที/key
const MCP_RETRY_INTERVAL = 60000;
// error ที่บ่งชี้ว่า "ต่อฐานข้อมูลไม่ได้" จริงๆ — ต่างจาก SQL ผิด/ตารางไม่มี/query เดียวหนักเกินจน statement
// timeout ซึ่งไม่ได้แปลว่าเครือข่ายไป RDS พัง เดิม markDbDown() ถูกเรียกทุก error ไม่เลือก ทำให้ error เฉพาะ
// จุด (เช่น /api/shipments ตอนยังไม่ได้ติดตั้ง module → "relation does not exist") ไปเปิด circuit breaker
// ปิดทุก endpoint ที่เหลือทิ้งยาว 2.5 นาที ทั้งที่ DB ยังต่อได้ปกติ
const isConnFailure = (e) => /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|terminated|getaddrinfo|Client has encountered a connection error/i.test((e && e.message) || '');
// snapshot อายุไม่เกินนี้ถือว่า "ยังสด" แม้รอบนี้จะโดน throttle ไม่ได้ fetch จริง (กัน UI ขึ้นเตือนหลอก)
// ต้องยาวกว่า MCP_RETRY_INTERVAL และ AutoProbe (2 นาที) รวมกัน ไม่งั้นจะมีช่วงโดนตีเป็น stale ทั้งที่เพิ่งอัปเดต
const SNAPSHOT_FRESH_WINDOW = 240000; // 4 นาที
const mcpNextTry = { import: 0, export: 0 };

// หมายเหตุสำคัญ: session id ("sid") ส่งผ่านเป็น parameter ทุกฟังก์ชัน ไม่เก็บเป็นตัวแปร
// module-level ที่ใช้ร่วมกัน — เพราะ import/export ถูกดึงพร้อมกัน (Promise.all ฝั่ง frontend)
// ถ้าใช้ sid ตัวเดียวร่วมกัน คำขอสองอันจะแย่ง/ทับ session กัน ทำให้ pagination พัง
// (เจอจริงตอนกด Sync: request ที่มาพร้อมกันทำให้ผลลัพธ์งอแงเป็นระยะ)
function mcpHeaders(sid) {
  return { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
    'Authorization': 'Bearer ' + MCP_TOKEN, ...(sid ? { 'Mcp-Session-Id': sid } : {}) };
}
function mcpParseBody(txt) {
  txt = (txt || '').trim();
  if (!txt) return null;
  if (txt[0] === '{') return JSON.parse(txt);
  const data = txt.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
  return JSON.parse(data);
}
// ต้องมี timeout เอง — ต่างจาก client ฝั่ง browser ที่มี fetchTimeout(); ถ้า MCP proxy ค้าง (ไม่ error แต่ไม่ตอบ)
// fetch() เปล่าๆ ไม่มี timeout ในตัว จะรอไม่จำกัดเวลา ทำให้ warm()/AutoProbe ค้างไปเรื่อยๆ ทุก 2 นาที
const MCP_FETCH_TIMEOUT = 20000;
async function mcpRpc(sid, method, params, id) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), MCP_FETCH_TIMEOUT);
  try {
    const r = await fetch(MCP_URL, { method: 'POST', headers: mcpHeaders(sid), signal: ac.signal,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id != null ? { id } : {}), method, ...(params ? { params } : {}) }) });
    const txt = await r.text();
    const newSid = r.headers.get('mcp-session-id') || sid;
    return { status: r.status, sid: newSid, body: txt ? mcpParseBody(txt) : null };
  } finally { clearTimeout(t); }
}
async function mcpConnect() {
  const init = await mcpRpc(null, 'initialize',
    { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'import-export-os-server', version: '1.0' } }, 0);
  if (init.status !== 200) throw new Error('MCP initialize HTTP ' + init.status);
  await mcpRpc(init.sid, 'notifications/initialized', null, null);
  return init.sid;
}
async function mcpRunSql(sid, sql) {
  const res = await mcpRpc(sid, 'tools/call', { name: 'run_sql', arguments: { sql } }, Math.floor(Math.random() * 1e6) + 2);
  if (res.status !== 200) throw new Error('MCP run_sql HTTP ' + res.status);
  const c = res.body?.result?.content;
  return Array.isArray(c) ? c.map(x => x.text || '').join('') : '';
}
// SELECT ที่คืนแต่ละแถวเป็น base64 หั่น NCOLS คอลัมน์ — MCP tool ตัดข้อความที่ ~58 ตัว/ช่อง
// เข้ารหัส base64 ทั้งแถวเป็น JSON เดียวแล้วหั่นเป็นคอลัมน์เล็กๆ กันตัด ประกอบคืนฝั่งนี้ (lossless)
function mcpWrap(innerSelect, orderCols, off, ncols = MCP_NCOLS) {
  const cols = [];
  for (let i = 0; i < ncols; i++) cols.push(`substring(b,${i * MCP_CHUNK + 1},${MCP_CHUNK}) AS c${i}`);
  const orderBy = orderCols.split(',').map(s => s.trim().split(' AS ')[1] + ' DESC NULLS LAST').join(', ');
  return `
    SELECT ${cols.join(', ')} FROM (
      SELECT translate(encode(convert_to(row_to_json(r)::text,'UTF8'),'base64'), E'\\n','') AS b, ${orderCols}
      FROM ( ${innerSelect} ) r
      ORDER BY ${orderBy}
      LIMIT ${MCP_PAGE} OFFSET ${off}
    ) x
    ORDER BY ${orderBy}`;
}
function mcpParseTable(text) {
  const lines = text.split(/\r?\n/).filter(l => l.includes('│'));
  const rows = [];
  for (const line of lines) {
    const cells = line.split('│').map(s => s.trim());
    if (cells.every(c => /^c\d+$/.test(c) || c === '')) continue; // header row
    const b64 = cells.join('').replace(/\s+/g, '');
    if (b64) rows.push(b64);
  }
  return rows;
}
// ถอดรหัส base64 → JSON ต่อแถว ใช้ร่วมกันทั้ง mcpPull (bulk, paginate) และ mcpFetchPoLines (เดี่ยว ไม่ paginate)
// แถวเสีย (เช่น ยาวเกิน budget ของคอลัมน์ base64 ที่หั่นไว้) เคย silent ข้ามเงียบๆ — log ไว้ให้เห็นใน server log
// อย่างน้อย จะได้ไล่ดูได้ว่าควรขยาย MCP_NCOLS ไหม แทนที่จะไม่รู้ตัวว่าข้อมูลหาย
function decodeB64Rows(b64rows, label) {
  const out = [];
  for (const b of b64rows) {
    try { out.push(JSON.parse(Buffer.from(b, 'base64').toString('utf8'))); }
    catch (e) { console.error('[MCP] แถวเสีย (parse ไม่ได้' + (label ? ', ' + label : '') + '):', e.message); }
  }
  return out;
}
// maxRows (ถ้าใส่) หยุด paginate เมื่อถึงจำนวนนี้ — mirror LIMIT ของ SQL_IMPORT/SQL_EXPORT (2000/500)
// ไม่งั้น path นี้ไม่มี cap เลย ต่างจาก direct pg ที่ถูกจำกัดไว้ ทำให้ชุดข้อมูลระหว่าง 2 ทางไม่ตรงกัน
async function mcpPull(sid, innerSelect, orderCols, maxRows, ncols = MCP_NCOLS) {
  const out = [];
  for (let off = 0; ; off += MCP_PAGE) {
    const text = await mcpRunSql(sid, mcpWrap(innerSelect, orderCols, off, ncols));
    const b64rows = mcpParseTable(text);
    if (!b64rows.length) break;
    out.push(...decodeB64Rows(b64rows, 'off=' + off));
    if (b64rows.length < MCP_PAGE) break;
    if (maxRows && out.length >= maxRows) break;
  }
  return maxRows ? out.slice(0, maxRows) : out;
}

// inner SELECT สำหรับ MCP path — ต้อง mirror WHERE/ชื่อคอลัมน์ของ SQL_IMPORT/SQL_EXPORT (ด้านล่าง) ให้ตรงกัน
// (คนละ path จาก direct pg แต่ frontend ใช้ชื่อ field เดียวกันกับทั้งสองทาง) SQL ชุดนี้แชร์กับ build-snapshot.mjs
// ผ่าน odoo-queries.js ไฟล์เดียว แก้ตรงนั้นที่เดียวพอ ไม่ต้องแก้ทั้งสองไฟล์แล้วเสี่ยงลืมอีกฝั่ง
const { IMPORT_INNER: MCP_IMPORT_INNER, EXPORT_INNER: MCP_EXPORT_INNER, ORDER_COLS: MCP_ORDER_COLS } = require('./odoo-queries.js');

async function mcpFetch(key) {
  // เปิด session ใหม่ทุกครั้ง (ไม่แชร์กับคำขออื่น) — ดู comment ที่ mcpHeaders ด้านบน
  const sid = await mcpConnect();
  const inner = key === 'import' ? MCP_IMPORT_INNER : MCP_EXPORT_INNER;
  const cap = key === 'import' ? 2000 : 500; // ตรงกับ LIMIT ของ SQL_IMPORT/SQL_EXPORT
  return await mcpPull(sid, inner, MCP_ORDER_COLS, cap);
}

// ดึงข้อมูลสด ถ้าล้มเหลว → ลองผ่าน MCP bridge ก่อน → ถ้ายังไม่ได้ เสิร์ฟ snapshot ล่าสุด
// (พร้อม flag stale + เวลาที่ดึง) force=true → ข้าม circuit breaker + throttle ของ MCP (ใช้ตอนกด Sync)
async function liveOrSnapshot(key, sql, force) {
  // cachedQuery จัดการ circuit breaker + retry ให้แล้ว — ที่นี่แค่เพิ่มชั้น MCP bridge และ disk snapshot
  try {
    const rows = await cachedQuery(key, sql, force);
    snapshot[key] = rows;
    snapshot._ts[key] = new Date().toISOString();
    saveSnapshot();
    return { rows, stale: false, as_of: snapshot._ts[key], via: 'direct' };
  } catch (e) {
    if (MCP_URL && MCP_TOKEN && (key === 'import' || key === 'export') && (force || Date.now() >= mcpNextTry[key])) {
      mcpNextTry[key] = Date.now() + MCP_RETRY_INTERVAL;
      try {
        const rows = await mcpFetch(key);
        // เดิมเช็ค rows.length ก่อนเชื่อผล — ถ้า Odoo ไม่มี PO/SO ตรงเงื่อนไขจริงๆ (ผลลัพธ์ว่างที่ถูกต้อง)
        // จะโดนมองว่า "MCP ก็ล้มเหลว" แล้วดันไปเสิร์ฟ snapshot เก่าแทนความจริงที่ว่างเปล่า — เชื่อผลลัพธ์เสมอ
        // เมื่อ mcpFetch ไม่ throw (แปลว่า query ผ่านจริง) ไม่ว่าจะได้กี่แถว
        snapshot[key] = rows;
        snapshot._ts[key] = new Date().toISOString();
        saveSnapshot();
        console.log('[MCP] ดึง ' + key + ' ผ่าน bridge สำเร็จ —', rows.length, 'แถว (direct หลุด:', e.message + ')');
        return { rows, stale: false, as_of: snapshot._ts[key], via: 'mcp' };
      } catch (mcpErr) {
        console.error('[MCP] fallback ล้มเหลว:', mcpErr.message);
      }
    }
    if (snapshot[key]) {
      // ไม่ได้ fetch สดในรอบนี้ (โดน throttle กันยิง MCP ถี่) ไม่ได้แปลว่าข้อมูล "เก่า" จริง —
      // ถ้า snapshot เพิ่งอัปเดตไม่นานมานี้ (เช่น MCP เพิ่งดึงสำเร็จเมื่อกี้) ให้ยังถือว่าสดอยู่
      // กันหน้าเว็บขึ้นแดง/ส้มเข้าใจผิดว่าหลุดทั้งที่ข้อมูลจริงยังใหม่มาก
      const asOf = snapshot._ts[key] || null;
      const age  = asOf ? Date.now() - new Date(asOf).getTime() : Infinity;
      return { rows: snapshot[key], stale: age > SNAPSHOT_FRESH_WINDOW, as_of: asOf, reason: e.message, via: 'snapshot' };
    }
    throw e;
  }
}

// ─── Postgres connection (read-only user, ค่าจาก .env) ───────────
// TLS: ถ้าตั้ง DB_SSL_CA (path ไปยัง AWS RDS CA bundle) จะ verify cert เต็มรูปแบบ (rejectUnauthorized:true)
// กัน MITM ต่อการเชื่อม RDS — แนะนำให้ตั้งใน production ดาวน์โหลด CA ได้จาก
// https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
// ถ้าไม่ได้ตั้ง จะ fallback เป็นเข้ารหัสแต่ไม่ verify (เดิม) เพื่อไม่ให้ deploy ที่ยังไม่มี CA พังทันที
function buildDbSsl() {
  const caPath = process.env.DB_SSL_CA;
  if (caPath) {
    try { return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true }; }
    catch (e) { console.error('[DB] อ่าน DB_SSL_CA ไม่ได้ (' + e.message + ') — fallback ไม่ verify cert'); }
  } else {
    console.warn('[DB] ⚠️  ไม่ได้ตั้ง DB_SSL_CA — เชื่อม RDS แบบเข้ารหัสแต่ไม่ verify cert (เสี่ยง MITM); ตั้งค่าใน production');
  }
  return { rejectUnauthorized: false };
}
const db = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  ssl:      buildDbSsl(),
  max:      5,
  idleTimeoutMillis: 30000,
  // ไม่ตั้งไว้แต่เดิม ทำให้ query ค้างรอไม่จำกัดเวลาเมื่อเครือข่ายไป RDS มีปัญหา
  // (หน้าเว็บเลย "กำลังโหลด…" ค้างตลอดโดยไม่มี error ให้เห็น) — บังคับ fail ไว ให้ retry ไว
  connectionTimeoutMillis: 6000,
  statement_timeout: 15000,
  query_timeout: 15000,
});

db.on('error', (err) => console.error('[DB] Unexpected error:', err.message));

// ─── รอบตรวจสอบข้อมูลอัตโนมัติ (data integrity check) ──────────────────────────
// ต่อยอดจากการตรวจสอบครั้งเดียวที่เจอบั๊ก currency_rate หายไปเงียบๆ 8 จุด (13-14 ก.ค. 2569)
// แทนที่จะรอให้คนสังเกตตัวเลขผิดปกติเอง ให้ตรวจรูปแบบบั๊กเดิมซ้ำอัตโนมัติเป็นประจำ — เช็คตรงจุดกำเนิดบั๊ก
// (currency ต่างประเทศแต่ rate เพี้ยนเป็น 1 พอดี = สัญญาณเดียวกับที่พบทุกครั้งที่ผ่านมา) ไม่ต้องรอ AI มาตรวจมือใหม่
let integrityReport = { ranAt: null, findings: [], importChecked: 0, exportChecked: 0 };
const INTEGRITY_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // ทุก 24 ชม. (ข้อมูลการเงินไม่ต้องเช็คถี่เท่า connectivity)

// เจอ currency ต่างประเทศที่ rate หายไป (parse ไม่ได้/0) หรือ rate ดันเป็น 1 พอดี (ค่า default ตอน rate>0
// เป็นเท็จ) — นี่คือรอยเดียวกับบั๊ก currency_rate ที่เจอจริงในระบบนี้มาแล้วหลายจุด ไม่ใช่การเดา
function checkCurrencyRateSanity(rows, board, poKey) {
  const findings = [];
  for (const r of (rows || [])) {
    const cur = r.currency;
    if (!cur || cur === 'THB') continue;
    const rate = parseFloat(r.currency_rate);
    if (!(rate > 0) || Math.abs(rate - 1) < 1e-9) {
      findings.push({
        board, po: r[poKey] || '?', currency: cur,
        message: `${r[poKey] || '?'} (${cur}) — currency_rate หายไปหรือเพี้ยนเป็น 1 พอดี มูลค่าอาจถูกนับเป็นบาทตรงๆ โดยไม่แปลงหน่วย`,
      });
    }
  }
  return findings;
}

// รายการที่ "ซ่อมอัตโนมัติ" แล้ว — SQL ตั้งธง rate_auto_corrected=1 เมื่อค่าที่ Odoo เพี้ยนแต่ดึง rate จาก
// ใบวางบิลมาแทนได้ ต่างจาก finding (ปัญหาจริงที่ยังแก้ไม่ได้) — ตัวนี้แอปแสดงเลขถูกแล้ว แต่ Odoo ต้นทางยัง
// ต้องตามไปแก้ ถึงโชว์ไว้เป็น "ข้อมูล" ไม่ใช่ error เพื่อไม่ให้การซ่อมอัตโนมัติบดบังปัญหาต้นทางไปเงียบๆ
function collectAutoCorrected(rows, board, poKey) {
  const out = [];
  for (const r of (rows || [])) {
    if (Number(r.rate_auto_corrected) === 1) {
      out.push({
        board, po: r[poKey] || '?', currency: r.currency || '?',
        message: `${r[poKey] || '?'} (${r.currency || '?'}) — Odoo ยังตั้ง currency_rate เพี้ยน แอปดึงอัตราจากใบวางบิลมาแสดงแทนให้แล้ว ควรตามไปแก้ที่ Odoo`,
      });
    }
  }
  return out;
}

// ─── แจ้งเตือนทางอีเมลเฉพาะ finding ที่ "ใหม่" ────────────────────────────────
// เก็บ key ของ finding ที่เคยแจ้งไปแล้วไว้ในไฟล์ (กันแจ้งซ้ำทุก 24 ชม.ถ้ายังไม่ได้แก้ที่ Odoo)
// ถ้า finding เดิมหายไปแล้วกลับมาใหม่ (แก้แล้วแต่พังซ้ำ) จะนับเป็น "ใหม่" อีกครั้ง ตั้งใจให้เป็นแบบนั้น
const findingKey = f => `${f.board}|${f.po}|${f.currency}`;
let integritySeenKeys = new Set();
try {
  const raw = JSON.parse(fs.readFileSync(INTEGRITY_SEEN_FILE, 'utf8'));
  if (Array.isArray(raw)) integritySeenKeys = new Set(raw);
} catch (e) { /* ไม่มีไฟล์ตอน deploy ครั้งแรก — เริ่มจากว่างเปล่า */ }

function saveIntegritySeenKeys() {
  try { writeFileAtomic(INTEGRITY_SEEN_FILE, JSON.stringify([...integritySeenKeys])); }
  catch (e) { console.error('[Integrity] เซฟ integrity_seen.json ไม่สำเร็จ:', e.message); }
}

// อีเมลแจ้งเตือนย้ายไปอยู่ lib/mailer.cjs — รองรับ Microsoft Graph (บัญชี M365 องค์กรที่เปิด
// Security Defaults จะล็อกอิน SMTP ไม่ได้เลย) และ SMTP ธรรมดา เลือกอัตโนมัติตามที่ตั้งค่าไว้
const { sendMail: sendAlertMail, mailMode } = require('./lib/mailer.cjs');

async function sendIntegrityAlertEmail(newFindings, label) {
  const to = process.env.ALERT_EMAIL_TO;
  const lines = newFindings.map(f => `- ${f.message}`).join('\n');
  const sent = await sendAlertMail({
    to,
    subject: `[Logistics Tracking] พบข้อมูลผิดปกติใหม่ ${newFindings.length} จุด`,
    text: `ระบบตรวจสอบข้อมูลอัตโนมัติ (${label}) พบรายการใหม่ที่น่าสงสัย:\n\n${lines}\n\nดูรายละเอียดที่ Dashboard: http://localhost:3000/`,
  });
  if (!sent) { console.log('[Integrity] ยังไม่ได้ตั้งค่าอีเมล (ดู .env.example หัวข้ออีเมลแจ้งเตือน) — ข้ามการแจ้งเตือน'); return; }
  console.log('[Integrity] ส่งอีเมลแจ้งเตือน', newFindings.length, 'จุดใหม่ ไปที่', to, `(${mailMode()})`);
}

// snapshot ว่างเปล่า (importChecked+exportChecked === 0) หน้าตาเหมือน "ตรวจแล้วไม่พบปัญหา" ทุกประการ
// (findings=[] ทั้งคู่) ทั้งที่จริงคือ "ไม่มีข้อมูลให้ตรวจเลย" — เช่น deploy ใหม่ หรือ Odoo direct + MCP bridge
// ล่มพร้อมกันตั้งแต่ก่อน warm() ครั้งแรกสำเร็จ ระบบเดิมไม่มีทางแยกสองเคสนี้ออกจากกัน แจ้งเตือนทันทีแยกต่างหาก
// จาก finding ปกติ (ไม่ต้องรอ weekly digest 7 วัน เพราะข้อมูลหายทั้งระบบเร่งด่วนกว่า currency rate ผิดจุดเดียว)
async function sendNoDataAlertEmail(label) {
  const to = process.env.ALERT_EMAIL_TO;
  const sent = await sendAlertMail({
    to,
    subject: '[Logistics Tracking] ⚠️ ไม่มีข้อมูลให้ตรวจสอบเลย (snapshot ว่างเปล่า)',
    text: `ระบบตรวจสอบข้อมูลอัตโนมัติ (${label}) พบว่า import/export snapshot ว่างเปล่าทั้งคู่ (0 รายการ) — แปลว่าดึงข้อมูลจาก Odoo ไม่สำเร็จเลยตั้งแต่ต้น (ทั้ง direct DB และ MCP bridge) ไม่ใช่ "ไม่พบปัญหา" ตามปกติ กรุณาตรวจสอบการเชื่อมต่อ Odoo/RDS โดยด่วน\n\nDashboard: http://localhost:3000/`,
  });
  if (!sent) { console.log('[Integrity] ยังไม่ได้ตั้งค่าอีเมล — ข้ามการแจ้งเตือน (snapshot ว่างเปล่า)'); return; }
  console.log('[Integrity] ส่งอีเมลแจ้งเตือน snapshot ว่างเปล่า ไปที่', to, `(${mailMode()})`);
}

// ─── สรุปรายสัปดาห์ (heartbeat) ──────────────────────────────────────────────
// ปัญหา: การแจ้งเตือน "เฉพาะของใหม่" แปลว่าถ้าอีเมลเงียบไป อาจหมายถึง "ทุกอย่างปกติ" หรือ "ระบบแจ้งเตือนพัง"
// ก็ได้ — แยกไม่ออก จึงส่งสรุปสถานะทุก 7 วันแม้ไม่มีปัญหา เพื่อยืนยันว่าระบบยังทำงานอยู่ (ถ้าไม่ได้สรุปตามรอบ
// = ระบบมีปัญหา) เก็บเวลาส่งครั้งล่าสุดลงไฟล์ ให้ทนต่อการ restart (ไม่ผูกกับ setInterval ที่รีเซ็ตทุกครั้ง)
const DIGEST_INTERVAL = 7 * 24 * 60 * 60 * 1000;
let lastDigestAt = 0;
try {
  const d = JSON.parse(fs.readFileSync(INTEGRITY_DIGEST_FILE, 'utf8'));
  if (d && typeof d.lastDigestAt === 'number') lastDigestAt = d.lastDigestAt;
} catch (e) { /* ยังไม่เคยส่ง */ }

async function maybeSendWeeklyDigest() {
  const now = Date.now();
  if (now - lastDigestAt < DIGEST_INTERVAL) return;
  const to = process.env.ALERT_EMAIL_TO;
  if (!mailMode() || !to) return; // ไม่ตั้งค่าอีเมล = ข้ามเงียบๆ (เหมือน alert)
  const ir = integrityReport;
  const fCount = (ir.findings || []).length, aCount = (ir.autoCorrected || []).length;
  const noData = (ir.importChecked || 0) + (ir.exportChecked || 0) === 0;
  // ต้องเช็ค noData ก่อน fCount — ไม่งั้น snapshot ว่างเปล่า (importChecked=exportChecked=0, findings=[]
  // เพราะไม่มีอะไรให้ตรวจ) จะโดนรายงานเป็น "ระบบทำงานปกติ" ทั้งที่จริงคือดึงข้อมูลจาก Odoo ไม่ได้เลย
  const statusLine = noData
    ? '⚠️ ไม่มีข้อมูลให้ตรวจเลย (snapshot ว่างเปล่า) — ดึงข้อมูลจาก Odoo ไม่สำเร็จ ไม่ใช่ "ปกติ"'
    : fCount
    ? `⚠️ ยังพบปัญหาค้างอยู่ ${fCount} จุด (ต้องแก้)`
    : 'ระบบทำงานปกติ — ไม่พบปัญหาที่ต้องแก้';
  const detail = [
    ...(fCount ? ['ปัญหาที่ต้องแก้:', ...ir.findings.map(f => `  - ${f.message}`)] : []),
    ...(aCount ? ['', `ซ่อมอัตโนมัติ (แอปแสดงถูกแล้ว แต่ควรตามไปแก้ที่ Odoo) ${aCount} จุด:`, ...ir.autoCorrected.map(f => `  - ${f.message}`)] : []),
  ].join('\n');
  try {
    await sendAlertMail({
      to,
      subject: `[Logistics Tracking] สรุปสถานะข้อมูลรายสัปดาห์ — ${noData ? 'ไม่มีข้อมูล!' : fCount ? 'พบ ' + fCount + ' จุด' : 'ปกติ'}`,
      text: `สรุปการตรวจสอบข้อมูลอัตโนมัติประจำสัปดาห์\n\n${statusLine}\nตรวจล่าสุด: ${ir.ranAt || '-'} · เช็ค ${(ir.importChecked||0)+(ir.exportChecked||0)} รายการ\n\n${detail || '(ไม่มีรายการที่ต้องรายงาน)'}\n\nอีเมลนี้ส่งทุก 7 วันเพื่อยืนยันว่าระบบแจ้งเตือนยังทำงานอยู่ — ถ้าไม่ได้รับตามรอบ แปลว่าระบบอาจมีปัญหา\nDashboard: http://localhost:3000/`,
    });
    lastDigestAt = now;
    writeFileAtomic(INTEGRITY_DIGEST_FILE, JSON.stringify({ lastDigestAt }));
    console.log('[Integrity] ส่งสรุปรายสัปดาห์ไปที่', to);
  } catch (e) {
    console.error('[Integrity] ส่งสรุปรายสัปดาห์ไม่สำเร็จ:', e.message);
  }
}

// ใช้ snapshot ปัจจุบัน (ข้อมูลที่กำลังเสิร์ฟให้ผู้ใช้จริงอยู่แล้ว) ไม่ยิง query ใหม่ — กันเพิ่มโหลดฐานข้อมูล/
// เสี่ยง trip circuit breaker โดยไม่จำเป็น เช็คแค่สิ่งที่ผู้ใช้เห็นอยู่ตอนนี้ว่าเชื่อถือได้ไหม
let integrityNoDataAlerted = false; // กันส่งอีเมลซ้ำทุกรอบถ้ายังว่างเปล่าต่อเนื่อง (reset เมื่อกลับมามีข้อมูล)
async function runIntegrityCheck(label) {
  const findings = [
    ...checkCurrencyRateSanity(snapshot.import, 'import', 'po_number'),
    ...checkCurrencyRateSanity(snapshot.export, 'export', 'so_number'),
  ];
  const autoCorrected = [
    ...collectAutoCorrected(snapshot.import, 'import', 'po_number'),
    ...collectAutoCorrected(snapshot.export, 'export', 'so_number'),
  ];
  const importChecked = (snapshot.import || []).length;
  const exportChecked = (snapshot.export || []).length;
  integrityReport = { ranAt: new Date().toISOString(), findings, autoCorrected, importChecked, exportChecked };
  const acNote = autoCorrected.length ? ' · ซ่อมอัตโนมัติ ' + autoCorrected.length + ' จุด' : '';
  // snapshot ว่างเปล่าทั้งคู่ = ไม่มีข้อมูลให้ตรวจเลย ไม่ใช่ "ตรวจแล้วสะอาด" (ดู comment ที่ sendNoDataAlertEmail)
  const noData = importChecked === 0 && exportChecked === 0;
  if (findings.length) console.error('[Integrity:' + label + '] พบความผิดปกติ', findings.length, 'จุด' + acNote);
  else if (noData) console.error('[Integrity:' + label + '] snapshot ว่างเปล่า (0 รายการ) — ไม่มีข้อมูลให้ตรวจ ไม่ใช่ผลลัพธ์สะอาด');
  else console.log('[Integrity:' + label + '] ตรวจ', importChecked + exportChecked, 'รายการ — ไม่พบความผิดปกติ' + acNote);

  const newFindings = findings.filter(f => !integritySeenKeys.has(findingKey(f)));
  integritySeenKeys = new Set(findings.map(findingKey));
  saveIntegritySeenKeys();
  if (newFindings.length) {
    sendIntegrityAlertEmail(newFindings, label).catch(e => console.error('[Integrity] ส่งอีเมลแจ้งเตือนไม่สำเร็จ:', e.message));
  }
  if (noData) {
    if (!integrityNoDataAlerted) {
      integrityNoDataAlerted = true;
      sendNoDataAlertEmail(label).catch(e => console.error('[Integrity] ส่งอีเมลแจ้งเตือน snapshot ว่างเปล่าไม่สำเร็จ:', e.message));
    }
  } else {
    integrityNoDataAlerted = false;
  }
  return integrityReport;
}

// ─── SQL Queries ─────────────────────────────────────────────────
// ─── Import PO query: Oversea only (country ≠ TH) ──────────────────────────
// รวมเฉพาะ vendor ต่างประเทศ (Oversea, PK, FG)
// ไม่รวม Domestic (country = TH / currency = THB)
// currency_rate self-heal (ดึง rate จากใบวางบิลจริงแทนตอนที่ po/so.currency_rate เพี้ยน) เดิมทำเป็น
// correlated subquery ตรงใน SELECT list ของแถวหลัก — ทำงานถูกแค่ตอน trigger เงื่อนไขน้อย/ไม่ trigger เลย
// (import เจอ 1/317, export ควรเจอ 0/105) แต่กลับพัง query ทั้งตัว: **แค่การมี correlated subquery อยู่ใน
// SELECT list ก็ทำให้ query planner ทิ้ง Memoize-based nested loop ที่มีประสิทธิภาพ (cache hit ~100%) ไปเลือก
// plan ที่ cost ประมาณ 500 พันล้าน** (ยืนยันด้วย EXPLAIN จริง) ไม่ว่า subquery จะได้ execute จริงกี่ครั้งก็ตาม
// — เป็นข้อจำกัดของ Postgres planner ไม่ใช่แค่เรื่อง "รันน้อยแปลว่าเร็ว" แก้โดยแยกงานซ่อม rate ออกเป็น CTE
// ต่างหาก (fixed_rates) ที่ join กับ base หลัง base ถูก query เสร็จแล้ว — base scan ยังใช้ plan เดิมที่เร็วอยู่
// ส่วน fixed_rates สแกน account_move (4 ล้านแถว ไม่มี index บน invoice_origin) แค่ "ครั้งเดียว" ไม่ว่าจะมี
// แถวเพี้ยนกี่แถว (ต่างจาก correlated subquery ที่สแกนซ้ำต่อแถว) วัดจริงผ่าน MCP: 2.2-4s ทุกครั้ง (จากเดิม timeout)
const SQL_IMPORT = `
  WITH base AS (
    SELECT
      po.id,
      po.name                   AS po_number,
      po.company_id,
      rc.name                   AS company_name,
      CASE po.company_id WHEN 1 THEN 'KOB' WHEN 2 THEN 'BTV' ELSE 'OTHER' END AS company_code,
      rp.id                     AS partner_id,
      rp.name                   AS supplier,
      po.state                  AS odoo_state,
      po.date_order,
      po.date_planned,
      po.amount_total,
      cu.name                   AS currency,
      po.currency_rate          AS raw_rate,
      po.receipt_status,
      po.origin,
      po.notes,
      'oversea'::text           AS source_type,
      cat.top_cat               AS goods_category,
      -- วันที่รับของเข้าคลังครั้งล่าสุดที่ "ทำเสร็จแล้วจริง" ของ PO นี้
      -- จำเป็นเพราะ receipt_status เป็นค่ารวมระดับ PO (pending/partial/full) ซึ่งบอกไม่ได้ว่า
      -- ชิปเม้นงวดไหนเข้าคลังแล้ว — PO ที่แบ่งส่งหลายงวดจะค้าง 'partial' จนกว่างวดสุดท้ายจะมา
      -- ทำให้งวดที่เข้าคลังไปตั้งแต่เดือนก่อนยังโชว์ว่าอยู่ระหว่างพิธีการ (AOF เจอเองกับ KOBPO2604-08431)
      rcpt.last_receipt::text   AS last_receipt_date
    FROM  purchase_order po
    JOIN  res_company    rc  ON rc.id  = po.company_id
    JOIN  res_partner    rp  ON rp.id  = po.partner_id
    JOIN  res_currency   cu  ON cu.id  = po.currency_id
    LEFT JOIN res_country rco ON rco.id = rp.country_id
    -- Dominant product-category (by line value) drives PK / FG / Oversea classification
    LEFT JOIN LATERAL (
      SELECT split_part(pc.complete_name, ' / ', 1) AS top_cat
      FROM purchase_order_line pol
      JOIN product_product  pp ON pp.id = pol.product_id
      JOIN product_template pt ON pt.id = pp.product_tmpl_id
      JOIN product_category pc ON pc.id = pt.categ_id
      WHERE pol.order_id = po.id
      GROUP BY 1
      ORDER BY SUM(pol.price_subtotal) DESC NULLS LAST
      LIMIT 1
    ) cat ON true
    -- รวมทีเดียวแล้ว hash join — ห้ามใช้ LATERAL ที่อ้าง po.name ตรงๆ เพราะ stock_picking.origin
    -- ไม่มี index ทำให้สแกนทั้งตารางซ้ำต่อ PO (ลองแล้ว: direct timeout ทันที ต้องตกไป MCP)
    LEFT JOIN (
      SELECT sp.origin AS po_name, MAX(sp.date_done)::date AS last_receipt
      FROM stock_picking sp
      WHERE sp.state = 'done' AND sp.date_done IS NOT NULL
        AND sp.date_done >= NOW() - INTERVAL '2 years'
      GROUP BY sp.origin
    ) rcpt ON rcpt.po_name = po.name
    WHERE po.company_id IN (1, 2)
      AND po.state NOT IN ('cancel')
      AND po.date_order >= NOW() - INTERVAL '2 years'
      AND (
        rco.code IS NOT NULL AND rco.code != 'TH'
        OR (rco.code IS NULL AND cu.name NOT IN ('THB'))
      )
      -- Actual imported goods only — Packaging / Finished Goods / Raw Materials.
      -- Excludes Expense, KOL, POSM, Semi-Finished, CMN-EXP and category-less POs.
      AND cat.top_cat IN ('Packaging', 'Finished Goods', 'Raw Materials')
    ORDER BY po.date_order DESC
    LIMIT 2000
  ),
  -- ต้องกัน currency<>'THB' ก่อนเสมอ — PO ที่ผู้ขายต่างประเทศแต่ตกลงจ่ายเป็น THB (rate=1 ถูกต้องอยู่แล้ว
  -- ไม่ต้องแปลง) ไม่ควรถูกนับเป็น "เพี้ยน" (เจอจริงฝั่ง export 17/105 แถวเป็นแบบนี้ ก่อนแก้ 16 ก.ค. 2569)
  bad_names AS (
    SELECT po_number FROM base
    WHERE currency <> 'THB' AND (raw_rate IS NULL OR raw_rate <= 0 OR ABS(raw_rate - 1) < 1e-9)
  ),
  fixed_rates AS (
    SELECT DISTINCT ON (am.invoice_origin) am.invoice_origin, am.invoice_currency_rate
    FROM account_move am
    WHERE am.invoice_origin IN (SELECT po_number FROM bad_names)
      AND am.state = 'posted' AND am.invoice_currency_rate IS NOT NULL
    ORDER BY am.invoice_origin, am.invoice_date DESC
  )
  SELECT
    base.id, base.po_number, base.company_id, base.company_name, base.company_code,
    base.partner_id, base.supplier, base.odoo_state, base.date_order, base.date_planned, base.amount_total,
    base.currency,
    COALESCE(fixed_rates.invoice_currency_rate, base.raw_rate) AS currency_rate,
    -- ธงบอกว่าแถวนี้ "ซ่อมอัตโนมัติ" (ค่าที่ Odoo เพี้ยน แต่ดึง rate จากใบวางบิลมาแทนได้) — โชว์เป็นข้อมูล
    -- ไม่ใช่ปัญหา เพื่อไม่ให้บดบังความจริงว่า Odoo ต้นทางยังต้องแก้ (ดู runIntegrityCheck)
    CASE WHEN fixed_rates.invoice_currency_rate IS NOT NULL THEN 1 ELSE 0 END AS rate_auto_corrected,
    base.receipt_status, base.origin, base.notes, base.source_type, base.goods_category,
    base.last_receipt_date
  FROM base
  LEFT JOIN fixed_rates ON fixed_rates.invoice_origin = base.po_number
  ORDER BY base.date_order DESC
`;

const SQL_EXPORT = `
  WITH base AS (
    SELECT
      so.id,
      so.name                   AS so_number,
      so.company_id,
      rc.name                   AS company_name,
      CASE so.company_id WHEN 1 THEN 'KOB' WHEN 2 THEN 'BTV' ELSE 'OTHER' END AS company_code,
      rp.id                     AS partner_id,
      rp.name                   AS customer,
      so.state                  AS odoo_state,
      so.date_order,
      so.amount_total,
      cu.name                   AS currency,
      so.currency_rate          AS raw_rate,
      so.delivery_status,
      so.invoice_status,
      so.origin,
      rco.code                  AS country_code,
      'oversea'::text           AS source_type
    FROM  sale_order    so
    JOIN  res_company   rc  ON rc.id  = so.company_id
    JOIN  res_partner   rp  ON rp.id  = so.partner_id
    JOIN  res_currency  cu  ON cu.id  = so.currency_id
    LEFT JOIN res_country rco ON rco.id = rp.country_id
    WHERE so.company_id IN (1, 2)
      AND so.state NOT IN ('cancel', 'draft')
      AND so.date_order >= NOW() - INTERVAL '2 years'
      AND (
        rco.code IS NOT NULL AND rco.code != 'TH'
        OR (rco.code IS NULL AND cu.name NOT IN ('THB'))
      )
    ORDER BY so.date_order DESC
    LIMIT 500
  ),
  bad_names AS (
    SELECT so_number FROM base
    WHERE currency <> 'THB' AND (raw_rate IS NULL OR raw_rate <= 0 OR ABS(raw_rate - 1) < 1e-9)
  ),
  fixed_rates AS (
    SELECT DISTINCT ON (am.invoice_origin) am.invoice_origin, am.invoice_currency_rate
    FROM account_move am
    WHERE am.invoice_origin IN (SELECT so_number FROM bad_names)
      AND am.state = 'posted' AND am.invoice_currency_rate IS NOT NULL
    ORDER BY am.invoice_origin, am.invoice_date DESC
  )
  SELECT
    base.id, base.so_number, base.company_id, base.company_name, base.company_code,
    base.partner_id, base.customer, base.odoo_state, base.date_order, base.amount_total,
    base.currency,
    COALESCE(fixed_rates.invoice_currency_rate, base.raw_rate) AS currency_rate,
    CASE WHEN fixed_rates.invoice_currency_rate IS NOT NULL THEN 1 ELSE 0 END AS rate_auto_corrected,
    base.delivery_status, base.invoice_status, base.origin, base.country_code, base.source_type
  FROM base
  LEFT JOIN fixed_rates ON fixed_rates.invoice_origin = base.so_number
  ORDER BY base.date_order DESC
`;

// ─── รายการสินค้าใน PO/SO — ดึงตามต้องการตอนเปิดดูรายละเอียด ไม่ query ทุก PO ล่วงหน้า ──────
// product_template.name/uom_uom.name เป็น jsonb หลายภาษา (เหมือน res_country.name) ต้องแกะ en_US/th_TH
// display_type IS NULL กันแถว section/note (หัวข้อย่อยไม่ใช่สินค้าจริง) หลุดเข้ามาปนสินค้าจริง
// SELECT ร่วมสำหรับรายการสินค้าใน PO/SO — ponameSql คือนิพจน์ SQL ที่แทนค่าเลข PO/SO
// ($1 สำหรับ direct pg แบบ parameterized, หรือ string literal ที่ escape แล้วสำหรับ MCP ที่ต้องฝัง SQL เป็น text)
// รวมเป็นจุดเดียวเพื่อไม่ให้ direct กับ MCP fallback มีข้อมูลไม่ตรงกันถ้าแก้ query ฝั่งเดียวแล้วลืมอีกฝั่ง
function poLineSelectBody(board, ponameSql) {
  return board === 'export' ? `
    SELECT sol.id, sol.sequence,
      COALESCE(pt.name->>'en_US', pt.name->>'th_TH', sol.name) AS product_name,
      pt.default_code AS sku, sol.product_uom_qty AS qty,
      COALESCE(uom.name->>'en_US', uom.name->>'th_TH') AS uom,
      sol.price_unit, sol.price_subtotal, sol.price_total,
      sol.qty_delivered AS qty_fulfilled, sol.qty_invoiced
    FROM sale_order_line sol
    JOIN sale_order so ON so.id = sol.order_id
    LEFT JOIN product_product pp ON pp.id = sol.product_id
    LEFT JOIN product_template pt ON pt.id = pp.product_tmpl_id
    LEFT JOIN uom_uom uom ON uom.id = sol.product_uom
    WHERE so.name = ${ponameSql} AND sol.display_type IS NULL` : `
    SELECT pol.id, pol.sequence,
      COALESCE(pt.name->>'en_US', pt.name->>'th_TH', pol.name) AS product_name,
      pt.default_code AS sku, pol.product_qty AS qty,
      COALESCE(uom.name->>'en_US', uom.name->>'th_TH') AS uom,
      pol.price_unit, pol.price_subtotal, pol.price_total,
      -- qty_received มีให้ตรงบน purchase_order_line อยู่แล้ว (ไม่ต้อง join stock_move) — ใช้ติดตามรับสินค้า
      -- บางส่วน (partial receipt) ต่อ SKU ให้ manager เห็นว่า PO ไหนรับของไม่ครบยัง
      pol.qty_received AS qty_fulfilled, pol.qty_invoiced
    FROM purchase_order_line pol
    JOIN purchase_order po ON po.id = pol.order_id
    LEFT JOIN product_product pp ON pp.id = pol.product_id
    LEFT JOIN product_template pt ON pt.id = pp.product_tmpl_id
    LEFT JOIN uom_uom uom ON uom.id = pol.product_uom
    WHERE po.name = ${ponameSql} AND pol.display_type IS NULL`;
}
function poLineOrderBy(board) { return board === 'export' ? 'sol.sequence, sol.id' : 'pol.sequence, pol.id'; }
function poLineSqlDirect(board) {
  return poLineSelectBody(board, '$1') + '\n    ORDER BY ' + poLineOrderBy(board);
}
// path MCP ส่ง SQL เป็น text ตรงๆ (ไม่มี placeholder แบบ pg) จึง escape เลข PO เองก่อนฝังในสตริง
// รายการสินค้าต่อ PO มีไม่กี่บรรทัด (ไม่ต้อง paginate) แต่ยังเข้ารหัส base64 กันชื่อสินค้ายาวเกิน 58 ตัวโดนตัด
async function mcpFetchPoLines(board, poNumber) {
  const esc = poNumber.replace(/'/g, "''");
  const inner = poLineSelectBody(board, `'${esc}'`);
  const sql = `
    SELECT ${Array.from({ length: MCP_NCOLS }, (_, i) => `substring(b,${i * MCP_CHUNK + 1},${MCP_CHUNK}) AS c${i}`).join(', ')}
    FROM (
      SELECT translate(encode(convert_to(row_to_json(r)::text,'UTF8'),'base64'), E'\\n','') AS b, r.sequence AS _seq, r.id AS _id
      FROM ( ${inner} ) r
    ) x
    ORDER BY _seq ASC NULLS LAST, _id ASC`;
  const sid = await mcpConnect();
  const text = await mcpRunSql(sid, sql);
  return decodeB64Rows(mcpParseTable(text), 'po-lines');
}
// cache รายการสินค้าต่อ PO — จำกัดจำนวน entry กันโตไม่มีเพดานถ้า process รันยาวและมีคนเปิดดูหลาย PO เรื่อยๆ
const poLineCache = { data: {}, ts: {} };
const PO_LINE_CACHE_TTL = 5 * 60 * 1000;
const PO_LINE_CACHE_MAX = 500;
function poLineCacheSet(key, rows) {
  poLineCache.data[key] = rows; poLineCache.ts[key] = Date.now();
  const keys = Object.keys(poLineCache.data);
  if (keys.length > PO_LINE_CACHE_MAX) {
    // ไม่มี insertion-order รับประกัน 100% ใน object เก่ามาก แต่ V8 คง insertion order ให้จริงในทางปฏิบัติ
    // เอาตัวเก่าสุดออกพอประมาณ — ไม่ต้องแม่นเป๊ะ แค่กันโตไม่มีที่สิ้นสุด
    for (const k of keys.slice(0, keys.length - PO_LINE_CACHE_MAX)) { delete poLineCache.data[k]; delete poLineCache.ts[k]; }
  }
}
function poLineCacheGet(key) {
  const ts = poLineCache.ts[key];
  if (ts == null) return undefined;
  if (Date.now() - ts >= PO_LINE_CACHE_TTL) { delete poLineCache.data[key]; delete poLineCache.ts[key]; return undefined; }
  return poLineCache.data[key];
}

// ─── In-memory cache (5 min TTL) ─────────────────────────────────
const cache = { data: {}, ts: {} };
const CACHE_TTL = 5 * 60 * 1000;

// mcp = { orderCols, maxRows, ncols } → เปิดทาง fallback ผ่าน MCP bridge เมื่อ direct pg ใช้ไม่ได้
// (ดู comment ที่ mcpWrap/mcpPull) endpoint ที่ไม่ส่ง mcp มาจะทำงานเหมือนเดิมทุกอย่าง
// ที่มา: บนเครื่องนี้ direct RDS (5432) หลุดถาวรเพราะ IP เป็น dynamic ไม่อยู่ใน security-group allowlist
// (ยืนยันจาก server.log: AutoProbe ล้มทุกรอบ แต่ MCP bridge สำเร็จทุกรอบ) — endpoint ที่มีแต่ทาง direct
// จึงตอบ 500 ตลอดเวลา: /api/vendors, /api/vendor-scorecard, /api/gl-reconciliation, /api/fx-rates
// ผลคือ Dashboard มี 2 panel ว่างเปล่าเงียบๆ, autocomplete forwarder ไม่มีรายชื่อ และอัตราแลกเปลี่ยน
// ตกไปใช้ค่าเดาที่ฮาร์ดโค้ดไว้ในหน้าเว็บ (rateGuess) โดยไม่มีอะไรบอกผู้ใช้ว่าไม่ใช่อัตราจริงจาก Odoo
async function cachedQuery(key, sql, force, mcp) {
  const now = Date.now();
  // force=true ต้องข้าม cache 5 นาทีด้วย ไม่ใช่แค่ circuit breaker — เดิมเช็ค cache ก่อนดู force เลย ทำให้
  // caller ที่ตั้งใจขอข้อมูลสด (AutoProbe force:true ทุก 2 นาที) มักได้ผลลัพธ์เก่าจาก cache ซ้ำ แต่ยัง stamp
  // snapshot._ts เป็นเวลาปัจจุบัน ทำให้ as_of โกหกว่าข้อมูลสดกว่าความเป็นจริงได้ถึง ~5 นาที
  if (!force && cache.data[key] && (now - cache.ts[key]) < CACHE_TTL) {
    return cache.data[key];
  }
  // ดึงผ่าน MCP bridge (คนละ path จาก direct — port 443 ไม่ติดปัญหา IP allowlist) แล้ว cache แบบเดียวกัน
  // คืน null = ไม่มีทางนี้ให้ใช้ (endpoint ไม่รองรับ / ไม่ได้ตั้งค่า MCP / เพิ่งลองไปเมื่อกี้)
  const tryMcp = async (why) => {
    if (!mcp || !MCP_URL || !MCP_TOKEN) return null;
    if (!force && Date.now() < (mcpNextTry[key] || 0)) return null;
    mcpNextTry[key] = Date.now() + MCP_RETRY_INTERVAL;
    const sid  = await mcpConnect();
    const rows = await mcpPull(sid, sql, mcp.orderCols, mcp.maxRows, mcp.ncols || MCP_NCOLS);
    cache.data[key] = rows;
    cache.ts[key]   = Date.now();
    console.log('[MCP] ดึง ' + key + ' ผ่าน bridge สำเร็จ —', rows.length, 'แถว (' + why + ')');
    return rows;
  };
  // Circuit breaker — DB เพิ่งล่มและยังไม่หมด window: ไม่ลองซ้ำ (กันทุก endpoint
  // เสียเวลารอ connect timeout 6 วิ ต่อ request). มี cache เก่าก็คืนไปก่อน
  if (!force && dbLikelyDown()) {
    if (cache.data[key]) return cache.data[key];
    const viaMcp = await tryMcp('direct ปิดอยู่ที่ circuit breaker').catch(e => {
      console.error('[MCP] fallback ' + key + ' ล้มเหลว:', e.message); return null;
    });
    if (viaMcp) return viaMcp;
    const e = new Error('DB recently down (circuit open)'); e.fast = true; throw e;
  }
  // เครือข่ายไป RDS สะดุดเป็นระยะ — ลองซ้ำสั้นๆ ก่อนยอมแพ้
  // เพื่อไม่ให้ blip 1 ครั้งกลายเป็น "Odoo หลุด" ทั้งที่จริงๆ กดใหม่อีกครั้งก็ผ่าน
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await db.query(sql);
      markDbUp();
      cache.data[key] = result.rows;
      cache.ts[key]   = now;
      return result.rows;
    } catch (e) {
      lastErr = e;
      // SQL/schema error ไม่หายไปเพราะลองใหม่ — ลองซ้ำเฉพาะที่ดูเหมือนปัญหาการเชื่อมต่อ
      if (!isConnFailure(e)) break;
      if (attempt === 0) await new Promise(r => setTimeout(r, 800));
    }
  }
  // เปิด circuit ให้ request ถัดๆ ไป fail เร็ว — เฉพาะเมื่อเป็นปัญหาการเชื่อมต่อจริง (ดู isConnFailure)
  if (isConnFailure(lastErr)) markDbDown();
  const viaMcp = await tryMcp('direct หลุด: ' + lastErr.message).catch(e => {
    console.error('[MCP] fallback ' + key + ' ล้มเหลว:', e.message); return null;
  });
  if (viaMcp) return viaMcp;
  throw lastErr;
}

// ─── MIME types ──────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css',
  '.js'  : 'application/javascript',
  '.json': 'application/json',
  '.png' : 'image/png',
  '.ico' : 'image/x-icon',
  '.svg' : 'image/svg+xml',
};

// ─── security headers พื้นฐาน (ใส่ทุก response) ───────────────────
// กัน MIME sniffing, clickjacking และจำกัดการรั่วของ referrer — ราคาถูกและไม่กระทบ same-origin app
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin',
};

// ─── rate limiter แบบง่าย (in-memory, per-IP fixed window) ─────────
// ใช้กับ endpoint ที่แพง (freight-extract เรียก OpenAI · integrity สแกนทั้งไฟล์ข้อมูล) กันคนยิงรัวจนทรัพยากรหมด
// single-process นี้เสิร์ฟ production ทั้งระบบ ถ้าล้ม = ทุกคนใช้งานไม่ได้พร้อมกัน
const _rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = _rateBuckets.get(key);
  if (!b || now > b.reset) { _rateBuckets.set(key, { count: 1, reset: now + windowMs }); return true; }
  if (b.count >= max) return false;
  b.count++;
  return true;
}
// เก็บกวาด bucket หมดอายุเป็นระยะ กัน Map โตไม่จำกัด
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of _rateBuckets) if (now > b.reset) _rateBuckets.delete(k);
}, 5 * 60 * 1000).unref();

// ─── JSON response helper ─────────────────────────────────────────
// same-origin เท่านั้น — ไม่เปิด CORS ให้ origin อื่น
function jsonOk(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

// ต้องมี charset=utf-8 (ข้อความ error เป็นภาษาไทยทั้งหมด) + security headers ชุดเดียวกับ jsonOk —
// เดิม response ทาง error หลุดออกไปโดยไม่มี nosniff/X-Frame-Options ทั้งที่ทาง success มีครบ
function jsonErr(res, code, msg) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify({ error: msg }));
}

// สำหรับ error ที่มาจาก exception จริง (SQL/DB/network) — e.message อาจมีชื่อ table/column/host จริงติดมาด้วย
// log รายละเอียดเต็มไว้ฝั่ง server เท่านั้น ส่งข้อความทั่วไปให้ client แทน (endpoint validation error ที่เขียน
// ข้อความเองอยู่แล้ว เช่น jsonErr(res,400,'ค่า X ไม่ถูกต้อง') ไม่ใช่กรณีนี้ ยังใช้ jsonErr ตรงๆ ได้ตามเดิม)
function jsonErrEx(res, code, label, err) {
  console.error(`[API] ${label}:`, err.message);
  jsonErr(res, code, `เกิดข้อผิดพลาดในการประมวลผล (${label}) — ดูรายละเอียดที่ server log`);
}

// ─── อ่าน JSON body แบบจำกัดขนาด ─────────────────────────────────
// body ปกติของ endpoint พวกนี้เป็น record เดียวหรือ list สั้นๆ (ไม่กี่ KB) 10MB เผื่อเหลือเฟือแล้ว
// กัน request เดียวที่ body ใหญ่ผิดปกติ (ตั้งใจหรือ client bug ก็ได้) ไม่ให้ทำ memory exhaustion —
// server นี้เป็น single process เสิร์ฟ production ทั้งหมด ถ้าล้มคือทุกคนใช้งานไม่ได้พร้อมกัน
// คืนค่า null แปลว่า response ถูกส่งไปแล้ว (413/400) — caller แค่ return ทันที ไม่ต้องทำอะไรต่อ
const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024; // 10MB
function readJsonBody(req, res, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve) => {
    // เก็บเป็น Buffer แล้วต่อทีเดียวตอนจบ — ห้าม `body += chunk` เพราะการบวก Buffer เข้ากับ string จะ
    // toString('utf8') ต่อ chunk ทันที ถ้าขอบ chunk (TCP/64KB) ตกกลางตัวอักษร UTF-8 หลายไบต์ (ภาษาไทย
    // ทุกตัวเป็น 3 ไบต์) ตัวอักษรนั้นจะเสียกลายเป็น U+FFFD ทำให้ JSON.parse พังหรือหมายเหตุภาษาไทยเพี้ยน
    // ตอนบันทึก — เกิดกับ body ที่ยาว (upsert หลายรายการ/หมายเหตุยาว) เท่านั้น จึงไม่โผล่ในการทดสอบสั้นๆ
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    req.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        jsonErr(res, 413, `request body ใหญ่เกินกำหนด (จำกัด ${Math.floor(maxBytes / 1024 / 1024)}MB)`);
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { jsonErr(res, 400, e.message); finish(null); }
    });
    req.on('error', (e) => {
      jsonErr(res, 400, e.message);
      finish(null);
    });
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const reqUrl  = req.url.split('?')[0];
  const method  = req.method;

  // ── Basic Auth (เปิดใช้เมื่อตั้ง APP_PASSWORD ใน .env) ──
  // /api/alive ยกเว้น เพื่อให้ watchdog เช็คสถานะได้
  if (process.env.APP_PASSWORD && reqUrl !== '/api/alive') {
    let authed = false;
    const hdr = req.headers['authorization'] || '';
    if (hdr.startsWith('Basic ')) {
      try {
        const dec = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
        authed = safeEqual(dec.split(':').slice(1).join(':'), process.env.APP_PASSWORD);
      } catch(e) {}
    }
    if (!authed) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Logistics Tracking"', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ต้องใส่รหัสผ่าน'); return;
    }
  }

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(); return;
  }

  // ── API Routes ──
  if (reqUrl.startsWith('/api/')) {

    if (reqUrl === '/api/import-pos' && method === 'GET') {
      const force = new URL('http://x' + req.url).searchParams.get('force') === '1';
      try {
        const r = await liveOrSnapshot('import', SQL_IMPORT, force);
        jsonOk(res, { ok: true, count: r.rows.length, rows: r.rows, stale: r.stale, as_of: r.as_of });
      } catch (e) {
        jsonErrEx(res, 500, 'import-pos', e);
      }
      return;
    }

    if (reqUrl === '/api/export-sos' && method === 'GET') {
      const force = new URL('http://x' + req.url).searchParams.get('force') === '1';
      try {
        const r = await liveOrSnapshot('export', SQL_EXPORT, force);
        jsonOk(res, { ok: true, count: r.rows.length, rows: r.rows, stale: r.stale, as_of: r.as_of });
      } catch (e) {
        jsonErrEx(res, 500, 'export-sos', e);
      }
      return;
    }

    // ── รายการสินค้าใน PO/SO — เรียกตอนเปิดดูรายละเอียด ไม่ query ทุก PO ล่วงหน้า ──
    // GET /api/po-lines?po=<po_number>&board=import|export
    if (reqUrl === '/api/po-lines' && method === 'GET') {
      const params = new URL('http://x' + req.url).searchParams;
      const po     = (params.get('po') || '').trim();
      const board  = params.get('board') === 'export' ? 'export' : 'import';
      if (!po) { jsonErr(res, 400, 'ต้องระบุ po'); return; }
      // allowlist รูปแบบเลข PO/SO — กัน injection ฝั่ง MCP ที่ต้องฝัง SQL เป็น text ตรงๆ (ไม่มี placeholder)
      if (!/^[\w\-\s().#/]{1,60}$/.test(po)) { jsonErr(res, 400, 'รูปแบบเลข PO ไม่ถูกต้อง'); return; }
      const cacheKey = board + ':' + po;
      const cached = poLineCacheGet(cacheKey);
      if (cached) { jsonOk(res, { ok: true, rows: cached, source: 'cache' }); return; }
      let directErr = null;
      if (!dbLikelyDown()) {
        try {
          const r = await db.query(poLineSqlDirect(board), [po]);
          markDbUp();
          poLineCacheSet(cacheKey, r.rows);
          jsonOk(res, { ok: true, rows: r.rows, source: 'direct' });
          return;
        } catch (e) { directErr = e; if (isConnFailure(e)) markDbDown(); }
      }
      // direct ต่อไม่ได้ (หรือรู้อยู่แล้วว่าล่ม) — ลองผ่าน MCP bridge ก่อนยอมแพ้
      if (MCP_URL && MCP_TOKEN) {
        try {
          const rows = await mcpFetchPoLines(board, po);
          poLineCacheSet(cacheKey, rows);
          jsonOk(res, { ok: true, rows, source: 'mcp' });
          return;
        } catch (mcpErr) { console.error('[API] po-lines MCP fallback:', mcpErr.message); }
      }
      if (directErr) console.error('[API] po-lines direct:', directErr.message);
      jsonErr(res, 503, 'ดึงรายการสินค้าไม่ได้ในขณะนี้ (Odoo ต่อไม่ได้)');
      return;
    }

    if (reqUrl === '/api/vendors' && method === 'GET') {
      try {
        // เพดานเดิม 500 ตัดเงียบเหมือน logistics-bills — วัดจริง 2026-08-13: ผู้ขายที่เข้าเงื่อนไขมี 2,518 ราย
        // คืนได้ 500 (ชนเพดานเป๊ะ) หายไป 2,018 ราย = 80% · autocomplete ผู้ขาย/ตัวแทนขนส่งจึงหาไม่เจอ
        // เรียงตามจำนวน PO มาก→น้อย เจ้าที่ไม่เคยสั่งเลยจึงตกหายก่อน ซึ่งคือเจ้าที่คนพิมพ์หาบ่อยที่สุด
        const VENDOR_CAP = 3000;
        const vTotal = await cachedQuery('vendors_count', `
          SELECT COUNT(*)::int AS n FROM res_partner rp
          WHERE rp.supplier_rank > 0 AND rp.active = true AND rp.is_company = true
        `, false, { orderCols: 'r.n AS _ord, r.n AS _id', maxRows: 1 }).then(r => r[0]?.n ?? null).catch(() => null);
        const rows = await cachedQuery('vendors', `
          SELECT
            rp.id,
            rp.name::text                       AS name,
            CASE
              WHEN rco.name IS NULL THEN NULL
              WHEN (rco.name::text) LIKE '{%'
                THEN COALESCE(rco.name::json->>'en_US', rco.name::json->>'th_TH')
              ELSE rco.name::text
            END                                 AS country,
            rco.code                            AS country_code,
            COALESCE(v.po_count, 0)    AS po_count,
            v.last_currency
          FROM res_partner rp
          LEFT JOIN res_country rco ON rco.id = rp.country_id
          LEFT JOIN (
            SELECT
              partner_id,
              COUNT(*)                                               AS po_count,
              (array_agg(cu.name ORDER BY po.date_order DESC))[1]   AS last_currency
            FROM purchase_order po
            JOIN res_currency cu ON cu.id = po.currency_id
            WHERE po.company_id IN (1, 2)
              AND po.state NOT IN ('cancel')
              AND po.date_order >= NOW() - INTERVAL '2 years'
            GROUP BY partner_id
          ) v ON v.partner_id = rp.id
          WHERE rp.supplier_rank > 0
            AND rp.active = true
            AND rp.is_company = true
          ORDER BY COALESCE(v.po_count, 0) DESC, rp.name ASC
          LIMIT ${VENDOR_CAP}
        `, false, { orderCols: 'r.po_count AS _ord, r.id AS _id', maxRows: VENDOR_CAP });
        jsonOk(res, { ok: true, count: rows.length, total: vTotal, limit: VENDOR_CAP,
          truncated: vTotal == null ? rows.length >= VENDOR_CAP : rows.length < vTotal, rows });
      } catch (e) {
        jsonErrEx(res, 500, 'vendors', e);
      }
      return;
    }

    // ── Vendor scorecard: อัตราส่งตรงเวลา + ความล่าช้าเฉลี่ยต่อผู้ขาย (เฉพาะผู้ขายต่างประเทศที่แอปติดตามอยู่
    // — filter เดียวกับ SQL_IMPORT ไม่งั้นจะปนผู้ขายในประเทศที่ไม่เกี่ยวกับ shipment ต่างประเทศเข้ามาด้วย) ──
    // scheduled_date/date_done มีให้ตรงบน stock_picking อยู่แล้ว ไม่ต้องคำนวณเองจาก stock_move
    if (reqUrl === '/api/vendor-scorecard' && method === 'GET') {
      try {
        const rows = await cachedQuery('vendor-scorecard', `
          SELECT rp.id AS vendor_id, rp.name AS vendor, COUNT(*) AS deliveries,
            COUNT(*) FILTER (WHERE sp.date_done <= sp.scheduled_date) AS on_time,
            ROUND(AVG(EXTRACT(EPOCH FROM (sp.date_done - sp.scheduled_date))/86400)::numeric, 1) AS avg_delay_days
          FROM stock_picking sp
          JOIN purchase_order po ON po.name = sp.origin
          JOIN res_partner rp ON rp.id = po.partner_id
          LEFT JOIN res_country rco ON rco.id = rp.country_id
          JOIN res_currency cu ON cu.id = po.currency_id
          WHERE po.company_id IN (1, 2) AND sp.state = 'done'
            -- ตัด scheduled_date/date_done ที่เพี้ยนสุดขั้ว (เจอจริง: ปี 2299 — data-entry ผิดใน Odoo)
            -- ไม่งั้นค่าเฉลี่ยความล่าช้าจะพังทั้งวงเพราะ outlier เดียว
            AND sp.scheduled_date BETWEEN NOW() - INTERVAL '3 years' AND NOW() + INTERVAL '3 years'
            AND sp.date_done      BETWEEN NOW() - INTERVAL '3 years' AND NOW() + INTERVAL '3 years'
            AND po.date_order >= NOW() - INTERVAL '2 years'
            AND (rco.code IS NOT NULL AND rco.code != 'TH' OR (rco.code IS NULL AND cu.name NOT IN ('THB')))
            AND EXISTS (
              SELECT 1 FROM purchase_order_line pol
              JOIN product_product  pp ON pp.id = pol.product_id
              JOIN product_template pt ON pt.id = pp.product_tmpl_id
              JOIN product_category pc ON pc.id = pt.categ_id
              WHERE pol.order_id = po.id AND split_part(pc.complete_name,' / ',1) IN ('Packaging','Finished Goods','Raw Materials')
            )
          -- group ด้วย rp.id ด้วย ไม่ใช่แค่ชื่อ — res_partner มีชื่อซ้ำกันจริง (เจอ >20 คู่ตอนตรวจสอบ) ถ้า group
          -- แค่ชื่ออย่างเดียว ผู้ขายคนละรายที่บังเอิญชื่อซ้ำจะถูกนับรวมยอดส่งตรงเวลาเป็นก้อนเดียวผิดๆ
          GROUP BY rp.id, rp.name
          HAVING COUNT(*) >= 2
          ORDER BY deliveries DESC
          LIMIT 200
        `, false, { orderCols: 'r.deliveries AS _ord, r.vendor_id AS _id', maxRows: 200 });
        jsonOk(res, { ok: true, count: rows.length, rows });
      } catch (e) {
        jsonErrEx(res, 500, 'vendor-scorecard', e);
      }
      return;
    }

    // ── GL reconciliation: PO ที่ Odoo ระบุว่า "invoiced" แล้ว แต่ยอดบิลจริง (posted, สกุลเงินเดียวกับ PO
    // กันปัญหาเทียบข้ามสกุลเงินแบบที่เจอมาแล้วในเซสชันนี้) ต่างจาก po.amount_total เกิน 15% ──
    // ขอบเขตเดียวกับ SQL_IMPORT (ผู้ขายต่างประเทศ + หมวด Packaging/Finished/Raw เท่านั้น) กัน PO ประเภท
    // Expense (ค่าคอมมิชชั่น TikTok ฯลฯ) ที่ไม่เกี่ยวกับแอปนี้เลยปนเข้ามาเป็น noise (ตรวจสอบแล้วจริง)
    // แยก 2 กลุ่มเพราะ root cause น่าจะต่างกัน: billed=0 (บิลจริงมีแต่ยอด 0 ทั้งที่ Odoo ว่า invoiced แล้ว —
    // เจอ 64 เคส รูปแบบเดียวกันสม่ำเสมอ น่าจะเป็นเรื่องระบบ ไม่ใช่ error สุ่ม) กับ billed>0 แต่ยังต่างมาก
    // (น่าจะเป็นการแบ่งจ่ายบางส่วนที่ยังไม่ครบ ไม่ใช่ error เสมอไป) — โชว์แยกกันเพื่อไม่ให้เข้าใจผิดว่าทั้งหมด
    // เป็นบั๊กเดียวกัน ให้ทีมบัญชีไปตรวจสอบเองว่าเข้าเงื่อนไขไหนที่ผิดจริง
    if (reqUrl === '/api/gl-reconciliation' && method === 'GET') {
      try {
        const rows = await cachedQuery('gl-reconciliation', `
          SELECT po.id AS po_id, po.name AS po_number, po.amount_total AS po_total, cu.name AS currency,
            SUM(CASE WHEN am.move_type = 'in_refund' THEN -am.amount_total ELSE am.amount_total END) AS billed_total,
            ROUND((SUM(CASE WHEN am.move_type = 'in_refund' THEN -am.amount_total ELSE am.amount_total END) - po.amount_total) / NULLIF(po.amount_total,0) * 100, 1) AS diff_pct
          FROM purchase_order po
          JOIN res_partner rp ON rp.id = po.partner_id
          LEFT JOIN res_country rco ON rco.id = rp.country_id
          JOIN res_currency cu ON cu.id = po.currency_id
          -- company_id ต้องตรงกันด้วย (ไม่ใช่แค่ invoice_origin=po.name) — เผื่อไว้กัน PO number ชนกันข้ามบริษัท
          -- (ตรวจสอบจริงแล้วว่า KOB/BTV ไม่มี prefix ชนกัน แต่กันไว้เป็น safety net ไม่เสียอะไร)
          -- move_type รวม in_refund (ใบลดหนี้) ด้วย กลับเครื่องหมายลบ — เดิมนับแต่ in_invoice ทำให้ PO ที่มี
          -- ใบลดหนี้หักล้างยอดจริงไปแล้วดูเหมือนยังไม่ตรงทั้งที่จริงๆ ตรงแล้ว (หรือในทางกลับกัน มองข้ามไปเลย
          -- ถ้า invoice ถูกหักล้างเต็มจำนวนจนเหลือ 0 — พบจริง 2 เคสที่ไม่เคยถูกตรวจพบมาก่อนตอนทดสอบ)
          JOIN account_move am ON am.invoice_origin = po.name AND am.company_id = po.company_id
            AND am.state = 'posted' AND am.move_type IN ('in_invoice', 'in_refund')
          JOIN res_currency am2c ON am2c.id = am.currency_id AND am2c.id = po.currency_id
          WHERE po.company_id IN (1, 2) AND po.date_order >= NOW() - INTERVAL '2 years'
            AND po.invoice_status = 'invoiced'
            AND (rco.code IS NOT NULL AND rco.code != 'TH' OR (rco.code IS NULL AND cu.name NOT IN ('THB')))
            AND EXISTS (
              SELECT 1 FROM purchase_order_line pol
              JOIN product_product  pp ON pp.id = pol.product_id
              JOIN product_template pt ON pt.id = pp.product_tmpl_id
              JOIN product_category pc ON pc.id = pt.categ_id
              WHERE pol.order_id = po.id AND split_part(pc.complete_name,' / ',1) IN ('Packaging','Finished Goods','Raw Materials')
            )
          GROUP BY po.id, po.name, po.amount_total, cu.name
          HAVING ABS(SUM(CASE WHEN am.move_type = 'in_refund' THEN -am.amount_total ELSE am.amount_total END) - po.amount_total) / NULLIF(po.amount_total,0) > 0.15
          ORDER BY ABS((SUM(CASE WHEN am.move_type = 'in_refund' THEN -am.amount_total ELSE am.amount_total END) - po.amount_total) / NULLIF(po.amount_total,0)) DESC
          LIMIT 300
        `, false, { orderCols: 'r.po_id AS _id', maxRows: 300 });
        // ใช้ !==0 ไม่ใช่ >0 กัน billed_total ติดลบ (ใบลดหนี้เกินยอด invoice) หลุดจากทั้งสองกลุ่มไปเงียบๆ
        const zeroBilled = rows.filter(r => parseFloat(r.billed_total) === 0);
        const partialMismatch = rows.filter(r => parseFloat(r.billed_total) !== 0);
        jsonOk(res, { ok: true, zeroBilled, partialMismatch, count: rows.length });
      } catch (e) {
        jsonErrEx(res, 500, 'gl-reconciliation', e);
      }
      return;
    }

    // ── รายการค่าใช้จ่ายนำเข้า/ส่งออก ให้ผู้ใช้เลือกจับคู่กับ shipment ──
    // 2 แหล่ง: (1) Vendor Bills = จ่ายจริง  (2) Expense POs = สั่งซื้อบริการแล้ว รอบิล
    // PO ที่มีบิลอ้างถึงแล้วจะถูกตัดออก (บิล actual กว่า)
    // จำแนก 5 ประเภท: freight / clearance / insurance / duty / vat
    // GET /api/logistics-bills?company=KOB&months=8&q=dhl
    // ── ต้นทุนจริงจากบิล (Landed Cost service) ────────────────────────────────────────────
    // คืนต้นทุนราย "การ์ด" ไม่ใช่ราย PO — เพราะ PO เดียวแบ่งส่งหลายชิปเม้นได้ และแต่ละงวด
    // มีบิลของตัวเอง (คนละ forwarder คนละใบขน) การรวมเป็นก้อนเดียวจะทำให้ต้นทุนต่อชิปเม้นผิด
    if (reqUrl.startsWith('/api/landed-cost') && method === 'GET') {
      const params = new URL('http://x' + req.url).searchParams;
      try {
        if (reqUrl.startsWith('/api/landed-cost/lines')) {
          const folder = params.get('folder') || '';
          if (!folder) { jsonErr(res, 400, 'ต้องระบุ folder'); return; }
          const j = await landedFetch('/api/lines?folder=' + encodeURIComponent(folder));
          jsonOk(res, { ok: true, rows: (j && j.rows) || [] });
          return;
        }
        const j = await landedFetch(`/api/shipments?months=${LANDED_MONTHS}&company=`, 45000);
        const shipments = (j && j.shipments) || [];
        // ── index ตัวระบุชิปเม้น → โฟลเดอร์ จาก artifact ของตัวสแกน ────────────────────────
        // จำเป็นเมื่อ PO เดียวแบ่งหลายงวด: เลข PO ซ้ำกันทุกใบในตระกูล ใช้แยกโฟลเดอร์ไม่ได้
        // แต่เลข B/L-AWB ของแต่ละงวดไม่ซ้ำกัน และตัวสแกนบันทึกไว้แล้วว่าเจอในโฟลเดอร์ไหน
        // ทำฝั่ง server เพราะ artifact เป็นไฟล์ปฏิบัติการขนาดหลาย MB ไม่ควรส่งไปทั้งก้อน
        const NK = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const keysOf = new Map(); // leaf → { bl:Set, ves:Set }
        try {
          if (fs.existsSync(SHIPMENT_RUNS_FILE)) {
            for (const line of fs.readFileSync(SHIPMENT_RUNS_FILE, 'utf8').split('\n')) {
              if (!line) continue;
              let r; try { r = JSON.parse(line); } catch (e) { continue; }
              const leaf = leafName(r.folder); if (!leaf) continue;
              if (!keysOf.has(leaf)) keysOf.set(leaf, { bl: new Set(), ves: new Set() });
              const g = keysOf.get(leaf);
              const kb = NK(r.bl_awb); if (kb.length >= 6) g.bl.add(kb);
              const kv = NK(r.vessel) + NK(r.voyage); if (kv.length >= 4) g.ves.add(kv);
            }
          }
        } catch (e) { console.error('[API] landed-cost อ่าน artifact ไม่ได้:', e.message); }
        jsonOk(res, { ok: true, built_at: j.built_at || null, count: shipments.length,
          cat_label: j.cat_label || {}, shipments: shipments.map(s => {
            const leaf = leafName(s.folder), k = keysOf.get(leaf);
            return { folder: s.folder, leaf, product_pos: s.product_pos || [],
              total: s.total, byCat: s.byCat || {}, bills: s.bills || [], n_lines: s.n_lines,
              blKeys: k ? [...k.bl] : [], vesKeys: k ? [...k.ves] : [] };
          }) });
      } catch (e) {
        // service ไม่รัน/ตอบช้า = บอร์ดต้องยังใช้งานได้ แค่ไม่มีตัวเลขต้นทุนให้ดู
        console.error('[API] landed-cost ไม่พร้อม:', e.message);
        jsonOk(res, { ok: true, unavailable: true, reason: e.message, shipments: [] });
      }
      return;
    }

    if (reqUrl === '/api/logistics-bills' && method === 'GET') {
      const params = new URL('http://x' + req.url).searchParams;
      const co      = params.get('company') || '';
      // ต้อง clamp ขั้นต่ำ 1 ด้วย ไม่ใช่แค่เพดาน — months ติดลบ (เช่น ?months=-6) ผ่าน `|| 8` ไปได้เพราะ
      // -6 เป็นค่า truthy แล้วกลายเป็น INTERVAL '-6 months' ทำให้เงื่อนไข invoice_date >= อนาคต → คืนลิสต์ว่าง
      // เปล่าโดยไม่มี error ให้เห็น (ดูเหมือน "ไม่มีบิล" ทั้งที่จริงมี)
      const months  = Math.min(Math.max(parseInt(params.get('months')) || 8, 1), 24);
      // จำกัดความยาว + charset ของ q ก่อนนำไปใช้ — ฝั่ง MCP ต้องฝัง q เป็น SQL literal (escape ' เอง)
      // การ cap ความยาว + ตัดอักขระควบคุม/backslash เป็น defense-in-depth เพิ่มจาก escape (กันพึ่ง
      // standard_conforming_strings อย่างเดียว) และกัน ReDoS/query ยาวผิดปกติ
      const q       = (params.get('q') || '').trim().slice(0, 80).replace(/[\\\x00-\x1f]/g, '');
      // ── เพดานผลลัพธ์ ────────────────────────────────────────────────────────────────────
      // เดิมฮาร์ดโค้ด LIMIT 300 ทั้ง bill และ po แล้ว "ตัดเงียบ" — ผู้ใช้ไม่มีทางรู้ว่าเห็นไม่ครบ
      // วัดจริง 2026-08-13: ?months=24 คืน 370 แถว (300 bill + 70 po) ชนเพดานเป๊ะ · วันเก่าสุดที่ได้
      // คือ 2026-01-12 ทั้งที่ขอ 24 เดือน · ยอดรวมต่ำกว่าความจริง ~20% · bill picker จึงหาบิลเก่าไม่เจอเลย
      // แก้ตามหลัก "ห้ามตัดข้อมูลโดยไม่บอก" — คืน total จริงมาด้วยเสมอ + เปิด limit/offset ให้ดึงต่อได้
      const limit   = Math.min(Math.max(parseInt(params.get('limit')) || 300, 1), 2000);
      const offset  = Math.max(parseInt(params.get('offset')) || 0, 0);
      const coFilter   = co === 'KOB' ? 'AND am.company_id = 1'
                       : co === 'BTV' ? 'AND am.company_id = 2' : '';
      const coFilterPo = co === 'KOB' ? 'AND po.company_id = 1'
                       : co === 'BTV' ? 'AND po.company_id = 2' : '';
      // partner บริษัทขนส่ง/ศุลกากร/ชิปปิ้ง/ประกันภัย (SQL regex)
      const LOGI_PATTERN = 'dhl|kerry|pantos|yusen|sino.?trans|sitc|maersk|oocl|cma|evergreen|nippon|nyk|\\mups\\M|fedex|tnt|schenker|expeditors|ceva|dsv|geodis|panalpina|ขนส่ง|forwarder|freight|logistic|shipping|customs|ศุลกากร|broker|clearing|express|cargo|insurance|ประกันภัย|ชิปปิ้ง|marine|transport';
      // product category ของค่าใช้จ่ายนำเข้าใน Odoo (Expense / ... / Import Expenses)
      const IMPORT_CAT = '%Import Expens%';
      // เดิม endpoint นี้ยิง db.query ตรงอย่างเดียว + ตอบ 503 ทันทีเมื่อ circuit เปิด ไม่มี fallback เลย
      // ทำให้ bill picker ตายสนิทเมื่อ RDS ตรงต่อไม่ได้ (dynamic IP หลุดบ่อย) ทั้งที่ MCP bridge ยังต่อได้
      // แก้: เพิ่มชั้น MCP bridge fallback แบบเดียวกับ import/export หลัก (liveOrSnapshot) — ลอง direct ก่อน
      // ถ้า circuit เปิด/ล้มเหลว → ผ่าน MCP bridge (base64 wrap แบบ mcpPull) จะ 503 ก็ต่อเมื่อทั้งสองทางล่มจริง
      const args = [`%${q}%`];
      // direct pg: ใช้ $1 parameterized (ปลอดภัยจาก injection) — MCP: ฝัง literal ที่ escape ' แล้ว (MCP รับ SQL เป็น text)
      const billSearchDirect = q ? `AND (rp.name ILIKE $1 OR am.ref::text ILIKE $1 OR (am.invoice_origin)::text ILIKE $1 OR am.name::text ILIKE $1)` : '';
      const poSearchDirect   = q ? `AND (rp.name ILIKE $1 OR po.name ILIKE $1 OR po.origin ILIKE $1)` : '';
      const qLit = "'%" + q.replace(/'/g, "''") + "%'";
      const billSearchMcp = q ? `AND (rp.name ILIKE ${qLit} OR am.ref::text ILIKE ${qLit} OR (am.invoice_origin)::text ILIKE ${qLit} OR am.name::text ILIKE ${qLit})` : '';
      const poSearchMcp   = q ? `AND (rp.name ILIKE ${qLit} OR po.name ILIKE ${qLit} OR po.origin ILIKE ${qLit})` : '';

      // ตัว SQL body รับ search clause เป็นพารามิเตอร์ ใช้ร่วมกันทั้ง direct และ MCP (จุดเดียว ไม่ drift)
      // WHERE แยกออกมาเป็นชิ้นเดียว เพื่อให้ query นับจำนวนใช้เงื่อนไข "ชุดเดียวกันเป๊ะ" กับ query ดึงข้อมูล
      // (ถ้าเขียนแยกสองที่ วันหนึ่งจะ drift แล้วเลข "จาก N รายการ" จะโกหกโดยไม่มีใครรู้)
      const billWhere = (search) => `
        WHERE am.company_id IN (1,2)
          ${coFilter}
          -- รวม in_refund (ใบลดหนี้) ด้วย กลับเครื่องหมายลบตอนประมวลผล — เดิมนับแต่ in_invoice ทำให้ผู้ใช้
          -- เห็นแต่ยอดเต็มโดยไม่รู้ว่ามีใบลดหนี้หักล้างอยู่ (บั๊กรูปแบบเดียวกับที่เจอใน gl-reconciliation:
          -- ยืนยันแล้วว่ามี in_refund จริง 2 ใบในขอบเขตนี้ ณ วันที่ตรวจสอบ)
          AND am.move_type IN ('in_invoice', 'in_refund')
          AND am.state = 'posted'
          AND am.invoice_date >= NOW() - INTERVAL '${months} months'
          AND (
            rp.name ~* '${LOGI_PATTERN}'
            OR EXISTS (
              SELECT 1 FROM account_move_line aml2
              JOIN product_product  pp2 ON pp2.id = aml2.product_id
              JOIN product_template pt2 ON pt2.id = pp2.product_tmpl_id
              JOIN product_category pc2 ON pc2.id = pt2.categ_id
              WHERE aml2.move_id = am.id AND pc2.complete_name ILIKE '${IMPORT_CAT}'
            )
          )
          ${search}`;
      const poWhere = (search) => `
        WHERE po.company_id IN (1,2)
          ${coFilterPo}
          AND po.state NOT IN ('cancel')
          AND po.date_order >= NOW() - INTERVAL '${months} months'
          AND (
            rp.name ~* '${LOGI_PATTERN}'
            OR EXISTS (
              SELECT 1 FROM purchase_order_line pol2
              JOIN product_product  pp2 ON pp2.id = pol2.product_id
              JOIN product_template pt2 ON pt2.id = pp2.product_tmpl_id
              JOIN product_category pc2 ON pc2.id = pt2.categ_id
              WHERE pol2.order_id = po.id AND pc2.complete_name ILIKE '${IMPORT_CAT}'
            )
          )
          ${search}`;
      // นับทั้งหมดที่เข้าเงื่อนไข (ไม่มี LIMIT) — ใช้บอกผู้ใช้ว่ากำลังเห็นกี่จากกี่รายการ
      // ไม่ต้อง join LATERAL ที่ใช้เฉพาะตอนดึงข้อมูล (lines/main_product) เพราะ WHERE ไม่ได้อ้างถึง
      const billCountSql = (search) => `
        SELECT COUNT(*)::int AS n
        FROM account_move am
        JOIN res_currency cu ON cu.id = am.currency_id
        JOIN res_partner  rp ON rp.id = am.partner_id
        ${billWhere(search)}`;
      const poCountSql = (search) => `
        SELECT COUNT(*)::int AS n
        FROM purchase_order po
        JOIN res_partner  rp ON rp.id = po.partner_id
        JOIN res_currency cu ON cu.id = po.currency_id
        ${poWhere(search)}`;
      // (1) Vendor Bills: partner เข้า pattern หรือ line เป็นสินค้าหมวด Import Expenses
      const billSql = (search) => `
        SELECT
          am.id,
          am.move_type::text        AS move_type,
          am.name::text             AS bill_name,
          (am.invoice_origin)::text AS invoice_origin,
          am.ref::text,
          am.amount_total,
          am.amount_tax,
          cu.name::text             AS currency,
          COALESCE(NULLIF(am.inverse_currency_rate,0), 1.0/NULLIF(am.invoice_currency_rate,0)) AS rate_thb,
          rp.name::text             AS partner,
          am.invoice_date::text     AS doc_date,
          COALESCE(aml_s.lines_json, '[]'::json) AS lines
        FROM account_move am
        JOIN res_currency cu ON cu.id = am.currency_id
        JOIN res_partner  rp ON rp.id = am.partner_id
        LEFT JOIN LATERAL (
          SELECT json_agg(json_build_object('name', aml.name, 'amount', aml.price_subtotal)
            ORDER BY aml.price_subtotal DESC) AS lines_json
          FROM account_move_line aml
          WHERE aml.move_id = am.id AND aml.display_type = 'product'
        ) aml_s ON true
        ${billWhere(search)}
        ORDER BY am.invoice_date DESC
        LIMIT ${limit} OFFSET ${offset}`;

      // (2) Expense POs: หมวด Import Expenses หรือ partner โลจิสติกส์ — รอออกบิล
      const poSql = (search) => `
        SELECT
          po.id,
          po.name::text        AS po_number,
          po.origin::text,
          po.amount_total,
          cu.name::text        AS currency,
          1.0/NULLIF(po.currency_rate,0) AS rate_thb,
          rp.name::text        AS partner,
          po.date_order::text  AS doc_date,
          prod.main_product,
          prod.cat_name
        FROM purchase_order po
        JOIN res_partner  rp ON rp.id = po.partner_id
        JOIN res_currency cu ON cu.id = po.currency_id
        LEFT JOIN LATERAL (
          SELECT (pt.name)::text AS main_product, pc.complete_name::text AS cat_name
          FROM purchase_order_line pol
          JOIN product_product  pp ON pp.id = pol.product_id
          JOIN product_template pt ON pt.id = pp.product_tmpl_id
          JOIN product_category pc ON pc.id = pt.categ_id
          WHERE pol.order_id = po.id
          ORDER BY pol.price_subtotal DESC LIMIT 1
        ) prod ON true
        ${poWhere(search)}
        ORDER BY po.date_order DESC
        LIMIT ${limit} OFFSET ${offset}`;

      // MCP path หั่นคอลัมน์ตาม doc_date/id (ต้องมีใน SELECT ทั้งสอง query) — ใช้ NCOLS_WIDE เพราะ bill มี lines[]
      const BILL_ORDER = 'r.doc_date AS _ord, r.id AS _id';
      let billRows, poRows, via = null, billTotal = null, poTotal = null;
      // ลอง direct ก่อน (ข้ามถ้า circuit เพิ่งเปิด — จะได้ไม่รอ timeout เปล่าๆ)
      if (!dbLikelyDown()) {
        try {
          billRows = (await db.query(billSql(billSearchDirect), q ? args : [])).rows;
          poRows   = (await db.query(poSql(poSearchDirect),     q ? args : [])).rows;
          billTotal = (await db.query(billCountSql(billSearchDirect), q ? args : [])).rows[0]?.n ?? null;
          poTotal   = (await db.query(poCountSql(poSearchDirect),     q ? args : [])).rows[0]?.n ?? null;
          markDbUp(); via = 'direct';
        } catch (e) {
          if (isConnFailure(e)) markDbDown();
          console.error('[API] logistics-bills direct หลุด → ลอง MCP bridge:', e.message);
        }
      }
      // fallback ผ่าน MCP bridge — เส้นทางเดียวกับที่ import/export ใช้ตอน RDS ตรงต่อไม่ได้
      if (!via) {
        if (!(MCP_URL && MCP_TOKEN)) { jsonErr(res, 503, 'Odoo ไม่พร้อมใช้งานชั่วคราว (RDS ตรงต่อไม่ได้ และไม่ได้ตั้งค่า MCP bridge)'); return; }
        try {
          const sid = await mcpConnect();
          billRows = await mcpPull(sid, billSql(billSearchMcp), BILL_ORDER, limit, MCP_NCOLS_WIDE);
          poRows   = await mcpPull(sid, poSql(poSearchMcp),     BILL_ORDER, limit, MCP_NCOLS_WIDE);
          // นับผ่าน bridge ด้วย — ถ้านับไม่ได้ปล่อย null แล้วฝั่งหน้าเว็บจะไม่โชว์ "จาก N" (ดีกว่าโชว์เลขมั่ว)
          const CNT_ORDER = 'r.n AS _ord, r.n AS _id';
          try {
            billTotal = (await mcpPull(sid, billCountSql(billSearchMcp), CNT_ORDER, 1, MCP_NCOLS_WIDE))[0]?.n ?? null;
            poTotal   = (await mcpPull(sid, poCountSql(poSearchMcp),     CNT_ORDER, 1, MCP_NCOLS_WIDE))[0]?.n ?? null;
          } catch (cntErr) { console.error('[API] logistics-bills นับจำนวนผ่าน MCP ไม่สำเร็จ:', cntErr.message); }
          via = 'mcp';
          console.log('[API] logistics-bills ผ่าน MCP bridge สำเร็จ — bills:', billRows.length, 'po:', poRows.length, '(direct ใช้ไม่ได้)');
        } catch (mcpErr) {
          console.error('[API] logistics-bills MCP bridge ก็หลุด:', mcpErr.message);
          jsonErr(res, 503, 'โหลดรายการบิลไม่สำเร็จ (ทั้ง RDS ตรงและ MCP bridge ต่อไม่ได้)');
          return;
        }
      }

      try {

        // ── จำแนกประเภท ──
        // บิลที่มีหลาย line ปนกัน (เช่น freight+insurance ใบเดียว) → แยกตามยอดของแต่ละ line
        // บิลที่ line หักล้างกัน (ภาษีกรมศุลกากร: +ฐาน −ฐาน) → จำแนกทั้งใบ ยอดจริง = amount_tax/amount_total
        const INS_RE   = /insurance|ประกันภัย|ประกัน/i;
        const VAT_RE   = /custom\s*\(?\s*vat|\bvat\b|ภาษีมูลค่าเพิ่ม|ภพ\.?\s*30|ภาษีนำเข้า/i;
        const DUTY_RE  = /custom\s*\(?\s*duty|\bduty\b|อากร|tariff|ภาษีขาเข้า|import\s*duty/i;
        const CLR_RE   = /clearance|พิธีการ|เดินพิธี|ชิปปิ้ง|shipping\s*service|\bbroker|clearing|d\/o|delivery\s*order|เอกสารนำเข้า|customs\s*service/i;
        const FRT_RE   = /freight|ขนส่ง|shipping|transport|cargo|courier|express|ระวาง/i;
        function lineCat(name) {
          const t = (name || '').toLowerCase();
          if (INS_RE.test(t))  return 'insurance';
          if (VAT_RE.test(t))  return 'vat';
          if (DUTY_RE.test(t)) return 'duty';
          if (CLR_RE.test(t))  return 'clearance';
          return 'freight';
        }
        function wholeBillCat(text, partner, tax) {
          const t = (text || '').toLowerCase(), p = (partner || '').toLowerCase();
          if (INS_RE.test(t) || INS_RE.test(p)) return 'insurance';
          if (VAT_RE.test(t))  return 'vat';
          if (DUTY_RE.test(t)) return 'duty';
          if (CLR_RE.test(t) || CLR_RE.test(p)) return 'clearance';
          if (/กรมศุลกากร|customs|ศุลกากร/.test(p)) return tax > 0 ? 'vat' : 'duty';
          return 'freight';
        }
        const zero5  = () => ({ freight: 0, clearance: 0, insurance: 0, duty: 0, vat: 0 });
        const round5 = c => { Object.keys(c).forEach(k => { c[k] = Math.round(c[k]); }); return c; };
        const argmax = c => Object.keys(c).reduce((a, b) => c[b] > c[a] ? b : a);

        const out = [];
        const billedPoNames = new Set();
        // แปลงเป็นบาทเสมอตาม rate_thb ของแต่ละบิล/PO — เดิมไม่แปลงเลย บิลสกุลต่างประเทศ (เช่น DHL/forwarder
        // ที่ออกบิลเป็น USD) ถูกนับเป็นบาทตรงๆ ผิดขนาด ~30 เท่า (bug จริงที่เจอและแก้ 13 ก.ค. 2569 — คนละจุด
        // กับ bug currency_rate ของ export SO ที่แก้ไปก่อนหน้านี้ แต่เป็น "โรค" เดียวกัน: ดึงยอดสกุลเงินมาโดยไม่แปลง)
        const thbRate = r => { if (!r.currency || r.currency === 'THB') return 1; const v = parseFloat(r.rate_thb); return v > 0 ? v : 1; };
        billRows.forEach(r => {
          const fx   = thbRate(r);
          // ใบลดหนี้ (in_refund) เก็บยอดใน Odoo เป็นบวกเสมอ (ความหมาย "เครดิต" มาจาก move_type ไม่ใช่เครื่องหมาย)
          // ต้องกลับเครื่องหมายลบเองตอนแสดงผล ไม่งั้นใบลดหนี้จะดูเหมือนบิลจ่ายเพิ่มอีกใบ
          const sign = r.move_type === 'in_refund' ? -1 : 1;
          const origAmount = (parseFloat(r.amount_total) || 0) * sign;
          const total = origAmount * fx;
          const tax   = (parseFloat(r.amount_tax) || 0) * fx * sign;
          const lines = Array.isArray(r.lines) ? r.lines : [];
          const text  = lines.map(l => l.name || '').join(' ');
          const c = zero5();
          // ลองแยกตาม line ก่อน — ใช้ได้เมื่อยอด line บวกรวมแล้วเป็นยอดจริง (ไม่หักล้างกัน)
          // เฉพาะใบที่ total ไม่ติดลบ (ไม่ใช่ in_refund) — Math.max(0,...) ด้านล่างสมมติว่าแต่ละหมวดไม่ติดลบ
          // สมมติฐานนี้ใช้ไม่ได้กับใบลดหนี้ (total ติดลบทั้งใบ) เลยส่งใบลดหนี้ไปทาง wholeBillCat แทนเสมอ
          let lineTotal = 0;
          const lineSums = zero5();
          lines.forEach(l => { const a = (parseFloat(l.amount) || 0) * fx * sign; lineTotal += a; lineSums[lineCat(l.name)] += a; });
          let cat;
          if (lines.length && total >= 0 && lineTotal > total * 0.5) {
            // scale ยอด line (ก่อน VAT) ให้เท่ายอดจ่ายจริงทั้งใบ
            const f = total / lineTotal;
            Object.keys(lineSums).forEach(k => { c[k] = Math.max(0, lineSums[k] * f); });
            cat = argmax(c);
          } else {
            cat = wholeBillCat(text, r.partner, tax);
            if (cat === 'vat' && tax > 0) { c.vat = tax; c.duty = Math.max(0, total - tax); }
            else c[cat] = total;
          }
          [r.invoice_origin, r.ref].forEach(v => { if (v) billedPoNames.add(v.trim()); });
          out.push({ id: r.id, kind: 'bill', bill: r.bill_name, partner: r.partner,
            ref: r.ref, origin: r.invoice_origin, amount: total, currency: r.currency,
            origAmount: fx !== 1 ? origAmount : null, fxRate: fx !== 1 ? fx : null,
            date: r.doc_date, category: cat, ...round5(c) });
        });
        poRows.forEach(r => {
          // PO ที่มีบิลอ้างถึงแล้ว → ข้าม (ใช้ยอดจากบิลจริงแทน)
          if (billedPoNames.has((r.po_number || '').trim())) return;
          const fx = thbRate(r);
          const origAmount = parseFloat(r.amount_total) || 0;
          const total = origAmount * fx;
          const text  = (r.main_product || '') + ' ' + (r.cat_name || '');
          const cat   = wholeBillCat(text, r.partner, 0);
          const c = zero5(); c[cat] = total;
          out.push({ id: 'po_' + r.id, kind: 'po', bill: r.po_number, partner: r.partner,
            ref: r.origin, origin: r.origin, amount: total, currency: r.currency,
            origAmount: fx !== 1 ? origAmount : null, fxRate: fx !== 1 ? fx : null,
            date: r.doc_date, category: cat, ...round5(c) });
        });
        out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        // via บอกว่าดึงมาจาก direct หรือ MCP bridge (markDbUp/markDbDown จัดการไปแล้วในขั้นดึงข้อมูล)
        // total/truncated = สัญญาว่า "ไม่ตัดข้อมูลโดยไม่บอก" — หน้าเว็บเอาไปแสดงว่าเห็นกี่จากกี่รายการ
        // count คือจำนวนที่ส่งกลับหลังกรอง PO ที่มีบิลอ้างแล้วออก จึงน้อยกว่า fetched ได้เป็นปกติ
        const fetched = billRows.length + poRows.length;
        const total   = (billTotal == null || poTotal == null) ? null : billTotal + poTotal;
        jsonOk(res, { ok: true, count: out.length, months, via, limit, offset,
          fetched, total, totalBills: billTotal, totalPos: poTotal,
          truncated: total == null ? (billRows.length >= limit || poRows.length >= limit) : (offset + fetched < total),
          bills: out });
      } catch(e) {
        // ถึงตรงนี้แปลว่าดึงข้อมูลสำเร็จแล้ว (direct หรือ MCP) — error ที่นี่คือขั้นประมวลผล ไม่ใช่ DB หลุด
        console.error('[API] logistics-bills ประมวลผล:', e.message);
        jsonErr(res, 500, 'ประมวลผลรายการบิลไม่สำเร็จ');
      }
      return;
    }

    if (reqUrl === '/api/ping' && method === 'GET') {
      const out = { ok: true, db: process.env.DB_NAME || '?', ts: new Date().toISOString() };
      try { await db.query('SELECT 1'); markDbUp(); out.direct = true; }
      catch (e) { if (isConnFailure(e)) markDbDown(); out.direct = false; out.direct_error = e.message; }
      if (MCP_URL && MCP_TOKEN) {
        try { await mcpRunSql(await mcpConnect(), 'SELECT 1 AS ok'); out.mcp = true; }
        catch (e) { out.mcp = false; out.mcp_error = e.message; }
      } else out.mcp = null; // ไม่ได้ตั้งค่า bridge ไว้
      out.ok = !!(out.direct || out.mcp);
      jsonOk(res, out);
      return;
    }

    // Lightweight liveness probe — does NOT touch the DB. Used by watchdog
    // health checks so a slow/unreachable database never triggers a restart.
    if (reqUrl === '/api/alive' && method === 'GET') {
      jsonOk(res, { ok: true, ts: new Date().toISOString() });
      return;
    }

    // POST (ไม่ใช่ GET) เพื่อกัน CSRF ผ่าน <img>/ลิงก์ — endpoint นี้เปลี่ยน state (ล้าง cache + reset breaker)
    if (reqUrl === '/api/cache/clear' && method === 'POST') {
      cache.data = {}; cache.ts = {};
      markDbUp(); // กด Sync = อยากลอง Odoo จริง ปลด circuit breaker
      jsonOk(res, { ok: true, message: 'Cache cleared' });
      return;
    }

    // ── ผลตรวจสอบข้อมูลอัตโนมัติ — GET /api/integrity-check?force=1 เพื่อสั่งตรวจใหม่ทันที ──
    if (reqUrl === '/api/integrity-check' && method === 'GET') {
      const force = new URL('http://x' + req.url).searchParams.get('force') === '1';
      // force=1 เขียนไฟล์ integrity_seen.json + อาจส่งอีเมลแจ้งเตือน — จำกัดไว้กันกดรัว/ยิงซ้ำ
      // (คืนผลรอบล่าสุดไปก่อน ไม่ต้อง error เพราะข้อมูลชุดเดิมก็ยังใช้ได้)
      if (force && !rateLimit('integrity:' + (req.socket.remoteAddress || '?'), 6, 60 * 1000)) {
        jsonOk(res, { ok: true, throttled: true, ...integrityReport });
        return;
      }
      if (force || !integrityReport.ranAt) await runIntegrityCheck(force ? 'Manual' : 'FirstView');
      jsonOk(res, { ok: true, ...integrityReport });
      return;
    }

    // ── Tracking data (server-side persistence) ──
    if (reqUrl === '/api/tracking' && method === 'GET') {
      const rows = loadTracking();
      jsonOk(res, { ok: true, count: rows.length, rows });
      return;
    }

    // (legacy) เขียนทับทั้งไฟล์ — คงไว้เพื่อ compatibility แต่ frontend ใช้ upsert แล้ว
    if (reqUrl === '/api/tracking' && method === 'POST') {
      const data = await readJsonBody(req, res);
      if (data === null) return;
      try {
        if (!Array.isArray(data)) { jsonErr(res, 400, 'expected array'); return; }
        auditLog('replace_all', '*', ['(' + data.length + ' records)'], req.socket.remoteAddress);
        const ok = saveTracking(data);
        jsonOk(res, { ok, count: data.length });
      } catch(e) { jsonErr(res, 400, e.message); }
      return;
    }

    // ── Upsert ทีละรายการ: ปลอดภัยเมื่อใช้พร้อมกันหลายคน ──
    // POST /api/tracking/upsert  body = record เดียว หรือ array ของ records
    // merge ด้วย key po_so — ไม่แตะรายการอื่นในไฟล์
    if (reqUrl === '/api/tracking/upsert' && method === 'POST') {
      const input = await readJsonBody(req, res);
      if (input === null) return;
      try {
        const recs  = Array.isArray(input) ? input : [input];
        // ที่มาของค่าในรอบนี้ — client ส่ง _origin มาได้ (ข้อมูลเก่ามี 'verify:<ไฟล์>' จากโมดูลตรวจเอกสารที่ถอดออกแล้ว)
        // ไม่ส่ง = คนกรอกผ่านหน้าเว็บ ซึ่งเป็นกรณีปกติ
        const origin = sanitizeOrigin(!Array.isArray(input) && input._origin ? input._origin : 'manual');
        const nowIso = new Date().toISOString();
        const data  = loadTracking();
        const byKey = new Map();
        data.forEach((r, i) => { const k = r.po_so || r.id; if (k != null && !byKey.has(k)) byKey.set(k, i); });
        // เดิม endpoint นี้ merge JSON จาก client ตรงๆ โดยไม่ตรวจสอบเลย — ฟิลด์ตัวเลขที่ผิดปกติ (ติดลบ/ไม่ใช่
        // ตัวเลข) จะถูกบันทึกเงียบๆ แล้วไปพังผลรวมต้นทุน/Dashboard ที่อื่นในภายหลังโดยไม่มี error ให้เห็น
        const NUM_FIELDS = ['freight','clearance','insurance','duty','vat','other','expectedCost','amount','rate','containerQty'];
        const invalidField = r => NUM_FIELDS.find(f => {
          if (r[f] === undefined || r[f] === null || r[f] === '') return false;
          const n = Number(r[f]);
          return !Number.isFinite(n) || n < 0;
        });
        // ISO 6346: 3 ตัวอักษร + ตัวระบุประเภท (U/J/Z) + 6 หลัก + เลขตรวจสอบ 1 หลัก
        // เลขตรวจสอบคำนวณจากน้ำหนักฐาน 2 ของ 10 ตัวแรก จึงยืนยันได้ว่า "เป็นเลขตู้จริง" ไม่ใช่แค่หน้าตาคล้าย
        const ISO6346_VAL = (() => {
          const m = {}; '0123456789'.split('').forEach((c, i) => { m[c] = i; });
          let n = 10;
          for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { if (n % 11 === 0) n++; m[c] = n++; }
          return m;
        })();
        const isContainerNo = v => {
          const s = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(s)) return false;
          let sum = 0;
          for (let i = 0; i < 10; i++) sum += ISO6346_VAL[s[i]] * Math.pow(2, i);
          return (sum % 11) % 10 === Number(s[10]);
        };
        const isEmpty = v => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
        let applied = 0;
        const rejected = [];
        // record ที่ server "ตั้งใจข้าม" — ต่างจาก rejected (ค่าผิด) และต่างจากเขียนสำเร็จ
        // ⚠ เดิมเส้นทางนี้ `return` เงียบ ตอบ 200 โดยไม่นับที่ไหนเลย → ตัวเรียก (scan-shipment-docs.mjs)
        //   แยกไม่ออกว่า "เขียนแล้ว" หรือ "ข้ามไป" จึง log ว่าสำเร็จทุกครั้ง (บั๊กจริง 2026-09-08)
        const skippedRecords = [];
        recs.forEach(r => {
          const key = r && (r.po_so || r.id);
          if (key == null) return;
          const bad = invalidField(r);
          if (bad) { rejected.push({ po_so: key, field: bad, value: r[bad] }); return; }
          // ── เลขตู้ต้องไม่หลุดเข้าช่อง B/L ────────────────────────────────────────────────
          // เลขตู้กับเลข B/L อยู่ใกล้กันในเอกสารและหน้าตาคล้ายกัน (ตัวอักษร+ตัวเลข) ตัวสกัดจึงสลับกันได้
          // เจอจริง 2026-08-13: กฎ "ใช้เลข House" ทำให้ AI เขียน NLLU4237054 (เลขตู้แท้ ผ่าน ISO 6346)
          // ลงช่อง bl_awb ของ 3 การ์ด · เลข B/L ไม่มีวันเป็นเลขตู้ที่ถูกต้องตามมาตรฐาน จึงตัดทิ้งได้เลย
          if (!isEmpty(r.bl_awb) && isContainerNo(r.bl_awb)) {
            console.log(`[Upsert] ${key} ทิ้งค่า bl_awb="${r.bl_awb}" — เป็นเลขตู้ตามมาตรฐาน ISO 6346 ไม่ใช่เลข B/L`);
            delete r.bl_awb;
            if (!isEmpty(r.bl) && isContainerNo(r.bl)) delete r.bl;
          }
          const idx    = byKey.has(key) ? byKey.get(key) : -1;
          const before = idx >= 0 ? data[idx] : null;
          // ── โหมด "เติมเฉพาะช่องว่าง" (_fillEmptyOnly) ────────────────────────────────
          // ใช้กับการเขียนอัตโนมัติจาก scan-shipment-docs.mjs — เติมได้เฉพาะฟิลด์ที่ยังว่างอยู่
          // ห้ามทับค่าที่มีอยู่แล้วเด็ดขาด เพราะ PO เดียวอาจแบ่งส่งหลายชิปเม้น (คนละ B/L/เรือ/ตู้)
          // แล้ว record เก็บได้ชุดเดียว — ถ้าทับ จะกลายเป็นข้อมูลของชิปเม้นอื่นเงียบๆ
          // ทำฝั่ง server เพื่อให้ตรวจกับค่าล่าสุดในไฟล์แบบ atomic (ฝั่ง client จะมี race)
          // _overwriteFields = รายชื่อฟิลด์ที่ "ยอมให้ทับได้" แม้อยู่ในโหมดเติมช่องว่าง
          // ใช้ตอนกฎการสกัดเปลี่ยน (เช่น 2026-08-13: forwarder ต้องเอาจากช่อง "For delivery of goods
          // please apply to" และ B/L ต้องใช้เลข House) ซึ่งค่าเดิมในการ์ด "ถูกตามกฎเก่า" จึงต้องเขียนทับ
          // แบบเจาะจงทีละฟิลด์ — ไม่ใช้ --overwrite ทั้งก้อน เพราะฟิลด์อื่น (เช่นเลขตู้) การ์ดแม่นกว่าเอกสาร
          const owFields = new Set(Array.isArray(r._overwriteFields) ? r._overwriteFields : []);
          delete r._overwriteFields;
          if (r._fillEmptyOnly) {
            delete r._fillEmptyOnly;
            if (before) {
              const isEmpty = v => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
              // ⚠ "เติมเฉพาะช่องว่าง" อย่างเดียวยังไม่พอ — ช่องที่ว่างอยู่ก็รับข้อมูลของ "คนละชิปเม้น" ได้
              // (เจอจริง 2026-08-11: KOBPO2501-00085 เป็นชิปเม้นเรือ CNC SATURN แต่ช่อง ETA ที่ว่างอยู่
              //  ถูกเติมด้วย ETA ของเรือ LITTLE ATHINA ซึ่งเป็นอีกชิปเม้นในโฟลเดอร์เดียวกัน)
              // ถ้า record มีตัวระบุชิปเม้นอยู่แล้ว (B/L หรือชื่อเรือ) และไม่ตรงกับที่กำลังจะเขียน
              // = คนละชิปเม้น ห้ามแตะ record นี้เลยแม้แต่ช่องที่ว่าง
              const same = (a, b) => { const n = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return n(a) && n(b) && (n(a) === n(b) || n(a).includes(n(b)) || n(b).includes(n(a))); };
              // ⚠ ชื่อเรือชี้ขาดว่าเป็นชิปเม้นเดียวกันหรือไม่ ไม่ใช่เลข B/L
              // shipment เดียวมี Master B/L (สายเรือ) กับ House B/L (forwarder) เลขคนละเลขเป็นปกติ
              // เดิมเทียบ bl_awb ด้วย ทำให้ "เรือลำเดียวเที่ยวเดียว แต่เอกสารคนละใบ" ถูกตัดสินว่าเป็น
              // คนละชิปเม้น แล้วข้ามทั้ง record → การ์ดไม่เคยได้ ETD/ETA เลย
              // (เจอจริง 2026-08-13: KOBPO2605-09063 การ์ดมี HBL MZY202605220303 เรือ ISEACO UNITY
              //  เอกสารให้ MBL SGCN202606004 เรือ ISEACO UNITY ลำเดียวกัน แต่ถูกข้ามทุกรอบ)
              // ⭐ เลข B/L ตรงกันเป๊ะ = ชิปเม้นเดียวกันแน่นอน ชนะทุกสัญญาณ (เลข B/L เป็นรหัสเอกสารที่ไม่ซ้ำ)
              // ต้องมาก่อนการเทียบชื่อเรือ เพราะ B/L ใบเดียวมีได้หลายลำจริงๆ จากการถ่ายลำ (feeder + mother)
              // วัดจริง 2026-08-13: ถูกบล็อกทั้งที่ B/L ตรงกัน 20 ครั้ง เช่น TWSABKK2601017 เรือ
              // "SAWASDEE ATLANTIC" vs "SAWASDEE PACIFIC" · HASLK01260707883 "KMTC SINGAPORE" vs
              // "KMTC BANGKOK" · และ NBPAT2611973 ที่ชื่อเรืออ่านได้ 108 กับ 98 (ตัวเลขคลาดกันตอนสกัด)
              // ผลคือข้อมูลที่ดึงถูกต้องแล้วไม่เคยลงการ์ดเลย — AOF เจอเองว่า forwarder ยังผิดอยู่
              // ใช้การเทียบแบบ "ตรงกันเป๊ะ" เท่านั้น (ไม่ใช่ substring) เพื่อไม่ให้เลขสั้นไปพ้องกับเลขอื่น
              const exact = (a, b) => { const n = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return !!n(a) && n(a) === n(b); };
              let idMismatch = false;
              if (exact(before.bl_awb, r.bl_awb)) idMismatch = false;
              else if (!isEmpty(before.vessel) && !isEmpty(r.vessel)) idMismatch = !same(before.vessel, r.vessel);
              else if (!isEmpty(before.bl_awb) && !isEmpty(r.bl_awb)) idMismatch = !same(before.bl_awb, r.bl_awb);
              if (idMismatch) {
                const why = `คนละชิปเม้น (ในระบบ bl=${before.bl_awb || '-'}/เรือ=${before.vessel || '-'} · ที่ส่งมา bl=${r.bl_awb || '-'}/เรือ=${r.vessel || '-'})`;
                console.log(`[Upsert] ${key} ข้ามทั้ง record — ${why}`);
                skippedRecords.push({ po_so: key, reason: why });
                return;
              }
              const skipped = [], forced = [];
              Object.keys(r).forEach(k => {
                if (k === 'po_so' || k.startsWith('_')) return;
                if (isEmpty(before[k]) || JSON.stringify(before[k]) === JSON.stringify(r[k])) return;
                // ฟิลด์ที่สั่งให้ทับได้ — ทับเฉพาะเมื่อค่าใหม่ไม่ว่าง (ห้ามล้างของเดิมทิ้งเป็นค่าว่าง)
                if (owFields.has(k) && !isEmpty(r[k])) { forced.push(`${k}: ${before[k]} → ${r[k]}`); return; }
                skipped.push(k); delete r[k];
              });
              if (forced.length) console.log(`[Upsert] ${key} ทับตามที่สั่ง — ${forced.join(' · ')}`);
              if (skipped.length) console.log(`[Upsert] ${key} โหมดเติมช่องว่าง — ไม่ทับ: ${skipped.join(', ')}`);
            }
          }
          // _origin / _src เป็น metadata ของ "การเขียน" ไม่ใช่ข้อมูล shipment — ห้ามให้ client
          // เขียน _src เองตรงๆ (ไม่งั้นอ้างที่มาปลอมได้) และห้าม _origin ค้างอยู่ในไฟล์ข้อมูล
          const changed = before
            ? Object.keys(r).filter(k => k !== '_src' && k !== '_origin' && JSON.stringify(before[k]) !== JSON.stringify(r[k]))
            : Object.keys(r).filter(k => k !== '_src' && k !== '_origin');
          // stamp provenance ก่อนเขียนลง data — ต้องใช้ changed ที่คำนวณจาก before เทียบ r
          // (ถ้า merge ก่อนแล้วเทียบทีหลังจะไม่เหลือความต่างให้เห็น)
          const recOrigin = sanitizeOrigin(r._origin || origin);
          // ── เลื่อนสถานะอัตโนมัติจากการสแกนเอกสาร ────────────────────────────────────
          // การเขียนจาก scanner เท่านั้นที่เลื่อนสถานะได้ · สถานะที่คนตั้งเองยังชี้ขาดเสมอ
          // ⚠ บล็อกนี้อยู่ **หลัง** ตัวกรอง _fillEmptyOnly ข้างบน จึงไม่ได้เกราะ "เติมเฉพาะช่องว่าง"
          //   เกราะที่กันการทับจึงต้องอยู่ในตัวมันเอง = `nextStage()` ที่ยอมเลื่อนไปข้างหน้าเท่านั้น
          //   (เจอจริง 2026-09-08: ถ้าตั้ง r.stage ตรงๆ การ์ด 24 ใบถูกดึงถอยหลัง — received→etd 12,
          //    customs→etd 6, received→po 5, customs→po 1 เพราะ autoStage คืน 'received' ไม่ได้เลย
          //    และ _stageManual มีอยู่ 0 จาก 1,073 record จึงไม่ได้กันอะไรกับข้อมูลเดิม)
          if (recOrigin.startsWith('scan:') && (r._board || before?._board || 'import') !== 'export'
              && !r._stageManual && !(before && before._stageManual)) {
            const effective = { ...(before || {}), ...r };
            const proposed = autoStage({
              mode: effective.mode,
              blNumber: effective.bl_awb || effective.bl,
              vessel: effective.vessel,
              voyage: effective.voyage || (String(effective.vessel || '').match(/\/\s*([^/]+)$/) || [])[1],
              portOfLoading: effective.origin,
              portOfDischarge: effective.dest,
              etd: effective.etd,
              etsActualArrivalDate: effective.etsActualArrivalDate,
            });
            const advanced = stageWriteNeeded(before && before.stage, proposed);
            if (advanced) r.stage = advanced;
            else if (before) delete r.stage;   // ไม่เลื่อน = ห้ามแตะฟิลด์นี้เลย (กันทับค่าเดิม)
            // `changed` ถูกคำนวณไว้ก่อนบล็อกนี้ ต้องแก้ให้ตรงกับที่จะเขียนจริง ไม่งั้นการเลื่อน
            // สถานะจะ **ไม่ขึ้น audit log และไม่ได้ stamp `_src`** = เปลี่ยนสถานะโดยไม่มีที่มา
            const hasStage = changed.indexOf('stage');
            if (r.stage !== undefined && r.stage !== (before && before.stage)) {
              if (hasStage < 0) changed.push('stage');
            } else if (hasStage >= 0) changed.splice(hasStage, 1);
          }
          const srcTag = stampProvenance(before && before._src, changed, recOrigin, nowIso);
          const merged = { ...r };
          delete merged._origin;
          delete merged._src;
          if (Object.keys(srcTag).length) merged._src = srcTag;
          if (idx >= 0) data[idx] = { ...data[idx], ...merged };
          else { byKey.set(key, data.length); data.push(merged); }
          // ไม่เขียน audit เมื่อ "อัปเดต" ที่ไม่มีฟิลด์ไหนเปลี่ยนจริง (หรือเปลี่ยนแค่ _ts = เวลาที่กดบันทึก)
          // เดิมบันทึกทุกครั้งที่ client ส่ง upsert เข้ามา ไม่ว่าจะมีอะไรต่างหรือไม่ ทำให้แถวชนิด
          // "แก้ไข (ไม่มีฟิลด์สำคัญเปลี่ยน)" กินพื้นที่ ~8% ของ audit log (43/540 แถว ณ วันตรวจ) แล้วดัน
          // การแก้ไขจริงตกออกจากแผง "ประวัติการแก้ไขล่าสุด" ที่โชว์แค่ 40 รายการล่าสุดบน Dashboard
          const meaningful = changed.filter(k => k !== '_ts');
          if (!before || meaningful.length) {
            auditLog(before ? 'update' : 'create', key, changed, req.socket.remoteAddress);
          }
          applied++;
        });
        const ok = saveTracking(data);
        if (rejected.length) console.error('[Upsert] ปฏิเสธค่าที่ผิดปกติ:', JSON.stringify(rejected));
        if (skippedRecords.length) console.log(`[Upsert] ข้าม ${skippedRecords.length} record (เป็นคนละชิปเม้น) — รายงานกลับให้ผู้เรียกแล้ว`);
        jsonOk(res, { ok, applied, total: data.length, rejected, skipped: skippedRecords });
      } catch(e) { jsonErr(res, 400, e.message); }
      return;
    }

    // ── ลบ shipment ที่แยกเอง (synthetic) เท่านั้น — ห้ามลบ PO จริงที่มาจาก Odoo ──
    // ปิดใช้งานโดย default: ต้องตั้ง DELETE_PASSWORD ใน .env ก่อน ไม่งั้นทุกคำขอถูกปฏิเสธเสมอ
    // (ผู้ใช้ทั่วไปแก้ .env ไม่ได้ — เจ้าของระบบเป็นคนตั้งรหัสแล้วแจกให้เฉพาะผู้มีอำนาจเท่านั้น)
    // POST /api/tracking/delete  body = { po_so, password }
    if (reqUrl === '/api/tracking/delete' && method === 'POST') {
      const parsedBody = await readJsonBody(req, res);
      if (parsedBody === null) return;
      try {
        if (!process.env.DELETE_PASSWORD) {
          jsonErr(res, 403, 'ฟีเจอร์ลบยังไม่เปิดใช้งาน — ต้องตั้งค่า DELETE_PASSWORD ใน .env ก่อน');
          return;
        }
        const { po_so, password } = parsedBody;
        if (!safeEqual(password, process.env.DELETE_PASSWORD)) {
          auditLog('delete_denied', po_so || '?', ['wrong_password'], req.socket.remoteAddress);
          jsonErr(res, 401, 'รหัสผ่านไม่ถูกต้อง');
          return;
        }
        if (!po_so) { jsonErr(res, 400, 'ไม่พบ po_so'); return; }
        const data = loadTracking();
        const idx  = data.findIndex(r => (r.po_so || r.id) === po_so);
        if (idx < 0) { jsonErr(res, 404, 'ไม่พบรายการนี้'); return; }
        if (!data[idx]._synthetic) {
          jsonErr(res, 400, 'ลบได้เฉพาะ shipment ที่แยกเอง (สร้างในแอป) เท่านั้น — PO จริงจาก Odoo ลบผ่านหน้านี้ไม่ได้');
          return;
        }
        data.splice(idx, 1);
        const ok = saveTracking(data);
        auditLog('delete', po_so, ['deleted'], req.socket.remoteAddress);
        jsonOk(res, { ok });
      } catch (e) { jsonErr(res, 400, e.message); }
      return;
    }

    // ── ประวัติการแก้ไขล่าสุด (จาก audit log) ──
    // GET /api/tracking/history?po=KOBPO...&limit=50
    if (reqUrl === '/api/tracking/history' && method === 'GET') {
      const params = new URL('http://x' + req.url).searchParams;
      const po     = params.get('po') || '';
      const limit  = Math.min(parseInt(params.get('limit')) || 50, 500);
      try {
        let entries = [];
        if (fs.existsSync(AUDIT_FILE)) {
          entries = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
            .filter(Boolean);
          if (po) entries = entries.filter(e => e.po_so === po);
          entries = entries.slice(-limit).reverse();
        }
        jsonOk(res, { ok: true, count: entries.length, entries });
      } catch(e) { jsonErrEx(res, 500, 'tracking/history', e); }
      return;
    }

    if (reqUrl === '/api/shipment-runs' && method === 'GET') {
      const params = new URL('http://x' + req.url).searchParams;
      const po     = (params.get('po') || '').trim().replace(/\s*\(\d+\)\s*$/, '').toUpperCase();
      const limit  = Math.min(Math.max(parseInt(params.get('limit')) || 20, 1), 200);
      try {
        let runs = [];
        if (fs.existsSync(SHIPMENT_RUNS_FILE)) {
          runs = fs.readFileSync(SHIPMENT_RUNS_FILE, 'utf8').split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
            .filter(Boolean);
          if (po) runs = runs.filter(r => String(r.base || r.po || '').toUpperCase() === po);
          // ยุบให้เหลือชิปเม้นละรายการ (สแกนซ้ำหลายรอบจะได้ B/L เดิม) เก็บรอบล่าสุดของแต่ละใบ
          const byShip = new Map();
          for (const r of runs) {
            const k = String(r.bl_awb || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || (r.vessel || '') + (r.voyage || '');
            byShip.set(k, r);
          }
          runs = [...byShip.values()].slice(-limit).reverse();
        }
        jsonOk(res, { ok: true, count: runs.length, runs });
      } catch (e) { jsonErrEx(res, 500, 'shipment-runs', e); }
      return;
    }

    // ── อัตราแลกเปลี่ยนล่าสุดจาก Odoo (ใช้ตอนสร้างรายการใหม่) ──
    // ── ใบเปรียบเทียบค่าเฟรท ──
    // GET /api/freight-quotes            → ทุกใบ (เล็ก ไม่กี่ KB/ใบ) ให้ client เลือกเปิด
    // POST /api/freight-quotes/upsert    body = ใบเดียว (มี id) → แทนที่ใบเดิม id เดียวกัน ไม่แตะใบอื่น
    // POST /api/freight-quotes/delete    body = { id }
    if (reqUrl === '/api/freight-quotes' && method === 'GET') {
      const rows = loadFreight();
      jsonOk(res, { ok: true, count: rows.length, rows });
      return;
    }
    // POST /api/freight-extract  body = { filename, dataBase64, type }
    // อ่านใบเสนอราคา PDF ด้วย OpenAI แล้วคืนโครงสร้างค่าใช้จ่าย — ไม่เขียนอะไรลงดิสก์นอกจาก log โทเคน
    // client เป็นคนตัดสินใจว่าจะเอาค่าไหนลงช่องไหน (server ไม่แตะใบเปรียบเทียบ)
    if (reqUrl === '/api/freight-extract' && method === 'POST') {
      if (!rateLimit('freight-extract:' + (req.socket.remoteAddress || '?'), FREIGHT_EXTRACT_RATE, 60 * 60 * 1000)) {
        jsonErr(res, 429, `อ่านไฟล์ได้สูงสุด ${FREIGHT_EXTRACT_RATE} ครั้ง/ชั่วโมง — ลองใหม่ภายหลัง`); return;
      }
      if (!process.env.OPENAI_API_KEY) { jsonErr(res, 503, 'ยังไม่ได้ตั้ง OPENAI_API_KEY ใน .env จึงอ่านไฟล์อัตโนมัติไม่ได้'); return; }
      const body = await readJsonBody(req, res, FREIGHT_PDF_MAX_BYTES * 2);
      if (body === null) return;
      const b64 = String(body?.dataBase64 || '');
      const filename = String(body?.filename || 'quotation.pdf').slice(0, 120);
      const qType = ['import-sea', 'import-air', 'export-sea'].includes(body?.type) ? body.type : 'import-sea';
      if (!b64) { jsonErr(res, 400, 'ไม่มีข้อมูลไฟล์'); return; }
      const approxBytes = Math.floor(b64.length * 3 / 4);
      if (approxBytes > FREIGHT_PDF_MAX_BYTES) {
        jsonErr(res, 400, `ไฟล์ใหญ่เกิน ${Math.round(FREIGHT_PDF_MAX_BYTES / 1024 / 1024)}MB`); return;
      }
      if (!Buffer.from(b64.slice(0, 16), 'base64').toString('latin1').startsWith('%PDF-')) {
        jsonErr(res, 400, 'ไฟล์นี้ไม่ใช่ PDF'); return;
      }
      try {
        const data = await extractFreightQuote(b64, filename, qType);
        jsonOk(res, { ok: true, filename, data: data.parsed, usage: data.usage });
      } catch (e) { jsonErrEx(res, 502, 'อ่านใบเสนอราคาไม่สำเร็จ', e); }
      return;
    }
    if (reqUrl === '/api/freight-quotes/upsert' && method === 'POST') {
      const q = await readJsonBody(req, res, FREIGHT_MAX_QUOTE_BYTES);
      if (q === null) return;
      if (!q || typeof q !== 'object' || Array.isArray(q)) { jsonErr(res, 400, 'expected a quote object'); return; }
      if (!FREIGHT_ID_RE.test(String(q.id || ''))) { jsonErr(res, 400, 'id ไม่ถูกต้อง'); return; }
      if (!['import-sea', 'import-air', 'export-sea'].includes(q.type)) { jsonErr(res, 400, 'type ไม่ถูกต้อง'); return; }
      if (!Array.isArray(q.rows) || !Array.isArray(q.options) || !q.head || typeof q.head !== 'object') { jsonErr(res, 400, 'โครงสร้างใบไม่ครบ (head/options/rows)'); return; }
      const rows = loadFreight();
      const idx = rows.findIndex(r => r.id === q.id);
      if (idx < 0 && rows.length >= FREIGHT_MAX_QUOTES) { jsonErr(res, 400, `เก็บได้สูงสุด ${FREIGHT_MAX_QUOTES} ใบ — ลบใบเก่าก่อน`); return; }
      q.updatedAt = new Date().toISOString();
      q.savedBy = req.socket.remoteAddress || '';
      if (idx >= 0) rows[idx] = q; else rows.push(q);
      if (!saveFreight(rows)) { jsonErr(res, 500, 'บันทึกไฟล์ไม่สำเร็จ'); return; }
      auditLog(idx >= 0 ? 'freight_update' : 'freight_create', String(q.head.ref || q.id), [q.type], req.socket.remoteAddress);
      jsonOk(res, { ok: true, row: { id: q.id, updatedAt: q.updatedAt }, count: rows.length });
      return;
    }
    if (reqUrl === '/api/freight-quotes/delete' && method === 'POST') {
      const body = await readJsonBody(req, res, 4096);
      if (body === null) return;
      const id = String(body?.id || '');
      if (!FREIGHT_ID_RE.test(id)) { jsonErr(res, 400, 'id ไม่ถูกต้อง'); return; }
      const rows = loadFreight();
      const next = rows.filter(r => r.id !== id);
      if (next.length === rows.length) { jsonErr(res, 404, 'ไม่พบใบนี้'); return; }
      if (!saveFreight(next)) { jsonErr(res, 500, 'บันทึกไฟล์ไม่สำเร็จ'); return; }
      auditLog('freight_delete', id, [], req.socket.remoteAddress);
      jsonOk(res, { ok: true, count: next.length });
      return;
    }

    if (reqUrl === '/api/fx-rates' && method === 'GET') {
      try {
        const rows = await cachedQuery('fx-rates', `
          SELECT DISTINCT ON (c.name)
            c.name::text  AS currency,
            r.rate,
            r.name::text  AS as_of
          FROM res_currency_rate r
          JOIN res_currency c ON c.id = r.currency_id
          ORDER BY c.name, r.name DESC
        `, false, { orderCols: 'r.currency AS _ord', maxRows: 500 });
        // Odoo เก็บ rate = จำนวนหน่วยเงินนั้นต่อ 1 บาท → thb_per_unit = 1/rate
        const out = rows.map(r => {
          const rate = parseFloat(r.rate) || 0;
          return { currency: r.currency, thb_per_unit: rate > 0 ? 1 / rate : null, as_of: r.as_of };
        }).filter(r => r.thb_per_unit);
        jsonOk(res, { ok: true, count: out.length, rows: out });
      } catch(e) {
        jsonErrEx(res, 500, 'fx-rates', e);
      }
      return;
    }


    jsonErr(res, 404, 'API endpoint not found');
    return;
  }

  // ── Static Files ──
  // Allowlist เท่านั้น — ห้าม serve reqUrl ตรงๆ ผ่าน path.join เพราะ reqUrl ไม่ได้ decode/sanitize
  // "/.env", "/api-server.js", "/tracking_data.json" หรือ "/../../Windows/..." จะโดน serve ออกไปทันที
  // (ยืนยันแล้วว่า path.join(ROOT, reqUrl) เดินออกนอก ROOT ได้จริงถ้ามี ../ พอ)
  const ALIASES = ['/', '/index.html', '/import-export-os.html'];
  let filePath;
  if (ALIASES.includes(reqUrl)) {
    filePath = path.join(ROOT, 'import-export-os.html');
  } else if (reqUrl === '/container-loading-calculator.html') {
    filePath = path.join(ROOT, 'container-loading-calculator.html');
  } else if (reqUrl === '/freight-comparison.html') {
    filePath = path.join(ROOT, 'freight-comparison.html');
  } else if (/^\/vendor\/[\w.-]+\.(js|css|map)$/.test(reqUrl)) {
    filePath = path.join(ROOT, reqUrl);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found: ' + reqUrl);
    return;
  }
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found: ' + reqUrl);
      return;
    }
    // HTML = ตัวแอปทั้งตัว (React + โค้ดทั้งหมดอยู่ในไฟล์เดียว ไม่มี hash ในชื่อไฟล์) — ถ้าไม่บอก no-cache
    // browser จะใช้ heuristic caching ของตัวเอง ทำให้หลัง deploy ผู้ใช้ยังเห็นโค้ดเก่าจนกด hard reload
    // ส่วน vendor/*.js เป็นไลบรารีตายตัว (react/babel/xlsx) cache ได้นานๆ ให้โหลดหน้าเร็วขึ้น
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'text/plain',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
});

// /api/freight-extract ส่ง PDF ให้ OpenAI อ่าน จึงตั้ง timeout ไว้กว้าง เผื่อไฟล์ใหญ่/โมเดลตอบช้า
server.requestTimeout = 6 * 60 * 1000;
server.headersTimeout = 65 * 1000;

// เซฟตี้เน็ต — process อยู่ในสถานะไม่แน่นอนหลัง uncaught exception เสมอ (ตาม Node docs) จึง log ให้เห็นสาเหตุ
// ชัดๆ ก่อน แล้ว exit ให้ pm2 (ดู ecosystem.config.js, autorestart:true) restart ด้วย process สะอาด แทนที่จะ
// ปล่อยให้ทำงานต่อในสถานะพัง — ตั้งใจไม่ swallow เฉยๆ เพราะ Node ตั้งแต่ v15 ถือว่า unhandledRejection ที่ไม่มี
// handler ต้อง crash อยู่แล้วโดย default การใส่ handler ที่ไม่ exit จะกลายเป็นเปลี่ยนพฤติกรรมเดิมไปในทางแย่กว่า
// (จาก "crash แล้ว pm2 restart ให้" เป็น "รันต่อแบบเงียบๆ ในสถานะที่อาจพังอยู่แล้ว")
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
  process.exit(1);
});

// HOST=127.0.0.1 (ค่าเริ่มต้น) = เข้าได้เฉพาะเครื่องนี้
// ถ้าต้องการเปิดให้เครือข่าย ให้ตั้ง HOST=0.0.0.0 + APP_PASSWORD ใน .env
const HOST = process.env.HOST || '127.0.0.1';
// ถ้า bind สู่เครือข่าย (ไม่ใช่ loopback) แต่ไม่ตั้ง APP_PASSWORD = ใครก็ได้บนเครือข่ายเขียน/แก้/ลบ
// ข้อมูล Odoo production ได้ ปฏิเสธการ start ทันทีเพื่อกันเปิดช่องโดยไม่ตั้งใจ
const isLoopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
if (!isLoopback && !process.env.APP_PASSWORD) {
  console.error(`[Config] ❌ HOST=${HOST} เปิดสู่เครือข่าย แต่ไม่ได้ตั้ง APP_PASSWORD — อันตราย ปฏิเสธการเริ่มระบบ`);
  console.error('         ตั้ง APP_PASSWORD ใน .env ก่อน หรือใช้ HOST=127.0.0.1 (เฉพาะเครื่องนี้)');
  process.exit(1);
}
// ถ้า port 3000 ถูกใช้อยู่ (มี instance อื่น/supervisor ซ้อนกันรันทับ) แจ้งชัดเจนแล้ว exit แทนที่จะ
// โยน uncaughtException ที่อ่านยาก — กัน crash loop เงียบตอนมี supervisor 2 ตัว (pm2 + start-server.vbs)
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] port ${PORT} ถูกใช้งานอยู่แล้ว — มี api-server อีกตัวรันอยู่หรือ supervisor ซ้อนกัน? ปิดตัวที่รันอยู่ก่อน หรือใช้ supervisor เพียงตัวเดียว (pm2 หรือ start-server.vbs — ห้ามทั้งคู่พร้อมกัน)`);
    process.exit(1);
  }
  console.error('[FATAL] server error:', err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const authStatus = process.env.APP_PASSWORD ? '✓ Basic Auth เปิดอยู่' : '✗ ปิด (ตั้ง APP_PASSWORD เพื่อเปิด)';
  // แถว "Odoo RPC" ถูกถอดออกพร้อมกับ Odoo JSON-RPC layer — ตอนนี้อ่านข้อมูลจาก Odoo ทาง Postgres
  // (direct 5432 → MCP bridge 443) เท่านั้น ไม่มีการเขียนกลับเข้า Odoo อีก จึงรายงานสองทางนั้นแทน
  const bridgeStatus = (MCP_URL && MCP_TOKEN) ? '✓ ตั้งค่าแล้ว (fallback อัตโนมัติ)' : '✗ ไม่ได้ตั้งค่า (MCP_URL/MCP_TOKEN)';
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   Import-Export OS — API Server                  ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   Web App : http://localhost:${PORT}/                 ║`);
  console.log(`║   Bind    : ${HOST.padEnd(38)} ║`);
  console.log(`║   DB      : ${(process.env.DB_NAME || '?').padEnd(38)} ║`);
  console.log(`║   Auth    : ${authStatus.substring(0,38).padEnd(38)} ║`);
  console.log(`║   MCP     : ${bridgeStatus.substring(0,38).padEnd(38)} ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  // Warm-up: ดึงข้อมูลจาก Odoo ทันทีที่เปิด server (background) — ถ้าสำเร็จก็ได้
  // snapshot สดไว้เสิร์ฟให้ browser ทันที; ถ้าล้ม circuit breaker จะถูกตั้งไว้แล้ว
  // ทำให้ request แรกจาก browser ไม่ต้องเสียเวลารอ timeout เอง
  const warm = async (label) => {
    // probe เบาก่อน (SELECT 1) — รู้เร็วว่า DB ตรงต่อได้ไหม โดยไม่ต้องยิง query หนัก
    // สำเร็จ → ปลด breaker ทันที (กลับมา live); ล้ม → markDbDown (request จาก browser fast-fail)
    // หมายเหตุ: ต่อให้ direct ล้ม ก็ยังเรียก liveOrSnapshot ต่อเสมอ (ไม่ return ตรงนี้) เพราะ
    // liveOrSnapshot มีชั้น MCP bridge fallback ในตัวแล้ว — ให้โอกาสดึงสดผ่าน MCP ต่อทุกรอบ
    try { await db.query('SELECT 1'); markDbUp(); }
    catch (e) { markDbDown(); console.log('[' + label + '] Odoo ตรงยังต่อไม่ได้ — ลอง MCP bridge ต่อ'); }
    try {
      // import/export แต่ละอันเปิด MCP session ของตัวเอง (ไม่แชร์กัน — ดู comment ที่ mcpFetch) ยิงพร้อมกันได้เลย
      // ไม่งั้นตอน direct หลุดจะรอ MCP handshake+pagination ของ import จบก่อนค่อยเริ่ม export ช้าเป็น 2 เท่าโดยไม่จำเป็น
      const [imp, exp] = await Promise.all([
        liveOrSnapshot('import', SQL_IMPORT, true),
        liveOrSnapshot('export', SQL_EXPORT, true),
      ]);
      console.log('[' + label + '] snapshot สำเร็จ (import:' + imp.via + ' export:' + exp.via + ')', new Date().toISOString());
      return true;
    } catch (e) { console.log('[' + label + '] ล้มเหลวทั้ง direct และ MCP — เสิร์ฟ snapshot เดิม:', e.message); return false; }
  };
  // รอข้อมูลพร้อมก่อน ไม่งั้นรอบแรกจะเช็คจากลิสต์ว่างเปล่า — แล้วส่งสรุปรายสัปดาห์ถ้าถึงรอบ (ครั้งแรก = ยืนยันระบบพร้อม)
  warm('Warmup').then(() => runIntegrityCheck('Startup')).then(() => maybeSendWeeklyDigest());
  // Probe เป็นระยะ — สร้าง/อัปเดต snapshot ทันทีที่ Odoo กลับมาต่อได้ แม้ไม่มีใครเปิดหน้าเว็บ
  // ทำให้ครั้งถัดไปที่เปิด browser มีข้อมูลสดเสิร์ฟทันที ไม่ต้องรอ
  setInterval(() => { warm('AutoProbe'); }, 2 * 60 * 1000).unref();
  // รอบตรวจสอบข้อมูลอัตโนมัติ — ทุก 24 ชม. โดยไม่ต้องรอให้คนสังเกตตัวเลขผิดปกติเอง + เช็คว่าถึงรอบสรุปรายสัปดาห์ไหม
  setInterval(() => { runIntegrityCheck('Scheduled').then(() => maybeSendWeeklyDigest()); }, INTEGRITY_CHECK_INTERVAL).unref();
});

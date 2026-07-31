// ─── Local rule-based document cross-check ("Verification Shipping Document") ──
// แทนที่เวอร์ชัน AI เดิม (lib/verify-shipment.js) ที่ต้องเรียก Anthropic API จริงทุกครั้ง
// (มีค่าใช้จ่าย + ต้องมี ANTHROPIC_API_KEY ที่ใช้งานได้) — เวอร์ชันนี้ทำงาน 100% ในเครื่อง
// ไม่มี network call ออกไปที่ไหนเลย
//
// เสริมความรู้โดเมน Thai customs จาก 2 skill:
//   C:\Users\User\My Obsidian\My Claude\skills\thai-import-declaration-verifier\SKILL.md
//   C:\Users\User\My Obsidian\My Claude\skills\thai-export-declaration-verifier\SKILL.md
// เนื้อหาของ skill ทั้งสองเป็นคำแนะนำสำหรับ "การให้เหตุผล" ของ AI (แยกแยะ draft placeholder
// vs error จริง, ตีความ box ต่างๆ, ยอมรับ rounding) — ย้ายมาเป็นกฎ deterministic ได้เฉพาะส่วนที่
// เป็นข้อเท็จจริง/สูตรคำนวณ/ตารางอ้างอิงเท่านั้น (ตารางอากร, รูปแบบรหัส, สูตรภาษี, known-good/known-bad
// pattern ที่เจอซ้ำจริงกับ KOB) — ส่วนที่ต้อง "เข้าใจบริบท" จริงๆ (เช่น ร่างนี้ยังไม่ยิงหรือยัง, ประโยค
// อธิบายว่าทำไมถึงต่าง) ทำแบบ regex ไม่ได้ ต้องใช้ AI เท่านั้น — ดู summary ที่ตอบกลับทุกครั้งเพื่อรู้
// ขอบเขตที่แท้จริงของรอบตรวจนั้นๆ
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const Busboy = require('busboy');
const XLSX = require('xlsx');

const MAX_FILES = 15;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

const PDF_EXT = '.pdf';
const EXCEL_EXTS = new Set(['.xlsx', '.xls', '.csv']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg']);

const PDF_WORKER = path.join(__dirname, 'pdf-extract-worker.cjs');
const PDF_TIMEOUT_MS = 20000;

function extOf(filename) {
  const m = /\.[^.]+$/.exec(filename || '');
  return m ? m[0].toLowerCase() : '';
}

// ── Step 1: parse multipart upload ──
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES } });
    } catch (e) {
      reject(new Error('รูปแบบคำขอไม่ถูกต้อง (ไม่ใช่ multipart/form-data)'));
      return;
    }
    const files = [];
    let totalBytes = 0, tooManyFiles = false, oversizedFile = false, rejected = false;

    bb.on('field', (name, val) => {
      if (name === 'mode') req._verifyMode = val;
      if (name === 'po') req._verifyPo = val;
      if (name === 'note') req._verifyNote = val;
    });
    bb.on('file', (name, stream, info) => {
      if (name !== 'files') { stream.resume(); return; }
      const chunks = [];
      let fileBytes = 0;
      stream.on('data', (chunk) => {
        fileBytes += chunk.length;
        totalBytes += chunk.length;
        if (fileBytes > MAX_FILE_BYTES) { oversizedFile = true; return; }
        if (totalBytes > MAX_TOTAL_BYTES) { rejected = true; return; }
        chunks.push(chunk);
      });
      stream.on('limit', () => { oversizedFile = true; });
      stream.on('end', () => {
        if (oversizedFile || rejected) return;
        files.push({ name: info.filename, ext: extOf(info.filename), buffer: Buffer.concat(chunks) });
      });
    });
    bb.on('filesLimit', () => { tooManyFiles = true; });
    bb.on('finish', () => {
      if (tooManyFiles) { reject(new Error(`อัปโหลดได้สูงสุด ${MAX_FILES} ไฟล์ต่อครั้ง`)); return; }
      if (oversizedFile) { reject(new Error(`มีไฟล์ขนาดเกิน ${MAX_FILE_BYTES / 1024 / 1024}MB — กรุณาแยกส่งหรือบีบอัดไฟล์`)); return; }
      if (rejected) { reject(new Error(`ขนาดรวมของไฟล์ทั้งหมดเกิน ${MAX_TOTAL_BYTES / 1024 / 1024}MB — กรุณาลดจำนวนไฟล์`)); return; }
      if (!files.length) { reject(new Error('ไม่พบไฟล์ที่อัปโหลด')); return; }
      resolve({
        mode: req._verifyMode === 'export' ? 'export' : 'import',
        po: (req._verifyPo || '').trim(),
        note: (req._verifyNote || '').trim(),
        files,
      });
    });
    bb.on('error', (e) => reject(e));
    req.pipe(bb);
  });
}

// ── Step 2: local text extraction ──
function execFileP(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (err, stdout) => {
      if (err) { resolve({ ok: false, error: err.killed ? 'timeout/killed' : err.message }); return; }
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve({ ok: false, error: 'worker output ไม่ใช่ JSON' }); }
    });
  });
}

// คืน { text, error } — เดิมคืนสตริงว่างเมื่อ worker ล้มเหลว ทำให้ทุกความล้มเหลว (worker timeout 20 วิ,
// PDF เสีย, ไฟล์ที่เข้ารหัส) ถูกรายงานเป็นข้อความเดียวว่า "อาจเป็น PDF ที่สแกนเป็นรูป ไม่มี text layer"
// ซึ่งวินิจฉัยผิดทางและทำให้ผู้ใช้ไปแก้ปัญหาผิดจุด (ไปหา OCR ทั้งที่จริงคือไฟล์ใหญ่จน worker หมดเวลา)
async function extractPdfText(buffer) {
  const tmpFile = path.join(os.tmpdir(), 'verify-pdf-' + crypto.randomBytes(8).toString('hex') + '.pdf');
  fs.writeFileSync(tmpFile, buffer);
  try {
    const out = await execFileP(process.execPath, [PDF_WORKER, tmpFile], {
      timeout: PDF_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024, encoding: 'utf8',
    });
    if (out.ok) return { text: out.text || '' };
    return { text: '', error: out.error || 'อ่านไฟล์ไม่สำเร็จ' };
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// ws['!ref'] บางไฟล์ถูก format ทั้งชีตจน !ref บวมเกือบสุดขอบ Excel (เช่น A1:XFC1048565) ทั้งที่
// ข้อมูลจริงมีไม่กี่เซลล์ — sheet_to_csv เชื่อ !ref ตรงๆ แล้ววนสร้าง CSV ทั้งกริดจนค้างสนิท (เคยกิน
// เวลา ~2 ชม.) ต้องคำนวณขอบเขตจากเซลล์ที่มีข้อมูลจริงก่อนเสมอ (เกิดบน web handler ได้ = กระทบ availability)
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

function extractExcelText(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const parts = [];
  wb.SheetNames.forEach((name) => {
    const ws = wb.Sheets[name];
    const originalRef = ws['!ref'];
    const usedRange = computeUsedRange(ws);
    if (usedRange) ws['!ref'] = XLSX.utils.encode_range(usedRange);
    try { parts.push(XLSX.utils.sheet_to_csv(ws, { blankrows: false }).trim()); }
    finally { ws['!ref'] = originalRef; }
  });
  return parts.join('\n');
}

// คืนรูปแบบเดียวกันทุกชนิดไฟล์: { text, error? }
async function extractDocText(file) {
  if (file.ext === PDF_EXT) return extractPdfText(file.buffer);
  if (EXCEL_EXTS.has(file.ext)) return { text: extractExcelText(file.buffer) };
  return { text: '' };
}

// ── Step 3: regex field extraction ──
function findAll(text, re) {
  const out = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = r.exec(text))) {
    const val = (m[1] || m[0]).trim();
    if (val) out.push(val);
    if (r.lastIndex === m.index) r.lastIndex++;
  }
  return out;
}
function findFirst(text, re) {
  const m = re.exec(text);
  return m ? (m[1] || m[0]).trim() : null;
}
function toNum(s) {
  const n = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// รหัสอ้างอิง — เทียบแบบ exact match ได้ (format นิ่ง ไม่ใช่ตัวเลขที่เขียนได้หลายแบบ)
// multi:true = ฟิลด์ที่ shipment เดียวมีได้หลายค่าโดยถูกต้อง (ตู้หลายตู้ต่อ B/L, สินค้าหลาย HS ต่อ invoice,
// invoice หลายใบต่อล็อต) → "เจอหลายค่า" ไม่ใช่ข้อผิดพลาด และเมื่อชุดค่าต่างกันระหว่างไฟล์ก็ยังไม่ควรฟันธง
// ว่าผิด เพราะเอกสารแต่ละชนิดตั้งใจแสดงไม่ครบเท่ากันเป็นเรื่องปกติ (PL ลงทุกตู้ แต่ CI อ้างแค่ใบเดียว)
// ฟิลด์ที่ไม่ใส่ multi (poSo, blAwb) ต้องมีค่าเดียวต่อ shipment — ต่างกันคือผิดจริง
const ID_FIELD_DEFS = [
  { key: 'poSo', label: 'เลข PO/SO', re: /\b(?:KOB|BTV)(?:PO|SO)\d{4}-\d{5}\b/gi, normalize: (s) => s.toUpperCase() },
  { key: 'container', label: 'เลขตู้คอนเทนเนอร์', multi: true, re: /\b[A-Z]{4}\d{7}\b/g, normalize: (s) => s.toUpperCase() },
  { key: 'blAwb', label: 'เลข B/L หรือ AWB', re: /(?:B\/?L|BILL OF LADING|AWB|AIR ?WAY ?BILL)[\s,|]*(?:NO\.?|NUMBER|#|:)[\s,|:\-]*([A-Z0-9\-]{6,20})/gi, normalize: (s) => s.toUpperCase().replace(/[\s-]/g, '') },
  { key: 'invoiceNo', label: 'เลข Invoice/CI', multi: true, re: /(?:COMMERCIAL INVOICE|INVOICE|C\/?I)[\s,|]*(?:NO\.?|NUMBER|#|:)[\s,|:\-]*([A-Z0-9\-\/]{4,20})/gi, normalize: (s) => s.toUpperCase().replace(/\s/g, '') },
  // HS Code: เทียบแค่ 6 หลักแรก (มาตรฐานสากล) เพราะ Form E/D มี 6 หลัก ส่วนใบขนไทยมี 8-10 หลัก (2-3 หลังเป็น sub-code ของไทย) — ดู skill: "ต้องตรงกันที่ 6 หลักแรก ไม่ใช่ทั้งหมด"
  { key: 'hsCode', label: 'HS Code (6 หลักแรก)', multi: true, re: /(?:HS\s*CODE|H\.?S\.?|TARIFF\s*CODE|พิกัดศุลกากร|พิกัด)\D{0,10}(\d{4}[.\-]?\d{2}(?:[.\-]?\d{2})?(?:[-\s]?\d{2,3})?)/gi, normalize: (s) => s.replace(/\D/g, '').slice(0, 6) },
];

// field ตัวเลข — ไม่ assert match/mismatch (format ต่างกันได้เยอะ) แค่โชว์ candidate ให้ตรวจเอง
const NUMERIC_FIELD_DEFS = [
  { key: 'totalAmount', label: 'ยอดรวม (Total)', re: /(?:GRAND\s*TOTAL|TOTAL\s*AMOUNT|TOTAL\s*VALUE|AMOUNT\s*DUE)\D{0,15}([\d,]+\.?\d*)/gi },
  { key: 'totalQty', label: 'จำนวนรวม (Qty)', re: /(?:TOTAL\s*QTY|TOTAL\s*PCS|TOTAL\s*CARTONS?|TOTAL\s*BOXES)\D{0,10}([\d,]+\.?\d*)/gi },
  { key: 'netWeight', label: 'น้ำหนักสุทธิ (Net Weight)', re: /NET\s*WEIGHT\D{0,10}([\d,]+\.?\d*)/gi },
  { key: 'grossWeight', label: 'น้ำหนักรวม (Gross Weight)', re: /GROSS\s*WEIGHT\D{0,10}([\d,]+\.?\d*)/gi },
];

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
// วันที่ไทยมักเป็น พ.ศ. (ปี ค.ศ. + 543) — ปีที่ >= 2400 ให้ถือว่าเป็น พ.ศ. แล้วแปลงเป็น ค.ศ. ก่อนเทียบเสมอ
// (ดู skill: "Always normalize to CE before comparing dates")
function beToCe(year) { return year >= 2400 ? year - 543 : year; }
function parseDateLoose(s) {
  if (!s) return null;
  let m = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/.exec(s);
  if (m) return `${beToCe(+m[3])}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  m = /(\d{1,2})[\s\-]([A-Za-z]{3})[\s\-](\d{4})/.exec(s);
  if (m && MONTHS[m[2].toUpperCase()]) return `${beToCe(+m[3])}-${String(MONTHS[m[2].toUpperCase()]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return null;
}
function findEtd(text) {
  const m = /(?:SHIPPED\s*ON\s*BOARD|ON\s*BOARD\s*DATE|LADEN\s*ON\s*BOARD|FLIGHT\s*DATE)\D{0,20}(\d{1,2}[\/\-.\s][A-Za-z0-9]{1,4}[\/\-.\s]\d{4})/i.exec(text);
  return m ? parseDateLoose(m[1]) : null;
}

// ── ตารางอ้างอิง Thai customs (จาก skill — ดู header ของไฟล์) ──
// อากรนำเข้า (MFN) ตามหมวดสินค้าที่ KOB สั่งเข้าจริง (Packaging/บรรจุภัณฑ์/เครื่องสำอาง)
const HS_IMPORT_DUTY = [
  { prefix: '330410', label: 'Lip make-up', mfnPct: 20 },
  { prefix: '330420', label: 'Eye make-up', mfnPct: 20 },
  { prefix: '330491', label: 'แป้ง (Powder)', mfnPct: 20 },
  { prefix: '3304', label: 'เครื่องสำอาง/สกินแคร์ (ทั่วไป)', mfnPct: 20 },
  { prefix: '3305', label: 'ผลิตภัณฑ์ผม (แชมพู/ครีมนวด)', mfnPct: 20 },
  { prefix: '3306', label: 'ยาสีฟัน', mfnPct: 20 },
  { prefix: '3307', label: 'ผลิตภัณฑ์ระงับกลิ่นกาย', mfnPct: 20 },
  { prefix: '3401', label: 'สบู่เหลว/ครีมอาบน้ำ', mfnPct: 20 },
  { prefix: '5601', label: 'สำลี/แผ่นสำลี (cotton pad)', mfnPct: 5, ftaNote: 'ACFTA (Form E): 0%' },
  { prefix: '3923', label: 'บรรจุภัณฑ์พลาสติก (ขวด/ฝา)', mfnPct: 10 },
  { prefix: '4819', label: 'กล่อง/ลังกระดาษ', mfnPct: 10 },
];
// อากรขาออกสินค้า KOB เอง — เครื่องสำอางแทบทั้งหมดไม่มีอากรขาออก
const HS_EXPORT_DUTY = [
  { prefix: '330300', label: 'น้ำหอม (EDP/EDT/Perfume Mist)', dutyThb: 0 },
  { prefix: '330491', label: 'แป้ง (Powder)', dutyThb: 0 },
  { prefix: '330499', label: 'Body Lotion/Serum/Mask/Underarm Serum', dutyThb: 0 },
  { prefix: '330510', label: 'แชมพู (Shampoo)', dutyThb: 0 },
];
function lookupHsDuty(table, hs6) {
  const matches = table.filter((e) => hs6.startsWith(e.prefix) || e.prefix.startsWith(hs6));
  if (!matches.length) return null;
  matches.sort((a, b) => b.prefix.length - a.prefix.length); // เอา prefix เจาะจงที่สุดก่อน
  return matches[0];
}

const VALID_ORIGIN_CRITERIA = new Set(['WO', 'PE', 'RVC', 'CTC', 'CTH', 'CTSH', 'PSR']);
const FTA_TABLE = {
  ACN: 'ACFTA (ASEAN-China) — Form E', AAN: 'ATIGA (ASEAN) — Form D', AKR: 'AKFTA (ASEAN-Korea) — Form AK',
  AJP: 'AJCEP (ASEAN-Japan) — Form AJ', AAU: 'AANZFTA — Form AANZ', ANZ: 'AANZFTA — Form AANZ',
  AIN: 'AIFTA (ASEAN-India) — Form AI', AHK: 'AHKFTA — Form AHK', RCE: 'RCEP — Form RCEP',
  JTE: 'JTEPA (Japan-Thailand) — Form JTEPA', TAF: 'TAFTA (Thailand-Australia) — Form TAFTA',
  TIN: 'TIFTA (Thailand-India) — Form TI', TPE: 'TPFTA (Thailand-Peru) — Form TP', TNZ: 'TNZCEP — Form TNZCEP',
};
// ชื่อ FTA แบบเต็มที่ผู้ใช้อาจพิมพ์ในช่องหมายเหตุ → รหัสสิทธิพิเศษที่ควรเจอในเอกสาร
const FTA_NAME_TO_CODE = {
  ACFTA: 'ACN', ATIGA: 'AAN', AKFTA: 'AKR', AJCEP: 'AJP', AANZFTA: 'AAU', AIFTA: 'AIN',
  AHKFTA: 'AHK', RCEP: 'RCE', JTEPA: 'JTE', TAFTA: 'TAF', TIFTA: 'TIN', TPFTA: 'TPE', TNZCEP: 'TNZ',
};

// FTA special code ปนเกลื่อนได้ง่าย (3 ตัวอักษร) — จำกัดให้หาเฉพาะไฟล์ที่ดูเหมือนเป็น Form E/D/CO จริงๆ
// เท่านั้น กัน false positive จากคำสามตัวอักษรทั่วไปใน CI/PL/BL
function findFtaCode(text) {
  if (!/CERTIFICATE OF ORIGIN|FORM\s*[ED]\b|รหัสสิทธิพิเศษ|สิทธิพิเศษทางภาษี/i.test(text)) return null;
  const m = /\b(ACN|AAN|AKR|AJP|AAU|ANZ|AIN|AHK|RCE|JTE|TAF|TIN|TPE|TNZ)\b/.exec(text);
  return m ? m[1] : null;
}

// ── Written Amount (ตัวอักษร) vs Sub Total (ตัวเลข) — ปัญหาที่เจอซ้ำจริงกับ KOB (⭐ ดู skill export) ──
const W2N_ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const W2N_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function wordsToNumber(phrase) {
  const words = phrase.toLowerCase().replace(/-/g, ' ').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  let total = 0, current = 0, matched = false;
  for (const w of words) {
    if (w in W2N_ONES) { current += W2N_ONES[w]; matched = true; }
    else if (w in W2N_TENS) { current += W2N_TENS[w]; matched = true; }
    else if (w === 'hundred') { current = (current || 1) * 100; matched = true; }
    else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; matched = true; }
    else if (w === 'million') { total += (current || 1) * 1000000; current = 0; matched = true; }
  }
  total += current;
  return matched ? total : null;
}
const WRITTEN_AMOUNT_RE = /(?:SAY\s+)?(?:US\s*)?(?:DOLLARS?|BAHT|YUAN|RMB|EURO|POUNDS?)\s+([A-Z][A-Za-z\s\-]{5,90}?)(?:AND\s+(\d{1,2})\s*\/\s*100)?\s*ONLY\b/i;
function findWrittenAmount(text) {
  const m = WRITTEN_AMOUNT_RE.exec(text);
  if (!m) return null;
  const dollars = wordsToNumber(m[1]);
  if (dollars == null) return null;
  const cents = m[2] ? parseInt(m[2], 10) : 0;
  return { value: dollars + cents / 100, raw: m[0].trim() };
}

// ── Port of Loading vs Destination — เจอเคสจริงที่ปลายทางถูกกรอกผิดเป็นท่าไทยเอง (ดู skill export) ──
const THAI_PORT_HINTS = /LAEM\s*CHABANG|BANGKOK|THAILAND|SUVARNABHUMI/i;
function checkPortSanity(text) {
  // filler ระหว่าง label กับค่า: จำกัดเฉพาะตัวคั่น (เว้นวรรค/colon/quote/comma) ห้ามใช้ \D เฉยๆ
  // เพราะ \D จะกินตัวอักษรตัวแรกของชื่อท่าเรือ (A-Z ก็เป็น non-digit เหมือนกัน) ไปด้วยแบบ greedy
  const SEP = '[\\s:\\-"\',]{0,5}';
  const pol = findFirst(text, new RegExp('PORT\\s*OF\\s*LOADING' + SEP + '([A-Z][A-Z .,\\-]{2,39})', 'i'));
  const pod = findFirst(text, new RegExp('(?:PORT\\s*OF\\s*DESTINATION|FINAL\\s*DESTINATION|PORT\\s*OF\\s*DISCHARGE)' + SEP + '([A-Z][A-Z .,\\-]{2,39})', 'i'));
  if (!pol || !pod) return null;
  if (THAI_PORT_HINTS.test(pod)) return { pol, pod, issue: 'destination-is-thailand' };
  if (pol.trim().toUpperCase() === pod.trim().toUpperCase()) return { pol, pod, issue: 'same-port' };
  return null;
}

// ── Step 4: cross-check ──
async function verifyShipmentLocal(req) {
  const { mode, po, note, files } = await parseMultipart(req);
  const perFile = [];
  const filesSkipped = [];

  for (const f of files) {
    if (IMAGE_EXTS.has(f.ext)) {
      filesSkipped.push({ name: f.name, reason: 'เป็นไฟล์รูปภาพ — ไม่มี OCR ในเครื่อง จึงตรวจอัตโนมัติไม่ได้ กรุณาตรวจด้วยตาเอง' });
      continue;
    }
    if (f.ext !== PDF_EXT && !EXCEL_EXTS.has(f.ext)) {
      filesSkipped.push({ name: f.name, reason: `นามสกุลไฟล์ไม่รองรับ (${f.ext || 'ไม่ทราบ'})` });
      continue;
    }
    let text = '', extractErr = null;
    try { const r = await extractDocText(f); text = r.text || ''; extractErr = r.error || null; }
    catch (e) { text = ''; extractErr = e.message; }
    if (!text.trim()) {
      filesSkipped.push({
        name: f.name,
        reason: extractErr
          ? (/timeout|killed/i.test(extractErr)
              ? `ใช้เวลาแกะข้อความเกิน ${PDF_TIMEOUT_MS / 1000} วินาที — ไฟล์อาจใหญ่/ซับซ้อนเกินไป ลองแยกหน้าหรือบีบอัดก่อน`
              : `อ่านไฟล์ไม่สำเร็จ (${extractErr})`)
          : 'ไม่มีข้อความในไฟล์ (น่าจะเป็น PDF ที่สแกนเป็นรูป ไม่มี text layer) — ไม่มี OCR ในเครื่อง จึงตรวจอัตโนมัติไม่ได้',
      });
      continue;
    }
    // เดิมเก็บ textUpper (สำเนา uppercase ของข้อความทั้งไฟล์) ไว้ด้วย แต่ไม่มีจุดไหนอ่านใช้เลย —
    // เปลืองหน่วยความจำเท่าตัวต่อไฟล์ฟรีๆ (อัปโหลดได้ถึง 15 ไฟล์/ครั้ง)
    perFile.push({ name: f.name, text });
  }

  if (!perFile.length) {
    return {
      ok: true, po, status: 'error',
      sections: { correct: [], review: [], errors: [] },
      summary: 'ไม่มีไฟล์ไหนที่อ่านข้อความได้เลย — การตรวจสอบในเครื่องรองรับเฉพาะ PDF ที่มี text layer จริงกับไฟล์ Excel/CSV เท่านั้น (ไม่มี OCR สำหรับรูปภาพหรือ PDF ที่สแกนเป็นรูป) กรุณาตรวจเอกสารเหล่านี้ด้วยตาเอง',
      taxCheck: null, shipmentInfo: null,
      meta: { mode, filesProcessed: 0, filesSkipped, engine: 'local-rule-based' },
    };
  }

  const correct = [], review = [], errors = [];
  const idFoundByKey = {};

  // ── รหัสอ้างอิง exact-match (PO/SO, ตู้, B/L-AWB, Invoice, HS 6 หลักแรก) ──
  for (const fd of ID_FIELD_DEFS) {
    const foundIn = [];
    perFile.forEach((pf) => {
      findAll(pf.text, fd.re).forEach((v) => foundIn.push({ file: pf.name, raw: v, norm: fd.normalize(v) }));
    });
    idFoundByKey[fd.key] = foundIn;
    if (!foundIn.length) continue;
    const filesInvolved = [...new Set(foundIn.map((x) => x.file))];
    // สรุปเป็น "ชุดค่าต่อไฟล์" ก่อนเทียบ — เดิมเทียบจำนวนค่าที่ไม่ซ้ำกันทั้งกอง (distinctNorms.length === 1)
    // แปลว่า shipment ใดมีตู้มากกว่า 1 ตู้ หรือมีสินค้าหลาย HS code (ซึ่งเป็นเรื่องปกติมาก) จะถูกฟันธงเป็น
    // "ไม่ตรงกันระหว่างไฟล์" = error ทันที ทั้งที่เอกสารถูกต้องทุกใบ — ทำให้ผลตรวจมี error ปลอมเกือบทุกรอบ
    // จนหมวด "ต้องแก้ไข" เชื่อถือไม่ได้ ตอนนี้เทียบว่า "แต่ละไฟล์ระบุค่าชุดเดียวกันไหม" แทน
    const perFileSets = filesInvolved.map((f) => ({
      file: f,
      set: [...new Set(foundIn.filter((x) => x.file === f).map((x) => x.norm))].sort(),
    }));
    const rawsOf = (f) => [...new Set(foundIn.filter((x) => x.file === f).map((x) => x.raw))].join(', ');
    const allValues = [...new Set(foundIn.map((x) => x.norm))];
    const sameAcrossFiles = perFileSets.every((p) => p.set.join('|') === perFileSets[0].set.join('|'));
    if (filesInvolved.length < 2) {
      review.push(`🟡 ${fd.label} พบเฉพาะใน "${filesInvolved[0]}" (${rawsOf(filesInvolved[0])}) — ไม่มีไฟล์อื่นให้เทียบ`);
    } else if (sameAcrossFiles) {
      const detail = allValues.length > 1 ? `${allValues.length} ค่า: ${rawsOf(filesInvolved[0])}` : rawsOf(filesInvolved[0]);
      correct.push(`${fd.label} ตรงกันทุกไฟล์ที่พบ (${filesInvolved.length} ไฟล์: ${filesInvolved.join(', ')}): ${detail}`);
    } else {
      const detail = perFileSets.map((p) => `${p.file}=${rawsOf(p.file)}`).join(' | ');
      // ฟิลด์ multi ต่างกันได้โดยไม่ผิด (เอกสารแต่ละชนิดแสดงไม่ครบเท่ากัน) → ให้คนตรวจตัดสิน ไม่ฟันธงว่าผิด
      if (fd.multi) review.push(`🟡 ${fd.label} ระบุไม่เหมือนกันในแต่ละไฟล์ — ปกติได้ถ้าเอกสารตั้งใจแสดงไม่ครบเท่ากัน แต่ควรไล่ดูว่าไม่มีตัวไหนตกหล่น: ${detail}`);
      else errors.push(`${fd.label} ไม่ตรงกันระหว่างไฟล์: ${detail}`);
    }
  }

  if (po) {
    const normPo = po.toUpperCase();
    const poFound = (idFoundByKey.poSo || []).some((x) => x.norm === normPo);
    if (!poFound) review.push(`🟡 ไม่พบเลข PO/SO "${po}" ที่ระบุไว้ ในเอกสารที่แนบมาเลย (อาจปกติถ้าเอกสารไม่ได้พิมพ์เลขอ้างอิงภายในไว้)`);
  }

  // ── ตัวเลข (candidate เฉยๆ ไม่ assert match) ──
  for (const fd of NUMERIC_FIELD_DEFS) {
    const foundIn = [];
    perFile.forEach((pf) => {
      findAll(pf.text, fd.re).forEach((v) => foundIn.push({ file: pf.name, raw: v }));
    });
    if (!foundIn.length) continue;
    review.push(`🔎 ${fd.label} พบในเอกสาร (ต้องตรวจเทียบด้วยตาเอง เพราะ format ตัวเลขต่างกันได้): ${foundIn.map((x) => `${x.file}=${x.raw}`).join(', ')}`);
  }

  // ── Net > Gross weight — เป็นไปไม่ได้จริง ถือเป็น error เสมอ (ดู skill: "Net > Gross: impossible") ──
  perFile.forEach((pf) => {
    const net = toNum(findFirst(pf.text, /NET\s*WEIGHT\D{0,10}([\d,]+\.?\d*)/i));
    const gross = toNum(findFirst(pf.text, /GROSS\s*WEIGHT\D{0,10}([\d,]+\.?\d*)/i));
    if (net != null && gross != null && net > gross) {
      errors.push(`น้ำหนักสุทธิมากกว่าน้ำหนักรวมใน "${pf.name}" (Net ${net} > Gross ${gross}) — เป็นไปไม่ได้ทางกายภาพ ต้องมีค่าใดค่าหนึ่งผิด`);
    }
  });

  // ── Thai Tax ID (13 หลัก) — เช็ครูปแบบถ้าเจอ label ชัดเจน ──
  perFile.forEach((pf) => {
    const m = /(?:TAX\s*I\.?D\.?|เลขประจำตัวผู้เสียภาษี)\D{0,5}(\d[\d\s-]{10,18}\d)/i.exec(pf.text);
    if (!m) return;
    const digits = m[1].replace(/\D/g, '');
    if (digits.length !== 13) {
      review.push(`🟡 เลขประจำตัวผู้เสียภาษีใน "${pf.name}" มี ${digits.length} หลัก (ปกติต้อง 13 หลัก) — ตรวจสอบว่าพิมพ์ครบหรือไม่: ${m[1].trim()}`);
    }
  });

  // ── Origin Criteria — ต้องเป็นหนึ่งใน WO/PE/RVC/CTC/CTH/CTSH/PSR เท่านั้น ──
  perFile.forEach((pf) => {
    const m = /ORIGIN\s*CRITERIA\D{0,10}\b([A-Z]{2,6})\b/i.exec(pf.text);
    if (!m) return;
    const code = m[1].toUpperCase();
    if (!VALID_ORIGIN_CRITERIA.has(code)) {
      review.push(`🟡 พบรหัส Origin Criteria "${code}" ใน "${pf.name}" ที่ไม่ใช่ค่ามาตรฐาน (ต้องเป็น WO/PE/RVC/CTC/CTH/CTSH/PSR) — ตรวจสอบว่าอ่าน/พิมพ์ถูกหรือไม่`);
    }
  });

  // ── FTA special code — ข้อมูลอ้างอิงเฉยๆ (ไม่ assert ถูก/ผิด เพราะไม่รู้ประเทศจริง) ──
  const ftaFoundFiles = [];
  perFile.forEach((pf) => {
    const code = findFtaCode(pf.text);
    if (code) { ftaFoundFiles.push({ file: pf.name, code }); review.push(`🔎 พบรหัสสิทธิพิเศษ FTA "${code}" (${FTA_TABLE[code] || code}) ใน "${pf.name}"`); }
  });

  // ── HS code → duty rate ตามตารางอ้างอิง (informational — ไม่ assert error) ──
  (idFoundByKey.hsCode || []).forEach((x) => {
    const table = mode === 'export' ? HS_EXPORT_DUTY : HS_IMPORT_DUTY;
    const entry = lookupHsDuty(table, x.norm);
    if (!entry) return;
    if (mode === 'export') {
      review.push(`🔎 HS ${x.raw} (${entry.label}) ปกติไม่มีอากรขาออก (${entry.dutyThb} บาท) ตามข้อมูลสินค้า KOB`);
    } else {
      review.push(`🔎 HS ${x.raw} (${entry.label}) อัตราอากร MFN ปกติคือ ${entry.mfnPct}%${entry.ftaNote ? ' — ' + entry.ftaNote : ''} — ตรวจสอบว่าใบขนใช้อัตรานี้หรือใช้สิทธิ FTA`);
    }
  });

  // ── Written Amount (ตัวอักษร) vs ยอดตัวเลข — ปัญหาที่เจอซ้ำจริง (⭐ ดู skill export) ──
  perFile.forEach((pf) => {
    const written = findWrittenAmount(pf.text);
    if (!written) return;
    const numericMatches = findAll(pf.text, /(?:GRAND\s*TOTAL|TOTAL\s*AMOUNT|TOTAL\s*VALUE|SUB\s*TOTAL)\D{0,15}([\d,]+\.?\d*)/gi).map(toNum).filter((n) => n != null);
    if (!numericMatches.length) return;
    const closest = numericMatches.reduce((a, b) => (Math.abs(b - written.value) < Math.abs(a - written.value) ? b : a));
    if (Math.abs(closest - written.value) > 0.02) {
      errors.push(`Written Amount (ตัวอักษร) ไม่ตรงกับยอดตัวเลขใน "${pf.name}": เขียนว่า ${written.value.toLocaleString()} แต่ตัวเลขในเอกสารแสดง ${closest.toLocaleString()} — เป็นปัญหาที่เจอซ้ำหลายครั้งจริงกับเอกสารลักษณะนี้ (สูตร Excel ไม่อัปเดตตามยอดล่าสุด)`);
    } else {
      correct.push(`Written Amount ตรงกับยอดตัวเลขใน "${pf.name}" (${written.value.toLocaleString()})`);
    }
  });

  // ── Port of Loading vs Destination (export) — เจอเคสจริงที่กรอกปลายทางผิดเป็นท่าไทยเอง ──
  if (mode === 'export') {
    perFile.forEach((pf) => {
      const r = checkPortSanity(pf.text);
      if (!r) return;
      if (r.issue === 'destination-is-thailand') {
        errors.push(`"${pf.name}": Port of Destination ดูเหมือนเป็นท่าในไทยเอง ("${r.pod}") — shipment ขาออกต้องมีปลายทางเป็นต่างประเทศ ตรวจสอบว่ากรอกผิดช่องหรือไม่`);
      } else {
        review.push(`🟡 "${pf.name}": Port of Loading กับ Port of Destination เป็นค่าเดียวกัน ("${r.pol}") — ตรวจสอบว่ากรอกถูกต้องหรือไม่`);
      }
    });
  }

  // ── หมายเหตุจากผู้ใช้ (free text hint — จับคำสำคัญง่ายๆ เท่านั้น ไม่ใช่ AI เข้าใจภาษาธรรมชาติ) ──
  if (note) {
    const noteUpper = note.toUpperCase();
    for (const [ftaName, code] of Object.entries(FTA_NAME_TO_CODE)) {
      if (!noteUpper.includes(ftaName)) continue;
      const foundThisCode = ftaFoundFiles.some((x) => x.code === code);
      if (!foundThisCode) {
        review.push(`🟡 ระบุว่าใช้สิทธิ ${ftaName} แต่ไม่พบรหัสสิทธิพิเศษ "${code}" หรือคำว่า Certificate of Origin/Form E/D ในเอกสารที่แนบมาเลย`);
      }
      break;
    }
    const noteHs = findFirst(note, /\b\d{4}[.\-]?\d{2}(?:[.\-]?\d{2})?\b/);
    if (noteHs) {
      const hs6 = noteHs.replace(/\D/g, '').slice(0, 6);
      const foundHere = (idFoundByKey.hsCode || []).some((x) => x.norm === hs6);
      if (!foundHere) review.push(`🟡 ระบุ HS Code "${noteHs}" ในหมายเหตุ แต่ไม่พบ HS code ที่ขึ้นต้นด้วย ${hs6} ในเอกสารที่แนบมาเลย`);
    }
  }

  // ── shipmentInfo: หาเฉพาะไฟล์ที่ดูเหมือน B/L หรือ AWB ──
  let shipmentInfo = null;
  const blAwbFiles = new Set((idFoundByKey.blAwb || []).map((x) => x.file));
  perFile.forEach((pf) => {
    if (!blAwbFiles.has(pf.name) && !/B\/?L|BILL OF LADING|AWB|AIR ?WAY ?BILL/i.test(pf.name)) return;
    const etd = findEtd(pf.text);
    const vesselM = /VESSEL[\s\/,|]*(?:VOY\.?(?:AGE)?\s*NO\.?)?[\s,|:\-]*([A-Z0-9 .\-\/]{3,40})/i.exec(pf.text);
    const polM = /PORT\s*OF\s*LOADING[\s,|:\-]*([A-Z0-9 ,.\-\/]{3,40})/i.exec(pf.text);
    const blNoEntry = (idFoundByKey.blAwb || []).find((x) => x.file === pf.name);
    if (!shipmentInfo || etd) {
      shipmentInfo = {
        etd: etd || (shipmentInfo && shipmentInfo.etd) || null,
        vessel: (vesselM ? vesselM[1].trim() : (shipmentInfo && shipmentInfo.vessel)) || '',
        blOrAwbNo: (blNoEntry ? blNoEntry.raw : (shipmentInfo && shipmentInfo.blOrAwbNo)) || '',
        portOfLoading: (polM ? polM[1].trim() : (shipmentInfo && shipmentInfo.portOfLoading)) || '',
        // ชื่อไฟล์ที่ค่าชุดนี้ถูกสกัดออกมา — ฝั่ง server เอาไปเป็น ref ของ provenance (`verify:<ไฟล์>`)
        // ต้องมี ไม่งั้นบันทึกได้แค่ว่า "มาจากการอัปโหลด" ซึ่งตามกลับไปหาเอกสารต้นทางไม่ได้
        sourceFile: pf.name,
      };
    }
  });

  const status = errors.length ? 'issues_found' : 'pass';
  const summary = `ตรวจสอบด้วยกฎในเครื่อง (ไม่มีการส่งข้อมูลออกนอกเครื่อง ไม่มีค่าใช้จ่าย เสริมความรู้ Thai customs จาก skill thai-${mode}-declaration-verifier) จากไฟล์ที่อ่านได้ ${perFile.length}/${files.length} ไฟล์ ` +
    `พบตรงกัน ${correct.length} รายการ, ควรตรวจสอบเพิ่ม ${review.length} รายการ, ไม่ตรงกัน/ผิดปกติ ${errors.length} รายการ. ` +
    `ขอบเขต: เทียบรหัสอ้างอิงแบบ exact-match, ตรวจ sanity check ที่คำนวณได้ชัดเจน (น้ำหนัก, written amount, HS 6 หลัก) และดึงตัวเลข/ตารางอ้างอิงมาโชว์ — ` +
    `แต่ไม่สามารถ "ตัดสินใจ" แบบที่ AI ทำได้ (เช่น แยกแยะว่าอะไรเป็นแค่ placeholder ในร่างกับอะไรคือ error จริง, ตีความ Box ต่างๆ ใน Form E/D) กรุณาตรวจรายการในหมวด "ควรตรวจสอบ" ด้วยตาเองก่อนสรุปผล`;

  return {
    ok: true, po, status,
    sections: { correct, review, errors },
    summary,
    taxCheck: null,
    shipmentInfo,
    meta: { mode, filesProcessed: perFile.length, filesSkipped, engine: 'local-rule-based+thai-customs-tables' },
  };
}

module.exports = { verifyShipmentLocal };

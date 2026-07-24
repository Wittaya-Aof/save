// ─── Local rule-based document cross-check ("ตรวจเอกสาร") ──────────────────
// แทนที่เวอร์ชัน AI เดิม (lib/verify-shipment.js) ที่ต้องเรียก Anthropic API จริงทุกครั้ง
// (มีค่าใช้จ่าย + ต้องมี ANTHROPIC_API_KEY ที่ใช้งานได้) — เวอร์ชันนี้ทำงาน 100% ในเครื่อง
// ไม่มี network call ออกไปที่ไหนเลย โดยแลกกับความสามารถ: อ่านได้เฉพาะ PDF ที่มี text layer จริง
// กับไฟล์ Excel/CSV (ไม่มี OCR ในเครื่อง — รูปภาพ/PDF ที่สแกนเป็นรูปจะข้ามไปให้ตรวจด้วยตาเอง) และ
// เทียบแบบ regex/keyword เท่านั้น ไม่ใช่ความเข้าใจเอกสารแบบ AI — ดู README/summary ที่ส่งกลับมา
// ทุกครั้งเพื่อรู้ขอบเขตที่แท้จริงของการตรวจรอบนั้นๆ
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

// ── Step 1: parse multipart upload (เหมือน lib/verify-shipment.js) ──
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
      resolve({ mode: req._verifyMode === 'export' ? 'export' : 'import', po: (req._verifyPo || '').trim(), files });
    });
    bb.on('error', (e) => reject(e));
    req.pipe(bb);
  });
}

// ── Step 2: local text extraction (ไม่มี network call) ──
function execFileP(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (err, stdout) => {
      if (err) { resolve({ ok: false, error: err.killed ? 'timeout/killed' : err.message }); return; }
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve({ ok: false, error: 'worker output ไม่ใช่ JSON' }); }
    });
  });
}

// รัน pdf-extract-worker.cjs เป็น subprocess แยกต่อไฟล์ — pdf-parse มี resource leak สะสมข้าม
// การเรียกในโปรเซสเดียวกัน (ดู comment เต็มใน lib/pdf-extract-worker.cjs) ใช้ execFile แบบ async
// (ไม่ใช่ execFileSync) เพราะโค้ดนี้รันอยู่ใน api-server.js โปรเซสหลักที่เสิร์ฟ request อื่นพร้อมกัน
// อยู่ด้วย — sync call จะบล็อก event loop ทั้งตัวระหว่างรอ child process
async function extractPdfText(buffer) {
  const tmpFile = path.join(os.tmpdir(), 'verify-pdf-' + crypto.randomBytes(8).toString('hex') + '.pdf');
  fs.writeFileSync(tmpFile, buffer);
  try {
    const out = await execFileP(process.execPath, [PDF_WORKER, tmpFile], {
      timeout: PDF_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024, encoding: 'utf8',
    });
    return out.ok ? (out.text || '') : '';
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

function extractExcelText(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const parts = [];
  wb.SheetNames.forEach((name) => {
    parts.push(XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false }).trim());
  });
  return parts.join('\n');
}

async function extractDocText(file) {
  if (file.ext === PDF_EXT) return extractPdfText(file.buffer);
  if (EXCEL_EXTS.has(file.ext)) return extractExcelText(file.buffer);
  return null;
}

// ── Step 3: regex field extraction ──
function findAll(text, re) {
  const out = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = r.exec(text))) {
    const val = (m[1] || m[0]).trim();
    if (val) out.push(val);
    if (r.lastIndex === m.index) r.lastIndex++; // กัน infinite loop กับ zero-width match
  }
  return out;
}

// field ที่เป็น "รหัสอ้างอิง" ล้วนๆ — เทียบแบบ exact match ได้ (ไม่ใช่ตัวเลขที่ format ต่างกันได้)
const ID_FIELD_DEFS = [
  { key: 'poSo', label: 'เลข PO/SO', re: /\b(?:KOB|BTV)(?:PO|SO)\d{4}-\d{5}\b/gi, normalize: (s) => s.toUpperCase() },
  { key: 'container', label: 'เลขตู้คอนเทนเนอร์', re: /\b[A-Z]{4}\d{7}\b/g, normalize: (s) => s.toUpperCase() },
  { key: 'blAwb', label: 'เลข B/L หรือ AWB', re: /(?:B\/?L|BILL OF LADING|AWB|AIR ?WAY ?BILL)\s*(?:NO\.?|NUMBER|#|:)\s*[:\-]?\s*([A-Z0-9\-]{6,20})/gi, normalize: (s) => s.toUpperCase().replace(/[\s-]/g, '') },
  { key: 'invoiceNo', label: 'เลข Invoice/CI', re: /(?:COMMERCIAL INVOICE|INVOICE|C\/?I)\s*(?:NO\.?|NUMBER|#|:)\s*[:\-]?\s*([A-Z0-9\-\/]{4,20})/gi, normalize: (s) => s.toUpperCase().replace(/\s/g, '') },
];

// field ตัวเลข — ไม่ assert match/mismatch (format ต่างกันได้เยอะ, ความเสี่ยง false positive สูง)
// แค่ดึงมาโชว์เป็น candidate ให้คนตรวจเอง ใน section "review"
const NUMERIC_FIELD_DEFS = [
  { key: 'totalAmount', label: 'ยอดรวม (Total)', re: /(?:GRAND\s*TOTAL|TOTAL\s*AMOUNT|TOTAL\s*VALUE|AMOUNT\s*DUE)\D{0,15}([\d,]+\.?\d*)/gi },
  { key: 'totalQty', label: 'จำนวนรวม (Qty)', re: /(?:TOTAL\s*QTY|TOTAL\s*PCS|TOTAL\s*CARTONS?|TOTAL\s*BOXES)\D{0,10}([\d,]+\.?\d*)/gi },
  { key: 'netWeight', label: 'น้ำหนักสุทธิ (Net Weight)', re: /NET\s*WEIGHT\D{0,10}([\d,]+\.?\d*)/gi },
  { key: 'grossWeight', label: 'น้ำหนักรวม (Gross Weight)', re: /GROSS\s*WEIGHT\D{0,10}([\d,]+\.?\d*)/gi },
];

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
function parseDateLoose(s) {
  if (!s) return null;
  let m = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/.exec(s); // DD/MM/YYYY หรือ DD-MM-YYYY
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  m = /(\d{1,2})[\s\-]([A-Za-z]{3})[\s\-](\d{4})/.exec(s); // DD-MMM-YYYY
  if (m && MONTHS[m[2].toUpperCase()]) return `${m[3]}-${String(MONTHS[m[2].toUpperCase()]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return null;
}
// หาวันที่ "Shipped on Board" / "On Board Date" / "Flight Date" ใกล้ๆ label — ไม่เดาถ้าไม่เจอชัดเจน
function findEtd(text) {
  const m = /(?:SHIPPED\s*ON\s*BOARD|ON\s*BOARD\s*DATE|LADEN\s*ON\s*BOARD|FLIGHT\s*DATE)\D{0,20}(\d{1,2}[\/\-.\s][A-Za-z0-9]{1,4}[\/\-.\s]\d{4})/i.exec(text);
  return m ? parseDateLoose(m[1]) : null;
}

// ── Step 4: cross-check ──
async function verifyShipmentLocal(req) {
  const { mode, po, files } = await parseMultipart(req);
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
    let text = '';
    try { text = await extractDocText(f); } catch (e) { text = ''; }
    if (!text || !text.trim()) {
      filesSkipped.push({ name: f.name, reason: 'อ่านข้อความจากไฟล์ไม่ได้ (อาจเป็น PDF ที่สแกนเป็นรูป ไม่มี text layer)' });
      continue;
    }
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

  for (const fd of ID_FIELD_DEFS) {
    const foundIn = [];
    perFile.forEach((pf) => {
      findAll(pf.text, fd.re).forEach((v) => foundIn.push({ file: pf.name, raw: v, norm: fd.normalize(v) }));
    });
    idFoundByKey[fd.key] = foundIn;
    if (!foundIn.length) continue;
    const distinctNorms = [...new Set(foundIn.map((x) => x.norm))];
    const filesInvolved = [...new Set(foundIn.map((x) => x.file))];
    if (filesInvolved.length < 2) {
      review.push(`🟡 ${fd.label} พบเฉพาะใน "${filesInvolved[0]}" (${foundIn[0].raw}) — ไม่มีไฟล์อื่นให้เทียบ`);
    } else if (distinctNorms.length === 1) {
      correct.push(`${fd.label} ตรงกันทุกไฟล์ที่พบ (${filesInvolved.length} ไฟล์: ${filesInvolved.join(', ')}): ${foundIn[0].raw}`);
    } else {
      errors.push(`${fd.label} ไม่ตรงกันระหว่างไฟล์: ${foundIn.map((x) => `${x.file}=${x.raw}`).join(', ')}`);
    }
  }

  if (po) {
    const normPo = po.toUpperCase();
    const poFound = (idFoundByKey.poSo || []).some((x) => x.norm === normPo);
    if (!poFound) review.push(`🟡 ไม่พบเลข PO/SO "${po}" ที่ระบุไว้ ในเอกสารที่แนบมาเลย (อาจปกติถ้าเอกสารไม่ได้พิมพ์เลขอ้างอิงภายในไว้)`);
  }

  for (const fd of NUMERIC_FIELD_DEFS) {
    const foundIn = [];
    perFile.forEach((pf) => {
      findAll(pf.text, fd.re).forEach((v) => foundIn.push({ file: pf.name, raw: v }));
    });
    if (!foundIn.length) continue;
    review.push(`🔎 ${fd.label} พบในเอกสาร (ต้องตรวจเทียบด้วยตาเอง เพราะ format ตัวเลขต่างกันได้): ${foundIn.map((x) => `${x.file}=${x.raw}`).join(', ')}`);
  }

  // shipmentInfo: พยายามหาเฉพาะไฟล์ที่ดูเหมือน B/L หรือ AWB (เจอ blAwb no. ในไฟล์นั้น หรือ filename ใบ้)
  let shipmentInfo = null;
  const blAwbFiles = new Set((idFoundByKey.blAwb || []).map((x) => x.file));
  perFile.forEach((pf) => {
    if (!blAwbFiles.has(pf.name) && !/B\/?L|BILL OF LADING|AWB|AIR ?WAY ?BILL/i.test(pf.name)) return;
    const etd = findEtd(pf.text);
    const vesselM = /VESSEL[\s\/]*(?:VOY\.?(?:AGE)?\s*NO\.?)?\s*[:\-]?\s*([A-Z0-9 .\-\/]{3,40})/i.exec(pf.text);
    const polM = /PORT\s*OF\s*LOADING\s*[:\-]?\s*([A-Z0-9 ,.\-\/]{3,40})/i.exec(pf.text);
    const blNoEntry = (idFoundByKey.blAwb || []).find((x) => x.file === pf.name);
    if (!shipmentInfo || etd) { // เก็บ shipmentInfo จากไฟล์แรกที่เจอ B/L/AWB, override ถ้าเจอ etd ชัดกว่า
      shipmentInfo = {
        etd: etd || (shipmentInfo && shipmentInfo.etd) || null,
        vessel: (vesselM ? vesselM[1].trim() : (shipmentInfo && shipmentInfo.vessel)) || '',
        blOrAwbNo: (blNoEntry ? blNoEntry.raw : (shipmentInfo && shipmentInfo.blOrAwbNo)) || '',
        portOfLoading: (polM ? polM[1].trim() : (shipmentInfo && shipmentInfo.portOfLoading)) || '',
      };
    }
  });

  const status = errors.length ? 'issues_found' : 'pass';
  const summary = `ตรวจสอบด้วยกฎในเครื่อง (ไม่มีการส่งข้อมูลออกนอกเครื่อง ไม่มีค่าใช้จ่าย) จากไฟล์ที่อ่านได้ ${perFile.length}/${files.length} ไฟล์ ` +
    `พบรหัสอ้างอิง (PO/SO, เลขตู้, B/L-AWB, เลข Invoice) ที่ตรงกัน ${correct.length} รายการ, ควรตรวจสอบเพิ่ม ${review.length} รายการ, ไม่ตรงกัน ${errors.length} รายการ. ` +
    `ขอบเขต: ระบบนี้เทียบเฉพาะรหัสอ้างอิงแบบ exact-match และดึงตัวเลข (ยอดรวม/น้ำหนัก/จำนวน) มาโชว์เฉยๆ ไม่ได้ยืนยันว่าตรงกันเพราะ format ต่างกันได้ — ` +
    `ต่างจากการตรวจด้วย AI ที่อ่านและเข้าใจเนื้อหาเอกสารได้ลึกกว่านี้ กรุณาตรวจรายการในหมวด "ควรตรวจสอบ" ด้วยตาเองก่อนสรุปผล`;

  return {
    ok: true, po, status,
    sections: { correct, review, errors },
    summary,
    taxCheck: null,
    shipmentInfo,
    meta: { mode, filesProcessed: perFile.length, filesSkipped, engine: 'local-rule-based' },
  };
}

module.exports = { verifyShipmentLocal };

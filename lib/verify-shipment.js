// ─── AI document cross-check ("ตรวจเอกสาร") — layer-4 feature ──────
// Upload shipment documents → แปลงเป็น content block ของ OpenAI Responses API
// (ไม่ใช้ Python/PyMuPDF: PDF/รูปส่งเข้าโมเดลตรงๆ ส่วน Excel/CSV แปลงเป็นข้อความ
// ด้วย xlsx ที่โปรเจกต์นี้ใช้อยู่แล้ว) → เรียก API ครั้งเดียว → ได้ JSON ตาม schema
// หมายเหตุ: ไฟล์นี้ยังไม่ได้ผูกเข้า api-server.js (ใช้ verify-shipment-local ที่ตรวจในเครื่องฟรีอยู่)
'use strict';

const Busboy = require('busboy');
const XLSX = require('xlsx');
const OpenAI = require('openai');
const { buildSystemPrompt, RESPONSE_SCHEMA } = require('./verify-shipment-prompt');

const MAX_FILES = 15;
const MAX_FILE_BYTES = 8 * 1024 * 1024;        // 8MB/file
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;      // ~24MB raw total (เผื่อ base64 บวม ~1.33x ให้อยู่ใต้เพดาน 32MB ของ request)
const MODEL = process.env.VERIFY_MODEL || 'gpt-5.4-mini';

const EXCEL_EXTS = new Set(['.xlsx', '.xls', '.csv']);
const PDF_EXT = '.pdf';
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

function extOf(filename) {
  const m = /\.[^.]+$/.exec(filename || '');
  return m ? m[0].toLowerCase() : '';
}

// ── Step 1: parse the multipart upload into { mode, files: [{name, ext, buffer}] } ──
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
    let totalBytes = 0;
    let tooManyFiles = false;
    let oversizedFile = false;
    let rejected = false;

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

// ── Step 2: classify + convert each file into Claude content blocks / text dump ──
// ws['!ref'] บางไฟล์ (เจอจริง: OXY清单.xlsx) ถูก format ทั้งชีตจน !ref บวมเกือบสุดขอบ Excel
// (เช่น A1:XFC1048565) ทั้งที่ข้อมูลจริงมีไม่กี่เซลล์ — sheet_to_csv เชื่อ !ref ตรงๆ แล้ววนสร้าง
// CSV ทั้งกริดจนค้างสนิท (เคยกินเวลา ~2 ชม.) ต้องคำนวณขอบเขตจากเซลล์ที่มีข้อมูลจริงก่อนเสมอ
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
    // เขียนทับ !ref ด้วยขอบเขตจริงชั่วคราวก่อนเรียก sheet_to_csv แล้วคืนค่าเดิมกลับ (กันชีตบวมค้าง)
    const originalRef = ws['!ref'];
    const usedRange = computeUsedRange(ws);
    if (usedRange) ws['!ref'] = XLSX.utils.encode_range(usedRange);
    let rows;
    try { rows = XLSX.utils.sheet_to_csv(ws, { blankrows: false }); }
    finally { ws['!ref'] = originalRef; }
    parts.push(`--- SHEET: ${sheetName} (${originalRef || ''}) ---`);
    parts.push(rows.trim());
  });
  return parts.join('\n');
}

function convertFiles(files) {
  const documentBlocks = [];
  const excelTextParts = [];
  const filesSkipped = [];
  let filesProcessed = 0;

  for (const f of files) {
    try {
      if (f.ext === PDF_EXT) {
        if (!f.buffer.slice(0, 5).toString('latin1').startsWith('%PDF-')) {
          filesSkipped.push({ name: f.name, reason: 'ไม่ใช่ไฟล์ PDF ที่ถูกต้อง (magic bytes ไม่ตรง)' });
          continue;
        }
        documentBlocks.push({
          type: 'input_file',
          filename: f.name,
          file_data: `data:application/pdf;base64,${f.buffer.toString('base64')}`,
        });
        filesProcessed++;
      } else if (IMAGE_MIME[f.ext]) {
        documentBlocks.push({
          type: 'input_image',
          image_url: `data:${IMAGE_MIME[f.ext]};base64,${f.buffer.toString('base64')}`,
        });
        filesProcessed++;
      } else if (EXCEL_EXTS.has(f.ext)) {
        excelTextParts.push(dumpExcelText(f.name, f.buffer));
        filesProcessed++;
      } else {
        filesSkipped.push({ name: f.name, reason: `นามสกุลไฟล์ไม่รองรับ (${f.ext || 'ไม่ทราบ'})` });
      }
    } catch (e) {
      filesSkipped.push({ name: f.name, reason: 'อ่านไฟล์ไม่สำเร็จ: ' + e.message });
    }
  }

  return { documentBlocks, excelText: excelTextParts.join('\n\n'), filesSkipped, filesProcessed };
}

// ── Step 3: เรียก OpenAI Responses API ครั้งเดียว การันตี JSON ด้วย structured output (strict) ──
// ตรวจแล้วว่า RESPONSE_SCHEMA เข้าเงื่อนไข strict ของ OpenAI ครบทุกชั้น
// (ทุก object มี additionalProperties:false และ required ครบทุก property) จึงใช้ได้เลยไม่ต้องแก้
const REPORT_TOOL_NAME = 'report_verification';

async function callVerify({ mode, documentBlocks, excelText }) {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('ยังไม่ได้ตั้งค่า OPENAI_API_KEY ใน .env');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120000, maxRetries: 2 });

  const modeLabel = mode === 'export' ? 'ส่งออก (export)' : 'นำเข้า (import)';
  const content = [...documentBlocks];
  if (excelText) content.push({ type: 'input_text', text: excelText });
  content.push({ type: 'input_text', text: `ตรวจสอบเอกสาร shipment นี้ (${modeLabel}) ตามคำสั่งข้างต้น แล้วตอบเป็น JSON ตาม schema ที่กำหนด` });

  const started = Date.now();
  const response = await openai.responses.create({
    model: MODEL,
    instructions: buildSystemPrompt(mode),
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_schema', name: REPORT_TOOL_NAME, strict: true, schema: RESPONSE_SCHEMA } },
    max_output_tokens: 16000, // เผื่อ reasoning token ของโมเดลตระกูล gpt-5 (เดิม max_tokens 8000 นับเฉพาะคำตอบ)
  });
  const durationMs = Date.now() - started;

  if (response.status === 'incomplete') {
    throw new Error(`AI ตอบไม่จบ (${response.incomplete_details?.reason || 'ไม่ทราบสาเหตุ'}) — ลองใหม่อีกครั้ง`);
  }
  const out = response.output_text;
  if (!out) throw new Error('AI ไม่ได้ส่งผลลัพธ์ในรูปแบบที่คาดไว้ — ลองใหม่อีกครั้ง');
  let parsed;
  try { parsed = JSON.parse(out); }
  catch (e) { throw new Error('AI ตอบกลับไม่ใช่ JSON ที่อ่านได้ — ลองใหม่อีกครั้ง'); }

  return {
    result: parsed,
    meta: {
      model: MODEL,
      durationMs,
      tokensUsed: response.usage ? { input: response.usage.input_tokens, output: response.usage.output_tokens } : null,
    },
  };
}

// ── Entry point used by api-server.js ──
async function verifyShipmentRequest(req) {
  const { mode, po, files } = await parseMultipart(req);
  const { documentBlocks, excelText, filesSkipped, filesProcessed } = convertFiles(files);
  if (!documentBlocks.length && !excelText) {
    throw new Error('ไม่มีไฟล์ที่อ่านได้เลย (รองรับ .pdf .xlsx .xls .csv .png .jpg .jpeg)');
  }
  const { result, meta } = await callVerify({ mode, documentBlocks, excelText });
  return {
    ok: true,
    po,
    status: result.status,
    sections: result.sections,
    summary: result.summary,
    taxCheck: result.taxCheck,
    shipmentInfo: result.shipmentInfo,
    meta: { ...meta, mode, filesProcessed, filesSkipped },
  };
}

module.exports = { verifyShipmentRequest };

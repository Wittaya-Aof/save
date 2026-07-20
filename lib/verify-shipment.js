// ─── AI document cross-check ("ตรวจเอกสาร") — layer-4 feature ──────
// Upload shipment documents → convert to Claude-readable content blocks
// (no Python/PyMuPDF: PDFs/images go to Claude natively, Excel/CSV gets
// dumped to text with the `xlsx` package already used elsewhere in this
// project) → one Anthropic API call → structured JSON result.
'use strict';

const Busboy = require('busboy');
const XLSX = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt, RESPONSE_SCHEMA } = require('./verify-shipment-prompt');

const MAX_FILES = 15;
const MAX_FILE_BYTES = 8 * 1024 * 1024;        // 8MB/file
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;      // ~24MB raw total (headroom under Claude's 32MB base64 PDF ceiling)
const MODEL = process.env.VERIFY_MODEL || 'claude-sonnet-5';

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
function dumpExcelText(name, buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const parts = [`=== FILE: ${name} ===`];
  wb.SheetNames.forEach((sheetName) => {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
    const range = ws['!ref'] || '';
    parts.push(`--- SHEET: ${sheetName} (${range}) ---`);
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
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') },
        });
        filesProcessed++;
      } else if (IMAGE_MIME[f.ext]) {
        documentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: IMAGE_MIME[f.ext], data: f.buffer.toString('base64') },
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

// ── Step 3: one Anthropic API call, JSON guaranteed via forced tool-use ──
const REPORT_TOOL_NAME = 'report_verification';

async function callVerify({ documentBlocks, excelText }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน .env');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const content = [...documentBlocks];
  if (excelText) content.push({ type: 'text', text: excelText });
  content.push({ type: 'text', text: 'ตรวจสอบเอกสาร shipment นี้ (import) ตามคำสั่งข้างต้น แล้วเรียก tool report_verification พร้อมผลลัพธ์' });

  const started = Date.now();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: buildSystemPrompt(),
    tools: [{ name: REPORT_TOOL_NAME, description: 'รายงานผลตรวจสอบเอกสาร shipment', input_schema: RESPONSE_SCHEMA }],
    tool_choice: { type: 'tool', name: REPORT_TOOL_NAME },
    messages: [{ role: 'user', content }],
  });
  const durationMs = Date.now() - started;

  const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === REPORT_TOOL_NAME);
  if (!toolUse) throw new Error('AI ไม่ได้ส่งผลลัพธ์ในรูปแบบที่คาดไว้ — ลองใหม่อีกครั้ง');

  return {
    result: toolUse.input,
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

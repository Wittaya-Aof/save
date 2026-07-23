// เติม ETD/actualDate ให้ shipment import ที่ Transit Time KPI (Dashboard) ยังวัดไม่ได้ โดยอ่านจาก
// แท็ก "(Ready DD.M.YYYY)"/"(Done DD.M.YYYY)" ที่พนักงานพิมพ์ไว้ท้ายชื่อโฟลเดอร์เอง (ไม่ใช้ AI, ไม่เปิด
// ไฟล์เอกสารเลย) — รันครั้งเดียวจบ ไม่ใช่ daemon เหมือน scan-shipment-docs.mjs
//
// "Done" = งานเสร็จ/รับเข้าคลังจริง ตรงความหมายกับ actualDate ตรงๆ ปลอดภัยที่จะเขียน
// "Ready" = สินค้าพร้อมที่ต้นทาง ซึ่งเกิดก่อน ETD จริง (วันที่เรือออก) เสมอ ถ้าใช้แทน ETD จะทำให้
// transit time คำนวณได้ยาวกว่าจริง เสี่ยงให้ Dashboard/vendor scorecard ตีตราผิดว่า "ช้ากว่ามาตรฐาน"
// ทั้งที่จริงไม่ได้ช้า — ค่าเริ่มต้นจึงเขียนเฉพาะ Done→actualDate เท่านั้น ต้องใส่ --apply-ready เพิ่มเอง
// ถึงจะเขียน Ready→ETD ด้วย (ดู memory project-logistics-api-audit สำหรับผลตรวจสอบจริงเมื่อ 2026-07-23)
//
// ค่า default: dry-run พิมพ์รายงานอย่างเดียว ไม่เขียนอะไร ต้องใส่ --apply ถึงจะเขียนเข้า
// /api/tracking/upsert จริง (ข้ามรายการที่ field นั้นมีค่าอยู่แล้วเสมอ — จึงรันซ้ำได้เรื่อยๆ โดยไม่ทับ
// ข้อมูลเดิม/ไม่ทำงานซ้ำกับรายการที่เคยเติมไปแล้ว)

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const IMPORT_ROOT = 'D:\\Aof\\1. Shipment\\1. Import';
const MIN_YEAR = 2025;
const PO_MATCH_RE = /(?:KOB|BTV)PO\d{4}-\d{5}/gi;
const APP_URL = 'http://localhost:3000/logistics-tracking-app.html';

const APPLY = process.argv.includes('--apply');
const APPLY_READY = process.argv.includes('--apply-ready');

(function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !m[1].startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  });
})();

// ── มาตรฐาน Transit KPI — คัดลอกจาก logistics-tracking-app.html (PORT_KPI) ให้ตรงกันเป๊ะ ──
const PORT_KPI = [
  { match: ['SHEKOU', 'NANSHA'], label: 'Shekou / Nansha', fcl: 9, lcl: 12 },
  { match: ['SHENZHEN'], label: 'Shenzhen (Yantian)', fcl: 11, lcl: 14 },
  { match: ['GUANGZHOU', 'ZHUHAI'], label: 'Guangzhou / Zhuhai', fcl: 12, lcl: 15 },
  { match: ['NINGBO'], label: 'Ningbo', fcl: 14, lcl: 17 },
  { match: ['SHANGHAI'], label: 'Shanghai', fcl: 15, lcl: 18 },
  { match: ['QINGDAO'], label: 'Qingdao', fcl: 16, lcl: 19 },
  { match: ['PUSAN', 'BUSAN'], label: 'Busan, Korea', fcl: 14, lcl: 17 },
];
function findPortKpi(origin) {
  const o = (origin || '').toUpperCase();
  return PORT_KPI.find(p => p.match.some(m => o.includes(m))) || null;
}

function extractPoNumbers(name) {
  return [...new Set([...name.matchAll(PO_MATCH_RE)].map(m => m[0].toUpperCase()))];
}
function discoverYearFolders() {
  return fs.readdirSync(IMPORT_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name)
    .filter(name => { const m = /^PO\s*(\d{4})$/i.exec(name.trim()); return m && parseInt(m[1], 10) >= MIN_YEAR; });
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function isoDate(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function parseFolderDate(raw) {
  raw = raw.trim();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(raw);
  if (m) {
    let d = +m[1], mo = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return isoDate(y, mo, d);
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/.exec(raw);
  if (m) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; return mo ? isoDate(+m[3], mo, +m[1]) : null; }
  return null;
}
// หาแท็ก (Ready ...)/(Done ...) ในวงเล็บของชื่อโฟลเดอร์ — บางโฟลเดอร์มีทั้งคู่ในวงเล็บเดียวกัน
// (เช่น "(Ready 11.7.2026 Done 15.7.2026)") ต้องแยกวันที่ของแต่ละคำให้ถูกคน ไม่ใช่หยิบแค่คำแรกแล้วทิ้ง
// อีกคำ — ตัด segment ตามตำแหน่งคำถัดไป แล้วหาวันที่เฉพาะใน segment ของคำนั้น ข้ามช่วงวันที่กำกวม
// ("8-9.7.2026", "20 to 30.8.2024") และข้อความที่ไม่มีวันที่ชัดเจน ("Ready now", "Ready 1st of June")
function extractDateTags(folderName) {
  const parens = [...folderName.matchAll(/\(([^)]*)\)/g)].map(mm => mm[1]);
  const out = {};
  for (const content of parens) {
    const kwMatches = [...content.matchAll(/\b(ready|done)\b/gi)];
    kwMatches.forEach((km, i) => {
      const kind = km[1].toLowerCase();
      if (out[kind]) return; // เจอคำนี้ซ้ำในโฟลเดอร์เดียวกัน ใช้ค่าแรกที่เจอ
      const start = km.index + km[0].length;
      const end = i + 1 < kwMatches.length ? kwMatches[i + 1].index : content.length;
      const segment = content.slice(start, end);
      if (/\bto\b/i.test(segment) || /\d\s*-\s*\d{1,2}\.\d{1,2}\.\d{2,4}/.test(segment)) { out[kind] = { date: null, raw: segment.trim(), reason: 'ambiguous-range' }; return; }
      const dm = /(\d{1,2}\.\d{1,2}\.\d{2,4})/.exec(segment) || /(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/.exec(segment);
      if (!dm) { out[kind] = { date: null, raw: segment.trim(), reason: 'no-date-found' }; return; }
      const iso = parseFolderDate(dm[1]);
      out[kind] = { date: iso, raw: segment.trim(), reason: iso ? 'ok' : 'unparsed-format' };
    });
  }
  return Object.keys(out).length ? out : null;
}

function scanFolders() {
  const poTags = {}; // poNo -> {folder, ready:{date,raw,reason}?, done:{date,raw,reason}?}
  const unresolved = [];
  discoverYearFolders().forEach(yf => {
    const dir = path.join(IMPORT_ROOT, yf);
    fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).forEach(d => {
      const pos = extractPoNumbers(d.name);
      if (!pos.length) return;
      const tags = extractDateTags(d.name);
      if (!tags) { unresolved.push({ folder: d.name, pos, reason: 'no-tag' }); return; }
      const hasUsableDate = Object.values(tags).some(t => t.date);
      if (!hasUsableDate) { unresolved.push({ folder: d.name, pos, reason: Object.values(tags)[0].reason, raw: Object.values(tags)[0].raw }); return; }
      pos.forEach(po => { poTags[po] = { folder: d.name, ...tags }; });
    });
  });
  return { poTags, unresolved };
}

// ดึง shipments ที่ merge แล้ว (Odoo + tracking overrides) ตรงจาก state จริงของหน้าเว็บ ผ่าน headless
// browser — เอาจากตรงนี้แทนที่จะ query API เองแล้ว merge ซ้ำ กัน logic เพี้ยนไม่ตรงกับที่ user เห็นจริงบนจอ
async function fetchLiveImports() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await page.getByText('Dashboard', { exact: false }).first().click();
    await page.waitForSelector('text=Transit Time KPI', { timeout: 20000 });
    await page.waitForTimeout(1000);
    const result = await page.evaluate(() => {
      const root = document.getElementById('root');
      const key = Object.keys(root).find(k => k.startsWith('__reactContainer$'));
      const seen = new Set();
      function findAppInstance(fiber, depth) {
        if (!fiber || depth > 500 || seen.has(fiber)) return null;
        seen.add(fiber);
        if (fiber.stateNode && fiber.stateNode.state && Array.isArray(fiber.stateNode.state.shipments)) return fiber.stateNode;
        let found = null;
        if (fiber.child) found = findAppInstance(fiber.child, depth + 1);
        if (!found && fiber.sibling) found = findAppInstance(fiber.sibling, depth + 1);
        return found;
      }
      const inst = findAppInstance(root[key], 0);
      if (!inst) return null;
      return inst.state.shipments.filter(s => s._board === 'import').map(s => ({
        poNo: s.poNo, party: s.party, stage: s.stage, mode: s.mode, origin: s.origin, etd: s.etd, actualDate: s.actualDate,
      }));
    });
    return result;
  } finally {
    await browser.close();
  }
}

function upsertTracking(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (process.env.APP_PASSWORD) headers['Authorization'] = 'Basic ' + Buffer.from('scan:' + process.env.APP_PASSWORD).toString('base64');
    const req = http.request({ hostname: '127.0.0.1', port: 3000, path: '/api/tracking/upsert', method: 'POST', headers }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(JSON.parse(data)) : reject(new Error(`HTTP ${res.statusCode} ${data}`)));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function main() {
  const { poTags, unresolved } = scanFolders();
  const imports = await fetchLiveImports();
  if (!imports) { console.error('[Error] อ่าน state ของหน้าเว็บไม่ได้ — เช็คว่า server รันอยู่ที่ port 3000'); process.exit(1); }

  const rows = [];
  imports.forEach(s => {
    const tag = poTags[s.poNo];
    if (!tag) return;
    const proposedEtd = (!s.etd && tag.ready && tag.ready.date) ? tag.ready.date : null;
    const proposedActual = (!s.actualDate && tag.done && tag.done.date) ? tag.done.date : null;
    if (!proposedEtd && !proposedActual) return; // มีค่าอยู่แล้ว หรือ tag ไม่ตรงฟิลด์ที่ยังว่าง — ข้าม
    const finalEtd = proposedEtd || s.etd, finalActual = proposedActual || s.actualDate;
    const becomesMeasured = !!(finalEtd && finalActual && s.mode === 'sea' && findPortKpi(s.origin));
    const tagRaw = [tag.ready && `Ready ${tag.ready.raw}`, tag.done && `Done ${tag.done.raw}`].filter(Boolean).join(' / ');
    rows.push({ poNo: s.poNo, party: s.party, stage: s.stage, tagRaw, tagFolder: tag.folder, proposedEtd, proposedActual, becomesMeasured });
  });

  const doneRows = rows.filter(r => r.proposedActual);
  const readyRows = rows.filter(r => r.proposedEtd);
  console.log(`โฟลเดอร์ปี ${discoverYearFolders().join(', ')} — พบแท็กอ่านได้ ${Object.keys(poTags).length} โฟลเดอร์, ข้าม ${unresolved.length} โฟลเดอร์ (กำกวม/ไม่มีวันที่)`);
  console.log(`เติมได้ใหม่: Done→actualDate ${doneRows.length} รายการ (ปลอดภัย), Ready→ETD ${readyRows.length} รายการ (Ready เกิดก่อน ETD จริงเสมอ — เสี่ยงทำ KPI ดูแย่กว่าจริง)`);
  console.log(`จะขยับจาก "ยังไม่ได้วัด" เป็น "วัดได้" จริง: ${rows.filter(r => r.becomesMeasured).length} รายการ`);

  if (!APPLY) { console.log('\n(dry-run — ไม่ได้เขียนอะไร ใส่ --apply เพื่อเขียน Done→actualDate จริง, เพิ่ม --apply-ready เพื่อเขียน Ready→ETD ด้วย)'); console.log(JSON.stringify(rows, null, 2)); return; }

  const toWrite = APPLY_READY ? rows : doneRows;
  const payload = toWrite.map(r => { const o = { po_so: r.poNo }; if (r.proposedActual) o.actualDate = r.proposedActual; if (APPLY_READY && r.proposedEtd) o.etd = r.proposedEtd; return o; });
  if (!payload.length) { console.log('ไม่มีอะไรต้องเขียน'); return; }
  const res = await upsertTracking(payload);
  console.log('เขียนเข้า /api/tracking/upsert แล้ว:', JSON.stringify(res));
}
main().catch(e => { console.error('[Error]', e.message); process.exit(1); });

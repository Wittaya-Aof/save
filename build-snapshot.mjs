// ─── สร้าง odoo_snapshot.json โดยดึงข้อมูลจริงผ่าน MCP proxy (HTTPS) ───
// ใช้เมื่อ RDS ตรง (พอร์ต 5432) ต่อไม่ได้จากเครื่องนี้ แต่ proxy 443 ต่อได้
// เทคนิค: MCP คืนผลเป็นตารางข้อความที่ตัดที่ ~58 ตัว/ช่อง จึงเข้ารหัสแต่ละแถว
// เป็น base64 แล้วหั่นเป็นหลายคอลัมน์เล็กๆ (กันตัด) แล้วประกอบ+ถอดรหัสฝั่ง Node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { IMPORT_INNER, EXPORT_INNER, ORDER_COLS } from './odoo-queries.js';

// อ่าน .env
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
  const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#')) env[m[1]] = m[2];
});
const MCP_URL = env.MCP_URL, TOKEN = env.MCP_TOKEN;
if (!MCP_URL || !TOKEN) { console.error('ไม่พบ MCP_URL / MCP_TOKEN ใน .env'); process.exit(1); }

const NCOLS = 16;          // จำนวนคอลัมน์ base64 ต่อแถว (16*50 = 800 b64 = 600 bytes JSON)
const CHUNK = 50;          // ความยาว base64 ต่อคอลัมน์
const PAGE  = 120;         // แถวต่อการเรียก 1 ครั้ง

function headers(sid) {
  return { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
    'Authorization': 'Bearer ' + TOKEN, ...(sid ? { 'Mcp-Session-Id': sid } : {}) };
}
function parseBody(txt) {
  txt = (txt || '').trim();
  if (!txt) return null;
  if (txt[0] === '{') return JSON.parse(txt);
  const data = txt.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
  return JSON.parse(data);
}
async function rpc(sid, method, params, id) {
  const r = await fetch(MCP_URL, { method: 'POST', headers: headers(sid),
    body: JSON.stringify({ jsonrpc: '2.0', ...(id != null ? { id } : {}), method, ...(params ? { params } : {}) }) });
  const txt = await r.text();
  return { status: r.status, sid: r.headers.get('mcp-session-id') || sid, body: txt ? parseBody(txt) : null };
}

let SID = null;
async function connect() {
  const init = await rpc(null, 'initialize',
    { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'logistics-snapshot', version: '1.0' } }, 0);
  if (init.status !== 200) throw new Error('initialize HTTP ' + init.status);
  SID = init.sid;
  await rpc(SID, 'notifications/initialized', null, null);
}
async function runSql(sql) {
  const res = await rpc(SID, 'tools/call', { name: 'run_sql', arguments: { sql } }, Math.floor(Math.random() * 1e6) + 2);
  if (res.status !== 200) throw new Error('run_sql HTTP ' + res.status);
  const c = res.body?.result?.content;
  return Array.isArray(c) ? c.map(x => x.text || '').join('') : '';
}

// สร้าง SELECT ที่คืนแต่ละแถวเป็น base64 หั่น NCOLS คอลัมน์
function wrap(innerSelect, orderCols) {
  const cols = [];
  for (let i = 0; i < NCOLS; i++) cols.push(`substring(b,${i * CHUNK + 1},${CHUNK}) AS c${i}`);
  return `
    SELECT ${cols.join(', ')} FROM (
      SELECT translate(encode(convert_to(row_to_json(r)::text,'UTF8'),'base64'), E'\\n','') AS b, ${orderCols}
      FROM ( ${innerSelect} ) r
      ORDER BY ${orderCols.split(',').map(s => s.trim().split(' AS ')[1] + ' DESC NULLS LAST').join(', ')}
      LIMIT ${PAGE} OFFSET __OFF__
    ) x
    ORDER BY ${orderCols.split(',').map(s => s.trim().split(' AS ')[1] + ' DESC NULLS LAST').join(', ')}`;
}
// แยกตาราง ASCII → คืน array ของ base64 string ต่อแถว
function parseTable(text) {
  const lines = text.split(/\r?\n/).filter(l => l.includes('│'));
  const rows = [];
  for (const line of lines) {
    const cells = line.split('│').map(s => s.trim());
    if (cells.every(c => /^c\d+$/.test(c) || c === '')) continue; // header
    const b64 = cells.join('').replace(/\s+/g, '');
    if (b64) rows.push(b64);
  }
  return rows;
}
async function pull(label, innerSelect, orderCols) {
  const out = [];
  for (let off = 0; ; off += PAGE) {
    const sql = wrap(innerSelect, orderCols).replace('__OFF__', off);
    const text = await runSql(sql);
    const b64rows = parseTable(text);
    if (!b64rows.length) break;
    for (const b of b64rows) {
      try { out.push(JSON.parse(Buffer.from(b, 'base64').toString('utf8'))); }
      catch (e) { console.error(`  แถวเสีย (off=${off}) ข้าม: ${e.message}`); }
    }
    console.log(`  ${label}: ดึงแล้ว ${out.length} แถว`);
    if (b64rows.length < PAGE) break;
  }
  return out;
}

// IMPORT_INNER/EXPORT_INNER/ORDER_COLS มาจาก odoo-queries.js (แชร์กับ api-server.js) แล้ว —
// เดิมก็อปปี้ SQL ชุดนี้แยกไว้ในไฟล์นี้เองด้วย เสี่ยงแก้เงื่อนไขกรองฝั่งเดียวแล้วอีกฝั่งข้อมูลไม่ตรงกัน

(async () => {
  console.log('เชื่อม MCP proxy…');
  await connect();
  console.log('✓ เชื่อมต่อสำเร็จ — เริ่มดึงข้อมูล');
  const imp = await pull('import', IMPORT_INNER, ORDER_COLS);
  const exp = await pull('export', EXPORT_INNER, ORDER_COLS);
  const now = new Date().toISOString();
  const snapshot = { _ts: { import: now, export: now }, import: imp, export: exp };
  fs.writeFileSync(path.join(ROOT, 'odoo_snapshot.json'), JSON.stringify(snapshot), 'utf8');
  console.log(`\n✓ เขียน odoo_snapshot.json แล้ว — import ${imp.length} / export ${exp.length} แถว`);
  console.log('  รีสตาร์ท server เพื่อให้โหลด snapshot แล้วรีเฟรชหน้าเว็บ');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

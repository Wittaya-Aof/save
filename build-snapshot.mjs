// ─── สร้าง odoo_snapshot.json โดยดึงข้อมูลจริงผ่าน MCP proxy (HTTPS) ───
// ใช้เมื่อ RDS ตรง (พอร์ต 5432) ต่อไม่ได้จากเครื่องนี้ แต่ proxy 443 ต่อได้
// เทคนิค: MCP คืนผลเป็นตารางข้อความที่ตัดที่ ~58 ตัว/ช่อง จึงเข้ารหัสแต่ละแถว
// เป็น base64 แล้วหั่นเป็นหลายคอลัมน์เล็กๆ (กันตัด) แล้วประกอบ+ถอดรหัสฝั่ง Node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

// ── inner SELECT (คอลัมน์เท่าที่แอปใช้ ใช้ FROM/WHERE เดียวกับ SQL_IMPORT/EXPORT) ──
const IMPORT_INNER = `
  SELECT po.id, po.name AS po_number,
    CASE po.company_id WHEN 1 THEN 'KOB' WHEN 2 THEN 'BTV' ELSE 'OTHER' END AS company_code,
    rp.name AS supplier, po.state AS odoo_state,
    to_char(po.date_order,'YYYY-MM-DD') AS date_order,
    to_char(po.date_planned,'YYYY-MM-DD') AS date_planned,
    po.amount_total, cu.name AS currency, po.currency_rate,
    po.receipt_status, po.origin, cat.top_cat AS goods_category
  FROM purchase_order po
  JOIN res_company rc ON rc.id = po.company_id
  JOIN res_partner rp ON rp.id = po.partner_id
  JOIN res_currency cu ON cu.id = po.currency_id
  LEFT JOIN res_country rco ON rco.id = rp.country_id
  LEFT JOIN LATERAL (
    SELECT split_part(pc.complete_name, ' / ', 1) AS top_cat
    FROM purchase_order_line pol
    JOIN product_product pp ON pp.id = pol.product_id
    JOIN product_template pt ON pt.id = pp.product_tmpl_id
    JOIN product_category pc ON pc.id = pt.categ_id
    WHERE pol.order_id = po.id GROUP BY 1 ORDER BY SUM(pol.price_subtotal) DESC NULLS LAST LIMIT 1
  ) cat ON true
  WHERE po.company_id IN (1,2) AND po.state NOT IN ('cancel')
    AND po.date_order >= NOW() - INTERVAL '2 years'
    AND (rco.code IS NOT NULL AND rco.code != 'TH' OR (rco.code IS NULL AND cu.name NOT IN ('THB')))
    AND cat.top_cat IN ('Packaging','Finished Goods','Raw Materials')`;

const EXPORT_INNER = `
  SELECT so.id, so.name AS so_number,
    CASE so.company_id WHEN 1 THEN 'KOB' WHEN 2 THEN 'BTV' ELSE 'OTHER' END AS company_code,
    rp.name AS customer, so.state AS odoo_state,
    to_char(so.date_order,'YYYY-MM-DD') AS date_order,
    so.amount_total, cu.name AS currency,
    so.delivery_status, so.origin, rco.code AS country_code
  FROM sale_order so
  JOIN res_company rc ON rc.id = so.company_id
  JOIN res_partner rp ON rp.id = so.partner_id
  JOIN res_currency cu ON cu.id = so.currency_id
  LEFT JOIN res_country rco ON rco.id = rp.country_id
  WHERE so.company_id IN (1,2) AND so.state NOT IN ('cancel','draft')
    AND so.date_order >= NOW() - INTERVAL '2 years'
    AND (rco.code IS NOT NULL AND rco.code != 'TH' OR (rco.code IS NULL AND cu.name NOT IN ('THB')))`;

(async () => {
  console.log('เชื่อม MCP proxy…');
  await connect();
  console.log('✓ เชื่อมต่อสำเร็จ — เริ่มดึงข้อมูล');
  const imp = await pull('import', IMPORT_INNER, 'r.date_order AS _ord, r.id AS _id');
  const exp = await pull('export', EXPORT_INNER, 'r.date_order AS _ord, r.id AS _id');
  const now = new Date().toISOString();
  const snapshot = { _ts: { import: now, export: now }, import: imp, export: exp };
  fs.writeFileSync(path.join(ROOT, 'odoo_snapshot.json'), JSON.stringify(snapshot), 'utf8');
  console.log(`\n✓ เขียน odoo_snapshot.json แล้ว — import ${imp.length} / export ${exp.length} แถว`);
  console.log('  รีสตาร์ท server เพื่อให้โหลด snapshot แล้วรีเฟรชหน้าเว็บ');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

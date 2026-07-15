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
const nodemailer = require('nodemailer');
const { verifyShipmentRequest } = require('./lib/verify-shipment');

const PORT = 3000;
const ROOT = __dirname;
const TRACKING_FILE = path.join(ROOT, 'tracking_data.json');
const AUDIT_FILE    = path.join(ROOT, 'tracking_audit.jsonl');
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
    fs.writeFileSync(TRACKING_FILE, JSON.stringify(data), 'utf8');
    return true;
  } catch(e) { console.error('[Tracking] save error:', e.message); return false; }
}

// ─── Audit log: บันทึกทุกการแก้ไข (append-only, ดูย้อนหลังได้) ────
function auditLog(action, poSo, fields, ip) {
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({
      ts: new Date().toISOString(), action, po_so: poSo, fields, ip: ip || '',
    }) + '\n', 'utf8');
  } catch(e) { console.error('[Audit]', e.message); }
}

// ─── Backup อัตโนมัติ: สำเนา tracking_data.json วันละไฟล์ เก็บ 14 วัน ──
function backupTracking() {
  try {
    if (!fs.existsSync(TRACKING_FILE)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    const stamp = new Date().toISOString().slice(0, 10);
    const dest  = path.join(BACKUP_DIR, `tracking-${stamp}.json`);
    if (!fs.existsSync(dest)) {
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
    try { fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot), 'utf8'); }
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
// NCOLS*CHUNK = งบ base64 ต่อแถว (24*50=1200 ตัว ≈ 900 byte JSON ดิบ) — เผื่อแถวที่มีชื่อผู้ขาย/สินค้ายาว
// หรือ currency_rate ทศนิยมเยอะ ไม่ให้ตัดขาดจน parse ไม่ผ่าน (เดิม 16 คอลัมน์ = 600 byte เสี่ยงพอดีกับแถวยาวๆ)
const MCP_NCOLS = 24, MCP_CHUNK = 50, MCP_PAGE = 120;
// แถวที่ JSON ใหญ่กว่า import/export (เช่น bill picker ที่มี lines[] ต่อบิล) — วัดจริงแล้ว bill สูงสุด ~1440
// base64 chars, PO ~512 → 40 คอลัมน์ (2000) มี headroom พอ ทดสอบผ่าน MCP tool จริงแล้วว่าไม่ถูกตัดแนวนอน
const MCP_NCOLS_WIDE = 40;
// กันยิง MCP ถี่เกินไปตอน direct หลุดยาว (ทุก request ที่ไม่ force จะเช็คก่อน) — ลองใหม่ได้ทุก 1 นาที/key
const MCP_RETRY_INTERVAL = 60000;
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
    { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'logistics-api-server', version: '1.0' } }, 0);
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
const db = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  ssl:      { rejectUnauthorized: false },
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
  try { fs.writeFileSync(INTEGRITY_SEEN_FILE, JSON.stringify([...integritySeenKeys])); }
  catch (e) { console.error('[Integrity] เซฟ integrity_seen.json ไม่สำเร็จ:', e.message); }
}

let mailTransporter;
function getMailTransporter() {
  if (mailTransporter !== undefined) return mailTransporter;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) { mailTransporter = null; return null; }
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  return mailTransporter;
}

async function sendIntegrityAlertEmail(newFindings, label) {
  const transporter = getMailTransporter();
  const to = process.env.ALERT_EMAIL_TO;
  if (!transporter || !to) {
    console.log('[Integrity] ยังไม่ได้ตั้งค่าอีเมล (GMAIL_USER/GMAIL_APP_PASSWORD/ALERT_EMAIL_TO ใน .env) — ข้ามการแจ้งเตือน');
    return;
  }
  const lines = newFindings.map(f => `- ${f.message}`).join('\n');
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to,
    subject: `[Logistics Tracking] พบข้อมูลผิดปกติใหม่ ${newFindings.length} จุด`,
    text: `ระบบตรวจสอบข้อมูลอัตโนมัติ (${label}) พบรายการใหม่ที่น่าสงสัย:\n\n${lines}\n\nดูรายละเอียดที่ Dashboard: http://localhost:3000/`,
  });
  console.log('[Integrity] ส่งอีเมลแจ้งเตือน', newFindings.length, 'จุดใหม่ ไปที่', to);
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
  const transporter = getMailTransporter();
  const to = process.env.ALERT_EMAIL_TO;
  if (!transporter || !to) return; // ไม่ตั้งค่าอีเมล = ข้ามเงียบๆ (เหมือน alert)
  const ir = integrityReport;
  const fCount = (ir.findings || []).length, aCount = (ir.autoCorrected || []).length;
  const statusLine = fCount
    ? `⚠️ ยังพบปัญหาค้างอยู่ ${fCount} จุด (ต้องแก้)`
    : 'ระบบทำงานปกติ — ไม่พบปัญหาที่ต้องแก้';
  const detail = [
    ...(fCount ? ['ปัญหาที่ต้องแก้:', ...ir.findings.map(f => `  - ${f.message}`)] : []),
    ...(aCount ? ['', `ซ่อมอัตโนมัติ (แอปแสดงถูกแล้ว แต่ควรตามไปแก้ที่ Odoo) ${aCount} จุด:`, ...ir.autoCorrected.map(f => `  - ${f.message}`)] : []),
  ].join('\n');
  try {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to,
      subject: `[Logistics Tracking] สรุปสถานะข้อมูลรายสัปดาห์ — ${fCount ? 'พบ ' + fCount + ' จุด' : 'ปกติ'}`,
      text: `สรุปการตรวจสอบข้อมูลอัตโนมัติประจำสัปดาห์\n\n${statusLine}\nตรวจล่าสุด: ${ir.ranAt || '-'} · เช็ค ${(ir.importChecked||0)+(ir.exportChecked||0)} รายการ\n\n${detail || '(ไม่มีรายการที่ต้องรายงาน)'}\n\nอีเมลนี้ส่งทุก 7 วันเพื่อยืนยันว่าระบบแจ้งเตือนยังทำงานอยู่ — ถ้าไม่ได้รับตามรอบ แปลว่าระบบอาจมีปัญหา\nDashboard: http://localhost:3000/`,
    });
    lastDigestAt = now;
    fs.writeFileSync(INTEGRITY_DIGEST_FILE, JSON.stringify({ lastDigestAt }));
    console.log('[Integrity] ส่งสรุปรายสัปดาห์ไปที่', to);
  } catch (e) {
    console.error('[Integrity] ส่งสรุปรายสัปดาห์ไม่สำเร็จ:', e.message);
  }
}

// ใช้ snapshot ปัจจุบัน (ข้อมูลที่กำลังเสิร์ฟให้ผู้ใช้จริงอยู่แล้ว) ไม่ยิง query ใหม่ — กันเพิ่มโหลดฐานข้อมูล/
// เสี่ยง trip circuit breaker โดยไม่จำเป็น เช็คแค่สิ่งที่ผู้ใช้เห็นอยู่ตอนนี้ว่าเชื่อถือได้ไหม
async function runIntegrityCheck(label) {
  const findings = [
    ...checkCurrencyRateSanity(snapshot.import, 'import', 'po_number'),
    ...checkCurrencyRateSanity(snapshot.export, 'export', 'so_number'),
  ];
  const autoCorrected = [
    ...collectAutoCorrected(snapshot.import, 'import', 'po_number'),
    ...collectAutoCorrected(snapshot.export, 'export', 'so_number'),
  ];
  integrityReport = {
    ranAt: new Date().toISOString(), findings, autoCorrected,
    importChecked: (snapshot.import || []).length, exportChecked: (snapshot.export || []).length,
  };
  const acNote = autoCorrected.length ? ' · ซ่อมอัตโนมัติ ' + autoCorrected.length + ' จุด' : '';
  if (findings.length) console.error('[Integrity:' + label + '] พบความผิดปกติ', findings.length, 'จุด' + acNote);
  else console.log('[Integrity:' + label + '] ตรวจ', integrityReport.importChecked + integrityReport.exportChecked, 'รายการ — ไม่พบความผิดปกติ' + acNote);

  const newFindings = findings.filter(f => !integritySeenKeys.has(findingKey(f)));
  integritySeenKeys = new Set(findings.map(findingKey));
  saveIntegritySeenKeys();
  if (newFindings.length) {
    sendIntegrityAlertEmail(newFindings, label).catch(e => console.error('[Integrity] ส่งอีเมลแจ้งเตือนไม่สำเร็จ:', e.message));
  }
  return integrityReport;
}

// ─── Odoo JSON-RPC ───────────────────────────────────────────────
// ตั้งค่า ODOO_USER / ODOO_PASS ผ่าน environment variable หรือแก้ที่นี่
const ODOO = {
  host: 'odoo.kissofbeauty.co.th',
  port: 80,
  db:   'kiss-production',
  user: process.env.ODOO_USER || '',
  pass: process.env.ODOO_PASS || '',
};

let _odooCookie = '';
let _odooUid    = null;

function odooPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: ODOO.host,
      port:     ODOO.port,
      path,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(_odooCookie ? { Cookie: _odooCookie } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) {
        const sid = sc.find(c => c.startsWith('session_id='));
        if (sid) _odooCookie = sid.split(';')[0];
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.data?.message || JSON.stringify(j.error)));
          resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function odooLogin() {
  if (_odooUid) return _odooUid;
  if (!ODOO.user || !ODOO.pass) throw new Error('Odoo credentials not configured (set ODOO_USER / ODOO_PASS)');
  const r = await odooPost('/web/session/authenticate', {
    jsonrpc: '2.0', method: 'call', id: 1,
    params: { db: ODOO.db, login: ODOO.user, password: ODOO.pass },
  });
  if (!r?.uid) throw new Error('Odoo login failed — check ODOO_USER / ODOO_PASS');
  _odooUid = r.uid;
  console.log('[Odoo] Authenticated as uid', _odooUid);
  return _odooUid;
}

async function odooKw(model, method, args = [], kwargs = {}) {
  await odooLogin();
  return odooPost('/web/dataset/call_kw', {
    jsonrpc: '2.0', method: 'call', id: 1,
    params: { model, method, args, kwargs },
  });
}

// ─── SQL Queries ─────────────────────────────────────────────────
// ─── Import PO query: Oversea only (country ≠ TH) ──────────────────────────
// รวมเฉพาะ vendor ต่างประเทศ (Oversea, PK, FG)
// ไม่รวม Domestic (country = TH / currency = THB)
const SQL_IMPORT = `
  SELECT
    po.id,
    po.name                   AS po_number,
    po.company_id,
    rc.name                   AS company_name,
    CASE po.company_id WHEN 1 THEN 'KOB' WHEN 2 THEN 'BTV' ELSE 'OTHER' END AS company_code,
    rp.name                   AS supplier,
    po.state                  AS odoo_state,
    po.date_order,
    po.date_planned,
    po.amount_total,
    cu.name                   AS currency,
    -- po.currency_rate ไม่ได้อัปเดตตามใบวางบิลที่สร้างทีหลัง PO (พบจริง: BTVPO2506-01022 ค้างเป็น 1
    -- ทั้งที่ใบวางบิลจริงมี rate ถูกต้อง 0.2174) — เฉพาะตอน po.currency_rate ผิดปกติ (หาย/เป็น 1 พอดี)
    -- ให้ดึง rate จากใบวางบิลจริง (account_move) ที่ผูกกับ PO นี้แทน ไม่กระทบ PO ปกติที่เหลือ
    CASE
      WHEN po.currency_rate IS NULL OR po.currency_rate <= 0 OR ABS(po.currency_rate - 1) < 1e-9
      THEN COALESCE(
        (SELECT am.invoice_currency_rate FROM account_move am
         WHERE am.invoice_origin = po.name AND am.state = 'posted' AND am.invoice_currency_rate IS NOT NULL
         ORDER BY am.invoice_date DESC LIMIT 1),
        po.currency_rate
      )
      ELSE po.currency_rate
    END                       AS currency_rate,
    -- ธงบอกว่าแถวนี้ "ซ่อมอัตโนมัติ" (ค่าที่ Odoo เพี้ยน แต่เราดึง rate จากใบวางบิลมาแทนได้) — โชว์เป็นข้อมูล
    -- ไม่ใช่ปัญหา เพื่อไม่ให้บดบังความจริงว่า Odoo ต้นทางยังต้องแก้ (ดู runIntegrityCheck)
    CASE
      WHEN (po.currency_rate IS NULL OR po.currency_rate <= 0 OR ABS(po.currency_rate - 1) < 1e-9)
       AND cu.name <> 'THB'
       AND (SELECT am.invoice_currency_rate FROM account_move am
            WHERE am.invoice_origin = po.name AND am.state = 'posted' AND am.invoice_currency_rate IS NOT NULL
            ORDER BY am.invoice_date DESC LIMIT 1) IS NOT NULL
      THEN 1 ELSE 0
    END                       AS rate_auto_corrected,
    po.receipt_status,
    po.origin,
    po.notes,
    'oversea'::text           AS source_type,
    cat.top_cat               AS goods_category
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
`;

const SQL_EXPORT = `
  SELECT
    so.id,
    so.name                   AS so_number,
    so.company_id,
    rc.name                   AS company_name,
    CASE so.company_id WHEN 1 THEN 'KOB' WHEN 2 THEN 'BTV' ELSE 'OTHER' END AS company_code,
    rp.name                   AS customer,
    so.state                  AS odoo_state,
    so.date_order,
    so.amount_total,
    cu.name                   AS currency,
    -- ป้องกันเคสเดียวกับฝั่ง PO (ดู SQL_IMPORT) แม้ยังไม่เจอจริงฝั่ง export ก็ตาม — กันไว้ก่อน
    CASE
      WHEN so.currency_rate IS NULL OR so.currency_rate <= 0 OR ABS(so.currency_rate - 1) < 1e-9
      THEN COALESCE(
        (SELECT am.invoice_currency_rate FROM account_move am
         WHERE am.invoice_origin = so.name AND am.state = 'posted' AND am.invoice_currency_rate IS NOT NULL
         ORDER BY am.invoice_date DESC LIMIT 1),
        so.currency_rate
      )
      ELSE so.currency_rate
    END                       AS currency_rate,
    CASE
      WHEN (so.currency_rate IS NULL OR so.currency_rate <= 0 OR ABS(so.currency_rate - 1) < 1e-9)
       AND cu.name <> 'THB'
       AND (SELECT am.invoice_currency_rate FROM account_move am
            WHERE am.invoice_origin = so.name AND am.state = 'posted' AND am.invoice_currency_rate IS NOT NULL
            ORDER BY am.invoice_date DESC LIMIT 1) IS NOT NULL
      THEN 1 ELSE 0
    END                       AS rate_auto_corrected,
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
      sol.price_unit, sol.price_subtotal, sol.price_total
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
      pol.price_unit, pol.price_subtotal, pol.price_total
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

// อ่าน logistics.shipment records (ใช้ได้หลัง module ถูก install ใน Odoo)
const SQL_SHIPMENTS = `
  SELECT
    ls.id,
    ls.name,
    ls.shipment_type,
    ls.po_id,
    po.name          AS po_number,
    CASE po.company_id WHEN 1 THEN 'KOB' WHEN 2 THEN 'BTV' ELSE NULL END AS company_code,
    ls.so_id,
    so.name          AS so_number,
    ls.import_state,
    ls.export_state,
    ls.transport_mode,
    ls.bl_awb_number,
    ls.container_no,
    ls.vessel_name,
    ls.voyage_number,
    ls.port_origin,
    ls.port_destination,
    ls.etd_date,
    ls.eta_date,
    ls.shipping_agent,
    cu.name          AS currency,
    ls.exchange_rate,
    ls.customs_duty,
    ls.customs_vat,
    ls.other_fees,
    ls.total_fees,
    ls.notes,
    to_char(ls.create_date, 'YYYY-MM-DD') AS created_date,
    COALESCE(rp_po.name, rp_so.name)      AS party
  FROM logistics_shipment ls
  LEFT JOIN purchase_order po  ON po.id  = ls.po_id
  LEFT JOIN sale_order so      ON so.id  = ls.so_id
  LEFT JOIN res_partner rp_po  ON rp_po.id = po.partner_id
  LEFT JOIN res_partner rp_so  ON rp_so.id = so.partner_id
  LEFT JOIN res_currency cu    ON cu.id  = ls.invoice_currency_id
  ORDER BY ls.create_date DESC
`;

const SQL_STATS = `
  SELECT
    (SELECT COUNT(*) FROM purchase_order WHERE company_id IN (1,2) AND state NOT IN ('cancel','draft')) AS total_po,
    (SELECT COUNT(*) FROM sale_order     WHERE company_id IN (1,2) AND state NOT IN ('cancel','draft')
       AND partner_id NOT IN (SELECT id FROM res_partner WHERE name ILIKE '%SHOPEE%' OR name ILIKE '%TIKTOK%' OR name ILIKE '%LAZADA%')
    ) AS total_so,
    (SELECT COUNT(*) FROM purchase_order WHERE company_id IN (1,2) AND state NOT IN ('cancel')
       AND currency_id NOT IN (SELECT id FROM res_currency WHERE name = 'THB')
       AND date_order >= NOW() - INTERVAL '2 years'
    ) AS import_pos,
    (SELECT name FROM res_currency ORDER BY id LIMIT 1) AS check
`;

// ─── In-memory cache (5 min TTL) ─────────────────────────────────
const cache = { data: {}, ts: {} };
const CACHE_TTL = 5 * 60 * 1000;

async function cachedQuery(key, sql, force) {
  const now = Date.now();
  if (cache.data[key] && (now - cache.ts[key]) < CACHE_TTL) {
    return cache.data[key];
  }
  // Circuit breaker — DB เพิ่งล่มและยังไม่หมด window: ไม่ลองซ้ำ (กันทุก endpoint
  // เสียเวลารอ connect timeout 6 วิ ต่อ request). มี cache เก่าก็คืนไปก่อน
  if (!force && dbLikelyDown()) {
    if (cache.data[key]) return cache.data[key];
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
      if (attempt === 0) await new Promise(r => setTimeout(r, 800));
    }
  }
  markDbDown(); // ทั้ง 2 ครั้งล้ม → เปิด circuit ให้ request ถัดๆ ไป fail เร็ว
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

// ─── JSON response helper ─────────────────────────────────────────
// same-origin เท่านั้น — ไม่เปิด CORS ให้ origin อื่น
function jsonOk(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function jsonErr(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
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
        authed = dec.split(':').slice(1).join(':') === process.env.APP_PASSWORD;
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
        console.error('[API] import-pos:', e.message);
        jsonErr(res, 500, e.message);
      }
      return;
    }

    if (reqUrl === '/api/export-sos' && method === 'GET') {
      const force = new URL('http://x' + req.url).searchParams.get('force') === '1';
      try {
        const r = await liveOrSnapshot('export', SQL_EXPORT, force);
        jsonOk(res, { ok: true, count: r.rows.length, rows: r.rows, stale: r.stale, as_of: r.as_of });
      } catch (e) {
        console.error('[API] export-sos:', e.message);
        jsonErr(res, 500, e.message);
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
        } catch (e) { directErr = e; markDbDown(); }
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
      jsonErr(res, 503, 'ดึงรายการสินค้าไม่ได้ในขณะนี้ (Odoo ต่อไม่ได้)' + (directErr ? ': ' + directErr.message : ''));
      return;
    }

    if (reqUrl === '/api/vendors' && method === 'GET') {
      try {
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
          LIMIT 500
        `);
        jsonOk(res, { ok: true, count: rows.length, rows });
      } catch (e) {
        console.error('[API] vendors:', e.message);
        jsonErr(res, 500, e.message);
      }
      return;
    }

    if (reqUrl === '/api/expense-pos' && method === 'GET') {
      const co = new URL('http://x'+reqUrl+
        (req.url.includes('?')?req.url.slice(req.url.indexOf('?')):'')
        ).searchParams.get('company');
      // Build company filter so the DB does the filtering (avoids loading all 10k rows
      // when only one company is needed).
      const coFilter = co === 'KOB' ? 'AND po.company_id = 1'
                     : co === 'BTV' ? 'AND po.company_id = 2'
                     : '';
      try {
        const cacheKey = co ? `expense-pos-${co}` : 'expense-pos-all';
        const rows = await cachedQuery(cacheKey, `
          SELECT
            po.id,
            po.name::text  AS po_number,
            CASE po.company_id WHEN 1 THEN 'KOB' WHEN 2 THEN 'BTV' ELSE 'OTHER' END AS company_code,
            rp.name::text  AS supplier,
            po.amount_total,
            cu.name::text  AS currency,
            po.date_order,
            po.state       AS odoo_state
          FROM  purchase_order po
          JOIN  res_partner    rp ON rp.id = po.partner_id
          JOIN  res_currency   cu ON cu.id = po.currency_id
          WHERE po.company_id IN (1, 2)
            ${coFilter}
            AND po.state NOT IN ('cancel')
            AND po.date_order >= '2025-01-01'
            -- Include PO if ANY of its lines belongs to the Expense category tree.
            AND EXISTS (
              SELECT 1
              FROM  purchase_order_line pol
              JOIN  product_product  pp ON pp.id = pol.product_id
              JOIN  product_template pt ON pt.id = pp.product_tmpl_id
              JOIN  product_category pc ON pc.id = pt.categ_id
              WHERE pol.order_id = po.id
                AND split_part(pc.complete_name, ' / ', 1) = 'Expense'
            )
          ORDER BY po.date_order DESC
          LIMIT 8000
        `);
        jsonOk(res, { ok: true, count: rows.length, rows });
      } catch (e) {
        console.error('[API] expense-pos:', e.message);
        jsonErr(res, 500, e.message);
      }
      return;
    }

    // ── Diagnostic: ดูโครงสร้าง expense POs ที่เชื่อมกับ import PO ──
    // GET /api/debug/expense-structure?po=KOBPO2606-09742
    if (reqUrl === '/api/debug/expense-structure' && method === 'GET') {
      const poNo = new URL('http://x' + req.url).searchParams.get('po') || '';
      try {
        // 1. Expense POs ที่ origin หรือ notes อ้างอิง PO นี้
        const byOrigin = await db.query(`
          SELECT po.name::text AS po_number, po.origin, (po.notes::text) AS notes,
            po.amount_total, cu.name::text AS currency, po.date_order::text,
            pol_cat.expense_sub, pol_prod.main_product
          FROM purchase_order po
          JOIN res_currency cu ON cu.id = po.currency_id
          LEFT JOIN LATERAL (
            SELECT split_part(pc.complete_name, ' / ', 2) AS expense_sub
            FROM purchase_order_line pol
            JOIN product_product pp ON pp.id = pol.product_id
            JOIN product_template pt ON pt.id = pp.product_tmpl_id
            JOIN product_category pc ON pc.id = pt.categ_id
            WHERE pol.order_id = po.id
            GROUP BY 1 ORDER BY SUM(pol.price_subtotal) DESC LIMIT 1
          ) pol_cat ON true
          LEFT JOIN LATERAL (
            SELECT (pt.name)::text AS main_product
            FROM purchase_order_line pol
            JOIN product_product pp ON pp.id = pol.product_id
            JOIN product_template pt ON pt.id = pp.product_tmpl_id
            WHERE pol.order_id = po.id ORDER BY pol.price_subtotal DESC LIMIT 1
          ) pol_prod ON true
          WHERE po.company_id IN (1,2)
            AND po.state NOT IN ('cancel')
            AND (po.origin ILIKE $1 OR (po.notes::text) ILIKE $1)
            AND EXISTS (
              SELECT 1 FROM purchase_order_line pol2
              JOIN product_product pp2 ON pp2.id = pol2.product_id
              JOIN product_template pt2 ON pt2.id = pp2.product_tmpl_id
              JOIN product_category pc2 ON pc2.id = pt2.categ_id
              WHERE pol2.order_id = po.id
                AND split_part(pc2.complete_name, '/', 1) = 'Expense'
            )
          LIMIT 20
        `, [`%${poNo}%`]);

        // 2. ตัวอย่าง expense POs ล่าสุด (ไม่ filter by PO) เพื่อดูรูปแบบ origin
        const sampleExpense = await db.query(`
          SELECT po.name::text, po.origin, po.amount_total, cu.name::text AS currency,
            pol_cat.expense_sub, pol_prod.main_product
          FROM purchase_order po
          JOIN res_currency cu ON cu.id = po.currency_id
          LEFT JOIN LATERAL (
            SELECT split_part(pc.complete_name, ' / ', 2) AS expense_sub
            FROM purchase_order_line pol
            JOIN product_product pp ON pp.id = pol.product_id
            JOIN product_template pt ON pt.id = pp.product_tmpl_id
            JOIN product_category pc ON pc.id = pt.categ_id
            WHERE pol.order_id = po.id
            GROUP BY 1 ORDER BY SUM(pol.price_subtotal) DESC LIMIT 1
          ) pol_cat ON true
          LEFT JOIN LATERAL (
            SELECT (pt.name)::text AS main_product
            FROM purchase_order_line pol
            JOIN product_product pp ON pp.id = pol.product_id
            JOIN product_template pt ON pt.id = pp.product_tmpl_id
            WHERE pol.order_id = po.id ORDER BY pol.price_subtotal DESC LIMIT 1
          ) pol_prod ON true
          WHERE po.company_id IN (1,2)
            AND po.state NOT IN ('cancel')
            AND po.date_order >= NOW() - INTERVAL '3 months'
            AND EXISTS (
              SELECT 1 FROM purchase_order_line pol2
              JOIN product_product pp2 ON pp2.id = pol2.product_id
              JOIN product_template pt2 ON pt2.id = pp2.product_tmpl_id
              JOIN product_category pc2 ON pc2.id = pt2.categ_id
              WHERE pol2.order_id = po.id
                AND split_part(pc2.complete_name, '/', 1) = 'Expense'
            )
          ORDER BY po.date_order DESC LIMIT 15
        `);

        // 3. Vendor Bills (account_move) ที่อ้างอิง PO นี้
        const vendorBills = await db.query(`
          SELECT am.name::text, am.ref::text, (am.invoice_origin)::text AS invoice_origin,
            am.amount_total, cu.name::text AS currency,
            am.invoice_date::text, am.state,
            rp.name::text AS partner,
            aml_cat.line_name
          FROM account_move am
          JOIN res_currency cu ON cu.id = am.currency_id
          JOIN res_partner  rp ON rp.id = am.partner_id
          LEFT JOIN LATERAL (
            SELECT aml.name::text AS line_name
            FROM account_move_line aml
            WHERE aml.move_id = am.id AND aml.display_type = 'product'
            ORDER BY aml.price_subtotal DESC LIMIT 1
          ) aml_cat ON true
          WHERE am.company_id IN (1,2)
            AND am.move_type = 'in_invoice'
            AND am.state != 'cancel'
            AND (am.ref ILIKE $1 OR (am.invoice_origin)::text ILIKE $1 OR am.narration::text ILIKE $1)
            AND am.invoice_date >= '2025-01-01'
          ORDER BY am.invoice_date DESC
          LIMIT 20
        `, [`%${poNo}%`]);

        // 4. ตัวอย่าง Vendor Bills ล่าสุด (เพื่อดูรูปแบบ ref/origin)
        const sampleBills = await db.query(`
          SELECT am.name::text, am.ref::text, (am.invoice_origin)::text AS invoice_origin,
            am.amount_total, cu.name::text AS currency, am.invoice_date::text,
            rp.name::text AS partner
          FROM account_move am
          JOIN res_currency cu ON cu.id = am.currency_id
          JOIN res_partner  rp ON rp.id = am.partner_id
          WHERE am.company_id IN (1,2)
            AND am.move_type = 'in_invoice'
            AND am.state != 'cancel'
            AND am.invoice_date >= NOW() - INTERVAL '2 months'
            AND rp.name ILIKE ANY(ARRAY['%freight%','%forwarder%','%customs%','%logistic%','%shipping%','%ขนส่ง%','%Sino%','%DHL%','%Kerry%','%Pantos%','%Yusen%','%SITC%','%Maersk%','%PIL%','%ONE%','%OOCL%','%CMA%'])
          ORDER BY am.invoice_date DESC LIMIT 15
        `);

        // 5. Top product categories ในระบบ (ดูว่ามี Expense หรือเปล่า)
        const topCategories = await db.query(`
          SELECT pc.complete_name::text, COUNT(*) AS po_lines
          FROM purchase_order_line pol
          JOIN product_product pp ON pp.id = pol.product_id
          JOIN product_template pt ON pt.id = pp.product_tmpl_id
          JOIN product_category pc ON pc.id = pt.categ_id
          JOIN purchase_order po ON po.id = pol.order_id
          WHERE po.company_id IN (1,2) AND po.date_order >= NOW() - INTERVAL '6 months'
          GROUP BY 1 ORDER BY 2 DESC LIMIT 20
        `);

        // 6. PO หลักที่ชื่อ match — ดู supplier + partner_id เพื่อเข้าใจ goods-bill filter
        const mainPo = await db.query(`
          SELECT po.name::text, po.partner_id, rp.name::text AS supplier,
            cu.name::text AS currency, po.amount_total
          FROM purchase_order po
          JOIN res_partner rp ON rp.id = po.partner_id
          JOIN res_currency cu ON cu.id = po.currency_id
          WHERE po.company_id IN (1,2) AND po.name ILIKE $1
          LIMIT 10
        `, [`%${poNo}%`]);

        // 7. bills ทั้งหมดที่ match พร้อม partner_id (เทียบกับ PO supplier)
        const billsWithPid = await db.query(`
          SELECT am.name::text AS bill, am.partner_id, rp.name::text AS partner,
            cu.name::text AS currency, am.amount_total
          FROM account_move am
          JOIN res_partner rp ON rp.id = am.partner_id
          JOIN res_currency cu ON cu.id = am.currency_id
          WHERE am.company_id IN (1,2) AND am.move_type='in_invoice' AND am.state!='cancel'
            AND ((am.invoice_origin)::text ILIKE $1 OR am.ref::text ILIKE $1)
          LIMIT 20
        `, [`%${poNo}%`]);

        jsonOk(res, {
          ok: true,
          query_po: poNo,
          main_po: mainPo.rows,
          bills_with_partner_id: billsWithPid.rows,
          found_by_origin: byOrigin.rows,
          vendor_bills_matched: vendorBills.rows,
          top_po_categories: topCategories.rows,
        });
      } catch(e) {
        console.error('[API] debug/expense-structure:', e.message);
        jsonErr(res, 500, e.message);
      }
      return;
    }

    // ── รายการค่าใช้จ่ายนำเข้า/ส่งออก ให้ผู้ใช้เลือกจับคู่กับ shipment ──
    // 2 แหล่ง: (1) Vendor Bills = จ่ายจริง  (2) Expense POs = สั่งซื้อบริการแล้ว รอบิล
    // PO ที่มีบิลอ้างถึงแล้วจะถูกตัดออก (บิล actual กว่า)
    // จำแนก 5 ประเภท: freight / clearance / insurance / duty / vat
    // GET /api/logistics-bills?company=KOB&months=8&q=dhl
    if (reqUrl === '/api/logistics-bills' && method === 'GET') {
      const params = new URL('http://x' + req.url).searchParams;
      const co      = params.get('company') || '';
      const months  = Math.min(parseInt(params.get('months')) || 8, 24);
      const q       = (params.get('q') || '').trim();
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
      // (1) Vendor Bills: partner เข้า pattern หรือ line เป็นสินค้าหมวด Import Expenses
      const billSql = (search) => `
        SELECT
          am.id,
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
        WHERE am.company_id IN (1,2)
          ${coFilter}
          AND am.move_type = 'in_invoice'
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
          ${search}
        ORDER BY am.invoice_date DESC
        LIMIT 300`;

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
          ${search}
        ORDER BY po.date_order DESC
        LIMIT 300`;

      // MCP path หั่นคอลัมน์ตาม doc_date/id (ต้องมีใน SELECT ทั้งสอง query) — ใช้ NCOLS_WIDE เพราะ bill มี lines[]
      const BILL_ORDER = 'r.doc_date AS _ord, r.id AS _id';
      let billRows, poRows, via = null;
      // ลอง direct ก่อน (ข้ามถ้า circuit เพิ่งเปิด — จะได้ไม่รอ timeout เปล่าๆ)
      if (!dbLikelyDown()) {
        try {
          billRows = (await db.query(billSql(billSearchDirect), q ? args : [])).rows;
          poRows   = (await db.query(poSql(poSearchDirect),     q ? args : [])).rows;
          markDbUp(); via = 'direct';
        } catch (e) {
          if (/timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|terminated/.test(e.message)) markDbDown();
          console.error('[API] logistics-bills direct หลุด → ลอง MCP bridge:', e.message);
        }
      }
      // fallback ผ่าน MCP bridge — เส้นทางเดียวกับที่ import/export ใช้ตอน RDS ตรงต่อไม่ได้
      if (!via) {
        if (!(MCP_URL && MCP_TOKEN)) { jsonErr(res, 503, 'Odoo ไม่พร้อมใช้งานชั่วคราว (RDS ตรงต่อไม่ได้ และไม่ได้ตั้งค่า MCP bridge)'); return; }
        try {
          const sid = await mcpConnect();
          billRows = await mcpPull(sid, billSql(billSearchMcp), BILL_ORDER, 300, MCP_NCOLS_WIDE);
          poRows   = await mcpPull(sid, poSql(poSearchMcp),     BILL_ORDER, 300, MCP_NCOLS_WIDE);
          via = 'mcp';
          console.log('[API] logistics-bills ผ่าน MCP bridge สำเร็จ — bills:', billRows.length, 'po:', poRows.length, '(direct ใช้ไม่ได้)');
        } catch (mcpErr) {
          console.error('[API] logistics-bills MCP bridge ก็หลุด:', mcpErr.message);
          jsonErr(res, 503, 'โหลดรายการบิลไม่สำเร็จ (ทั้ง RDS ตรงและ MCP bridge ต่อไม่ได้): ' + mcpErr.message);
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
          const fx = thbRate(r);
          const origAmount = parseFloat(r.amount_total) || 0;
          const total = origAmount * fx;
          const tax   = (parseFloat(r.amount_tax) || 0) * fx;
          const lines = Array.isArray(r.lines) ? r.lines : [];
          const text  = lines.map(l => l.name || '').join(' ');
          const c = zero5();
          // ลองแยกตาม line ก่อน — ใช้ได้เมื่อยอด line บวกรวมแล้วเป็นยอดจริง (ไม่หักล้างกัน)
          let lineTotal = 0;
          const lineSums = zero5();
          lines.forEach(l => { const a = (parseFloat(l.amount) || 0) * fx; lineTotal += a; lineSums[lineCat(l.name)] += a; });
          let cat;
          if (lines.length && lineTotal > total * 0.5) {
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
        jsonOk(res, { ok: true, count: out.length, months, via, bills: out });
      } catch(e) {
        // ถึงตรงนี้แปลว่าดึงข้อมูลสำเร็จแล้ว (direct หรือ MCP) — error ที่นี่คือขั้นประมวลผล ไม่ใช่ DB หลุด
        console.error('[API] logistics-bills ประมวลผล:', e.message);
        jsonErr(res, 500, 'ประมวลผลรายการบิลไม่สำเร็จ: ' + e.message);
      }
      return;
    }

    // ── ดึงต้นทุน freight/duty/VAT สำหรับ PO ──
    // แหล่งข้อมูล 1: Vendor Bills (account_move) ที่ invoice_origin = PO number
    // แหล่งข้อมูล 2: Expense POs (purchase_order) ที่ origin = PO number, category = Expense
    // GET /api/costs-for-po?po=KOBPO2606-09742&company=KOB
    if (reqUrl === '/api/costs-for-po' && method === 'GET') {
      const params = new URL('http://x' + req.url).searchParams;
      const poNo   = params.get('po') || '';
      const co     = params.get('company') || '';
      if (!poNo) { jsonErr(res, 400, 'missing po param'); return; }
      const coFilter     = co === 'KOB' ? 'AND am.company_id = 1'
                         : co === 'BTV' ? 'AND am.company_id = 2' : '';
      const coFilterPo   = co === 'KOB' ? 'AND po.company_id = 1'
                         : co === 'BTV' ? 'AND po.company_id = 2' : '';

      // ── FREIGHT FORWARDER partners ที่รู้จัก ──
      const FORWARDER_RE = /dhl|kerry|pantos|yusen|sino.?trans|sitc|maersk|oocl|cma|one |evg|logwin|nhx|nsk|nippon|ups|fedex|ขนส่ง|forwarder|freight|logistics/i;
      // ── CUSTOMS BROKER partners ──
      const CUSTOMS_RE   = /customs|ศุลกากร|duty|broker|clearing/i;

      try {
        // 1. Vendor Bills: ค้นหาจาก invoice_origin หรือ ref ที่มี PO number
        //    is_goods_supplier = บิลนี้เป็นค่าสินค้า (partner ตรงกับผู้ขายใน import PO เดียวกัน)
        //    → ใช้กรองบิลค่าสินค้าออก ไม่นับเป็นค่าขนส่ง/ภาษี
        const billResult = await db.query(`
          SELECT
            am.id,
            am.name::text           AS bill_name,
            (am.invoice_origin)::text AS invoice_origin,
            am.ref::text,
            am.amount_total,
            am.amount_tax,
            cu.name::text           AS currency,
            rp.name::text           AS partner,
            am.invoice_date::text,
            EXISTS (
              SELECT 1 FROM purchase_order po
              WHERE po.company_id IN (1,2)
                AND po.name ILIKE $1
                AND po.partner_id = am.partner_id
            ) AS is_goods_supplier,
            COALESCE(aml_s.lines_json, '[]'::json) AS lines
          FROM account_move am
          JOIN res_currency cu ON cu.id = am.currency_id
          JOIN res_partner  rp ON rp.id = am.partner_id
          LEFT JOIN LATERAL (
            SELECT json_agg(json_build_object(
              'name',   aml.name,
              'amount', aml.price_subtotal
            ) ORDER BY aml.price_subtotal DESC) AS lines_json
            FROM account_move_line aml
            WHERE aml.move_id = am.id AND aml.display_type = 'product'
          ) aml_s ON true
          WHERE am.company_id IN (1,2)
            ${coFilter}
            AND am.move_type = 'in_invoice'
            AND am.state != 'cancel'
            AND (
              (am.invoice_origin)::text ILIKE $1
              OR am.ref::text ILIKE $1
            )
          ORDER BY am.invoice_date DESC
          LIMIT 30
        `, [`%${poNo}%`]);

        // 2. Expense POs: ค้นหาจาก origin field, category = Expense / ...
        const expResult = await db.query(`
          SELECT po.name::text AS po_number, po.amount_total, cu.name::text AS currency,
            pol_cat.expense_sub, pol_prod.main_product
          FROM purchase_order po
          JOIN res_currency cu ON cu.id = po.currency_id
          LEFT JOIN LATERAL (
            SELECT split_part(pc.complete_name, ' / ', 2) AS expense_sub
            FROM purchase_order_line pol
            JOIN product_product  pp ON pp.id = pol.product_id
            JOIN product_template pt ON pt.id = pp.product_tmpl_id
            JOIN product_category pc ON pc.id = pt.categ_id
            WHERE pol.order_id = po.id
            GROUP BY 1 ORDER BY SUM(pol.price_subtotal) DESC LIMIT 1
          ) pol_cat ON true
          LEFT JOIN LATERAL (
            SELECT (pt.name)::text AS main_product
            FROM purchase_order_line pol
            JOIN product_product  pp ON pp.id = pol.product_id
            JOIN product_template pt ON pt.id = pp.product_tmpl_id
            WHERE pol.order_id = po.id ORDER BY pol.price_subtotal DESC LIMIT 1
          ) pol_prod ON true
          WHERE po.company_id IN (1,2)
            ${coFilterPo}
            AND po.state NOT IN ('cancel')
            AND (po.origin ILIKE $1 OR (po.notes::text) ILIKE $1)
            AND EXISTS (
              SELECT 1 FROM purchase_order_line pol2
              JOIN product_product  pp2 ON pp2.id = pol2.product_id
              JOIN product_template pt2 ON pt2.id = pp2.product_tmpl_id
              JOIN product_category pc2 ON pc2.id = pt2.categ_id
              WHERE pol2.order_id = po.id
                AND pc2.complete_name ILIKE 'Expense%'
            )
        `, [`%${poNo}%`]);

        // ── Classify costs ──
        let freight = 0, duty = 0, vat = 0;
        const matched = [];
        const skipped = [];

        // จาก vendor bills
        billResult.rows.forEach(r => {
          const partner = (r.partner || '').toLowerCase();
          const lines   = Array.isArray(r.lines) ? r.lines : [];
          const amt     = parseFloat(r.amount_total) || 0;

          // ── กรองบิลค่าสินค้าออก ──
          // บิลที่ partner = ผู้ขายใน import PO เดียวกัน คือ "ค่าสินค้า" ไม่ใช่ค่าขนส่ง
          if (r.is_goods_supplier) {
            skipped.push({ bill: r.bill_name, partner: r.partner, amount: amt,
              currency: r.currency, reason: 'goods_supplier_bill' });
            return;
          }
          // บิลสกุลเงินต่างประเทศที่ไม่ใช่ forwarder/customs → น่าจะเป็นค่าสินค้าด้วย ข้าม
          const isThb = (r.currency === 'THB');
          if (!isThb && !FORWARDER_RE.test(partner) && !CUSTOMS_RE.test(partner)) {
            skipped.push({ bill: r.bill_name, partner: r.partner, amount: amt,
              currency: r.currency, reason: 'foreign_currency_non_logistics' });
            return;
          }

          // ตรวจ line items ก่อน
          let billFreight = 0, billDuty = 0, billVat = 0;
          lines.forEach(l => {
            const n = (l.name || '').toLowerCase();
            const a = parseFloat(l.amount) || 0;
            if (/freight|shipping|ขนส่ง|sea freight|air freight|เรือ|อากาศ/.test(n)) billFreight += a;
            else if (/duty|อากร|import duty/.test(n)) billDuty += a;
            else if (/vat|ภาษี|customs vat|พิธี|tax/.test(n)) billVat += a;
            else billFreight += a; // unknown line → นับเป็น freight
          });

          // ถ้าไม่มี line items เลย → classify จาก partner name โดยใช้ amount_total
          if (lines.length === 0) {
            if (CUSTOMS_RE.test(partner)) { billDuty = amt * 0.8; billVat = amt * 0.2; }
            else billFreight = amt;
          }

          freight += billFreight;
          duty    += billDuty;
          vat     += billVat;
          matched.push({ source: 'vendor_bill', bill: r.bill_name, partner: r.partner,
            amount: amt, currency: r.currency, date: r.invoice_date,
            classified: { freight: billFreight, duty: billDuty, vat: billVat } });
        });

        // จาก expense POs
        expResult.rows.forEach(r => {
          const sub  = (r.expense_sub  || '').toLowerCase();
          const prod = (r.main_product || '').toLowerCase();
          const tag  = sub + ' ' + prod;
          const amt  = parseFloat(r.amount_total) || 0;
          if (/freight|shipping|ขนส่ง|เรือ|sea|forwarder/.test(tag)) freight += amt;
          else if (/duty|อากร/.test(tag)) duty += amt;
          else if (/vat|ภาษี|customs/.test(tag)) vat += amt;
          else freight += amt;
          matched.push({ source: 'expense_po', po: r.po_number, amount: amt, currency: r.currency,
            expense_sub: r.expense_sub, product: r.main_product });
        });

        jsonOk(res, { ok: true, po: poNo, freight: Math.round(freight), duty: Math.round(duty), vat: Math.round(vat), matched, skipped });
      } catch(e) {
        console.error('[API] costs-for-po:', e.message);
        jsonErr(res, 500, e.message);
      }
      return;
    }

    if (reqUrl === '/api/ping' && method === 'GET') {
      try {
        await db.query('SELECT 1');
        jsonOk(res, { ok: true, db: 'kiss-production', ts: new Date().toISOString() });
      } catch (e) {
        jsonErr(res, 500, e.message);
      }
      return;
    }

    // Lightweight liveness probe — does NOT touch the DB. Used by watchdog
    // health checks so a slow/unreachable database never triggers a restart.
    if (reqUrl === '/api/alive' && method === 'GET') {
      jsonOk(res, { ok: true, ts: new Date().toISOString() });
      return;
    }

    if (reqUrl === '/api/cache/clear' && method === 'GET') {
      cache.data = {}; cache.ts = {};
      markDbUp(); // กด Sync = อยากลอง Odoo จริง ปลด circuit breaker
      jsonOk(res, { ok: true, message: 'Cache cleared' });
      return;
    }

    // ── ผลตรวจสอบข้อมูลอัตโนมัติ — GET /api/integrity-check?force=1 เพื่อสั่งตรวจใหม่ทันที ──
    if (reqUrl === '/api/integrity-check' && method === 'GET') {
      const force = new URL('http://x' + req.url).searchParams.get('force') === '1';
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
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!Array.isArray(data)) { jsonErr(res, 400, 'expected array'); return; }
          auditLog('replace_all', '*', ['(' + data.length + ' records)'], req.socket.remoteAddress);
          const ok = saveTracking(data);
          jsonOk(res, { ok, count: data.length });
        } catch(e) { jsonErr(res, 400, e.message); }
      });
      return;
    }

    // ── Upsert ทีละรายการ: ปลอดภัยเมื่อใช้พร้อมกันหลายคน ──
    // POST /api/tracking/upsert  body = record เดียว หรือ array ของ records
    // merge ด้วย key po_so — ไม่แตะรายการอื่นในไฟล์
    if (reqUrl === '/api/tracking/upsert' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const input = JSON.parse(body);
          const recs  = Array.isArray(input) ? input : [input];
          const data  = loadTracking();
          const byKey = new Map();
          data.forEach((r, i) => { const k = r.po_so || r.id; if (k != null && !byKey.has(k)) byKey.set(k, i); });
          let applied = 0;
          recs.forEach(r => {
            const key = r && (r.po_so || r.id);
            if (key == null) return;
            const idx    = byKey.has(key) ? byKey.get(key) : -1;
            const before = idx >= 0 ? data[idx] : null;
            if (idx >= 0) data[idx] = { ...data[idx], ...r };
            else { byKey.set(key, data.length); data.push(r); }
            const changed = before
              ? Object.keys(r).filter(k => JSON.stringify(before[k]) !== JSON.stringify(r[k]))
              : Object.keys(r);
            auditLog(before ? 'update' : 'create', key, changed, req.socket.remoteAddress);
            applied++;
          });
          const ok = saveTracking(data);
          jsonOk(res, { ok, applied, total: data.length });
        } catch(e) { jsonErr(res, 400, e.message); }
      });
      return;
    }

    // ── ลบ shipment ที่แยกเอง (synthetic) เท่านั้น — ห้ามลบ PO จริงที่มาจาก Odoo ──
    // ปิดใช้งานโดย default: ต้องตั้ง DELETE_PASSWORD ใน .env ก่อน ไม่งั้นทุกคำขอถูกปฏิเสธเสมอ
    // (ผู้ใช้ทั่วไปแก้ .env ไม่ได้ — เจ้าของระบบเป็นคนตั้งรหัสแล้วแจกให้เฉพาะผู้มีอำนาจเท่านั้น)
    // POST /api/tracking/delete  body = { po_so, password }
    if (reqUrl === '/api/tracking/delete' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          if (!process.env.DELETE_PASSWORD) {
            jsonErr(res, 403, 'ฟีเจอร์ลบยังไม่เปิดใช้งาน — ต้องตั้งค่า DELETE_PASSWORD ใน .env ก่อน');
            return;
          }
          const { po_so, password } = JSON.parse(body || '{}');
          if (password !== process.env.DELETE_PASSWORD) {
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
      });
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
      } catch(e) { jsonErr(res, 500, e.message); }
      return;
    }

    // ── อัตราแลกเปลี่ยนล่าสุดจาก Odoo (ใช้ตอนสร้างรายการใหม่) ──
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
        `);
        // Odoo เก็บ rate = จำนวนหน่วยเงินนั้นต่อ 1 บาท → thb_per_unit = 1/rate
        const out = rows.map(r => {
          const rate = parseFloat(r.rate) || 0;
          return { currency: r.currency, thb_per_unit: rate > 0 ? 1 / rate : null, as_of: r.as_of };
        }).filter(r => r.thb_per_unit);
        jsonOk(res, { ok: true, count: out.length, rows: out });
      } catch(e) {
        console.error('[API] fx-rates:', e.message);
        jsonErr(res, 500, e.message);
      }
      return;
    }

    // ── Logistics Shipments (logistics.shipment Odoo model) ──
    // GET  /api/shipments          — อ่านจาก DB (SQL)
    // POST /api/shipments          — สร้างใน Odoo ผ่าน JSON-RPC
    // PATCH /api/shipments/:id     — แก้ไขใน Odoo ผ่าน JSON-RPC
    // DELETE /api/shipments/:id    — ลบใน Odoo ผ่าน JSON-RPC

    if (reqUrl === '/api/shipments' && method === 'GET') {
      try {
        const rows = await cachedQuery('shipments', SQL_SHIPMENTS);
        jsonOk(res, { ok: true, count: rows.length, rows });
      } catch (e) {
        if (e.message.includes('does not exist')) {
          jsonOk(res, { ok: true, count: 0, rows: [], note: 'logistics_shipment table not found — install module first' });
        } else {
          console.error('[API] shipments GET:', e.message);
          jsonErr(res, 500, e.message);
        }
      }
      return;
    }

    if (reqUrl === '/api/shipments' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const vals = JSON.parse(body);
          const id = await odooKw('logistics.shipment', 'create', [vals]);
          delete cache.data['shipments'];
          jsonOk(res, { ok: true, id });
        } catch (e) {
          console.error('[API] shipments POST:', e.message);
          jsonErr(res, 500, e.message);
        }
      });
      return;
    }

    const shipPatchMatch = reqUrl.match(/^\/api\/shipments\/(\d+)$/);
    if (shipPatchMatch && method === 'PATCH') {
      const shipId = parseInt(shipPatchMatch[1]);
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const vals = JSON.parse(body);
          await odooKw('logistics.shipment', 'write', [[shipId], vals]);
          delete cache.data['shipments'];
          jsonOk(res, { ok: true, id: shipId });
        } catch (e) {
          console.error('[API] shipments PATCH:', e.message);
          jsonErr(res, 500, e.message);
        }
      });
      return;
    }

    if (shipPatchMatch && method === 'DELETE') {
      const shipId = parseInt(shipPatchMatch[1]);
      try {
        await odooKw('logistics.shipment', 'unlink', [[shipId]]);
        delete cache.data['shipments'];
        jsonOk(res, { ok: true, id: shipId });
      } catch (e) {
        console.error('[API] shipments DELETE:', e.message);
        jsonErr(res, 500, e.message);
      }
      return;
    }

    // ── AI ตรวจเอกสาร shipment (layer 4) — เรียก Claude API ตรงจาก server ──
    // multipart/form-data: field "mode" (import|export) + field "files" (หลายไฟล์)
    // มีค่าใช้จ่ายจริงต่อครั้ง (ต้องตั้ง ANTHROPIC_API_KEY ใน .env ก่อน)
    if (reqUrl === '/api/verify-shipment' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) {
        jsonErr(res, 503, 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน .env — ฟีเจอร์ตรวจเอกสารยังใช้งานไม่ได้');
        return;
      }
      try {
        const result = await verifyShipmentRequest(req);
        jsonOk(res, result);
      } catch (e) {
        console.error('[API] verify-shipment:', e.message);
        jsonErr(res, e.code === 'NO_API_KEY' ? 503 : 400, e.message);
      }
      return;
    }

    jsonErr(res, 404, 'API endpoint not found');
    return;
  }

  // ── Static Files ──
  const ALIASES = ['/', '/index.html'];
  let filePath = ALIASES.includes(reqUrl) ? '/logistics-tracking-app.html' : reqUrl;
  filePath = path.join(ROOT, filePath);
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found: ' + reqUrl);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

// การตรวจเอกสารด้วย AI (/api/verify-shipment) เป็น request เดียวที่ใช้เวลานาน (30 วิ - 2 นาที)
// ค่า default ของ Node (headersTimeout 60s, requestTimeout 5min) พอไหวอยู่แล้ว แต่ตั้งชัดเจน
// ไว้กันเคสไฟล์เยอะ/เอกสารยาวผิดปกติที่อาจใช้เวลาเกิน 5 นาที
server.requestTimeout = 6 * 60 * 1000;
server.headersTimeout = 65 * 1000;

// HOST=127.0.0.1 (ค่าเริ่มต้น) = เข้าได้เฉพาะเครื่องนี้
// ถ้าต้องการเปิดให้เครือข่าย ให้ตั้ง HOST=0.0.0.0 + APP_PASSWORD ใน .env
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  const odooStatus = ODOO.user ? `✓ ${ODOO.user}` : '✗ ไม่ได้ตั้งค่า (set ODOO_USER/ODOO_PASS)';
  const authStatus = process.env.APP_PASSWORD ? '✓ Basic Auth เปิดอยู่' : '✗ ปิด (ตั้ง APP_PASSWORD เพื่อเปิด)';
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   Logistics Tracking + Odoo API Server           ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   Web App : http://localhost:${PORT}/                 ║`);
  console.log(`║   Bind    : ${HOST.padEnd(38)} ║`);
  console.log(`║   DB      : ${(process.env.DB_NAME || '?').padEnd(38)} ║`);
  console.log(`║   Auth    : ${authStatus.substring(0,38).padEnd(38)} ║`);
  console.log(`║   Odoo RPC: ${odooStatus.substring(0,38).padEnd(38)} ║`);
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

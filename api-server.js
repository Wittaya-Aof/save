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

const PORT = 3000;
const ROOT = __dirname;
const TRACKING_FILE = path.join(ROOT, 'tracking_data.json');
const AUDIT_FILE    = path.join(ROOT, 'tracking_audit.jsonl');
const BACKUP_DIR    = path.join(ROOT, 'backups');

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
});

db.on('error', (err) => console.error('[DB] Unexpected error:', err.message));

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
    po.currency_rate,
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

async function cachedQuery(key, sql) {
  const now = Date.now();
  if (cache.data[key] && (now - cache.ts[key]) < CACHE_TTL) {
    return cache.data[key];
  }
  const result = await db.query(sql);
  cache.data[key] = result.rows;
  cache.ts[key]   = now;
  return result.rows;
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
      try {
        const rows = await cachedQuery('import', SQL_IMPORT);
        jsonOk(res, { ok: true, count: rows.length, rows });
      } catch (e) {
        console.error('[API] import-pos:', e.message);
        jsonErr(res, 500, e.message);
      }
      return;
    }

    if (reqUrl === '/api/export-sos' && method === 'GET') {
      try {
        const rows = await cachedQuery('export', SQL_EXPORT);
        jsonOk(res, { ok: true, count: rows.length, rows });
      } catch (e) {
        console.error('[API] export-sos:', e.message);
        jsonErr(res, 500, e.message);
      }
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
      try {
        const args = [`%${q}%`];
        const billSearch = q ? `AND (rp.name ILIKE $1 OR am.ref::text ILIKE $1 OR (am.invoice_origin)::text ILIKE $1 OR am.name::text ILIKE $1)` : '';
        const poSearch   = q ? `AND (rp.name ILIKE $1 OR po.name ILIKE $1 OR po.origin ILIKE $1)` : '';

        // (1) Vendor Bills: partner เข้า pattern หรือ line เป็นสินค้าหมวด Import Expenses
        const billRows = (await db.query(`
          SELECT
            am.id,
            am.name::text             AS bill_name,
            (am.invoice_origin)::text AS invoice_origin,
            am.ref::text,
            am.amount_total,
            am.amount_tax,
            cu.name::text             AS currency,
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
            ${billSearch}
          ORDER BY am.invoice_date DESC
          LIMIT 300
        `, q ? args : [])).rows;

        // (2) Expense POs: หมวด Import Expenses หรือ partner โลจิสติกส์ — รอออกบิล
        const poRows = (await db.query(`
          SELECT
            po.id,
            po.name::text        AS po_number,
            po.origin::text,
            po.amount_total,
            cu.name::text        AS currency,
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
            ${poSearch}
          ORDER BY po.date_order DESC
          LIMIT 300
        `, q ? args : [])).rows;

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
        billRows.forEach(r => {
          const total = parseFloat(r.amount_total) || 0;
          const tax   = parseFloat(r.amount_tax)   || 0;
          const lines = Array.isArray(r.lines) ? r.lines : [];
          const text  = lines.map(l => l.name || '').join(' ');
          const c = zero5();
          // ลองแยกตาม line ก่อน — ใช้ได้เมื่อยอด line บวกรวมแล้วเป็นยอดจริง (ไม่หักล้างกัน)
          let lineTotal = 0;
          const lineSums = zero5();
          lines.forEach(l => { const a = parseFloat(l.amount) || 0; lineTotal += a; lineSums[lineCat(l.name)] += a; });
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
            date: r.doc_date, category: cat, ...round5(c) });
        });
        poRows.forEach(r => {
          // PO ที่มีบิลอ้างถึงแล้ว → ข้าม (ใช้ยอดจากบิลจริงแทน)
          if (billedPoNames.has((r.po_number || '').trim())) return;
          const total = parseFloat(r.amount_total) || 0;
          const text  = (r.main_product || '') + ' ' + (r.cat_name || '');
          const cat   = wholeBillCat(text, r.partner, 0);
          const c = zero5(); c[cat] = total;
          out.push({ id: 'po_' + r.id, kind: 'po', bill: r.po_number, partner: r.partner,
            ref: r.origin, origin: r.origin, amount: total, currency: r.currency,
            date: r.doc_date, category: cat, ...round5(c) });
        });
        out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        jsonOk(res, { ok: true, count: out.length, months, bills: out });
      } catch(e) {
        console.error('[API] logistics-bills:', e.message);
        jsonErr(res, 500, e.message);
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
      jsonOk(res, { ok: true, message: 'Cache cleared' });
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
});

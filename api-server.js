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

// ─── Postgres connection (read-only user) ────────────────────────
const db = new Pool({
  host:     'db-odoo-prod.c5m88wi68cyr.ap-southeast-1.rds.amazonaws.com',
  port:     5432,
  database: 'kiss-production',
  user:     'bim_read_only',
  password: 'BiMro0K!ss37',
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
function jsonOk(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
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

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
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

    if (reqUrl === '/api/tracking' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!Array.isArray(data)) { jsonErr(res, 400, 'expected array'); return; }
          const ok = saveTracking(data);
          jsonOk(res, { ok, count: data.length });
        } catch(e) { jsonErr(res, 400, e.message); }
      });
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

server.listen(PORT, () => {
  const odooStatus = ODOO.user ? `✓ ${ODOO.user}` : '✗ ไม่ได้ตั้งค่า (set ODOO_USER/ODOO_PASS)';
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   Logistics Tracking + Odoo API Server           ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   Web App : http://localhost:${PORT}/                 ║`);
  console.log(`║   API     : http://localhost:${PORT}/api/import-pos   ║`);
  console.log(`║   DB      : kiss-production (AWS RDS, SSL)        ║`);
  console.log(`║   Odoo RPC: ${odooStatus.substring(0,38).padEnd(38)} ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
});

// ─── SQL ร่วมสำหรับดึง import PO / export SO ผ่าน MCP proxy ───────────────────
// ใช้ร่วมกันโดย api-server.js (MCP fallback อัตโนมัติในตัว server) และ build-snapshot.mjs
// (สคริปต์สำรองไว้รันมือ) — เดิมสองไฟล์นี้ก็อปปี้ SQL ชุดนี้แยกกันคนละที่ ถ้าแก้เงื่อนไขกรอง
// (เช่น goods_category ที่นับเป็น import จริง) แล้วแก้แค่ไฟล์เดียว อีกไฟล์จะข้อมูลไม่ตรงกันแบบไม่รู้ตัว
// ต้อง mirror WHERE/ชื่อคอลัมน์ให้ตรงกับ SQL_IMPORT/SQL_EXPORT (query ตรง ไม่ผ่าน MCP) ใน api-server.js ด้วย
//
// currency_rate self-heal ใช้โครงสร้าง CTE (base → bad_names → fixed_rates) เหมือน SQL_IMPORT/SQL_EXPORT
// ไม่ทำเป็น correlated subquery ตรงใน SELECT list — ยืนยันด้วย EXPLAIN จริงว่าแค่มี correlated subquery
// อยู่ใน SELECT list ก็ทำให้ query planner ทิ้ง plan ที่มีประสิทธิภาพไปเลือก plan cost ~500 พันล้าน (ทำให้
// query timeout) ไม่ว่า subquery จะ trigger จริงกี่ครั้งก็ตาม ดู comment เต็มที่ SQL_IMPORT ใน api-server.js
const IMPORT_INNER = `
  WITH base AS (
    SELECT po.id, po.name AS po_number,
      CASE po.company_id WHEN 1 THEN 'KOB' WHEN 2 THEN 'BTV' ELSE 'OTHER' END AS company_code,
      rp.name AS supplier, po.state AS odoo_state,
      po.date_order AS raw_date_order, po.date_planned AS raw_date_planned,
      po.amount_total, cu.name AS currency, po.currency_rate AS raw_rate,
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
      AND cat.top_cat IN ('Packaging','Finished Goods','Raw Materials')
  ),
  -- ต้องกัน currency<>'THB' ก่อนเสมอ — แถวที่ผู้ขายต่างประเทศแต่ตกลงจ่ายเป็น THB (rate=1 ถูกต้องอยู่แล้ว)
  -- ไม่ควรถูกนับเป็น "เพี้ยน" (เจอจริงฝั่ง export 17/105 แถว ก่อนแก้ 16 ก.ค. 2569)
  bad_names AS (
    SELECT po_number FROM base
    WHERE currency <> 'THB' AND (raw_rate IS NULL OR raw_rate <= 0 OR ABS(raw_rate - 1) < 1e-9)
  ),
  fixed_rates AS (
    SELECT DISTINCT ON (am.invoice_origin) am.invoice_origin, am.invoice_currency_rate
    FROM account_move am
    WHERE am.invoice_origin IN (SELECT po_number FROM bad_names)
      AND am.state = 'posted' AND am.invoice_currency_rate IS NOT NULL
    ORDER BY am.invoice_origin, am.invoice_date DESC
  )
  SELECT base.id, base.po_number, base.company_code, base.supplier, base.odoo_state,
    to_char(base.raw_date_order,'YYYY-MM-DD') AS date_order,
    to_char(base.raw_date_planned,'YYYY-MM-DD') AS date_planned,
    base.amount_total, base.currency,
    COALESCE(fixed_rates.invoice_currency_rate, base.raw_rate) AS currency_rate,
    CASE WHEN fixed_rates.invoice_currency_rate IS NOT NULL THEN 1 ELSE 0 END AS rate_auto_corrected,
    base.receipt_status, base.origin, base.goods_category
  FROM base
  LEFT JOIN fixed_rates ON fixed_rates.invoice_origin = base.po_number`;

const EXPORT_INNER = `
  WITH base AS (
    SELECT so.id, so.name AS so_number,
      CASE so.company_id WHEN 1 THEN 'KOB' WHEN 2 THEN 'BTV' ELSE 'OTHER' END AS company_code,
      rp.name AS customer, so.state AS odoo_state,
      so.date_order AS raw_date_order,
      so.amount_total, cu.name AS currency, so.currency_rate AS raw_rate,
      so.delivery_status, so.origin, rco.code AS country_code
    FROM sale_order so
    JOIN res_company rc ON rc.id = so.company_id
    JOIN res_partner rp ON rp.id = so.partner_id
    JOIN res_currency cu ON cu.id = so.currency_id
    LEFT JOIN res_country rco ON rco.id = rp.country_id
    WHERE so.company_id IN (1,2) AND so.state NOT IN ('cancel','draft')
      AND so.date_order >= NOW() - INTERVAL '2 years'
      AND (rco.code IS NOT NULL AND rco.code != 'TH' OR (rco.code IS NULL AND cu.name NOT IN ('THB')))
  ),
  bad_names AS (
    SELECT so_number FROM base
    WHERE currency <> 'THB' AND (raw_rate IS NULL OR raw_rate <= 0 OR ABS(raw_rate - 1) < 1e-9)
  ),
  fixed_rates AS (
    SELECT DISTINCT ON (am.invoice_origin) am.invoice_origin, am.invoice_currency_rate
    FROM account_move am
    WHERE am.invoice_origin IN (SELECT so_number FROM bad_names)
      AND am.state = 'posted' AND am.invoice_currency_rate IS NOT NULL
    ORDER BY am.invoice_origin, am.invoice_date DESC
  )
  SELECT base.id, base.so_number, base.company_code, base.customer, base.odoo_state,
    to_char(base.raw_date_order,'YYYY-MM-DD') AS date_order,
    base.amount_total, base.currency,
    COALESCE(fixed_rates.invoice_currency_rate, base.raw_rate) AS currency_rate,
    CASE WHEN fixed_rates.invoice_currency_rate IS NOT NULL THEN 1 ELSE 0 END AS rate_auto_corrected,
    base.delivery_status, base.origin, base.country_code
  FROM base
  LEFT JOIN fixed_rates ON fixed_rates.invoice_origin = base.so_number`;

// ORDER BY ที่ mcpWrap/wrap() ใช้ตอน paginate — ต้องคู่กับ IMPORT_INNER/EXPORT_INNER เสมอ (มี r.id กันเรียงชนกัน)
const ORDER_COLS = 'r.date_order AS _ord, r.id AS _id';

module.exports = { IMPORT_INNER, EXPORT_INNER, ORDER_COLS };

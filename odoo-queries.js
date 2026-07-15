// ─── SQL ร่วมสำหรับดึง import PO / export SO ผ่าน MCP proxy ───────────────────
// ใช้ร่วมกันโดย api-server.js (MCP fallback อัตโนมัติในตัว server) และ build-snapshot.mjs
// (สคริปต์สำรองไว้รันมือ) — เดิมสองไฟล์นี้ก็อปปี้ SQL ชุดนี้แยกกันคนละที่ ถ้าแก้เงื่อนไขกรอง
// (เช่น goods_category ที่นับเป็น import จริง) แล้วแก้แค่ไฟล์เดียว อีกไฟล์จะข้อมูลไม่ตรงกันแบบไม่รู้ตัว
// ต้อง mirror WHERE/ชื่อคอลัมน์ให้ตรงกับ SQL_IMPORT/SQL_EXPORT (query ตรง ไม่ผ่าน MCP) ใน api-server.js ด้วย
const IMPORT_INNER = `
  SELECT po.id, po.name AS po_number,
    CASE po.company_id WHEN 1 THEN 'KOB' WHEN 2 THEN 'BTV' ELSE 'OTHER' END AS company_code,
    rp.name AS supplier, po.state AS odoo_state,
    to_char(po.date_order,'YYYY-MM-DD') AS date_order,
    to_char(po.date_planned,'YYYY-MM-DD') AS date_planned,
    po.amount_total, cu.name AS currency,
    CASE
      WHEN po.currency_rate IS NULL OR po.currency_rate <= 0 OR ABS(po.currency_rate - 1) < 1e-9
      THEN COALESCE(
        (SELECT am.invoice_currency_rate FROM account_move am
         WHERE am.invoice_origin = po.name AND am.state = 'posted' AND am.invoice_currency_rate IS NOT NULL
         ORDER BY am.invoice_date DESC LIMIT 1),
        po.currency_rate
      )
      ELSE po.currency_rate
    END AS currency_rate,
    CASE
      WHEN (po.currency_rate IS NULL OR po.currency_rate <= 0 OR ABS(po.currency_rate - 1) < 1e-9)
       AND cu.name <> 'THB'
       AND (SELECT am.invoice_currency_rate FROM account_move am
            WHERE am.invoice_origin = po.name AND am.state = 'posted' AND am.invoice_currency_rate IS NOT NULL
            ORDER BY am.invoice_date DESC LIMIT 1) IS NOT NULL
      THEN 1 ELSE 0
    END AS rate_auto_corrected,
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
    CASE
      WHEN so.currency_rate IS NULL OR so.currency_rate <= 0 OR ABS(so.currency_rate - 1) < 1e-9
      THEN COALESCE(
        (SELECT am.invoice_currency_rate FROM account_move am
         WHERE am.invoice_origin = so.name AND am.state = 'posted' AND am.invoice_currency_rate IS NOT NULL
         ORDER BY am.invoice_date DESC LIMIT 1),
        so.currency_rate
      )
      ELSE so.currency_rate
    END AS currency_rate,
    CASE
      WHEN (so.currency_rate IS NULL OR so.currency_rate <= 0 OR ABS(so.currency_rate - 1) < 1e-9)
       AND cu.name <> 'THB'
       AND (SELECT am.invoice_currency_rate FROM account_move am
            WHERE am.invoice_origin = so.name AND am.state = 'posted' AND am.invoice_currency_rate IS NOT NULL
            ORDER BY am.invoice_date DESC LIMIT 1) IS NOT NULL
      THEN 1 ELSE 0
    END AS rate_auto_corrected,
    so.delivery_status, so.origin, rco.code AS country_code
  FROM sale_order so
  JOIN res_company rc ON rc.id = so.company_id
  JOIN res_partner rp ON rp.id = so.partner_id
  JOIN res_currency cu ON cu.id = so.currency_id
  LEFT JOIN res_country rco ON rco.id = rp.country_id
  WHERE so.company_id IN (1,2) AND so.state NOT IN ('cancel','draft')
    AND so.date_order >= NOW() - INTERVAL '2 years'
    AND (rco.code IS NOT NULL AND rco.code != 'TH' OR (rco.code IS NULL AND cu.name NOT IN ('THB')))`;

// ORDER BY ที่ mcpWrap/wrap() ใช้ตอน paginate — ต้องคู่กับ IMPORT_INNER/EXPORT_INNER เสมอ (มี r.id กันเรียงชนกัน)
const ORDER_COLS = 'r.date_order AS _ord, r.id AS _id';

module.exports = { IMPORT_INNER, EXPORT_INNER, ORDER_COLS };

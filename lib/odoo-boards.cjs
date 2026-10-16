'use strict';

const MAX_ROWS = 100000;
const BATCH = 500;
const GOODS = new Set(['Packaging', 'Finished Goods', 'Raw Materials']);
const nullable = value => value === false || value === undefined || value === null ? null : value;
const idOf = value => Array.isArray(value) ? value[0] : nullable(value);
const unique = values => [...new Set(values.filter(value => value !== null && value !== undefined))];

function utcTimestamp(value) {
  if (!nullable(value)) return null;
  const text = String(value);
  const date = new Date(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(date.getTime())) throw new Error('Odoo invalid timestamp');
  return date.toISOString();
}

function twoYearCutoff(date) {
  const result = new Date(date);
  const month = result.getUTCMonth(), day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCFullYear(result.getUTCFullYear() - 2);
  const last = new Date(Date.UTC(result.getUTCFullYear(), month + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result.toISOString().replace('T', ' ').slice(0, 19);
}

function createOdooBoards(client, { now = () => new Date() } = {}) {
  function checkBoard(board) {
    if (board !== 'import' && board !== 'export') throw new Error('Odoo invalid board');
  }

  async function readMap(model, ids, fields) {
    const wanted = unique(ids);
    if (wanted.length > MAX_ROWS) throw new Error('Odoo related-record limit overflow');
    const map = new Map();
    for (let offset = 0; offset < wanted.length; offset += BATCH) {
      const batch = wanted.slice(offset, offset + BATCH);
      const rows = await client.read(model, batch, fields);
      for (const row of rows) map.set(row.id, row);
      // Missing access must not turn a financial join into silently incomplete data.
      if (batch.some(id => !map.has(id))) throw new Error('Odoo related records unavailable');
    }
    return map;
  }

  async function related(model, key, values, fields, extra = [], options = {}) {
    const wanted = unique(values);
    const out = [];
    for (let offset = 0; offset < wanted.length; offset += BATCH) {
      const rows = await client.searchAll(model, [[key, 'in', wanted.slice(offset, offset + BATCH)], ...extra], fields, { ...options, maxRows: MAX_ROWS });
      out.push(...rows);
      if (out.length > MAX_ROWS) throw new Error('Odoo related-record limit overflow');
    }
    return out;
  }

  async function productsFor(lines, details = false) {
    const products = await readMap('product.product', lines.map(line => idOf(line.product_id)), ['product_tmpl_id']);
    const fields = details ? ['name', 'default_code', 'categ_id'] : ['categ_id'];
    const templates = await readMap('product.template', [...products.values()].map(product => idOf(product.product_tmpl_id)), fields);
    return { products, templates, templateFor: line => templates.get(idOf(products.get(idOf(line.product_id))?.product_tmpl_id)) };
  }

  async function dominantCategories(orders) {
    const lines = await related('purchase.order.line', 'order_id', orders.map(order => order.id), ['order_id', 'product_id', 'price_subtotal']);
    const { templates, templateFor } = await productsFor(lines);
    const categories = await readMap('product.category', [...templates.values()].map(template => idOf(template.categ_id)), ['complete_name']);
    const weights = new Map();
    for (const line of lines) {
      const category = categories.get(idOf(templateFor(line)?.categ_id));
      if (!category || nullable(category.complete_name) === null) continue;
      const top = category.complete_name.split(' / ')[0];
      const orderId = idOf(line.order_id);
      if (!weights.has(orderId)) weights.set(orderId, new Map());
      const orderWeights = weights.get(orderId);
      if (!orderWeights.has(top)) orderWeights.set(top, null);
      if (nullable(line.price_subtotal) !== null) orderWeights.set(top, (orderWeights.get(top) || 0) + Number(line.price_subtotal));
    }
    const result = new Map();
    for (const [orderId, entries] of weights) {
      // SQL has no secondary category sort; stabilize genuine equal-value groups.
      const ranked = [...entries].sort(([a, av], [b, bv]) => {
        if ((av === null) !== (bv === null)) return av === null ? 1 : -1;
        return (bv || 0) - (av || 0) || a.localeCompare(b, 'en');
      });
      result.set(orderId, ranked[0][0]);
    }
    return result;
  }

  async function repairRates(rows, orders, imports) {
    const bad = rows.filter(row => row.currency !== 'THB' && (row.currency_rate === null || row.currency_rate <= 0 || Math.abs(row.currency_rate - 1) < 1e-9));
    const orderCurrency = new Map(orders.map(order => [order.id, idOf(order.currency_id)]));
    const direction = imports ? 'in_invoice' : 'out_invoice';
    // Refunds can have a different exchange-date basis; they are not evidence of
    // the original purchase/sale rate without an explicit business rule.
    const moves = await related('account.move', 'invoice_origin', bad.map(row => row.po_number || row.so_number), ['invoice_origin', 'company_id', 'currency_id', 'move_type', 'invoice_currency_rate', 'invoice_date'], [
      ['state', '=', 'posted'], ['move_type', '=', direction],
      ['company_id', 'in', unique(bad.map(row => row.company_id))],
      ['currency_id', 'in', unique(bad.map(row => orderCurrency.get(row.id)))],
    ], { order: 'invoice_date desc, id desc' });
    const key = (origin, company, currency) => JSON.stringify([origin, company, currency]);
    const latest = new Map();
    for (const move of moves) {
      const rate = Number(nullable(move.invoice_currency_rate));
      if (!Number.isFinite(rate) || rate <= 0 || move.move_type !== direction) continue;
      const scope = key(move.invoice_origin, idOf(move.company_id), idOf(move.currency_id));
      if (!latest.has(scope)) latest.set(scope, rate);
    }
    for (const row of bad) {
      const scope = key(row.po_number || row.so_number, row.company_id, orderCurrency.get(row.id));
      if (latest.has(scope)) { row.currency_rate = latest.get(scope); row.rate_auto_corrected = 1; }
    }
  }

  async function boards(board = 'import') {
    checkBoard(board);
    const imports = board === 'import';
    const cutoff = twoYearCutoff(now());
    const commonFields = ['name', 'company_id', 'partner_id', 'state', 'date_order', 'amount_total', 'currency_id', 'currency_rate', 'origin'];
    const fields = [...commonFields, ...(imports ? ['date_planned', 'receipt_status', 'notes'] : ['delivery_status', 'invoice_status'])];
    const country = 'partner_id.country_id.code';
    const domain = [
      ['company_id', 'in', [1, 2]], ['state', 'not in', imports ? ['cancel'] : ['cancel', 'draft']], ['date_order', '>=', cutoff],
      '|', '&', [country, '!=', false], [country, '!=', 'TH'],
      '&', '|', ['partner_id.country_id', '=', false], [country, '=', false], ['currency_id.name', 'not in', ['THB']],
    ];
    const model = imports ? 'purchase.order' : 'sale.order';
    const orders = imports
      ? await client.searchAll(model, domain, fields, { order: 'date_order desc, id desc', maxRows: MAX_ROWS })
      : await client.searchRead(model, domain, fields, { order: 'date_order desc, id desc', limit: 500 });
    const categories = imports ? await dominantCategories(orders) : new Map();
    const selected = (imports ? orders.filter(order => GOODS.has(categories.get(order.id))) : orders).slice(0, imports ? 2000 : 500);
    const [partners, companies, currencies] = await Promise.all([
      readMap('res.partner', selected.map(order => idOf(order.partner_id)), ['name', 'country_id']),
      readMap('res.company', selected.map(order => idOf(order.company_id)), ['name']),
      readMap('res.currency', selected.map(order => idOf(order.currency_id)), ['name']),
    ]);
    const countries = imports ? new Map() : await readMap('res.country', [...partners.values()].map(partner => idOf(partner.country_id)), ['code']);
    const receipts = new Map();
    if (imports) {
      const pickings = await related('stock.picking', 'origin', selected.map(order => order.name), ['origin', 'company_id', 'date_done'], [['company_id', 'in', [1, 2]], ['state', '=', 'done'], ['date_done', '>=', cutoff]], { order: 'date_done desc, id desc' });
      for (const picking of pickings) {
        const key = `${idOf(picking.company_id)}:${picking.origin}`;
        if (nullable(picking.date_done) !== null && !receipts.has(key)) receipts.set(key, String(picking.date_done).slice(0, 10));
      }
    }
    const rows = selected.map(order => {
      const companyId = idOf(order.company_id);
      const partner = partners.get(idOf(order.partner_id));
      const row = {
        id: order.id, [imports ? 'po_number' : 'so_number']: order.name,
        company_id: companyId, company_name: nullable(companies.get(companyId)?.name), company_code: companyId === 1 ? 'KOB' : companyId === 2 ? 'BTV' : 'OTHER',
        partner_id: idOf(order.partner_id), [imports ? 'supplier' : 'customer']: nullable(partner?.name),
        odoo_state: nullable(order.state), date_order: utcTimestamp(order.date_order),
        ...(imports ? { date_planned: utcTimestamp(order.date_planned) } : {}),
        amount_total: nullable(order.amount_total), currency: nullable(currencies.get(idOf(order.currency_id))?.name), currency_rate: nullable(order.currency_rate), rate_auto_corrected: 0,
      };
      if (imports) Object.assign(row, { receipt_status: nullable(order.receipt_status), origin: nullable(order.origin), notes: nullable(order.notes), source_type: 'oversea', goods_category: categories.get(order.id), last_receipt_date: receipts.get(`${companyId}:${order.name}`) || null });
      else Object.assign(row, { delivery_status: nullable(order.delivery_status), invoice_status: nullable(order.invoice_status), origin: nullable(order.origin), country_code: nullable(countries.get(idOf(partner?.country_id))?.code), source_type: 'oversea' });
      return row;
    });
    await repairRates(rows, selected, imports);
    return rows;
  }

  async function poLines(board, poNumber, { companyId, orderId } = {}) {
    checkBoard(board);
    if (typeof poNumber !== 'string' || !poNumber || poNumber.length > 200) throw new Error('Odoo invalid order number');
    const imports = board === 'import';
    const orderModel = imports ? 'purchase.order' : 'sale.order';
    if (companyId !== undefined && ![1, 2].includes(companyId)) throw new Error('Odoo invalid company_id');
    if (orderId !== undefined && (!Number.isSafeInteger(orderId) || orderId <= 0)) throw new Error('Odoo invalid order_id');
    const domain = [['name', '=', poNumber], ['company_id', 'in', [1, 2]]];
    if (companyId !== undefined) domain.push(['company_id', '=', companyId]);
    if (orderId !== undefined) domain.push(['id', '=', orderId]);
    const orders = await client.searchAll(orderModel, domain, ['id']);
    if (orders.length > 1) throw new Error('Odoo ambiguous order number; specify company_id and order_id');
    const qty = imports ? 'product_qty' : 'product_uom_qty';
    const fulfilled = imports ? 'qty_received' : 'qty_delivered';
    const lines = await related(orderModel + '.line', 'order_id', orders.map(order => order.id), ['sequence', 'product_id', 'product_uom', 'name', qty, fulfilled, 'qty_invoiced', 'price_unit', 'price_subtotal', 'price_total'], [['display_type', '=', false]], { order: 'sequence asc, id asc' });
    // Related chunks may interleave sequence values across duplicate order names.
    lines.sort((a, b) => (nullable(a.sequence) === null ? Infinity : a.sequence) - (nullable(b.sequence) === null ? Infinity : b.sequence) || a.id - b.id);
    const { templateFor } = await productsFor(lines, true);
    const uoms = await readMap('uom.uom', lines.map(line => idOf(line.product_uom)), ['name']);
    return lines.map(line => ({
      id: line.id, sequence: nullable(line.sequence), product_name: nullable(templateFor(line)?.name) ?? nullable(line.name), sku: nullable(templateFor(line)?.default_code),
      qty: nullable(line[qty]), uom: nullable(uoms.get(idOf(line.product_uom))?.name), price_unit: nullable(line.price_unit), price_subtotal: nullable(line.price_subtotal), price_total: nullable(line.price_total),
      qty_fulfilled: nullable(line[fulfilled]), qty_invoiced: nullable(line.qty_invoiced),
    }));
  }

  return { boards, poLines };
}
module.exports = { createOdooBoards };

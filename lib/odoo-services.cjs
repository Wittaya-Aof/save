'use strict';

const COMPANIES = [1, 2];
const MAX_ROWS = 100000;
const CHUNK = 500;
const IMPORT_ROOTS = new Set(['Packaging', 'Finished Goods', 'Raw Materials']);
const LOGISTICS = /dhl|kerry|pantos|yusen|sino.?trans|sitc|maersk|oocl|cma|evergreen|nippon|nyk|(?<![\p{L}\p{N}_])ups(?![\p{L}\p{N}_])|fedex|tnt|schenker|expeditors|ceva|dsv|geodis|panalpina|ขนส่ง|forwarder|freight|logistic|shipping|customs|ศุลกากร|broker|clearing|express|cargo|insurance|ประกันภัย|ชิปปิ้ง|marine|transport/iu;
const id = value => Array.isArray(value) ? value[0] : value || null;
const nullable = value => value === false || value == null ? null : value;
const unique = values => [...new Set(values.filter(v => v != null))];
function number(value) {
  if (value === false || value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('Odoo returned an invalid numeric field');
  return n;
}
function positiveRate(value) { const n = number(value); return n > 0 ? n : null; }
function inverseRate(value) { const n = positiveRate(value); return n === null ? null : 1 / n; }
function checked(rows, model, fields) {
  for (const row of rows) for (const field of ['id', ...fields]) {
    if (!Object.hasOwn(row, field)) throw new Error(`Odoo required field unavailable: ${model}.${field}`);
  }
  return rows;
}
function dateTime(date) { return date.toISOString().replace('T', ' ').slice(0, 19); }
// PostgreSQL calendar intervals clamp to the last day of the target month.
function monthsFrom(date, months) {
  const out = new Date(date), day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}
function roundOne(value) { return Math.sign(value) * Math.round(Math.abs(value) * 10 + 1e-10) / 10; }
// Financial thresholds use decimal arithmetic, as PostgreSQL NUMERIC does.
function decimal(value) {
  const n = number(value);
  if (n == null) return null;
  const [mantissa, exponent = '0'] = String(n).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  let units = BigInt(whole + fraction), places = fraction.length - Number(exponent);
  if (places < 0) { units *= 10n ** BigInt(-places); places = 0; }
  return { units, places };
}
function aligned(a, b) {
  const places = Math.max(a.places, b.places);
  return [a.units * 10n ** BigInt(places - a.places), b.units * 10n ** BigInt(places - b.places), places];
}
function addDecimal(a, b) {
  const [left, right, places] = aligned(a, b);
  return { units: left + right, places };
}
function asNumber(value) { return Number(`${value.units}e-${value.places}`); }
function decimalPercent(diff, denominator) {
  const sign = diff < 0n ? -1 : 1, numerator = (diff < 0n ? -diff : diff) * 1000n;
  return sign * Number((numerator * 2n + denominator) / (denominator * 2n)) / 10;
}
function timestamp(value) { return Date.parse(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:\d\d$/.test(String(value)) ? '' : 'Z')); }
function descendingDate(a, b, field) { return String(b[field]).localeCompare(String(a[field])) || a.id - b.id; }

function createOdooServices(client, { now = () => new Date() } = {}) {
  async function all(model, domain, fields, options = {}) {
    return checked(await client.searchAll(model, domain, fields, { order: 'id asc', ...options }), model, fields);
  }
  async function byIds(model, field, ids, fields, domain = []) {
    const out = [];
    const values = unique(ids);
    for (let start = 0; start < values.length; start += CHUNK) {
      out.push(...await all(model, [[field, 'in', values.slice(start, start + CHUNK)], ...domain], fields));
      if (out.length > MAX_ROWS) throw new Error('Odoo supporting-data row limit exceeded');
    }
    return out;
  }
  async function readMap(model, ids, fields) {
    const values = unique(ids), result = new Map();
    for (let start = 0; start < values.length; start += CHUNK) {
      const subset = values.slice(start, start + CHUNK);
      const rows = checked(await client.read(model, subset, fields), model, fields);
      for (const row of rows) result.set(row.id, row);
      if (subset.some(key => !result.has(key))) throw new Error(`Odoo required related records unavailable: ${model}`);
    }
    return result;
  }
  async function currencies(rows) { return readMap('res.currency', rows.map(r => id(r.currency_id)), ['name']); }
  async function partners(rows) { return readMap('res.partner', rows.map(r => id(r.partner_id)), ['name', 'country_id']); }
  async function importOrders(extra = []) {
    const orders = await all('purchase.order', [['company_id', 'in', COMPANIES], ['date_order', '>=', dateTime(monthsFrom(now(), -24))], ...extra], ['name', 'company_id', 'partner_id', 'currency_id', 'amount_total']);
    const [vendors, money, cats] = await Promise.all([partners(orders), currencies(orders), all('product.category', [], ['complete_name'])]);
    const rootIds = cats.filter(c => IMPORT_ROOTS.has(String(c.complete_name).split(' / ')[0])).map(c => c.id);
    const lines = rootIds.length ? await byIds('purchase.order.line', 'order_id', orders.map(p => p.id), ['order_id'], [['product_id.categ_id', 'in', rootIds]]) : [];
    const matching = new Set(lines.map(l => id(l.order_id)));
    const country = await readMap('res.country', [...vendors.values()].map(v => id(v.country_id)), ['code']);
    return {
      orders: orders.filter(order => {
        const vendor = vendors.get(id(order.partner_id)), currency = money.get(id(order.currency_id));
        if (!vendor || !currency || !matching.has(order.id)) return false;
        const code = nullable(country.get(id(vendor.country_id))?.code);
        return code != null ? code !== 'TH' : currency.name !== 'THB';
      }), vendors, money,
    };
  }

  async function vendors() {
    const rows = await all('res.partner', [['supplier_rank', '>', 0], ['active', '=', true], ['is_company', '=', true], ['company_id', 'in', [false, ...COMPANIES]]], ['name', 'country_id']);
    const [orders, countries] = await Promise.all([
      byIds('purchase.order', 'partner_id', rows.map(r => r.id), ['partner_id', 'currency_id', 'date_order'], [['company_id', 'in', COMPANIES], ['state', 'not in', ['cancel']], ['date_order', '>=', dateTime(monthsFrom(now(), -24))]]),
      readMap('res.country', rows.map(r => id(r.country_id)), ['name', 'code']),
    ]);
    const money = await currencies(orders), counts = new Map();
    for (const order of orders) {
      const currency = money.get(id(order.currency_id));
      if (!currency) continue; // SQL has an inner currency join.
      const key = id(order.partner_id), existing = counts.get(key);
      if (!existing) counts.set(key, { count: 1, date: order.date_order, currency: currency.name });
      else {
        existing.count++;
        if (order.date_order > existing.date) { existing.date = order.date_order; existing.currency = currency.name; }
      }
    }
    const result = rows.map(row => {
      const country = countries.get(id(row.country_id)), history = counts.get(row.id);
      return { id: row.id, name: nullable(row.name), country: nullable(country?.name), country_code: nullable(country?.code), po_count: history?.count || 0, last_currency: nullable(history?.currency) };
    });
    result.sort((a, b) => b.po_count - a.po_count || String(a.name).localeCompare(String(b.name), 'en') || a.id - b.id);
    return { rows: result.slice(0, 3000), total: rows.length };
  }

  async function vendorScorecard() {
    const { orders, vendors } = await importOrders();
    const current = now(), lower = dateTime(monthsFrom(current, -36)), upper = dateTime(monthsFrom(current, 36));
    const picks = await byIds('stock.picking', 'origin', orders.map(p => p.name), ['origin', 'company_id', 'scheduled_date', 'date_done'], [['company_id', 'in', COMPANIES], ['state', '=', 'done'], ['scheduled_date', '>=', lower], ['scheduled_date', '<=', upper], ['date_done', '>=', lower], ['date_done', '<=', upper]]);
    const origins = new Map(), groups = new Map();
    for (const order of orders) {
      const key = JSON.stringify([order.name, id(order.company_id)]);
      if (!origins.has(key)) origins.set(key, []);
      origins.get(key).push(order);
    }
    for (const picking of picks) for (const order of origins.get(JSON.stringify([picking.origin, id(picking.company_id)])) || []) {
      const key = id(order.partner_id), vendor = vendors.get(key);
      if (!groups.has(key)) groups.set(key, { vendor_id: key, vendor: nullable(vendor.name), deliveries: 0, on_time: 0, delay: 0 });
      const group = groups.get(key), delay = (timestamp(picking.date_done) - timestamp(picking.scheduled_date)) / 86400000;
      if (!Number.isFinite(delay)) throw new Error('Odoo returned an invalid delivery date field');
      group.deliveries++; group.on_time += delay <= 0 ? 1 : 0; group.delay += delay;
    }
    return [...groups.values()].filter(g => g.deliveries >= 2).sort((a, b) => b.deliveries - a.deliveries || a.vendor_id - b.vendor_id).slice(0, 200).map(({ delay, ...row }) => ({ ...row, avg_delay_days: roundOne(delay / row.deliveries) }));
  }

  async function glReconciliation() {
    const { orders, money } = await importOrders([['invoice_status', '=', 'invoiced']]);
    const moves = await byIds('account.move', 'invoice_origin', orders.map(p => p.name), ['invoice_origin', 'company_id', 'currency_id', 'move_type', 'amount_total'], [['company_id', 'in', COMPANIES], ['state', '=', 'posted'], ['move_type', 'in', ['in_invoice', 'in_refund']]]);
    const totals = new Map();
    for (const move of moves) {
      const key = JSON.stringify([move.invoice_origin, id(move.company_id), id(move.currency_id)]);
      const amount = decimal(move.amount_total);
      if (amount != null) {
        if (move.move_type === 'in_refund') amount.units = -amount.units;
        totals.set(key, addDecimal(totals.get(key) || { units: 0n, places: 0 }, amount));
      }
    }
    return orders.flatMap(order => {
      const total = decimal(order.amount_total), key = JSON.stringify([order.name, id(order.company_id), id(order.currency_id)]);
      if (total == null || total.units <= 0n || !totals.has(key)) return [];
      const billed = totals.get(key), [billedUnits, totalUnits] = aligned(billed, total), diff = billedUnits - totalUnits;
      const absDiff = diff < 0n ? -diff : diff;
      if (absDiff * 100n <= totalUnits * 15n) return [];
      return [{ po_id: order.id, po_number: nullable(order.name), po_total: asNumber(total), currency: nullable(money.get(id(order.currency_id))?.name), billed_total: asNumber(billed), diff_pct: decimalPercent(diff, totalUnits), _ratio: Number(absDiff) / Number(totalUnits) }];
    }).sort((a, b) => b._ratio - a._ratio || a.po_id - b.po_id).slice(0, 300).map(({ _ratio, ...row }) => row);
  }

  async function fxRates() {
    // Match the SQL adapter's UTC effective day. Future-dated entries are not live rates.
    const today = now().toISOString().slice(0, 10);
    const rates = await all('res.currency.rate', [['company_id', 'in', [false, ...COMPANIES]], ['name', '<=', today]], ['company_id', 'currency_id', 'rate', 'name']);
    const money = await currencies(rates), result = new Map();
    for (const rate of rates) {
      const currency = money.get(id(rate.currency_id));
      const sourceCompany = id(rate.company_id);
      if (!currency || !rate.name || rate.name > today) continue;
      for (const company of COMPANIES) {
        if (sourceCompany !== null && sourceCompany !== company) continue;
        const key = JSON.stringify([currency.name, company]), old = result.get(key);
        const specific = sourceCompany === company;
        if (!old || Number(specific) > Number(old.specific) || specific === old.specific && (rate.name > old.row.as_of || rate.name === old.row.as_of && rate.id > old.id)) {
          result.set(key, { specific, id: rate.id, row: { currency: currency.name, rate: number(rate.rate), as_of: rate.name, company_id: company } });
        }
      }
    }
    return [...result.values()].map(value => value.row).sort((a, b) => a.currency.localeCompare(b.currency) || a.company_id - b.company_id);
  }

  async function logisticsBills({ company = '', months = 8, q = '', limit = 300, offset = 0 } = {}) {
    months = Math.min(Math.max(parseInt(months) || 8, 1), 24);
    limit = Math.min(Math.max(parseInt(limit) || 300, 1), 2000);
    offset = Math.max(parseInt(offset) || 0, 0);
    q = String(q).trim().slice(0, 80).replace(/[\\\x00-\x1f]/g, '');
    const cutoff = monthsFrom(now(), -months), companies = company === 'KOB' ? [1] : company === 'BTV' ? [2] : COMPANIES;
    const common = [['company_id', 'in', companies]];
    // invoice_date is SQL DATE: the cutoff day's midnight precedes NOW()-interval.
    const dateOperator = cutoff.toISOString().slice(11) === '00:00:00.000Z' ? '>=' : '>';
    const billDomain = [...common, ['state', '=', 'posted'], ['move_type', 'in', ['in_invoice', 'in_refund']], ['invoice_date', dateOperator, cutoff.toISOString().slice(0, 10)]];
    const poDomain = [...common, ['state', 'not in', ['cancel']], ['date_order', '>=', dateTime(cutoff)]];
    if (q) {
      billDomain.push('|', '|', '|', ['partner_id.name', 'ilike', q], ['ref', 'ilike', q], ['invoice_origin', 'ilike', q], ['name', 'ilike', q]);
      poDomain.push('|', '|', ['partner_id.name', 'ilike', q], ['name', 'ilike', q], ['origin', 'ilike', q]);
    }
    const [bills, orders] = await Promise.all([
      all('account.move', billDomain, ['company_id', 'move_type', 'name', 'invoice_origin', 'ref', 'amount_total', 'amount_tax', 'currency_id', 'inverse_currency_rate', 'invoice_currency_rate', 'partner_id', 'invoice_date']),
      all('purchase.order', poDomain, ['company_id', 'name', 'origin', 'amount_total', 'currency_id', 'currency_rate', 'partner_id', 'date_order']),
    ]);
    const [vendors, money, importCats] = await Promise.all([
      partners([...bills, ...orders]), currencies([...bills, ...orders]), all('product.category', [['complete_name', 'ilike', 'Import Expens']], ['complete_name']),
    ]);
    const categoryIds = importCats.map(c => c.id);
    const [billMatches, poMatches] = categoryIds.length ? await Promise.all([
      byIds('account.move.line', 'move_id', bills.map(b => b.id), ['move_id'], [['product_id.categ_id', 'in', categoryIds]]),
      byIds('purchase.order.line', 'order_id', orders.map(p => p.id), ['order_id'], [['product_id.categ_id', 'in', categoryIds]]),
    ]) : [[], []];
    const matchingBills = new Set(billMatches.map(l => id(l.move_id))), matchingPos = new Set(poMatches.map(l => id(l.order_id)));
    const eligible = (row, matching) => vendors.has(id(row.partner_id)) && money.has(id(row.currency_id)) && (LOGISTICS.test(vendors.get(id(row.partner_id)).name || '') || matching.has(row.id));
    const selectedBills = bills.filter(b => eligible(b, matchingBills)).sort((a, b) => descendingDate(a, b, 'invoice_date'));
    const selectedPos = orders.filter(p => eligible(p, matchingPos)).sort((a, b) => descendingDate(a, b, 'date_order'));
    const billPage = selectedBills.slice(offset, offset + limit), poPage = selectedPos.slice(offset, offset + limit);
    const [billLines, poLines] = await Promise.all([
      byIds('account.move.line', 'move_id', billPage.map(b => b.id), ['move_id', 'name', 'price_subtotal'], [['display_type', '=', 'product']]),
      byIds('purchase.order.line', 'order_id', poPage.map(p => p.id), ['order_id', 'product_id', 'price_subtotal'], [['product_id', '!=', false]]),
    ]);
    const products = await readMap('product.product', poLines.map(l => id(l.product_id)), ['product_tmpl_id']);
    const templates = await readMap('product.template', [...products.values()].map(p => id(p.product_tmpl_id)), ['name', 'categ_id']);
    const categories = await readMap('product.category', [...templates.values()].map(p => id(p.categ_id)), ['complete_name']);
    const main = new Map();
    poLines.sort((a, b) => (number(b.price_subtotal) ?? Infinity) - (number(a.price_subtotal) ?? Infinity) || a.id - b.id);
    for (const line of poLines) {
      const template = templates.get(id(products.get(id(line.product_id))?.product_tmpl_id));
      const category = categories.get(id(template?.categ_id)), orderId = id(line.order_id);
      if (template && category && !main.has(orderId)) main.set(orderId, { main_product: nullable(template.name), cat_name: nullable(category.complete_name) });
    }
    const billLineMap = new Map();
    billLines.sort((a, b) => (number(b.price_subtotal) ?? Infinity) - (number(a.price_subtotal) ?? Infinity) || a.id - b.id);
    for (const line of billLines) {
      const key = id(line.move_id);
      if (!billLineMap.has(key)) billLineMap.set(key, []);
      billLineMap.get(key).push({ name: nullable(line.name), amount: number(line.price_subtotal) });
    }
    return {
      billTotal: selectedBills.length, poTotal: selectedPos.length,
      billRows: billPage.map(b => ({ id: b.id, company_id: id(b.company_id), move_type: nullable(b.move_type), bill_name: nullable(b.name), invoice_origin: nullable(b.invoice_origin), ref: nullable(b.ref), amount_total: number(b.amount_total), amount_tax: number(b.amount_tax), currency: nullable(money.get(id(b.currency_id)).name), rate_thb: positiveRate(b.inverse_currency_rate) ?? inverseRate(b.invoice_currency_rate), partner: nullable(vendors.get(id(b.partner_id)).name), doc_date: nullable(b.invoice_date), lines: billLineMap.get(b.id) || [] })),
      poRows: poPage.map(p => ({ id: p.id, company_id: id(p.company_id), po_number: nullable(p.name), origin: nullable(p.origin), amount_total: number(p.amount_total), currency: nullable(money.get(id(p.currency_id)).name), rate_thb: inverseRate(p.currency_rate), partner: nullable(vendors.get(id(p.partner_id)).name), doc_date: nullable(p.date_order), ...(main.get(p.id) || { main_product: null, cat_name: null }) })),
    };
  }

  return { vendors, vendorScorecard, glReconciliation, fxRates, logisticsBills };
}

module.exports = { createOdooServices };

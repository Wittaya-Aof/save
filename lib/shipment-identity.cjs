'use strict';
const crypto = require('node:crypto');
const { normalizeWorkflow } = require('./import-workflow.cjs');
function companyOf(record) {
  const value = record._companyId ?? record.company_id ?? record.companyId;
  if ([1, 2].includes(Number(value))) return Number(value);
  return record.company === 'KOB' ? 1 : record.company === 'BTV' ? 2 : null;
}
function normalizeTrackingRecord(record, before = null, { strict = false } = {}) {
  const companyId = companyOf(record);
  const key = String(record.po_so || record.id || '').trim();
  const parent = String(record._splitBase || key).trim();
  const seed = JSON.stringify([record._board || record.board || 'import', companyId, key]);
  const existingId = before && before._shipmentId || record._shipmentId;
  const _shipmentId = /^shp_[a-f0-9]{32}$/.test(existingId || '') ? existingId :
    'shp_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const source = Array.isArray(record.poRefs) && record.poRefs.length ? record.poRefs : [{
    poNumber: parent, companyId, odooOrderId: record._odooId ?? record.odooOrderId ?? null,
  }];
  const seen = new Set();
  const poRefs = source.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || !String(ref.poNumber || '').trim() || String(ref.poNumber).length > 80) throw Error('ข้อมูล PO ที่สัมพันธ์ไม่ถูกต้อง');
    const scope = ref.companyId == null ? companyId : Number(ref.companyId);
    if (scope != null && ![1, 2].includes(scope)) throw Error('บริษัทของ PO ไม่ถูกต้อง');
    const order = ref.odooOrderId == null ? null : Number(ref.odooOrderId);
    if (order != null && (!Number.isSafeInteger(order) || order < 1)) throw Error('รหัส PO ใน Odoo ไม่ถูกต้อง');
    return { poNumber: String(ref.poNumber).trim(), companyId: scope, odooOrderId: order };
  }).filter(ref => { const id = JSON.stringify(ref); if (seen.has(id)) return false; seen.add(id); return true; });
  return { ...record, _shipmentId, poRefs, ...normalizeWorkflow(record, { strict }) };
}
function resolveTrackingIndex(rows, input) {
  const key = String(input.po_so || input.id || '').trim();
  const company = companyOf(input);
  const board = input._board || input.board;
  const fail = () => { const error = Error('ระบุ Shipment และบริษัทให้ชัดเจน — เลข PO ซ้ำหรือข้อมูลอ้างอิงเปลี่ยนแล้ว'); error.code = 'TRACKING_IDENTITY_CONFLICT'; throw error; };
  if (input._shipmentId) {
    const index = rows.findIndex(row => row._shipmentId === input._shipmentId);
    if (index >= 0) {
      const row = rows[index];
      const sameKey = rows.filter(r => String(r.po_so || r.id || '').trim() === key);
      const oldOrder = row.odooOrderId ?? row._odooId ?? row.poRefs?.find(r => r.poNumber === key)?.odooOrderId;
      const newOrder = Number(input.odooOrderId);
      const bindLegacy = companyOf(row) == null && company != null && sameKey.length === 1 &&
        !row._synthetic && Number.isSafeInteger(newOrder) && newOrder > 0 && (oldOrder == null || Number(oldOrder) === newOrder);
      if (String(row.po_so || row.id || '').trim() !== key || (company != null && companyOf(row) !== company && !bindLegacy) ||
          (board && (row._board || row.board || 'import') !== board)) fail();
      return index;
    }
  }
  const candidates = rows.map((row, index) => ({ row, index })).filter(({ row }) =>
    String(row.po_so || row.id || '').trim() === key && (company == null || companyOf(row) === company) &&
    (!board || (row._board || row.board || 'import') === board));
  if (candidates.length > 1) fail();
  // A scoped edit must bind its existing legacy row, never create a second PO beside it.
  if (!candidates.length && company != null && rows.some(row => String(row.po_so || row.id || '').trim() === key && companyOf(row) == null)) fail();
  return candidates.length ? candidates[0].index : -1;
}
module.exports = { normalizeTrackingRecord, companyOf, resolveTrackingIndex };

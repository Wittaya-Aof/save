'use strict';
const DEFAULT_OWNER = 'Wittaya Sawangphol';
const CHECKLIST = Object.freeze({
  commercial_invoice: 'Commercial Invoice', packing_list: 'Packing List', form_e: 'Form E',
  forwarder_booking: 'ประสาน Freight Forwarder', bl: 'B/L หรือ AWB', insurance: 'Insurance',
  import_declaration: 'ใบขนสินค้าขาเข้า', tisi_permit: 'ตรวจเงื่อนไขและใบอนุญาต TISI',
  warehouse_notice: 'แจ้งวันสินค้าเข้าคลัง', tax_payment_notice: 'แจ้งบัญชีจ่ายภาษีนำเข้า',
});
const STATUSES = new Set(['pending', 'done', 'not_required']);
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function normalizeWorkflow(record, { strict = true } = {}) {
  const importBoard = (record._board || record.board || 'import') !== 'export';
  const owner = record.owner == null ? (importBoard ? DEFAULT_OWNER : '') : String(record.owner).trim().slice(0, 120);
  let dueDate = record.dueDate == null ? '' : String(record.dueDate).trim();
  if (dueDate && !validDate(dueDate)) { if (strict) throw Error('วันที่กำหนดเสร็จไม่ถูกต้อง'); dueDate = ''; }
  const source = record.documentChecklist;
  if (strict && source != null && (!source || typeof source !== 'object' || Array.isArray(source))) throw Error('รูปแบบรายการเอกสารไม่ถูกต้อง');
  const documentChecklist = {};
  if (importBoard) for (const key of Object.keys(CHECKLIST)) {
    const status = source && Object.hasOwn(source, key) ? source[key] : 'pending';
    if (!STATUSES.has(status) && strict) throw Error('สถานะรายการเอกสารไม่ถูกต้อง');
    documentChecklist[key] = STATUSES.has(status) ? status : 'pending';
  }
  return { owner, dueDate, documentChecklist };
}
module.exports = { DEFAULT_OWNER, CHECKLIST, validDate, normalizeWorkflow };

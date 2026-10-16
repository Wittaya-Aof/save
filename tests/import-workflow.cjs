'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const identity = require('../lib/shipment-identity.cjs');
const workflow = require('../lib/import-workflow.cjs');
const worklist = require('../lib/worklist.js');
test('legacy shipment identity is stable, additive and company scoped', () => {
  const r = { po_so: 'PO1', company: 'KOB', amount: 100 };
  const a = identity.normalizeTrackingRecord(r), b = identity.normalizeTrackingRecord(r);
  assert.equal(a._shipmentId, b._shipmentId); assert.match(a._shipmentId, /^shp_[a-f0-9]{32}$/);
  assert.notEqual(a._shipmentId, identity.normalizeTrackingRecord({ ...r, company: 'BTV' })._shipmentId);
  assert.equal(r._shipmentId, undefined); assert.equal(a.amount, 100);
  assert.deepEqual(a.poRefs, [{ poNumber: 'PO1', companyId: 1, odooOrderId: null }]);
});
test('split identity is distinct and links original PO without inventing quantities', () => {
  const parent = identity.normalizeTrackingRecord({ po_so: 'PO1', company: 'KOB' });
  const child = identity.normalizeTrackingRecord({ po_so: 'PO1 (2)', _splitBase: 'PO1', _synthetic: true, company: 'KOB' });
  assert.notEqual(parent._shipmentId, child._shipmentId);
  assert.equal(child.poRefs[0].poNumber, 'PO1');
  assert.equal(child.amount, undefined); assert.equal(child.receivedQty, undefined);
  const changed = identity.normalizeTrackingRecord({ ...child, _shipmentId: 'spoofed', note: 'edit' }, child);
  assert.equal(changed._shipmentId, child._shipmentId);
});
test('checklist defaults do not claim permits, documents or receipts verified', () => {
  const r = identity.normalizeTrackingRecord({ po_so: 'PO1', _board: 'import' });
  assert.equal(r.owner, 'Wittaya Sawangphol'); assert.equal(r.dueDate, '');
  for (const status of Object.values(r.documentChecklist)) assert.equal(status, 'pending');
  assert.equal(r.documentChecklist.tisi_permit, 'pending');
  assert.equal(r.actualDate, undefined);
});
test('workflow accepts only documented statuses and real calendar dates', () => {
  assert.throws(() => workflow.normalizeWorkflow({ dueDate: '2026-02-31' }), /วันที่/);
  assert.throws(() => workflow.normalizeWorkflow({ documentChecklist: { tisi_permit: 'automatic-approved' } }), /สถานะ/);
  const r = workflow.normalizeWorkflow({ dueDate: '2026-10-16', owner: 'Wittaya', documentChecklist: { tisi_permit: 'not_required' } });
  assert.equal(r.documentChecklist.tisi_permit, 'not_required');
  assert.equal(r.documentChecklist.form_e, 'pending');
});
test('daily work carries explicit owner, due date, shipment/PO identity', () => {
  const row = identity.normalizeTrackingRecord({ po_so: 'PO1 (2)', _splitBase: 'PO1', _synthetic: true,
    _board: 'import', stage: 'transit', owner: 'Wittaya', dueDate: '2026-10-16', bl: 'BL-TEST' });
  const result = worklist.buildWorklist([row], '2026-10-16');
  const due = result.now.find(x => x.key === 'due_workflow');
  assert(due); assert.equal(due.items[0].owner, 'Wittaya');
  assert.equal(due.items[0].dueDate, '2026-10-16');
  assert.equal(due.items[0].shipmentId, row._shipmentId);
  assert.equal(due.items[0].poRefs[0].poNumber, 'PO1');
});

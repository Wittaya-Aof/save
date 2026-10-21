'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./persistence-permissions.cjs');
test('legacy scanner ATA cannot overwrite ETA, and a subsequent admin estimate leaves ATA intact',async()=>{
 const f=await fixture([{po_so:'PO-FIXTURE',_board:'import',company:'KOB',_ts:100,eta:'2026-10-30',vessel:'SITC JADE',voyage:'2622S'}]);
 try{
  let r=await f.request('/api/tracking/upsert',{po_so:'PO-FIXTURE',_board:'import',company:'KOB',_origin:'scan:fixture',_fillEmptyOnly:true,eta:'2026-10-20',etsActualArrivalDate:'2026-10-20',etsStatus:'found'});
  assert.equal(r.status,200);let row=r.body.rows.find(r=>r.po_so==='PO-FIXTURE');assert.equal(row.eta,'2026-10-30');assert.equal(row.etsActualArrivalDate,'2026-10-20');
  r=await f.request('/api/tracking/upsert',{po_so:'PO-FIXTURE',_board:'import',company:'KOB',_baseTs:row._ts,eta:'2026-10-29'});assert.equal(r.status,200);row=r.body.rows.find(r=>r.po_so==='PO-FIXTURE');assert.equal(row.eta,'2026-10-29');assert.equal(row.etsActualArrivalDate,'2026-10-20');
  assert.equal((await f.request('/api/ets/arrival',{vessel:'A',voyage:'B',port:'0119'},'viewer')).status,403);
  assert.equal((await f.request('/api/ets/arrival',{vessel:'A',voyage:'',port:'0119'})).status,400);
 }finally{await f.close();}
});

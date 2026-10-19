'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {test}=require('node:test');
const vm=require('node:vm');
const W=require('../lib/logistics-workspace.js');
const today='2026-10-19';
const base={id:'i1',company:'KOB',poNo:'PO-A',_board:'import',stage:'etd',cur:'THB',amount:1000,rate:1,eta:'2026-10-22'};
const describe=(row,opts={cost:1000,expense:0})=>W.describe(row,today,opts);

test('preview is opt-in and explicit classic overrides saved operations',()=>{
 assert.equal(W.layout('',null),'classic');assert.equal(W.layout('?layout=operations',null),'operations');
 assert.equal(W.layout('?layout=classic','operations'),'classic');assert.equal(W.layout('', 'operations'),'operations');assert.equal(W.layout('?layout=bad','bad'),'classic');
});
test('business day uses Bangkok and dates reject rollover',()=>{
 assert.equal(W.today(new Date('2026-10-18T18:00:00Z')),'2026-10-19');assert.equal(W.dateKey('2026-02-30'),'');assert.equal(W.dateKey('2026-10-19T10:00:00Z'),'2026-10-19');
});
test('source PO has no invented shipment ID or declared complete checklist',()=>{
 const r=describe(base);assert.equal(r.shipmentId,'');assert.equal(r.documentState,'unknown');assert.equal(r.transportLabel,'กำลังขนส่ง');assert.deepEqual(r.poNumbers,['PO-A']);
});
test('known pending TISI and accounting notice are distinct and not proof of payment',()=>{
 const r=describe({...base,_shipmentId:'SHIP-A',documentChecklist:{tisi_permit:'pending',tax_payment_notice:'done'}});
 assert(r.pendingDocuments.some(x=>x.key==='tisi_permit'&&x.label.includes('เงื่อนไข')));assert.equal(r.accountingLabel,'แจ้งบัญชีแล้ว');assert(!r.accountingLabel.includes('ชำระแล้ว'));assert.equal(r.documentState,'pending');
});
test('closed transport with pending documents and deadline remains actionable',()=>{
 const r=describe({...base,stage:'received',dueDate:'2026-10-18',documentChecklist:{form_e:'pending'}});
 assert.equal(r.closed,true);assert.equal(r.overdue,true);assert.equal(r.attention,true);assert(r.nextAction.includes('Form E'));assert(W.select([r],'today').length===1);
});
test('unknown FX stays incomplete and zero remains a known amount',()=>{
 assert.equal(describe(base,{cost:null,expense:0}).costMissing,true);assert.equal(describe(base,{cost:0,expense:0}).costMissing,false);
 assert.equal(W.select([describe(base,{cost:null,expense:0})],'cost').length,1);
});
test('past ETA without actual evidence is awaiting confirmation rather than asserted delay',()=>{
 const r=describe({...base,eta:'2026-10-18'});assert.equal(r.etaNeedsConfirmation,true);assert.match(r.etaLabel,/รอยืนยัน/);assert(!r.etaLabel.includes('เรือล่าช้า'));
 assert.equal(describe({...base,stage:'received',eta:'2026-10-18'}).etaNeedsConfirmation,false);
});
test('duplicate PO names across companies stay independent and refs are not joined',()=>{
 const a=describe({...base,poRefs:[{poNumber:'PO-A'},{poNumber:'PO-B'}]}),b=describe({...base,id:'i2',company:'BTV'});
 const rs=W.select([a,b],'all');assert.deepEqual(rs.map(r=>r.id),['i1','i2']);assert.deepEqual(a.poNumbers,['PO-A','PO-B']);assert.deepEqual(b.poNumbers,['PO-A']);
});
test('schedule distinguishes estimates and confirmed events without using task deadline as warehouse ETA',()=>{
 const r=describe({...base,stage:'received',etd:'2026-10-17',eta:'2026-10-20',etsActualArrivalDate:'2026-10-19',actualDate:'2026-10-21',dueDate:'2026-10-22'});
 const es=W.schedule([r],'2026-10-19','2026-10-22');assert.equal(es.length,3);assert(es.some(e=>e.kind==='eta'&&!e.actual));assert(es.some(e=>e.kind==='port'&&e.actual));assert(es.some(e=>e.kind==='receipt'&&e.actual));assert(!es.some(e=>e.date==='2026-10-22'));
 assert.equal(W.schedule([r],'2026-10-22','2026-10-19').length,0);
});
test('presentation does not mutate frozen row or nested operational data',()=>{
 const row=Object.freeze({...base,poRefs:Object.freeze([Object.freeze({poNumber:'PO-A'})]),documentChecklist:Object.freeze({form_e:'pending'})});
 const r=describe(row);W.select([r],'attention');W.schedule([r],'2026-10-19','2026-10-30');assert.equal(row.documentChecklist.form_e,'pending');
});
test('near arrivals and confirmed transport missing ETA appear in daily work',()=>{
 assert.equal(describe(base).attention,true);
 const r=describe({...base,eta:'',etd:'2026-10-18'});assert.equal(r.attention,true);assert.match(r.nextAction,/วันถึง/);
});
test('historical paperwork is backlog unless a current explicit deadline makes it active',()=>{
 const old={...base,stage:'received',actualDate:'2026-01-01',eta:'2026-01-01',documentChecklist:{form_e:'pending'}};
 assert.equal(describe(old).backlog,true);assert.equal(W.select([describe(old)],'today').length,0);
 assert.equal(describe({...old,dueDate:today}).backlog,false);
});
test('workspace helper has explicit static allowlist and stays in Docker context',()=>{
 const api=fs.readFileSync(path.join(__dirname,'../api-server.js'),'utf8');assert(api.includes("reqUrl === '/lib/logistics-workspace.js'"));
 assert(fs.readFileSync(path.join(__dirname,'../.dockerignore'),'utf8').includes('!lib/*.js'));
});

function exportedIds(models,view,focus='all',from=today,to='2026-10-22'){
 const source=fs.readFileSync(path.join(__dirname,'../import-export-os.html'),'utf8'),start=source.indexOf('  exportExcel(tab){'),end=source.indexOf('\n  // ── รายงานสรุปต้นทุน',start);let exported;
 const context=vm.createContext({Date,LogisticsWorkspace:W,window:{XLSX:true},XLSX:{utils:{json_to_sheet:rows=>(exported=rows,{}),book_new:()=>({}),book_append_sheet(){}},writeFile(){}}});
 const app={state:{layout:'operations',view,opsFocus:focus,opsFrom:from,opsTo:to},filtered:()=>models.map(r=>r.source),workspaceRows:()=>models,buildExcelRows:rows=>rows.map(r=>({id:r.id})),showToast(){}};
 vm.runInContext('({'+source.slice(start,end)+'})',context).exportExcel.call(app,'import');return exported?exported.map(r=>r.id):[];
}
test('actual daily Excel export contains all visible actionable rows but excludes backlog and non-actionable rows',()=>{
 const actionable=describe({...base,id:'active',documentChecklist:{form_e:'pending'}}),old=describe({...base,id:'old',eta:'2026-01-01',documentChecklist:{form_e:'pending'}}),quiet=describe({...base,id:'quiet',stage:'received',eta:'2026-01-01'});
 assert.deepEqual(exportedIds([actionable,old,quiet],'today'),['active']);assert.deepEqual(exportedIds([old],'today','backlog'),['old']);
});
test('actual schedule Excel export respects event range and deduplicates shipment IDs, independent of paging',()=>{
 const a=describe({...base,id:'A',etd:today,eta:'2026-10-20'}),b=describe({...base,id:'B',eta:'2026-11-01'});
 assert.deepEqual(exportedIds([a,b],'schedule'),['A']);assert.deepEqual(exportedIds([a,b],'schedule','all','2026-10-25','2026-10-20'),[]);
 assert.deepEqual(exportedIds([a,b],'table'),['A','B']);
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {normalizeEtsResult}=require('../lib/shipment-rules.cjs');
test('ETS actual arrival never writes estimated ETA',()=>{const r=normalizeEtsResult({status:'found',eta:'2026-10-20',matchedVoyage:'2622S'},'2026-10-21T00:00:00Z');assert.equal(r.etsActualArrivalDate,'2026-10-20');assert.equal(Object.hasOwn(r,'eta'),false);});
test('unavailable actual date cannot become a found ATA',()=>{const r=normalizeEtsResult({status:'found',eta:'2026-02-30'});assert.equal(r.etsStatus,'error');assert.equal(r.etsActualArrivalDate,undefined);});
test('ETS service requires exact voyage and never returns a schedule as ATA',async()=>{
 const {createEtsService}=require('../lib/ets-service.cjs');let closed=0,port;
 const service=createEtsService({env:{ETS_USER:'fixture',ETS_PASS:'fixture'},open:async()=>({page:{}}),search:async(...args)=>{port=args[5];return {status:'found',eta:'2026-10-20',matchedVoyage:'2622S'};},close:async()=>{closed++;}});
 const r=await service.lookup({vessel:'SITC JADE',voyage:'2622S',etd:'2026-10-15',port:'0119'});assert.equal(r.etsActualArrivalDate,'2026-10-20');assert.equal(Object.hasOwn(r,'eta'),false);assert.equal(port,'0119');assert.equal(closed,1);
 const wrong=createEtsService({env:{ETS_USER:'x',ETS_PASS:'x'},open:async()=>({page:{}}),search:async()=>({status:'found',eta:'2026-10-20',matchedVoyage:'2621S'}),close:async()=>{}});
 const rejected=await wrong.lookup({vessel:'SITC JADE',voyage:'2622S',port:'0119'});assert.equal(rejected.etsStatus,'not_found');assert.equal(rejected.etsActualArrivalDate,undefined);
 await assert.rejects(service.lookup({vessel:'SITC JADE',voyage:'',port:'0119'}),/Voyage/);
});
test('ETS service has bounded concurrency and closes late sessions after timeout',async()=>{
 const {createEtsService}=require('../lib/ets-service.cjs');let resolveOpen,closed=0;
 const service=createEtsService({env:{ETS_USER:'x',ETS_PASS:'x'},timeoutMs:15,open:()=>new Promise(r=>resolveOpen=r),search:async()=>({status:'not_found'}),close:async()=>{closed++;}});
 const pending=service.lookup({vessel:'A',voyage:'B',port:'0119'});
 await assert.rejects(service.lookup({vessel:'A',voyage:'B',port:'0119'}),/กำลัง/);
 await assert.rejects(pending,/ไม่ตอบ/);resolveOpen({page:{}});await new Promise(r=>setTimeout(r,5));assert.equal(closed,1);
});
test('ETS failures and missing credentials never expose private error content',async()=>{
 const {createEtsService}=require('../lib/ets-service.cjs');
 await assert.rejects(createEtsService({env:{}}).lookup({vessel:'A',voyage:'B',port:'0119'}),/ยังไม่ได้ตั้งค่า/);
 const s=createEtsService({env:{ETS_USER:'x',ETS_PASS:'x'},open:async()=>{throw Error('private-password');}});
 await assert.rejects(s.lookup({vessel:'A',voyage:'B',port:'0119'}),e=>!e.message.includes('private-password'));
});

test('ETS cleanup logs out the owned session and closes its browser even if logout fails',async()=>{
 const {closeEtsSession}=await import(require('node:url').pathToFileURL(require('node:path').resolve(__dirname,'../lib/ets-lookup.mjs')).href);
 let clicked=0,closed=0;
 const link={first(){return this;},isVisible:async()=>true,click:async()=>{clicked++;}};
 const page={isClosed:()=>false,locator:()=>link,once:()=>{},waitForNavigation:async()=>{}};
 await closeEtsSession({page,browser:{close:async()=>{closed++;}}});assert.equal(clicked,1);assert.equal(closed,1);
 link.click=async()=>{throw Error('fixture unavailable');};await closeEtsSession({page,browser:{close:async()=>{closed++;}}});assert.equal(closed,2);
});

test('ETS account already in use returns a useful conflict without exposing credentials',async()=>{
 const {createEtsService}=require('../lib/ets-service.cjs');
 const service=createEtsService({env:{ETS_USER:'x',ETS_PASS:'x'},open:async()=>{throw Object.assign(Error('private'),{code:'ETS_SESSION_IN_USE'});},search:async()=>{},close:async()=>{}});
 await assert.rejects(service.lookup({vessel:'A',voyage:'B',port:'0119'}),e=>e.statusCode===409&&!e.message.includes('private'));
});

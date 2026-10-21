'use strict';
const {normalizeEtsResult}=require('./shipment-rules.cjs');
const canonical=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/^V(?=\d)/,'');
function createEtsService({env=process.env,open,search,close,timeoutMs=90000}={}){
 let busy=false;
 const failure=(status,message)=>Object.assign(new Error(message),{statusCode:status,safeEtsMessage:true});
 return {async lookup(input){
  const vessel=typeof input?.vessel==='string'?input.vessel.trim():'',voyage=typeof input?.voyage==='string'?input.voyage.trim():'';
  const port=String(input?.port||''),etd=String(input?.etd||'');
  if(!vessel||vessel.length>120||!canonical(voyage)||voyage.length>40||!/^\d{4}$/.test(port))throw failure(400,'กรอกชื่อเรือ Voyage และรหัสท่าปลายทาง 4 หลัก');
  if(etd&&(!/^\d{4}-\d{2}-\d{2}$/.test(etd)||!Number.isFinite(Date.parse(etd+'T00:00:00Z'))||new Date(etd+'T00:00:00Z').toISOString().slice(0,10)!==etd))throw failure(400,'วันที่ ETD ไม่ถูกต้อง');
  if(!env.ETS_USER||!env.ETS_PASS)throw failure(503,'ยังไม่ได้ตั้งค่าบัญชี ETS สำหรับบริการนี้');
  if(busy)throw failure(409,'กำลังตรวจ ETS รายการอื่น กรุณาลองอีกครั้ง');
  busy=true;let session,expired=false,timer;const closed=new WeakSet();
  let closeSession=close;
  async function cleanup(s){if(!s||closed.has(s))return;closed.add(s);try{await closeSession(s);}catch{}}
  try{
   if(!open||!search||!close){const api=await import('./ets-lookup.mjs');open=api.openEtsSession;search=api.searchVesselActualDate;closeSession=api.closeEtsSession;}
   const opening=Promise.resolve().then(()=>open());
   opening.then(s=>{if(expired)void cleanup(s);},()=>{});
   const task=(async()=>{session=await opening;if(expired)throw failure(504,'ETS ไม่ตอบภายในเวลาที่กำหนด');return search(session.page,vessel,'sea',voyage,etd||null,port);})();
   const raw=await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure(504,'ETS ไม่ตอบภายในเวลาที่กำหนด')),timeoutMs);})]);
   const checkedAt=new Date().toISOString();
   if(raw?.status==='error')throw failure(502,'ตรวจ ETS ไม่สำเร็จ กรุณาลองใหม่');
   if(raw?.status==='found'&&canonical(raw.matchedVoyage)!==canonical(voyage))return {etsStatus:'not_found',etsCheckedAt:checkedAt};
   const result=normalizeEtsResult(raw,checkedAt);
   const today=new Date(Date.now()+7*3600000).toISOString().slice(0,10);
   if(result.etsActualArrivalDate>today||(etd&&result.etsActualArrivalDate&&result.etsActualArrivalDate<etd))throw failure(502,'วันที่เรือถึงจริงไม่สอดคล้องกับ ETD หรือวันปัจจุบัน กรุณาตรวจเที่ยวเรือ');
   return {...result,etsPortCode:port};
  }catch(e){if(e.safeEtsMessage)throw e;if(e.code==='ETS_SESSION_IN_USE')throw failure(409,'บัญชี ETS กำลังถูกใช้งานอีกเซสชัน กรุณาออกจาก ETS ที่เครื่องอื่นแล้วลองใหม่');throw failure(502,'เชื่อม ETS ไม่สำเร็จ กรุณาตรวจบัญชีหรือทดลองใหม่');}
  finally{expired=true;clearTimeout(timer);await cleanup(session);busy=false;}
 }};
}
module.exports={createEtsService};

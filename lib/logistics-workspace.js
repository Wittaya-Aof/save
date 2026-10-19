(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.LogisticsWorkspace=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const DOCUMENTS={commercial_invoice:'Commercial Invoice',packing_list:'Packing List',form_e:'Form E',bl:'B/L / AWB',insurance:'Insurance',import_declaration:'ใบขนขาเข้า',tisi_permit:'ตรวจเงื่อนไข TISI'};
 const COORDINATION={forwarder_booking:'ประสาน Forwarder',warehouse_notice:'แจ้งคลังสินค้า',tax_payment_notice:'แจ้งบัญชีจ่ายภาษี'};
 const IMPORT={po:'รอจัดส่ง',etd:'กำลังขนส่ง',arrived:'ถึงท่าเรือ',customs:'ดำเนินพิธีการ',received:'รับเข้าคลังแล้ว'};
 const EXPORT={draft:'เตรียมคำสั่งขาย',packing:'ผลิต / แพ็ค',booking:'จองขนส่ง',shipped:'จัดส่งแล้ว',arrived:'ถึงปลายทางแล้ว'};
 const validState=s=>['pending','done','not_required'].includes(s);
 function dateKey(value){const d=typeof value==='string'?value.slice(0,10):'';if(!/^\d{4}-\d{2}-\d{2}$/.test(d))return '';const stamp=new Date(d+'T00:00:00Z');return Number.isFinite(stamp.getTime())&&stamp.toISOString().slice(0,10)===d?d:'';}
 function today(now=new Date()){const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);const get=k=>p.find(x=>x.type===k).value;return get('year')+'-'+get('month')+'-'+get('day');}
 function addDays(value,n){return new Date(Date.parse(dateKey(value)+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);}
 function dayDiff(a,b){a=dateKey(a);b=dateKey(b);return a&&b?Math.round((Date.parse(a+'T00:00:00Z')-Date.parse(b+'T00:00:00Z'))/86400000):null;}
 function layout(search,saved){let picked='';try{picked=new URLSearchParams(search||'').get('layout');}catch{}return ['classic','operations'].includes(picked)?picked:['classic','operations'].includes(saved)?saved:'classic';}
 function describe(source,asOf,options={}){
  const s=source||{},board=s._board==='export'?'export':'import',closed=s.stage===(board==='export'?'arrived':'received');
  const checklist=s.documentChecklist&&typeof s.documentChecklist==='object'?s.documentChecklist:{};
  const keys=board==='export'?['commercial_invoice','packing_list','bl','insurance']:Object.keys(DOCUMENTS);
  const pendingDocuments=keys.filter(k=>checklist[k]==='pending').map(key=>({key,label:DOCUMENTS[key]}));
  const pendingCoordination=Object.keys(COORDINATION).filter(k=>checklist[k]==='pending').map(key=>({key,label:COORDINATION[key]}));
  const documentState=pendingDocuments.length?'pending':keys.every(k=>validState(checklist[k]))?'complete':'unknown';
  const eta=dateKey(s.eta),etd=dateKey(s.etd),dueDate=dateKey(s.dueDate),actualArrival=dateKey(s.etsActualArrivalDate),actualReceipt=closed?dateKey(s.actualDate):'';
  const etaDays=dayDiff(eta,asOf),dueDays=dayDiff(dueDate,asOf),etaNeedsConfirmation=!closed&&!actualArrival&&etaDays!==null&&etaDays<0;
  const cost=typeof options.cost==='number'&&Number.isFinite(options.cost)?options.cost:null;
  const expense=typeof options.expense==='number'&&Number.isFinite(options.expense)?options.expense:null;
  const costMissing=cost===null,shipmentId=String(s._shipmentId||'');
  const hasPending=pendingDocuments.length>0||pendingCoordination.length>0;
  const overdue=dueDays!==null&&dueDays<0&&(!closed||hasPending),dueToday=dueDays===0&&(!closed||hasPending);
  const needsDocs=pendingDocuments.length>0||documentState==='unknown'&&!!shipmentId;
  const soon=!closed&&etaDays!==null&&etaDays>=0&&etaDays<=7;
  const missingTransportEta=!closed&&!eta&&['etd','shipped','arrived','customs'].includes(s.stage);
  const attention=overdue||dueToday||etaNeedsConfirmation||soon||missingTransportEta||costMissing||needsDocs||pendingCoordination.length>0;
  const activityDays=dayDiff(actualReceipt||actualArrival||eta||dateKey(s.orderDate)||etd,asOf);
  const backlog=attention&&(dueDays===null||dueDays<-30)&&activityDays!==null&&activityDays<-30;
  const refs=Array.isArray(s.poRefs)?s.poRefs:[],poNumbers=[...new Set(refs.map(r=>String(r.poNumber||'').trim()).filter(Boolean))];
  if(!poNumbers.length&&s.poNo)poNumbers.push(String(s._splitBase||s.poNo));
  let nextAction='ติดตามตามแผน';
  if(pendingDocuments.length)nextAction='ติดตาม '+pendingDocuments[0].label+(pendingDocuments.length>1?' และอีก '+(pendingDocuments.length-1)+' รายการ':'');
  else if(pendingCoordination.length)nextAction=pendingCoordination[0].label;
  else if(costMissing)nextAction='ตรวจ FX หรือยอดจัดสรร';
  else if(etaNeedsConfirmation)nextAction='ยืนยันวันถึงและสถานะล่าสุด';
  else if(missingTransportEta)nextAction='ติดตามวันถึงปลายทาง';
  else if(needsDocs)nextAction='ประเมินรายการเอกสาร';
  else if(soon)nextAction='เตรียมเอกสารและประสานแผนรับสินค้า';
  else if(!closed&&!shipmentId)nextAction='วางแผน Shipment / แบ่งส่ง';
  else if(closed)nextAction='ตรวจปิดเอกสารและต้นทุน';
  const accountingLabel=checklist.tax_payment_notice==='done'?'แจ้งบัญชีแล้ว':checklist.tax_payment_notice==='pending'?'รอแจ้งบัญชี':checklist.tax_payment_notice==='not_required'?'ไม่ต้องแจ้งบัญชี':'ยังไม่ระบุ';
  return {id:s.id,source:s,board,closed,shipmentId,poNumbers,company:s.company||'—',transportLabel:(board==='export'?EXPORT:IMPORT)[s.stage]||'ยังไม่ระบุสถานะ',pendingDocuments,pendingCoordination,documentState,accountingLabel,eta,etd,dueDate,actualArrival,actualReceipt,etaNeedsConfirmation,etaLabel:etaNeedsConfirmation?'เลยกำหนด / รอยืนยัน':'วันคาดการณ์',cost,expense,costMissing,overdue,dueToday,attention,backlog,soon,nextAction,owner:s.owner||'ยังไม่ระบุ',priority:overdue?0:dueToday?1:etaNeedsConfirmation?2:hasPending?3:costMissing?4:5};
 }
 function select(rows,focus){return (rows||[]).filter(r=>focus==='open'?!r.closed:focus==='attention'?r.attention:focus==='today'?r.attention&&!r.backlog:focus==='backlog'?r.backlog:focus==='documents'?r.pendingDocuments.length>0||r.documentState==='unknown'&&!!r.shipmentId:focus==='cost'?r.costMissing:focus==='soon'?r.soon:focus==='undated'?!r.eta:true);}
 function schedule(rows,from,to){from=dateKey(from);to=dateKey(to);if(!from||!to||from>to)return [];const events=[];for(const row of rows||[]){for(const [kind,date,label,actual] of [['etd',row.etd,'ETD · คาดออก',false],['eta',row.eta,'ETA / กำหนดรับ · คาดการณ์',false],['port',row.actualArrival,'ถึงท่าจริง (ETS)',true],['receipt',row.actualReceipt,row.board==='export'?'ถึงปลายทางที่บันทึก':'รับเข้าคลังที่บันทึก',true]])if(date&&date>=from&&date<=to)events.push({id:String(row.id)+'|'+kind,row,date,kind,label,actual});}return events.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));}
 function forView(rows,options={}){
  if(options.view==='today')return (rows||[]).filter(r=>r.attention&&(options.focus==='backlog'||!r.backlog));
  if(options.view==='schedule'){const seen=new Set();return schedule(rows,options.from,options.to).flatMap(e=>{if(seen.has(e.row.id))return [];seen.add(e.row.id);return [e.row];});}
  return (rows||[]).slice();
 }
 return {describe,select,schedule,forView,dateKey,today,addDays,dayDiff,layout};
});

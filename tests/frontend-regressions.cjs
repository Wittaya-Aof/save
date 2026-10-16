const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname,'../import-export-os.html'),'utf8');
function method(name) {
  const match = new RegExp('^  (?:async )?'+name+'\\(', 'm').exec(source);
  assert.ok(match, 'method '+name+' exists');
  const tail=source.slice(match.index);
  const next=/\n  (?:async )?[A-Za-z_$][\w$]*\([^\n]*\)\s*\{/.exec(tail.slice(1));
  return tail.slice(0,next?next.index+1:undefined).replace(/^\s*\/\/.*$/gm,'').trim();
}
function app(fetcher=async()=>({ok:true,status:200,json:async()=>({ok:true}),clone(){return this;}})) {
  const globals={fetch:fetcher,fetchTimeout:fetcher,Date,console,setTimeout:()=>0,clearTimeout(){},stageMeta:()=>({label:'received'}),IMP_STAGES:[{key:'po'},{key:'received'}],EXP_STAGES:[],normType:x=>x};
  const names=['isAmbiguousPo','canEditPo','withBase','persistTracking','workflowFields','hitConflict','saveEdit','setStageFor','quickCloseAlert','openBillPicker','toggleBill','applySelectedBills','loadData','startEdit','mapPo','mapSynthetic','applyOne','loadPoLines','splitShipment','submitCreate','openDeleteDialog','confirmDelete'];
  const a=vm.runInNewContext('({'+names.map(method).join(',\n')+'})',globals);
  a.state={canWrite:true,shipments:[{id:'i1',poNo:'PO1',_board:'import',stage:'po',_ts:100}],editForm:{board:'import',poNo:'PO1',freight:55,bills:[]},editing:true};
  a._overrides={PO1:{po_so:'PO1',_ts:100}}; a._fx={}; a._poLinesCache={};
  a.setState=function(update,cb){Object.assign(this.state,typeof update==='function'?update(this.state):update);if(cb)cb();};
  a.allShipments=()=>a.state.shipments; a.showToast=(msg,kind)=>{a.toast={msg,kind};};
  a.loadData=async()=>{a.reloaded=true;};a.nowTime=()=> 'now';a.loadVendors=()=>{};a.loadLanded=()=>{};a.canWrite=()=>a.state.canWrite===true;
  return a;
}
test('ordinary edit submits the loaded revision and keeps form until JSON acknowledgement',async()=>{
  let body; const a=app(async(u,o)=>{body=JSON.parse(o.body);return {ok:true,json:async()=>({ok:false,error:'disk failed'}),clone(){return this;}};});
  await a.saveEdit();assert.equal(body._baseTs,100);assert.equal(a.state.editing,true);assert.ok(a.state.editForm);assert.equal(a.toast.kind,'error');assert.equal(a._overrides.PO1._ts,100);
});
test('conflict reloads through loadData even on HTTP 409',async()=>{
  const a=app();const r={ok:false,status:409,json:async()=>({ok:false,conflicts:[{reason:'changed'}]}),clone(){return this;}};
  assert.equal(await a.hitConflict(r),true);assert.equal(a.reloaded,true);
});
test('new records explicitly send revision zero',()=>{const a=app();assert.equal(a.withBase({po_so:'NEW'})._baseTs,0);});
test('tracking delete submits the revision loaded when its dialog opened',async()=>{let body;const a=app(async(u,o)=>{body=JSON.parse(o.body);return {ok:true,json:async()=>({ok:true})};});a.openDeleteDialog('PO1');a.state.deleteDialog.password='fixture';a._overrides.PO1._ts=200;await a.confirmDelete();assert.equal(body._baseTs,100);assert.equal(body.po_so,'PO1');});
test('stale delete reloads data and retains the record and pending dialog',async()=>{const a=app(async()=>({ok:false,status:409,json:async()=>({ok:false,conflicts:[{reason:'changed'}]}),clone(){return this;}}));a.openDeleteDialog('PO1');await a.confirmDelete();assert.equal(a.reloaded,true);assert.equal(a.state.shipments.length,1);assert.equal(a.state.deleteDialog.busy,false);});
test('failed create retains its form and never adds an unsaved board card',async()=>{const a=app(async()=>({ok:true,json:async()=>({ok:false,error:'disk failed'}),clone(){return this;}}));a.state.form={poNo:'NEW',board:'import',cur:'THB'};a.state.creating=true;a.fxRate=()=>1;await a.submitCreate();assert.equal(a.state.creating,true);assert.equal(a.state.form.poNo,'NEW');assert.equal(a.state.shipments.length,1);assert.equal(a._overrides.NEW,undefined);});
test('bill retry preserves freight target and selection persists category',async()=>{
  const a=app(async()=>({ok:true,json:async()=>({bills:[{id:7,amount:55}]})}));a.state.billTarget={bucket:'freight',label:'Freight'};
  await a.openBillPicker();assert.equal(a.state.billTarget.bucket,'freight');a.state.selBills={7:{id:7,amount:55}};a.applySelectedBills();
  assert.equal(a.state.editForm.freight,55);assert.equal(a.state.editForm.bills[0].id,7);assert.equal(a.state.editForm.bills[0].category,'freight');
});
test('unknown THB bill cannot be selected or imported as zero',()=>{const a=app();const b={id:7,amount:null,origAmount:55,currency:'USD',fxStatus:'missing'};a.state.selBills={};a.toggleBill(b);assert.equal(Object.keys(a.state.selBills).length,0);a.state.billTarget={bucket:'freight',label:'Freight'};a.state.selBills={7:b};a.applySelectedBills();assert.equal(a.state.editForm.freight,55);assert.equal(a.toast.kind,'error');});
test('split preserves source PO record scope when source has no stored poRefs',async()=>{const a=app();a.state.detailId='i1';Object.assign(a.state.shipments[0],{company:'BTV',companyId:2,odooOrderId:123,poRefs:[]});a.strip=x=>x;a.startEdit=()=>{};let payload;a.persistTracking=async p=>{payload=p;return p;};await a.splitShipment();assert.equal(payload.poRefs.length,1);assert.equal(payload.poRefs[0].companyId,2);assert.equal(payload.poRefs[0].odooOrderId,123);assert.equal(payload._baseTs,0);});
test('partial outage retains previous board and labels incomplete',async()=>{
  const a=app(async u=>({ok:true,json:async()=>u.includes('import-pos')?{ok:true,rows:[{id:2,po_number:'NEW'}]}:u.includes('export-sos')?{ok:false}:{ok:true,rows:[]}}));
  a.state.shipments=[{id:'old',poNo:'OLD',_board:'export'}];a.applyOverrides=x=>x;a.mapPo=(r,b)=>({_board:b,poNo:r.po_number});
  a.loadData=vm.runInNewContext('({'+method('loadData')+'})',{fetchTimeout:async u=>({ok:true,json:async()=>u.includes('import-pos')?{ok:true,rows:[{id:2,po_number:'NEW'}]}:u.includes('export-sos')?{ok:false}:{ok:true,rows:[]}}),setTimeout,Date}).loadData;
  await a.loadData();assert.ok(a.state.shipments.some(x=>x.poNo==='OLD'));assert.equal(a.state.dataSource,'incomplete');
});
test('total refresh outage retains both boards and leaves an honest incomplete status',async()=>{
  const a=app();a._forceSync=true;a.state.shipments=[{poNo:'I',_board:'import'},{poNo:'E',_board:'export'}];a.applyOverrides=x=>x;
  a.loadData=vm.runInNewContext('({'+method('loadData')+'})',{fetchTimeout:async()=>{throw Error('offline');},setTimeout:fn=>fn(),Date}).loadData;
  await a.loadData();assert.equal(a.state.shipments.length,2);assert.equal(a.state.dataSource,'incomplete');
});
test('both boards unavailable with tracking available retains unedited POs and merges known updates',async()=>{
  const tracked=[{po_so:'EDITED',_board:'import',note:'latest',_ts:200},{po_so:'NEW-SPLIT',_board:'import',_synthetic:true,_splitBase:'EDITED',_ts:201}];
  const a=app();a.state.shipments=[{poNo:'EDITED',_board:'import'},{poNo:'UNEDITED',_board:'import'},{poNo:'EXPORT',_board:'export'}];
  a.mapTracking=r=>({poNo:r.po_so,_board:r._board});
  a.applyOverrides=function(rows){return rows.map(r=>({...r,...(this._overrides[r.poNo]||{})})).concat(Object.values(this._overrides).filter(r=>r._synthetic&&!rows.some(s=>s.poNo===r.po_so)).map(r=>({poNo:r.po_so,_board:r._board})));};
  a.loadData=vm.runInNewContext('({'+method('loadData')+'})',{fetchTimeout:async u=>({ok:true,json:async()=>u==='/api/tracking'?{ok:true,rows:tracked}:{ok:false}}),setTimeout:fn=>fn(),Date}).loadData;
  await a.loadData();assert.ok(a.state.shipments.some(r=>r.poNo==='UNEDITED'));assert.ok(a.state.shipments.some(r=>r.poNo==='EXPORT'));assert.equal(a.state.shipments.find(r=>r.poNo==='EDITED').note,'latest');assert.ok(a.state.shipments.some(r=>r.poNo==='NEW-SPLIT'));assert.equal(a.state.dataSource,'incomplete');
});
test('without a prior board snapshot an authoritative empty tracking list removes old tracking-only rows',async()=>{
  const a=app();a.state.shipments=[{poNo:'DELETED',_board:'import',_synthetic:true}];a._boardRows={};a.applyOverrides=x=>x;
  a.loadData=vm.runInNewContext('({'+method('loadData')+'})',{fetchTimeout:async u=>({ok:true,json:async()=>u==='/api/tracking'?{ok:true,rows:[]}:{ok:false}}),setTimeout:fn=>fn(),Date}).loadData;
  await a.loadData();assert.equal(a.state.shipments.length,0);
});
test('same PO across companies cannot cross-apply name-only tracking overrides',async()=>{
  const tracked=[{po_so:'DUP',company:'KOB',_board:'import',freight:111,_ts:100},{po_so:'DUP',company:'BTV',_board:'import',freight:222,_ts:200}];
  const a=app();a.mapPo=(r,b)=>({poNo:'DUP',_board:b,company:r.company,freight:0});a.applyOverrides=rows=>rows.map(r=>a.applyOne(r,a._overrides[r.poNo]||{}));
  a.loadData=vm.runInNewContext('({'+method('loadData')+'})',{fetchTimeout:async u=>({ok:true,json:async()=>u==='/api/tracking'?{ok:true,rows:tracked}:u.includes('import-pos')?{ok:true,rows:[{company:'KOB'},{company:'BTV'}]}:{ok:true,rows:[]}}),Date}).loadData;
  await a.loadData();assert.ok(a.state.shipments.every(r=>r.freight===0));assert.equal(a._overrides.DUP,undefined);assert.equal(a.state.dataSource,'incomplete');assert.ok(a.state.ambiguousPoNames.includes('DUP'));
});
test('ambiguous PO name blocks edit, stage, delete, split and save handlers',async()=>{let writes=0;const a=app(async()=>{writes++;throw Error('unexpected');});a.state.ambiguousPoNames=['PO1'];a.state.detailId='i1';a.strip=x=>x;a.state.deleteDialog={poNo:'PO1',_baseTs:100,password:'fixture'};a.startEdit();await a.saveEdit();await a.setStageFor(a.state.shipments[0],'received');await a.splitShipment();await a.confirmDelete();assert.equal(writes,0);});
test('same company PO appearing on import and export boards is also guarded',async()=>{const a=app();a.applyOverrides=x=>x;a.mapPo=(r,b)=>({poNo:'DUP',_board:b});a.loadData=vm.runInNewContext('({'+method('loadData')+'})',{fetchTimeout:async u=>({ok:true,json:async()=>u==='/api/tracking'?{ok:true,rows:[{po_so:'DUP',company:'KOB',_board:'import'},{po_so:'DUP',company:'KOB',_board:'export'}]}:{ok:true,rows:[{}]}}),Date}).loadData;await a.loadData();assert.ok(a.state.ambiguousPoNames.includes('DUP'));assert.equal(a._overrides.DUP,undefined);assert.equal(a.state.dataSource,'incomplete');});
test('refresh keeps displayed data and revision atomic while user opens an edit',async()=>{
  let release,started;const boards=new Promise(r=>{release=r;}),waiting=new Promise(r=>{started=r;});
  const fetcher=async u=>{if(u.includes('import-pos')||u.includes('export-sos')){started();await boards;return {ok:true,json:async()=>({ok:true,rows:u.includes('import-pos')?[{id:1,po_number:'PO1'}]:[]})};}return {ok:true,json:async()=>({ok:true,rows:[{po_so:'PO1',freight:200,_ts:200}]})};};
  const a=app();a.state.detailId='i1';a.state.shipments[0].freight=100;a.state.editing=false;a.mapPo=()=>({id:'i1',poNo:'PO1',_board:'import'});a.applyOverrides=rows=>rows.map(r=>a.applyOne(r,a._overrides[r.poNo]||{}));
  a.loadData=vm.runInNewContext('({'+method('loadData')+'})',{fetchTimeout:fetcher,Date}).loadData;
  const refreshing=a.loadData();await waiting;a.startEdit();assert.equal(a.state.editForm.freight,100);assert.equal(a.state.editForm._baseTs,100);assert.equal(a._overrides.PO1._ts,100);
  release();await refreshing;assert.equal(a.state.shipments[0].freight,200);assert.equal(a.state.shipments[0]._ts,200);assert.equal(a.state.editForm._baseTs,100);
});
test('edit captures its displayed row revision even if cached overrides have advanced',()=>{const a=app();a.state.detailId='i1';a.state.shipments[0].freight=100;a._overrides.PO1={_ts:200,freight:200};a.startEdit();assert.equal(a.state.editForm.freight,100);assert.equal(a.state.editForm._baseTs,100);});
test('older refresh cannot replace a successfully acknowledged local save',async()=>{
  let release,started;const boards=new Promise(r=>{release=r;}),waiting=new Promise(r=>{started=r;});
  const fetcher=async(u,o)=>{if(o&&o.method==='POST')return {ok:true,json:async()=>({ok:true,rows:[{po_so:'PO1',_ts:300,freight:300}]}),clone(){return this;}};if(u.includes('import-pos')||u.includes('export-sos')){started();await boards;return {ok:true,json:async()=>({ok:true,rows:u.includes('import-pos')?[{id:1}]:[]})};}return {ok:true,json:async()=>({ok:true,rows:[{po_so:'PO1',_ts:200,freight:200}]})};};
  const a=app(fetcher);a.state.shipments[0].freight=100;a.state.editForm={poNo:'PO1',board:'import',_baseTs:100,freight:300};a.mapPo=()=>({id:'i1',poNo:'PO1',_board:'import'});a.applyOverrides=rows=>rows.map(r=>a.applyOne(r,a._overrides[r.poNo]||{}));
  a.loadData=vm.runInNewContext('({'+method('loadData')+'})',{fetchTimeout:fetcher,Date}).loadData;
  const refreshing=a.loadData();await waiting;await a.saveEdit();release();await refreshing;assert.equal(a.state.shipments[0].freight,300);assert.equal(a._overrides.PO1._ts,300);
});
test('board-outage fallback reapplies latest cleared fields and manual stage to raw board rows',async()=>{
  const a=app();a.state.shipments=[{id:'i1',poNo:'PO1',_board:'import',_ts:100,stage:'received',bl:'OLD-BL'}];a._boardRows={import:[{id:'i1',poNo:'PO1',_board:'import',stage:'po',bl:'ODOO-BL'}],export:[]};
  a.applyOverrides=rows=>rows.map(r=>a.applyOne(r,a._overrides[r.poNo]||{}));
  a.loadData=vm.runInNewContext('({'+method('loadData')+'})',{fetchTimeout:async u=>({ok:true,json:async()=>u==='/api/tracking'?{ok:true,rows:[{po_so:'PO1',_ts:200,stage:'po',_stageManual:true,bl:'',bl_awb:''}]}:{ok:false}}),setTimeout:fn=>fn(),Date}).loadData;
  await a.loadData();assert.equal(a.state.shipments[0].bl,'');assert.equal(a.state.shipments[0].stage,'po');assert.equal(a.state.shipments[0]._ts,200);
});
test('viewer handlers cannot mutate even when invoked directly',async()=>{let writes=0;const a=app(async()=>{writes++;throw Error('unexpected');});a.state.canWrite=false;await a.saveEdit();await a.setStageFor(a.state.shipments[0],'received');await a.quickCloseAlert(a.state.shipments[0]);a.splitShipment();await a.submitCreate();await a.confirmDelete();assert.equal(writes,0);});
test('PO detail request retains company and Odoo record scope',async()=>{let url;const a=app(async u=>{url=u;return {ok:true,json:async()=>({ok:true,rows:[]})};});await a.loadPoLines({_board:'import',poNo:'PO1',id:'i1',companyId:2,odooOrderId:123});assert.match(url,/company_id=2/);assert.match(url,/order_id=123/);});
test('mapping retains shipment workflow and source identity',()=>{const a=app();const s=a.mapSynthetic({po_so:'PO1',_shipmentId:'S1',owner:'Owner',dueDate:'2026-10-20',poRefs:[{poNumber:'PO1',companyId:1,odooOrderId:3}],documentChecklist:{tisi_permit:'pending'}});assert.equal(s._shipmentId,'S1');assert.equal(s.owner,'Owner');assert.equal(s.poRefs[0].odooOrderId,3);assert.equal(s.documentChecklist.tisi_permit,'pending');});
const freight=fs.readFileSync(require('node:path').join(__dirname,'../freight-comparison.html'),'utf8');
function freightMethods(context){
  const names=['api','saveQuote','deleteQuote'];
  const code=names.map(name=>{const start=freight.indexOf('async function '+name+'(');const tail=freight.slice(start);const next=/\n(?:async )?function /.exec(tail.slice(1));return tail.slice(0,next.index+1);}).join('\n');
  vm.createContext(context);vm.runInContext(code,context);return context;
}
test('freight JSON failure retains dirty quote',async()=>{const c=freightMethods({canWrite:true,Q:{type:'test',id:'Q1',head:{ref:'PO1'},updatedAt:'old'},TEMPLATES:{test:{refLabel:'PO'}},dirty:true,fetch:async()=>({ok:true,json:async()=>({ok:false,error:'disk failed'})}),toast(){},loadSaved(){},localStorage:{removeItem(){}},document:{querySelector:()=>null}});await c.saveQuote();assert.equal(c.dirty,true);assert.equal(c.Q.updatedAt,'old');});
test('freight viewer cannot save or delete',async()=>{let writes=0;const c=freightMethods({canWrite:false,Q:{type:'test',id:'Q1',head:{ref:'PO1'}},TEMPLATES:{test:{}},saved:[{id:'Q1'}],confirm:()=>true,fetch:async()=>{writes++;throw Error('unexpected');},toast(){}});await c.saveQuote();await c.deleteQuote();assert.equal(writes,0);});
test('freight API requires an explicit JSON success acknowledgement',async()=>{const c=freightMethods({fetch:async()=>({ok:true,json:async()=>({})})});await assert.rejects(c.api('/api/freight-quotes/delete',{method:'POST'}));});
test('new freight quote explicitly clears both persisted revision fields',()=>{const start=freight.indexOf('function newQuote('),tail=freight.slice(start),end=/\nfunction /.exec(tail.slice(1)).index+1;const c=vm.createContext({TEMPLATES:{test:{termOptions:['FOB'],options:[],sections:[]}},uid:()=> 'new',fxRates:null,Date});vm.runInContext(tail.slice(0,end),c);const q=c.newQuote('test');assert.equal(q.updatedAt,null);assert.equal(q._baseUpdatedAt,null);});
test('duplicate freight quote clears an inherited base revision',()=>{const button={};const c=vm.createContext({Q:{id:'OLD',updatedAt:'old',_baseUpdatedAt:'old',head:{ref:'PO1'}},uid:()=> 'new',Date,$:()=>button,touch(){},renderAll(){},toast(){}});vm.runInContext(freight.split(/\r?\n/).find(l=>l.startsWith("$('btnDup').onclick=")),c);button.onclick();assert.equal(c.Q.id,'new');assert.equal(c.Q.updatedAt,null);assert.equal(c.Q._baseUpdatedAt,null);});
test('main React JSX compiles after permission controls',()=>{const babelContext=vm.createContext({});vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../vendor/babel.min.js'),'utf8'),babelContext);const script=source.match(/<script type="text\/babel">([\s\S]*?)<\/script>/)[1];assert.doesNotThrow(()=>babelContext.Babel.transform(script,{presets:['react']}));});

'use strict';
// Runs the page's actual functions against DOM/storage/network boundaries only.
// No server, live port, operational data or AI call is used.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync(path.join(__dirname,'../freight-comparison.html'),'utf8');
const code=html.slice(html.lastIndexOf('<script>')+8,html.lastIndexOf('</script>')).split('(async function init(){')[0];
function fresh(){
  const elems=new Map(),memory=new Map(),events={};
  const get=id=>{if(!elems.has(id))elems.set(id,{value:'',hidden:true,checked:false,disabled:false,textContent:'',innerHTML:'',dataset:{},classList:{toggle(){},remove(){}},addEventListener(n,f){this[n]=f;},querySelectorAll:()=>[],querySelector:()=>null});return elems.get(id);};
  const c=vm.createContext({console,Date,setTimeout:()=>0,clearTimeout(){},document:{getElementById:get,addEventListener:(n,f)=>{(events[n]??=[]).push(f);},querySelectorAll:()=>[],querySelector:()=>null,body:{appendChild(){}}},localStorage:{setItem:(k,v)=>memory.set(k,v),getItem:k=>memory.get(k),removeItem:k=>memory.delete(k)},window:{addEventListener(){},XLSX:true,print(){}},confirm:()=>true});
  const run=s=>vm.runInContext(s,c);
  run(code);run("Q=newQuote('import-sea');Q.head.fx=33;Q.head.cbm=6;Q.head.ref='FIXTURE-A';canWrite=true;");
  return {c,get,memory,events,run};
}
function importPdf(h,lines=[],tiers=[],flat=null){
  h.c.lines=lines;h.c.tiers=tiers;h.c.flat=flat;
  h.get('mBody').querySelectorAll=()=>lines.map((_,i)=>({checked:true,dataset:{pv:String(i)}}));
  h.get('pvFlat').checked=true;h.get('pvTiers').checked=true;
  h.run("pdfData={};pdfName='fixture.pdf';applyPdf(lines,tiers,flat)");
}
function pending(h,kind='save'){
  let release;h.c.fetch=async(_url,opts)=>{const submitted=JSON.parse(opts.body);return new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({ok:true,row:{id:submitted.id,updatedAt:'2026-10-19T00:00:01.000Z'}})});});};
  h.run('loadSaved=async()=>{};saved=[JSON.parse(JSON.stringify(Q))];');
  const promise=h.run(kind==='save'?'saveQuote()':'deleteQuote()');
  return {promise,release:()=>release()};
}
const cases=[];const test=(name,fn)=>cases.push({name,fn});
test('F1 KYOEI incompatible THB freight/USD CIC are rejected visibly without reinterpreting either currency',()=>{
  const h=fresh();h.c.fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/kyoei-extract.json'),'utf8'));
  const lines=h.run('pickForColumn(fixture.lines,1).mapped');h.run('pvCol=1;Q.rows[0].prices[0]=77;');
  importPdf(h,lines,[],h.run("fixture.freightTiers.find(t=>t.loadType==='fcl20')"));
  assert.equal(h.run('Q.rows[0].prices[1]'),null);assert.equal(h.run("Q.rows.find(r=>r.desc==='Other Charges').prices[1]"),null);
  assert.equal(h.run('Q.rows[0].prices[0]'),77);assert.match(h.run('compareWarnings().join(" ")'),/THB.*USD|USD.*THB/);
});
test('F1 compatible PDF tier retains rate meaning and incompatible tier rejects atomically',()=>{
  const h=fresh();importPdf(h,[],[{min:0,max:10,price:10,currency:'THB'}]);
  assert.equal(h.run('hasTiers(Q.options[0])'),false);assert.match(h.run('compareWarnings().join(" ")'),/THB.*USD|USD.*THB/);
  const good=fresh();importPdf(good,[],[{min:0,max:10,price:10,currency:'USD'}]);assert.equal(good.run('amount(Q.rows[0],0)'),1980);
});
test('F1 unknown positive PDF currency is rejected, zero free tier may omit currency',()=>{
  const h=fresh();importPdf(h,[{mappedTo:'Other Charges',amount:60,currency:null}]);assert.equal(h.run("Q.rows.find(r=>r.desc==='Other Charges').prices[0]"),null);
  const free=fresh();importPdf(free,[],[{min:0,max:10,price:0,currency:null}]);assert.equal(free.run('amount(Q.rows[0],0)'),0);
});
test('FX rows never collapse company-specific rates into an unknown-company quote',async()=>{
  const h=fresh();h.c.fetch=async()=>({ok:true,json:async()=>({ok:true,rows:[{currency:'USD',company_id:1,thb_per_unit:33,as_of:'2026-10-19'},{currency:'USD',company_id:2,thb_per_unit:36,as_of:'2026-10-19'}]})});
  await h.run('loadFx(false)');assert.equal(h.run("newQuote('import-sea').head.fx"),null);
  h.run('Q.head.companyId=1');await h.run('loadFx(false)');assert.equal(h.run('fxRates.USD'),33);assert.equal(h.run("newQuote('import-sea').head.fx"),null);
  h.run('Q.head.companyId=2');await h.run('loadFx(false)');assert.equal(h.run('fxRates.USD'),36);
});
test('FX refresh on an unknown company keeps entered rate and explains missing company scope',async()=>{
  const h=fresh();h.c.fetch=async()=>({ok:true,json:async()=>({ok:true,rows:[{currency:'USD',company_id:1,thb_per_unit:33,as_of:'2026-10-19'},{currency:'USD',company_id:2,thb_per_unit:36,as_of:'2026-10-19'}]})});
  h.run('Q.head.fx=34;renderHead()');await h.get('btnFx').onclick();assert.equal(h.run('Q.head.fx'),34);assert.match(h.get('toast').textContent,/บริษัท/);
});
test('F2 save acknowledgement preserves later edits dirty and rebases recovery draft',async()=>{
  const h=fresh();h.run('touch()');const p=pending(h);h.run("Q.head.party='LATER EDIT';touch()");p.release();await p.promise;
  assert.equal(h.run('dirty'),true);assert.equal(h.run('Q.head.party'),'LATER EDIT');const draft=JSON.parse(h.memory.get('kobFreightDraft'));assert.equal(draft.head.party,'LATER EDIT');assert.equal(draft.updatedAt,'2026-10-19T00:00:01.000Z');
});
test('F2 save acknowledgement leaves another active quote and its draft untouched',async()=>{
  const h=fresh();h.run('touch()');const p=pending(h);h.run("Q=newQuote('import-air');Q.head.ref='FIXTURE-B';touch()");const draft=h.memory.get('kobFreightDraft');p.release();await p.promise;
  assert.equal(h.run('Q.updatedAt'),null);assert.equal(h.run('dirty'),true);assert.equal(h.memory.get('kobFreightDraft'),draft);
});
test('F2 same revision save becomes clean and clears recovery draft',async()=>{
  const h=fresh();h.run('touch()');const p=pending(h);p.release();await p.promise;assert.equal(h.run('dirty'),false);assert.equal(h.memory.has('kobFreightDraft'),false);
});
test('F2 delete acknowledgement cannot discard later edits',async()=>{
  const h=fresh();h.run("Q.updatedAt='old';touch()");const id=h.run('Q.id'),p=pending(h,'delete');h.run("Q.head.party='KEEP AFTER DELETE';touch()");p.release();await p.promise;
  assert.equal(h.run('Q.id'),id);assert.equal(h.run('Q.head.party'),'KEEP AFTER DELETE');assert.equal(h.run('dirty'),true);assert.equal(h.run('Q.updatedAt'),null);assert.equal(JSON.parse(h.memory.get('kobFreightDraft')).head.party,'KEEP AFTER DELETE');
});
test('F2 delete acknowledgement leaves switched quote untouched',async()=>{
  const h=fresh(),p=pending(h,'delete');h.run("Q=newQuote('import-air');Q.head.ref='FIXTURE-B';touch()");const draft=h.memory.get('kobFreightDraft');p.release();await p.promise;
  assert.equal(h.run('Q.head.ref'),'FIXTURE-B');assert.equal(h.run('dirty'),true);assert.equal(h.memory.get('kobFreightDraft'),draft);
});
for(const kind of ['save','delete'])test('F2 reopening the same saved ID during '+kind+' cannot strand later edits on a stale revision',async()=>{
  const h=fresh();h.run("Q.updatedAt='old';Q._baseUpdatedAt='old';touch()");const id=h.run('Q.id'),p=pending(h,kind);
  h.get('savedSel').onchange({target:{value:id}});h.run("Q.head.party='EDIT AFTER SELECTOR';touch()");p.release();await p.promise;
  assert.equal(h.run('Q.id'),id);assert.equal(h.run('dirty'),true);assert.equal(h.run('Q.head.party'),'EDIT AFTER SELECTOR');
  const draft=JSON.parse(h.memory.get('kobFreightDraft')),base=kind==='save'?'2026-10-19T00:00:01.000Z':null;
  assert.equal(h.run('Q.updatedAt'),base);assert.equal(h.run('Q._baseUpdatedAt'),base);assert.equal(draft.updatedAt,base);assert.equal(draft._baseUpdatedAt,base);
});
for(const kind of ['save','delete'])test('F2 pending '+kind+' ID cannot reopen over another active quote',async()=>{
  const h=fresh();h.run("Q.updatedAt='old';touch()");const id=h.run('Q.id'),p=pending(h,kind);
  h.run("Q=newQuote('import-air');Q.head.ref='FIXTURE-B';touch()");const other=h.run('Q.id'),draft=h.memory.get('kobFreightDraft');
  h.get('savedSel').onchange({target:{value:id}});assert.equal(h.run('Q.id'),other);assert.equal(h.memory.get('kobFreightDraft'),draft);assert.match(h.get('toast').textContent,/รอ/);
  p.release();await p.promise;assert.equal(h.run('Q.id'),other);assert.equal(h.run('dirty'),true);assert.equal(h.memory.get('kobFreightDraft'),draft);
});
for(const dismiss of ['button','close','escape','backdrop'])test('F3 tier '+dismiss+' discards draft without changing quote amount or dirty state',()=>{
  const h=fresh();h.run('Q.options[0].tiers=[{min:0,max:10,price:10}];dirty=false;openTierEditor(0)');h.get('mBody').oninput({target:{dataset:{t:'0.price'},value:'99'}});
  if(dismiss==='button')h.get('tCancel').onclick();else if(dismiss==='close')h.get('mClose').onclick();else if(dismiss==='escape')h.events.keydown.forEach(fn=>fn({key:'Escape'}));else h.get('mask').mousedown({target:h.get('mask')});
  assert.equal(h.run('amount(Q.rows[0],0)'),1980);assert.equal(h.run('dirty'),false);assert.equal(h.memory.has('kobFreightDraft'),false);
});
test('F3 adding/removing/clearing tiers changes only draft until Apply recalculates and marks dirty',()=>{
  const h=fresh();h.run('Q.options[0].tiers=[{min:0,max:10,price:10}];openTierEditor(0)');h.get('tClear').onclick();assert.equal(h.run('amount(Q.rows[0],0)'),1980);h.get('tCancel').onclick();
  h.run('openTierEditor(0)');h.get('mBody').oninput({target:{dataset:{t:'0.price'},value:'20'}});h.get('tOk').onclick();assert.equal(h.run('amount(Q.rows[0],0)'),3960);assert.equal(h.run('dirty'),true);assert.equal(JSON.parse(h.memory.get('kobFreightDraft')).options[0].tiers[0].price,20);
});
test('F4 exported effective tier unit price reconciles to amount and out-of-range stays blank',()=>{
  const h=fresh();let aoa;h.c.XLSX={utils:{aoa_to_sheet:a=>{aoa=a;return{};},book_new:()=>({}),book_append_sheet(){}},writeFile(){}};
  h.run('Q.options[0].tiers=[{min:0,max:10,price:10}];Q.rows[0].prices[0]=99;exportXlsx()');let row=aoa.find(r=>r[1]==='O/F  (Ocean Freight)');assert.equal(row[5],10);assert.equal(row[6],1980);
  h.run('Q.head.cbm=20;exportXlsx()');row=aoa.find(r=>r[1]==='O/F  (Ocean Freight)');assert.equal(row[5],'');assert.equal(row[6],'');
});
test('F5 PDF tiers never overwrite existing tiers or flat freight, including zero',()=>{
  for(const setup of ['Q.options[0].tiers=[{min:0,max:10,price:10}]','Q.rows[0].prices[0]=99','Q.rows[0].prices[0]=0']){
    const h=fresh();h.run(setup);const before=h.run('JSON.stringify({tiers:Q.options[0].tiers,prices:Q.rows[0].prices})');importPdf(h,[],[{min:0,max:10,price:88,currency:'USD'}]);assert.equal(h.run('JSON.stringify({tiers:Q.options[0].tiers,prices:Q.rows[0].prices})'),before);
  }
});
test('F5 PDF flat freight and mapped primary freight cannot override tiers',()=>{
  for(const mapped of [false,true]){
    const h=fresh();h.run('Q.options[0].tiers=[{min:0,max:10,price:10}]');const line={mappedTo:'O/F  (Ocean Freight)',amount:99,currency:'USD'};importPdf(h,mapped?[line]:[],[],mapped?null:{price:99,currency:'USD'});assert.equal(h.run('Q.rows[0].prices[0]'),null);assert.equal(h.run('amount(Q.rows[0],0)'),1980);
  }
});
for(const [name,setup] of [['FX','Q.head.fx=null;Q.rows[0].prices=[100,200,null]'],['negative FX','Q.head.fx=-33;Q.rows[0].prices=[100,200,null]'],['CBM','Q.head.cbm=null;Q.rows[0].prices=[100,200,null]'],['tier quantity','Q.head.cbm=null;Q.options[0].tiers=[{min:0,max:10,price:10}]'],['tier range','Q.head.cbm=20;Q.options[0].tiers=[{min:0,max:10,price:10}]']])test('F6 missing/invalid '+name+' blocks recommendation and flags unresolved populated charges in UI/export',()=>{
  const h=fresh();h.run(setup+';Q.rows[2].prices=[1000,1100,null]');const meta=h.run('cmpMeta(totals())');assert.equal(meta.fair,false);assert.equal(meta.best,-1);assert.equal(h.run('totals()[0].total'),null);assert.ok(h.run('compareWarnings().length')>0);h.run('renderAll()');assert.doesNotMatch(h.get('tbl').innerHTML,/tag-best/);assert.match(h.get('summary').innerHTML,/คำนวณไม่ครบ|ยังคำนวณไม่ได้/);
  let aoa;h.c.XLSX={utils:{aoa_to_sheet:a=>{aoa=a;return{};},book_new:()=>({}),book_append_sheet(){}},writeFile(){}};h.run('exportXlsx()');assert.equal(aoa.find(r=>r[0]==='TOTAL COST (THB)')[6],'');assert.ok(aoa.some(r=>String(r[0]).includes('คำเตือน')));
});
test('F6 absent AIR CW basis is unresolved, valid zero-priced local charge remains valid',()=>{
  const h=fresh();h.run("Q=newQuote('import-air');Q.head.fx=33;Q.rows[0].prices[0]=10");assert.equal(h.run('cmpMeta(totals()).fair'),false);assert.equal(h.run('totals()[0].total'),null);
  const free=fresh();free.run('Q.rows[2].prices[0]=0');assert.equal(free.run('totals()[0].total'),0);assert.equal(free.run('cmpMeta(totals()).fair'),true);
});
(async()=>{let failed=0;for(const t of cases){try{await t.fn();console.log('PASS '+t.name);}catch(e){failed++;console.error('FAIL '+t.name+'\n'+e.stack);}}console.log(`${cases.length-failed}/${cases.length} freight correctness cases passed`);process.exitCode=failed?1:0;})();

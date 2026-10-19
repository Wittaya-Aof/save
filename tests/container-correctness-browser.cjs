'use strict';
// Isolated file fixture only: no app server, network, saved data or external API.
const assert=require('node:assert/strict');
const path=require('node:path');const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const p=await browser.newPage(),errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  await p.route('**/*',r=>r.request().url().startsWith('file:')?r.continue():r.abort());
  await p.goto(pathToFileURL(path.resolve(__dirname,'../container-loading-calculator.html')).href);
  const exported=await p.evaluate(()=>{
   setLang('en');
   groups=[{id:1,name:'Oil, "Fresh"\nGroup',items:[{...makeDefaultItem(),id:2,name:'Product, "special"\nnew line',pieces:13,pcsPerCtn:12,qty:2,weight:5}]}];
   renderGroups();
   let href='';const old=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){href=this.href;};
   doExport();HTMLAnchorElement.prototype.click=old;
   return {csv:decodeURIComponent(href.slice(href.indexOf(',')+1)),group:groups[0].name,name:groups[0].items[0].name};
  });
  await p.evaluate(()=>{groups=[];window._alerts=[];window.alert=s=>window._alerts.push(s);});
  async function upload(text){
   const chooserPromise=p.waitForEvent('filechooser');await p.evaluate(()=>doImport());
   await (await chooserPromise).setFiles({name:'fixture.csv',mimeType:'text/csv',buffer:Buffer.from(text)});
   await p.waitForFunction(()=>window._alerts.length>0);
  }
  await upload(exported.csv);
  const imported=await p.evaluate(()=>groups);
  assert.equal(imported[0].name,exported.group);assert.equal(imported[0].items[0].name,exported.name);
  assert.equal(imported[0].items[0].pieces,13);assert.equal(imported[0].items[0].pcsPerCtn,12);
  const pieces=await p.evaluate(()=>{
   const r=buildResult(CONTAINERS.find(c=>c.id==='20GP'),groups[0].items);renderResults([r]);
   openCIPLModal=()=>{};doExportCIPL(0);
   return {pcs:window._ciplDraft.data.items[0].qty_pcs,text:document.querySelector('.res-table tbody').textContent};
  });
  assert.equal(pieces.pcs,13);assert.match(pieces.text,/13/);
  await p.evaluate(()=>{window._alerts=[];switchTab('products');renderGroups();});
  const input=p.locator("input[onchange*=\"'weight'\"]");await input.fill('-100');await input.dispatchEvent('change');
  await p.evaluate(()=>{selUnits=[makeUnit('20GP')];calculate();});
  assert.match((await p.evaluate(()=>window._alerts)).join(' '),/invalid[\s\S]*weight/i);
  const unknown=await p.evaluate(()=>{
   groups[0].items[0].weight=0;const r=buildResult(CONTAINERS.find(c=>c.id==='20GP'),groups[0].items);renderResults([r]);
   return {valid:r.weightValid,fit:r.allFit,text:document.getElementById('results-area').textContent};
  });
  assert.equal(unknown.valid,null);assert.equal(unknown.fit,false);assert.match(unknown.text,/weight not provided; payload unconfirmed/i);
  const before=await p.evaluate(()=>{window._alerts=[];return groups.length;});
  await upload('Group,Type,Name,L,W,H,D,Weight,Pieces,PcsPerCtn,Cartons,Color\nNew,box,Valid,40,30,25,20,5,1,1,1,#123456\nNew,box,Invalid,40,30,25,20,-100,1,1,1,#123456');
  assert.equal(await p.evaluate(()=>groups.length),before,'invalid import must not append its valid prefix');
  assert.match((await p.evaluate(()=>window._alerts)).join(' '),/invalid[\s\S]*weight/i);
  assert.deepEqual(errors,[]);
  console.log('Container isolated UI: CSV roundtrip, partial cartons, rejected negative input/import and unknown payload all pass; no page errors.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});


'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
async function exercise(page){
 const stats=await page.evaluate(()=>{
  setLang('th');
  const pal={presetKey:'standard',L:1200,W:1000,H:2000,D:150,maxW:1500,tare:5.2};
  const base={...makeDefaultItem(),usePallet:true,pallet:pal,weight:5};
  const data=[{...base,name:'KMC088 — PERFUME MIST CRAZY IN LOVE 88ML',L:30,W:20,H:13.5,qty:625,pieces:15000,pcsPerCtn:24},{...base,name:'SBB275 — PRO B3 AHA CONCENTRATE BODY SERUM 275g',L:28,W:21,H:23.5,qty:667,pieces:8000,pcsPerCtn:12}];
  const r=buildResult(CONTAINERS[0],data);renderResults([r]);switchTab('results');
  return {cartons:r.totPkg,pallets:r._palletManifest.length,mass:r.totWt,cg:r.loading.cg,status:r.loading.status};
 });
 assert.equal(stats.cartons,1292);assert.equal(stats.pallets,9);assert.equal(stats.status,'pending');
 await page.getByText('รอตรวจยืนยันการโหลด',{exact:true}).waitFor();
 await page.getByText('ยังไม่ระบุน้ำหนักกดทับที่กล่องรับได้',{exact:false}).waitFor();
 const overflow=await page.locator('.pm-card').evaluateAll(cards=>cards.some(c=>c.scrollWidth>c.clientWidth+1));assert.equal(overflow,false);
 await page.evaluate(()=>{
  groups=[{id:1,name:'Test',usePallet:true,pallet:{...PALLET_PRESET},items:[{...makeDefaultItem(),id:2}]}];renderGroups();switchTab('products');openEditModal(1,2);
 });
 assert.equal(await page.locator('#mi-rotL').isChecked(),false);assert.equal(await page.locator('#mi-rotW').isChecked(),false);assert.equal(await page.locator('#mi-weight').inputValue(),'0');
 await page.locator('#mi-maxTopLoad').fill('0');await page.locator('#modal-save-btn').click();
 assert.equal(await page.evaluate(()=>groups[0].items[0].maxTopLoad),0);
 await page.evaluate(()=>{selUnits=[makeUnit('20GP')];renderContainers();switchTab('containers');});
 const length=page.locator('input[onchange*="setUnitField"][onchange*="\'L\'"]');await length.fill('5800');await length.dispatchEvent('change');
 assert.equal(await page.evaluate(()=>unitSpec(selUnits[0]).L),5800);
 const door=page.locator('input[onchange*="doorH"]');await door.fill('2200');await door.dispatchEvent('change');assert.equal(await page.evaluate(()=>unitSpec(selUnits[0]).doorH),2200);
 await page.evaluate(()=>{setLang('en');const it={...makeDefaultItem(),L:100,W:100,H:50,weight:10,qty:3,maxTopLoad:0,usePallet:true,pallet:{L:1200,W:1000,H:2000,D:150,maxW:1500,tare:5.2}};renderResults([buildResult(CONTAINERS[0],[it])]);switchTab('results');});
 await page.getByText('Revise this loading plan',{exact:true}).waitFor();
 return stats;
}
if(require.main===module)(async()=>{const browser=await chromium.launch();try{const p=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];p.on('pageerror',e=>errors.push(e.message));await p.route('**/*',r=>r.request().url().startsWith('file:')?r.continue():r.abort());await p.goto(pathToFileURL(path.resolve(__dirname,'../container-loading-calculator.html')).href);await exercise(p);assert.deepEqual(errors,[]);console.log('Pallet browser: screenshot counts, pending strength, upright default, zero top-load, editable equipment and wrapped cards pass.');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={exercise};

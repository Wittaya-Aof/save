'use strict';
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const {fixtureRouter}=require('./helpers/freight-browser-fixture.cjs');
const legacy=process.argv.find(a=>a.startsWith('--legacy='));
if(legacy){
  const name=legacy.split('=')[1];if(!['freight-ui','freight-pdf','freight-review'].includes(name))throw Error('Unsupported fixture suite');
  const launch=chromium.launch.bind(chromium);
  chromium.launch=async opts=>{const browser=await launch(opts),newContext=browser.newContext.bind(browser);browser.newContext=async opts=>{const ctx=await newContext(opts),fixture=fixtureRouter();await ctx.route('**/*',fixture.route);return ctx;};return browser;};
  require('./'+name+'.cjs');
}else(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const ctx=await browser.newContext({viewport:{width:1500,height:1000}}),fixture=fixtureRouter(),errors=[];
    await ctx.route('**/*',fixture.route);const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await page.goto('http://freight.fixture/freight-comparison.html',{waitUntil:'networkidle'});await page.waitForSelector('#tbl tbody tr');
    const fill=(p,v)=>page.fill('[data-p="'+p+'"]',String(v));
    await fill('head.cbm',6);await fill('head.fx',33);await fill('head.ref','FIXTURE-A');
    await page.click('[data-tier="0"]');await page.fill('[data-t="0.min"]','0');await page.fill('[data-t="0.max"]','10');await page.fill('[data-t="0.price"]','10');await page.click('#tOk');
    const amount=()=>page.locator('#tbl tbody tr:not(.sec)').first().locator('td.amt').first().innerText();
    assert.equal(await amount(),'1,980.00');
    for(const cancel of ['escape','close','backdrop','button']){
      await page.click('[data-tier="0"]');await page.fill('[data-t="0.price"]','99');
      if(cancel==='escape')await page.keyboard.press('Escape');else if(cancel==='close')await page.click('#mClose');else if(cancel==='button')await page.click('#tCancel');else await page.locator('#mask').click({position:{x:2,y:2}});
      assert.equal(await amount(),'1,980.00');
    }
    await page.click('[data-tier="0"]');await page.click('#tClear');await page.click('#tCancel');assert.equal(await amount(),'1,980.00');
    await page.click('[data-tier="0"]');await page.click('#tAdd');await page.fill('[data-t="1.price"]','88');await page.click('[data-trem="1"]');await page.fill('[data-t="0.price"]','20');await page.click('#tOk');assert.equal(await amount(),'3,960.00');
    await fill('head.cbm',5);assert.equal(await amount(),'3,300.00');assert.match(await page.locator('#tbl tbody tr:not(.sec)').first().locator('td.amt').first().getAttribute('title'),/20\.00/);
    console.log('PASS real browser tier draft, cancellation, clear/add/remove, Apply and effective tooltip');
    await page.setInputFiles('#pdfInput',{name:'fixture.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 fixture')});await page.waitForSelector('#pvCol');await page.selectOption('#pvCol','1');await page.click('#pvOk');
    const state=await page.evaluate(()=>({freight:Q.rows[0].prices[1],cic:Q.rows.find(r=>r.desc==='Other Charges').prices[1],tiers:Q.options[0].tiers[0].price,warnings:document.querySelector('#cmpWarn').textContent}));
    assert.equal(state.freight,null);assert.equal(state.cic,null);assert.equal(state.tiers,20);assert.match(state.warnings,/THB.*USD|USD.*THB/);
    console.log('PASS real browser PDF rejects incompatible currency and preserves prior tiers');
    await fill('head.fx','');assert.match(await page.locator('#summary').innerText(),/ยังคำนวณไม่ได้/);assert.equal(await page.locator('.tag-best').count(),0);
    await page.evaluate(()=>{window.exported=null;window.XLSX={utils:{aoa_to_sheet:a=>(window.exported=a,{}),book_new:()=>({}),book_append_sheet(){}},writeFile(){}};});await page.click('#btnXlsx');
    assert.equal(await page.evaluate(()=>window.exported.find(r=>r[0]==='TOTAL COST (THB)')[6]),'');
    console.log('PASS real browser missing FX suppresses recommendation and incomplete exported total');
    await fill('head.fx',33);let release=fixture.hold();const firstRequest=page.waitForRequest('**/api/freight-quotes/upsert');await page.click('#btnSave');await firstRequest;
    await fill('head.party','EDIT WHILE SAVING');release();await page.waitForFunction(()=>!pendingWrites.size);assert.equal(await page.evaluate(()=>dirty),true);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('kobFreightDraft')).head.party),'EDIT WHILE SAVING');
    const activeId=await page.evaluate(()=>Q.id),oldBase=await page.evaluate(()=>Q.updatedAt);
    release=fixture.hold();const reopeningSave=page.waitForRequest('**/api/freight-quotes/upsert');await page.click('#btnSave');await reopeningSave;
    await page.selectOption('#savedSel',activeId);await fill('head.party','EDIT AFTER RESELECT SAVE');release();await page.waitForFunction(()=>!pendingWrites.size);
    const reselectedSave=await page.evaluate(()=>({base:Q.updatedAt,party:Q.head.party,dirty,draft:JSON.parse(localStorage.getItem('kobFreightDraft'))}));
    assert.notEqual(reselectedSave.base,oldBase);assert.equal(reselectedSave.party,'EDIT AFTER RESELECT SAVE');assert.equal(reselectedSave.dirty,true);assert.equal(reselectedSave.draft.updatedAt,reselectedSave.base);
    release=fixture.hold();const reopeningDelete=page.waitForRequest('**/api/freight-quotes/delete');await page.click('#btnDel');await reopeningDelete;
    await page.selectOption('#savedSel',activeId);await fill('head.party','EDIT AFTER RESELECT DELETE');release();await page.waitForFunction(()=>!pendingWrites.size);
    const reselectedDelete=await page.evaluate(()=>({id:Q.id,base:Q.updatedAt,party:Q.head.party,dirty,draft:JSON.parse(localStorage.getItem('kobFreightDraft'))}));
    assert.equal(reselectedDelete.id,activeId);assert.equal(reselectedDelete.base,null);assert.equal(reselectedDelete.party,'EDIT AFTER RESELECT DELETE');assert.equal(reselectedDelete.dirty,true);assert.equal(reselectedDelete.draft.updatedAt,null);
    console.log('PASS real browser selecting pending same quote preserves edits with acknowledged save/delete base');
    release=fixture.hold();const request=page.waitForRequest('**/api/freight-quotes/upsert');await page.click('#btnSave');await request;await page.click('#btnNew');await fill('head.ref','FIXTURE-B');release();await page.waitForFunction(()=>!pendingWrites.size);
    assert.equal(await page.evaluate(()=>Q.head.ref),'FIXTURE-B');assert.equal(await page.evaluate(()=>Q.updatedAt),null);assert.equal(await page.evaluate(()=>dirty),true);
    console.log('PASS real browser late save keeps subsequent edits and switched quote recovery draft');
    assert.deepEqual(errors,[]);await ctx.close();console.log('PASS no browser page errors; all requests fulfilled locally');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

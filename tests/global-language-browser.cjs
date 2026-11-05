'use strict';
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const {fixture}=require('./persistence-permissions.cjs');
const choose=(control,code)=>control.locator('button[data-language="'+code+'"]').click();
async function audit(page,label){
 const remaining=await page.evaluate(()=>{const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),out=new Set();let n;while((n=walker.nextNode())){const el=n.parentElement;if(el&&!el.closest('script,style,input,textarea,[translate="no"],[data-control-language]')&&el.getClientRects().length&&/[\u0e01-\u0e3a\u0e40-\u0e4e]/.test(n.nodeValue))out.add(n.nodeValue.trim());}return[...out];});
 if(process.argv.includes('--audit'))console.log(label+': '+JSON.stringify(remaining));
 assert.deepEqual(remaining,[],label+' UI must use English; business values are excluded');
}
(async()=>{
 const f=await fixture([{po_so:'PO-FIXTURE',company:'KOB',_board:'import',_ts:100,note:'Business note ไทย',eta:'2026-11-05',dueDate:'2026-01-01',documentChecklist:{commercial_invoice:'pending'}}]);
 let browser;try{
  browser=await chromium.launch({headless:true});const errors=[];
  for(const role of ['admin','viewer']){
   const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
   page.on('pageerror',e=>errors.push(e.message));
   // This is a fixed translation fixture. Read it before registering the route;
   // an in-flight route.fetch() response can be disposed during navigation.
   const importPayload=(await f.request('/api/import-pos')).body;
   importPayload.rows.forEach(row=>{row.supplier='บริษัท วันใหม่ จำกัด';});
   await page.route('**/api/import-pos',route=>route.fulfill({json:importPayload}));
   await page.goto(f.base+'/login');await page.locator('#username').fill(role);await page.locator('#password').fill('fixture-'+role);await page.locator('#submit').click();await page.waitForURL(f.base+'/');
   const language=page.locator('#controlLanguage');await language.waitFor();
   const languageBox=await language.boundingBox(),logoutBox=await page.locator('#controlLogout').boundingBox();
   assert.ok(languageBox.y>=logoutBox.y+logoutBox.height,'language selector belongs below logout');
   const identityBox=await page.locator('#controlIdentity').boundingBox();
   assert.ok(Math.abs(identityBox.y+identityBox.height/2-logoutBox.y-logoutBox.height/2)<1,'account and logout must share a centered first row');
   assert.ok(Math.abs(languageBox.x+languageBox.width-logoutBox.x-logoutBox.width)<1,'language row must align with logout at the right edge');
   assert.equal(await language.locator('select').count(),0,'language choices must be buttons');
   assert.equal(await language.getByRole('img').getAttribute('aria-label'),'Thailand');
   if(role==='admin'&&process.argv.includes('--screenshot'))await page.locator('#controlSessionBar').screenshot({path:require('node:path').join(require('node:os').tmpdir(),'control-language-header.png')});
   await choose(language,'en');await page.getByRole('button',{name:'Log out',exact:true}).waitFor();
   assert.equal(await language.locator('[data-language="en"]').getAttribute('aria-pressed'),'true');
   assert.equal(await language.getByRole('img').getAttribute('aria-label'),'United Kingdom');
   await page.setViewportSize({width:390,height:844});
   assert.ok(await page.locator('#controlSessionBar').evaluate(el=>el.scrollWidth<=el.clientWidth),'account rows must fit a mobile screen');
   await page.setViewportSize({width:1440,height:1000});
   await page.getByRole('button',{name:'Follow-ups',exact:true}).waitFor();
   await page.getByText('Arrived at port',{exact:true}).first().waitFor();
   await page.getByText('บริษัท วันใหม่ จำกัด',{exact:true}).first().waitFor();
   if(role==='admin')await audit(page,'Tracking');
   await page.getByText('PO-FIXTURE',{exact:true}).first().click();
   if(role==='admin')await audit(page,'PO detail');
   if(role==='admin'){
    await page.getByRole('button',{name:'Edit',exact:true}).click();
    await audit(page,'PO editor');
    await page.locator('textarea').fill('Do not translate user data: หมายเหตุ');
    await choose(language,'th');assert.equal(await page.locator('textarea').inputValue(),'Do not translate user data: หมายเหตุ');
    await choose(language,'en');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('button',{name:'Edit',exact:true}).waitFor();
    assert.equal((await f.request('/api/tracking')).body.rows[0].note,'Do not translate user data: หมายเหตุ');
    await page.getByText('Do not translate user data: หมายเหตุ',{exact:true}).waitFor();
   }
   await page.getByRole('button',{name:'Close',exact:true}).last().click();
   await page.getByRole('button',{name:'Container Calculator',exact:true}).click();
   const calculator=page.frameLocator('iframe[title="Container Calculator"]');
   await calculator.getByText('Products',{exact:true}).waitFor();
   assert.equal(await calculator.locator('.lang-switch').count(),0);assert.equal(await calculator.locator('#controlLanguage').count(),0);
   const frame=page.frames().find(x=>x.url().endsWith('/container-loading-calculator.html'));
   await frame.evaluate(()=>openAddModal(groups[0].id));
   await calculator.locator('#mi-name').fill('Draft ไทย');await calculator.locator('#mi-weight').fill('11');await calculator.locator('#mi-pieces').fill('777');
   await choose(language,'th');await calculator.getByText('สินค้า',{exact:true}).first().waitFor();
   assert.equal(await calculator.locator('#mi-name').inputValue(),'Draft ไทย');assert.equal(await calculator.locator('#mi-weight').inputValue(),'11');assert.equal(await calculator.locator('#mi-pieces').inputValue(),'777');
   await choose(language,'en');await calculator.getByText('Products',{exact:true}).waitFor();
   assert.equal(await calculator.locator('#mi-name').inputValue(),'Draft ไทย');
   await page.getByRole('button',{name:'Freight Charges Comparison',exact:true}).click();
   const freight=page.frameLocator('iframe[title="Freight Charges Comparison"]');await freight.getByText('Template',{exact:true}).waitFor();
   if(role==='admin')await audit(page.frames().find(x=>x.url().endsWith('/freight-comparison.html')),'Freight');
   if(role==='admin'){await freight.locator('[data-tier]').first().click();await audit(page.frames().find(x=>x.url().endsWith('/freight-comparison.html')),'Freight tiers');await freight.locator('#tCancel').click();}
   await freight.locator('input[data-p="head.ref"]').fill('KEEP-REF-123');
   await choose(language,'th');await freight.getByText('แม่แบบ',{exact:true}).waitFor();assert.equal(await freight.locator('input[data-p="head.ref"]').inputValue(),'KEEP-REF-123');
   await choose(language,'en');await freight.getByText('Template',{exact:true}).waitFor();
   const other=await context.newPage();await other.goto(f.base+'/');await other.locator('#controlLanguage').waitFor();assert.equal(await other.locator('#controlLanguage').getAttribute('data-language'),'en');
   await choose(other.locator('#controlLanguage'),'th');await page.waitForFunction(()=>document.getElementById('controlLanguage').dataset.language==='th');await freight.getByText('แม่แบบ',{exact:true}).waitFor();
   await choose(language,'en');await page.reload();await page.getByRole('button',{name:'Log out',exact:true}).waitFor();assert.equal(await language.getAttribute('data-language'),'en');
   if(role==='admin'){await page.getByRole('button',{name:'Dashboard',exact:true}).click();await audit(page,'Dashboard');await page.getByRole('button',{name:'Follow-ups',exact:true}).click();await audit(page,'Follow-ups');}
   await context.close();
  }
  assert.deepEqual(errors,[]);console.log('Global language: admin/viewer, single selector, all modules, drafts, save, reload, new tabs and cross-tab synchronization passed.');
 }finally{if(browser)await browser.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

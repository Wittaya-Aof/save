'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),{chromium}=require('playwright');
const {fixture}=require('./persistence-permissions.cjs');
test('language review: form data, translated hints and identity boundaries',async t=>{
 const fixtureApp=await fixture();const browser=await chromium.launch({headless:true});
 async function open({user}={}){
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
  if(user)await page.route('**/api/me',async route=>{const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),user}});});
  await page.goto(fixtureApp.base+'/login');await page.locator('#username').fill('admin');await page.locator('#password').fill('fixture-admin');await page.locator('#submit').click();await page.waitForURL(fixtureApp.base+'/');await page.locator('#controlLanguage').waitFor();
  return {context,page};
 }
 try{
  await t.test('search and note placeholders translate without changing field values',async()=>{
   const {context,page}=await open();try{
    await page.evaluate(()=>ControlLanguage.set('en'));
    await page.getByRole('button',{name:'Follow-ups',exact:true}).waitFor();
    assert.match(await page.locator('input[placeholder*="PO"]').first().getAttribute('placeholder'),/Search/);
    await page.getByText('PO-FIXTURE',{exact:true}).first().click();await page.getByRole('button',{name:'Edit',exact:true}).click();
    assert.match(await page.locator('textarea').getAttribute('placeholder'),/Additional notes/);
   }finally{await context.close();}
  });
  await t.test('Thai account names remain identifiers rather than translated UI text',async()=>{
   const {context,page}=await open({user:'วัน'});try{await page.evaluate(()=>ControlLanguage.set('en'));await page.getByRole('button',{name:'Log out',exact:true}).waitFor();assert.match(await page.locator('#controlIdentity').innerText(),/^วัน · /);}finally{await context.close();}
  });
  await t.test('long account names do not push logout and language buttons outside mobile screens',async()=>{
   const {context,page}=await open({user:'A'.repeat(120)});try{assert.ok(await page.locator('#controlSessionBar').evaluate(el=>el.scrollWidth<=el.clientWidth));const b=await page.locator('#controlLogout').boundingBox();assert.ok(b.x+b.width<=390);}finally{await context.close();}
  });
  await t.test('remote language changes retain blank numeric drafts in the product editor',async()=>{
   const {context,page}=await open();try{
    await page.getByRole('button',{name:'Container Calculator',exact:true}).click();await page.frameLocator('iframe[title="Container Calculator"]').locator('.it-name-inp').first().waitFor();const frame=page.frames().find(f=>f.url().endsWith('/container-loading-calculator.html'));
    await frame.waitForFunction(()=>typeof openAddModal==='function');await frame.evaluate(()=>openAddModal(groups[0].id));
    await frame.locator('#mi-L').fill('');await page.evaluate(()=>ControlLanguage.set('en'));
    await frame.getByText('Products',{exact:true}).waitFor();assert.equal(await frame.locator('#mi-L').inputValue(),'');
    await frame.locator('#mi-L').fill('60');await frame.locator('#modal-save-btn').click();
    assert.equal(await frame.evaluate(()=>groups[0].items.at(-1).L),60,'saving after the language change must use the edited draft');
   }finally{await context.close();}
  });
  await t.test('remote language changes retain inline text before its change event commits',async()=>{
   const {context,page}=await open();try{
    await page.getByRole('button',{name:'Container Calculator',exact:true}).click();await page.frameLocator('iframe[title="Container Calculator"]').locator('.it-name-inp').first().waitFor();const frame=page.frames().find(f=>f.url().endsWith('/container-loading-calculator.html'));
    await frame.locator('.it-name-inp').first().fill('Unsaved inline name');await page.evaluate(()=>ControlLanguage.set('en'));await frame.getByText('Products',{exact:true}).waitFor();
    assert.equal(await frame.locator('.it-name-inp').first().inputValue(),'Unsaved inline name');
    await frame.locator('.it-name-inp').first().blur();
    assert.equal(await frame.evaluate(()=>groups[0].items[0].name),'Unsaved inline name','blur must commit the retained draft to the model');
   }finally{await context.close();}
  });
  await t.test('implicit option values follow app updates while labels are translated',async()=>{
   const {context,page}=await open();try{
    await page.evaluate(()=>{ControlLanguage.set('en');const s=document.createElement('select');s.id='review-select';s.innerHTML='<option>รายการ</option>';document.body.append(s);});
    await page.waitForFunction(()=>document.querySelector('#review-select option').label==='items');
    assert.equal(await page.locator('#review-select').inputValue(),'รายการ');
    await page.evaluate(()=>{document.querySelector('#review-select option').textContent='หมายเหตุ';});
    await page.waitForFunction(()=>document.querySelector('#review-select option').label==='Notes');
    assert.equal(await page.locator('#review-select').inputValue(),'หมายเหตุ');
    await page.evaluate(()=>{const option=document.querySelector('#review-select option');option.value='EXPLICIT-CODE';option.textContent='บันทึก';});
    await page.waitForFunction(()=>document.querySelector('#review-select option').label==='Save');
    await page.evaluate(()=>ControlLanguage.set('th'));
    assert.equal(await page.locator('#review-select').inputValue(),'EXPLICIT-CODE');
    assert.equal(await page.locator('#review-select option').textContent(),'บันทึก');
   }finally{await context.close();}
  });
 }finally{await browser.close();await fixtureApp.close();}
});

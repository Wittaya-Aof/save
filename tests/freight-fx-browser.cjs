'use strict';
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const {fixtureRouter}=require('./helpers/freight-browser-fixture.cjs');
(async()=>{
 const browser=await chromium.launch();try{
  const context=await browser.newContext(),fixture=fixtureRouter(),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',fixture.route);
  await context.route('**/api/fx-rates*',r=>r.fulfill({json:{ok:true,rows:[{currency:'USD',company_id:1,thb_per_unit:33.8833,as_of:'2026-11-04'},{currency:'USD',company_id:2,thb_per_unit:36,as_of:'2026-11-03'}]}}));
  await context.route('**/api/import-pos',r=>r.fulfill({json:{ok:true,rows:[{po_number:'PO-FX-FIXTURE',company_id:2,supplier:'Fixture supplier'}]}}));
  await page.goto('http://freight.fixture/freight-comparison.html');await page.waitForFunction(()=>pos.length===1);
  await page.locator('[data-p="head.ref"]').fill('PO-FX-FIXTURE');await page.locator('[data-p="head.ref"]').blur();
  assert.equal(await page.locator('#quoteCompany').inputValue(),'2');
  await page.locator('#btnFx').click();await page.waitForFunction(()=>Q.head.fx===36);
  await page.locator('#btnSave').click();await page.waitForFunction(()=>!dirty&&saved.length===1);
  const id=await page.evaluate(()=>Q.id);await page.reload();await page.locator('#savedSel').selectOption(id);
  assert.equal(await page.locator('#quoteCompany').inputValue(),'2');assert.equal(await page.locator('[data-p="head.fx"]').inputValue(),'36');
  await page.locator('#quoteCompany').selectOption('1');assert.equal(await page.locator('[data-p="head.fx"]').inputValue(),'');
  await page.locator('#btnFx').click();await page.waitForFunction(()=>Q.head.fx===33.8833);
  await page.locator('#btnSave').click();await page.waitForFunction(()=>!dirty);
  await page.reload();await page.locator('#savedSel').selectOption(id);assert.equal(await page.locator('#quoteCompany').inputValue(),'1');assert.equal(await page.locator('[data-p="head.fx"]').inputValue(),'33.8833');
  assert.deepEqual(errors,[]);console.log('Freight FX: unique PO company, scoped refresh, company switch clears old FX, save/reopen preserves scope and rate; zero page errors.');
 }finally{await browser.close();}
 const {fixture}=require('./persistence-permissions.cjs'),fs=require('node:fs'),path=require('node:path');const f=await fixture();try{
  const set=rate=>fs.writeFileSync(path.join(f.dir,'fixture-fx.json'),JSON.stringify([{currency:'USD',company_id:1,rate:1/rate,as_of:'2026-11-04'}]));
  set(33);assert.equal((await f.request('/api/fx-rates')).body.rows[0].thb_per_unit,33);
  set(34);assert.equal((await f.request('/api/fx-rates')).body.rows[0].thb_per_unit,33);
  assert.equal((await f.request('/api/fx-rates?force=1')).body.rows[0].thb_per_unit,34);
  console.log('Freight FX real HTTP: force refresh bypasses cached Odoo FX.');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

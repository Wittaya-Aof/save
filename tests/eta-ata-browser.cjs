'use strict';
const assert=require('node:assert/strict'),{chromium}=require('playwright'),{fixture}=require('./persistence-permissions.cjs');
(async()=>{
 const f=await fixture([{po_so:'PO-FIXTURE',company:'KOB',_board:'import',_ts:100,mode:'sea',vessel:'SITC JADE',voyage:'2622S',etd:'2026-10-01',eta:'2026-10-25',etsActualArrivalDate:'2026-10-20',etsStatus:'found',etsPortCode:'0119'}]);
 const browser=await chromium.launch();try{
  const context=await browser.newContext(),p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.goto(f.base+'/login');await p.locator('#username').fill('admin');await p.locator('#password').fill('fixture-admin');await p.locator('#submit').click();await p.waitForURL(f.base+'/');
  await p.getByText('PO-FIXTURE',{exact:true}).first().click();await p.getByRole('button',{name:'แก้ไข',exact:true}).click();
  assert.equal(await p.locator('#edit-eta').isEditable(),true);assert.equal(await p.locator('#edit-ata').isEditable(),false);assert.equal(await p.locator('#edit-ata').inputValue(),'2026-10-20');
  await p.locator('#edit-eta').fill('2026-10-24');await p.getByRole('button',{name:'บันทึก',exact:true}).click();await p.getByRole('button',{name:'แก้ไข',exact:true}).waitFor();
  let rows=(await(await context.request.get(f.base+'/api/tracking')).json()).rows;let row=rows.find(r=>r.po_so==='PO-FIXTURE');assert.equal(row.eta,'2026-10-24');assert.equal(row.etsActualArrivalDate,'2026-10-20');
  await p.getByRole('button',{name:'แก้ไข',exact:true}).click();
  await p.route('**/api/ets/arrival',route=>route.fulfill({json:{ok:true,etsStatus:'found',etsActualArrivalDate:'2026-10-21',etsMatchedVoyage:'2622S',etsCheckedAt:'2026-10-21T00:00:00Z',etsPortCode:'0119'}}));
  await p.getByRole('button',{name:'ตรวจ ATA จาก ETS',exact:true}).click();await p.waitForFunction(()=>document.querySelector('#edit-ata')?.value==='2026-10-21');assert.equal(await p.locator('#edit-eta').inputValue(),'2026-10-24');
  await p.getByRole('button',{name:'บันทึก',exact:true}).click();await p.getByRole('button',{name:'แก้ไข',exact:true}).waitFor();
  await p.reload();await p.getByText('PO-FIXTURE',{exact:true}).first().click();await p.getByRole('button',{name:'แก้ไข',exact:true}).click();assert.equal(await p.locator('#edit-eta').inputValue(),'2026-10-24');assert.equal(await p.locator('#edit-ata').inputValue(),'2026-10-21');
  const dates=p.locator('input[type="text"][placeholder="เช่น 123S"]');await dates.fill('2623S');assert.equal(await p.locator('#edit-ata').inputValue(),'');assert.equal(await p.locator('#edit-eta').inputValue(),'2026-10-24');
  await p.getByRole('button',{name:'ยกเลิก',exact:true}).click();await p.getByRole('button',{name:'แก้ไข',exact:true}).click();
  let release,started;const pending=new Promise(r=>started=r);
  await p.route('**/api/ets/arrival',async route=>{started();await new Promise(r=>release=r);await route.fulfill({json:{ok:true,etsStatus:'found',etsActualArrivalDate:'2026-10-19',etsMatchedVoyage:'2622S'}});});
  await p.getByRole('button',{name:'ตรวจ ATA จาก ETS',exact:true}).click();await pending;
  await p.getByRole('button',{name:'ยกเลิก',exact:true}).click();await p.getByRole('button',{name:'แก้ไข',exact:true}).click();
  const response=p.waitForResponse(r=>r.url().endsWith('/api/ets/arrival'));release();await response;await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await p.locator('#edit-ata').inputValue(),'2026-10-21','cancelled lookup cannot update a reopened draft');
  await p.getByRole('button',{name:'ยกเลิก',exact:true}).click();await p.getByRole('button',{name:'ออกจากระบบ',exact:true}).click();await p.locator('#username').waitFor();await p.locator('#username').fill('viewer');await p.locator('#password').fill('fixture-viewer');await p.locator('#submit').click();await p.waitForURL(f.base+'/');await p.getByText('PO-FIXTURE',{exact:true}).first().click();assert.equal(await p.getByRole('button',{name:'แก้ไข',exact:true}).count(),0);assert.deepEqual(errors,[]);
  console.log('ETA/ATA browser: editable estimate, read-only actual, lookup preserves ETA, persistence/reload, changed voyage invalidates draft ATA and viewer read-only passed.');
 }finally{await browser.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
// Browser + real application HTTP handler. Only random-port/temporary fixture data.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture } = require('./persistence-permissions.cjs');
(async () => {
  const f = await fixture([{ po_so: 'PO-FIXTURE', _board: 'import', _ts: 100,
    company: 'KOB', party: 'Fixture Supplier', cur: 'THB', amount: 1000, rate: 1,
    stage: 'etd', bl: 'BL-FIXTURE', etd: '2026-10-01', owner: 'Fixture Owner', note: 'original' }]);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const viewer = await browser.newContext();
    const view = await viewer.newPage();
    await view.goto(f.base+'/login');await view.locator('#username').fill('viewer');await view.locator('#password').fill('fixture-viewer');await view.getByRole('button',{name:'เข้าสู่ระบบ',exact:true}).click();await view.waitForURL(f.base+'/');
    await view.getByText('PO-FIXTURE', { exact: true }).first().click();
    assert.equal(await view.getByRole('button', { name: 'แก้ไข', exact: true }).count(), 0);
    assert.equal((await viewer.request.post(f.base + '/api/tracking/upsert', { data: { po_so: 'PO-FIXTURE', _baseTs: 100, note: 'forbidden' } })).status(), 403);
    const admin = await browser.newContext();
    const page = await admin.newPage();
    await page.goto(f.base+'/login');await page.locator('#username').fill('admin');await page.locator('#password').fill('fixture-admin');await page.getByRole('button',{name:'เข้าสู่ระบบ',exact:true}).click();await page.waitForURL(f.base+'/');
    await page.getByText('PO-FIXTURE', { exact: true }).first().click();
    await page.getByRole('button', { name: 'แก้ไข', exact: true }).click();
    await page.getByLabel('ผู้รับผิดชอบ').fill('Browser Fixture Owner');
    await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
    await page.waitForFunction(async () => {
      const response = await fetch('/api/tracking'); const json = await response.json();
      return json.rows[0].owner === 'Browser Fixture Owner';
    });
    const saved = (await f.request('/api/tracking')).body.rows[0];
    assert(saved._ts > 100); assert.match(saved._shipmentId, /^shp_[a-f0-9]{32}$/);
    assert.equal(saved.poRefs[0].poNumber, 'PO-FIXTURE');
    assert.equal((await f.request('/api/tracking/upsert', { po_so: 'PO-FIXTURE', _baseTs: 100, owner: 'Stale fixture' })).status, 409);
    await page.goto(f.base+'/');await page.getByText('เชื่อมต่อ Odoo',{exact:true}).waitFor();
    const lastSync=await page.getByText(/^ซิงก์สำเร็จล่าสุด /).textContent();
    for(const board of ['import-pos','export-sos']){const payload=(await f.request('/api/'+board)).body;await page.route('**/api/'+board+'?force=1',route=>route.fulfill({json:{...payload,via:'snapshot',stale:false,as_of:'2026-10-16T06:58:00.000Z'}}));}
    await page.getByRole('button',{name:'Sync Odoo',exact:true}).click();await page.getByText('ดึงข้อมูลล่าสุดไม่สำเร็จ',{exact:false}).waitFor();
    assert.equal(await page.getByText(/^ซิงก์สำเร็จล่าสุด /).textContent(),lastSync);assert.equal(await page.getByText('เชื่อมต่อ Odoo',{exact:true}).count(),0);
    console.log('browser-real-api: passed (viewer denied, admin UI saves actual handler, canonical revision and PO/shipment links persist)');
  } finally { if (browser) await browser.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

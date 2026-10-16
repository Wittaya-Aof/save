'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    for (const route of ['/', '/container-loading-calculator.html', '/freight-comparison.html']) {
      const r = await page.goto('http://127.0.0.1:3002' + route, { waitUntil: 'domcontentloaded' });
      assert.equal(r.status(), 200);
      await page.waitForSelector('button', { timeout: 45000 });
      assert((await page.locator('body').innerText()).trim().length > 100);
      console.log(JSON.stringify({ route, status: r.status(), title: await page.title(), pageErrors: errors.length }));
    }
    assert.deepEqual(errors, []);
    console.log('new-workspace browser smoke: passed');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

// ทดสอบโมดูลเปรียบเทียบค่าเฟรทด้วยเบราว์เซอร์จริง: 0 pageerror ทั้งสองธีม + กรอกเคสจริงจาก Excel แล้วเทียบยอด
const { chromium } = require('playwright');
// ภาพหน้าจอเก็บที่ SHOT_DIR (ถ้าตั้ง) ไม่งั้นลงโฟลเดอร์ปัจจุบัน — รันจากรากโปรเจกต์: NODE_PATH=./node_modules node tests/freight-e2e.cjs
const SP = (process.env.SHOT_DIR || '.').replace(/\\/g, '/').replace(/\/?$/, '/');
(async () => {
  const browser = await chromium.launch();
  const out = { errors: [], console: [] };
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addInitScript(t => { try { localStorage.setItem('kobTheme', t); localStorage.removeItem('kobFreightDraft'); } catch (e) {} }, theme);
    const page = await ctx.newPage();
    page.on('pageerror', e => out.errors.push(theme + ': ' + e.message));
    page.on('console', m => { if (m.type() === 'error') out.console.push(theme + ': ' + m.text()); });
    await page.goto('http://127.0.0.1:3000/freight-comparison.html', { waitUntil: 'networkidle' });
    await page.waitForSelector('#tbl tbody tr');
    if (theme === 'light') {
      // เคสจริง KOBPO2605-08758 (ชีทใน Import Charges Comparison.xlsx) — เทียบยอดกับ Excel
      const fill = async (p, v) => { await page.fill(`[data-p="${p}"]`, String(v)); };
      await fill('head.ref', 'KOBPO2605-08758'); await fill('head.fx', 32.9927); await fill('head.cbm', 17.2); await fill('head.qty', 30000);
      const P = { 'rows.0.prices.0': 15, 'rows.0.prices.1': 470, 'rows.2.prices.0': 1300, 'rows.2.prices.1': 1300, 'rows.3.prices.0': 750, 'rows.3.prices.1': 2800,
        'rows.7.prices.1': 300, 'rows.13.prices.1': 300, 'rows.17.prices.0': 150, 'rows.21.prices.0': 1800, 'rows.21.prices.1': 2000, 'rows.23.prices.0': 2800,
        'rows.24.prices.1': 5300, 'rows.25.prices.0': 300 };
      for (const [k, v] of Object.entries(P)) await fill(k, v);
      await page.waitForTimeout(150);
      const foot = await page.$$eval('#tbl tfoot tr', trs => trs.slice(0, 4).map(tr => [...tr.querySelectorAll('td.amt')].map(td => td.textContent.trim())));
      out.footer = { subtotal: foot[0], tax: foot[1], total: foot[2], avg: foot[3] };
      out.best = await page.$$eval('#tbl thead .tag-best', els => els.map(e => e.closest('th').querySelector('input').value));
      out.summary = await page.$eval('#summary', el => el.innerText.replace(/\s+/g, ' ').slice(0, 300));
      // บันทึกขึ้น server แล้วโหลดกลับ
      await page.click('#btnSave'); await page.waitForTimeout(600);
      out.saved = await page.$eval('#savedSel', s => [...s.options].map(o => o.textContent).slice(0, 3));
      out.status = await page.$eval('#status', s => s.textContent);
      await page.screenshot({ path: SP + 'pw-freight-light.png', fullPage: true });
      // ลบทิ้งไม่ให้ค้างในไฟล์ข้อมูลจริง
      page.on('dialog', d => d.accept());
      await page.click('#btnDel'); await page.waitForTimeout(500);
      out.afterDelete = await page.$eval('#savedSel', s => s.options.length);
      // แม่แบบอากาศ: CW = max(GW,VW) และ 3 คอลัมน์
      await page.click('[data-type="import-air"]'); await page.waitForTimeout(150);
      await fill('head.fx', 32.9927); await fill('head.gw', 577.5); await fill('head.vw', 166.35); await fill('head.qty', 1000);
      await fill('rows.0.prices.0', 2.01); await fill('rows.2.prices.0', 500); await fill('rows.4.prices.0', 1800); await fill('rows.6.prices.0', 3800); await fill('rows.10.prices.0', 500);
      await page.waitForTimeout(150);
      const af = await page.$$eval('#tbl tfoot tr', trs => trs.slice(0, 4).map(tr => tr.querySelector('td.amt').textContent.trim()));
      out.air = { subtotal: af[0], tax: af[1], total: af[2], avg: af[3] }; // Excel: 44,897.10 / 8,979.42 / 53,876.52 / 53.8765
    } else {
      await page.screenshot({ path: SP + 'pw-freight-dark.png', fullPage: false });
      // แอปหลัก: กดแท็บใหม่แล้ว iframe ต้องโหลด
      const main = await ctx.newPage();
      main.on('pageerror', e => out.errors.push('main: ' + e.message));
      await main.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
      await main.click('text=Freight Charges Comparison');
      const fr = await main.waitForSelector('iframe[src="/freight-comparison.html"]', { timeout: 10000 });
      const frame = await fr.contentFrame(); await frame.waitForSelector('#tbl tbody tr');
      out.mainTab = { title: await frame.title(), embeddedHeaderHidden: await frame.$eval('.header', el => getComputedStyle(el).display) };
      await main.screenshot({ path: SP + 'pw-freight-inapp.png' });
    }
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

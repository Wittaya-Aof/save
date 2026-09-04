// ทดสอบโมดูลเปรียบเทียบค่าเฟรทด้วยเบราว์เซอร์จริง: 0 pageerror ทั้งสองธีม + กรอกเคสจริงจาก Excel แล้วเทียบยอด
const { chromium } = require('playwright');
// ตั้ง SHOT_DIR ถ้าอยากได้ภาพหน้าจอ · ไม่ตั้ง = ไม่เขียนไฟล์เลย — รันจากรากโปรเจกต์: NODE_PATH=./node_modules node tests/freight-e2e.cjs
// ภาพเป็น opt-in: ไม่ตั้ง SHOT_DIR = ไม่เขียนไฟล์ใด ๆ ลงดิสก์ (ให้ตัวรีวิวแบบอ่านอย่างเดียวรันได้)
const SP = process.env.SHOT_DIR ? process.env.SHOT_DIR.replace(/\\/g, '/').replace(/\/?$/, '/') : null;
const shot = async (target, name, opts) => { if (SP) await target.screenshot({ ...(opts || {}), path: SP + name }); };
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
      // อ้างแถวด้วย "ชื่อรายการ" ไม่ใช่เลขลำดับ — แม่แบบมีการเพิ่มแถวได้ ถ้าผูกกับเลขลำดับเทสจะกรอกผิดแถวเงียบ ๆ
      const rowIndex = async desc => page.$$eval('input.desc',
        (els, d) => { const el = els.find(e => e.value === d); return el ? +el.dataset.p.split('.')[1] : -1; }, desc);
      const fillRow = async (desc, oi, v) => {
        const i = await rowIndex(desc);
        if (i < 0) throw new Error('ไม่พบแถว "' + desc + '" ในแม่แบบ');
        await fill(`rows.${i}.prices.${oi}`, v);
      };
      const P = [
        ['O/F  (Ocean Freight)', 0, 15], ['O/F  (Ocean Freight)', 1, 470],
        ['D/O  (Delivery Order)', 0, 1300], ['D/O  (Delivery Order)', 1, 1300],
        ['THC  (Terminal Handling Charge)', 0, 750], ['THC  (Terminal Handling Charge)', 1, 2800],
        ['Cleaning Fee', 1, 300], ['EMC', 1, 300], ['Handling', 0, 150],
        ['Customs Clearance', 0, 1800], ['Customs Clearance', 1, 2000],
        ['Transportation  (6 wheels)', 0, 2800], ["Transportation  (FCL 20' / 40')", 1, 5300],
        ['Service Charge', 0, 300],
      ];
      for (const [d, oi, v] of P) await fillRow(d, oi, v);
      await page.waitForTimeout(150);
      const foot = await page.$$eval('#tbl tfoot tr', trs => trs.slice(0, 4).map(tr => [...tr.querySelectorAll('td.amt')].map(td => td.textContent.trim())));
      out.footer = { subtotal: foot[0], tax: foot[1], total: foot[2], avg: foot[3] };
      out.best = await page.$$eval('#tbl thead .tag-best', els => els.map(e => e.closest('th').querySelector('input').value));
      out.summary = await page.$eval('#summary', el => el.innerText.replace(/\s+/g, ' ').slice(0, 300));
      // บันทึกขึ้น server แล้วโหลดกลับ
      await page.click('#btnSave'); await page.waitForTimeout(600);
      out.saved = await page.$eval('#savedSel', s => [...s.options].map(o => o.textContent).slice(0, 3));
      out.status = await page.$eval('#status', s => s.textContent);
      await shot(page, 'pw-freight-light.png', { fullPage: true });
      // ลบทิ้งไม่ให้ค้างในไฟล์ข้อมูลจริง
      page.on('dialog', d => d.accept());
      await page.click('#btnDel'); await page.waitForTimeout(500);
      out.afterDelete = await page.$eval('#savedSel', s => s.options.length);
      // แม่แบบอากาศ: CW = max(GW,VW) และ 3 คอลัมน์
      await page.click('[data-type="import-air"]'); await page.waitForTimeout(150);
      await fill('head.fx', 32.9927); await fill('head.gw', 577.5); await fill('head.vw', 166.35); await fill('head.qty', 1000);
      for (const [d, v] of [['A/F  (Air Freight)', 2.01], ['D/O  (Delivery Order)', 500], ['Customs Clearance', 1800],
        ['Transportation  (6 wheels)', 3800], ['DG Handling', 500]]) await fillRow(d, 0, v);
      await page.waitForTimeout(150);
      const af = await page.$$eval('#tbl tfoot tr', trs => trs.slice(0, 4).map(tr => tr.querySelector('td.amt').textContent.trim()));
      out.air = { subtotal: af[0], tax: af[1], total: af[2], avg: af[3] }; // Excel: 44,897.10 / 8,979.42 / 53,876.52 / 53.8765
    } else {
      await shot(page, 'pw-freight-dark.png', { fullPage: false });
      // แอปหลัก: กดแท็บใหม่แล้ว iframe ต้องโหลด
      const main = await ctx.newPage();
      main.on('pageerror', e => out.errors.push('main: ' + e.message));
      await main.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
      await main.click('text=Freight Charges Comparison');
      const fr = await main.waitForSelector('iframe[src="/freight-comparison.html"]', { timeout: 10000 });
      const frame = await fr.contentFrame(); await frame.waitForSelector('#tbl tbody tr');
      out.mainTab = { title: await frame.title(), embeddedHeaderHidden: await frame.$eval('.header', el => getComputedStyle(el).display) };
      await shot(main, 'pw-freight-inapp.png');
    }
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

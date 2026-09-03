// ตรวจ 2 ฟีเจอร์ใหม่ของ Freight Charges Comparison ด้วยเบราว์เซอร์จริง
//   A. ขั้นบันไดค่าระวาง — เลือกขั้นตาม CBM · นอกช่วงต้องเตือนและไม่คิดราคา · ฟรี = 0 ไม่ใช่ว่าง
//   B. อ่านใบเสนอราคา PDF — เติมเฉพาะช่องว่าง · ทำเครื่องหมายทุกช่องที่เติม · ตั้งชื่อคอลัมน์และขั้นบันไดให้
// การเรียก /api/freight-extract ถูก mock ด้วยผลจริงที่บันทึกไว้จาก KYOEI (tests/fixtures/kyoei-extract.json)
// จึงรันซ้ำได้ฟรีและผลคงที่ — ตัว endpoint จริงทดสอบแยกด้วยการยิง PDF ตรง ๆ
// รันจากรากโปรเจกต์: NODE_PATH=./node_modules node tests/freight-pdf.cjs
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const URL = 'http://127.0.0.1:3000/freight-comparison.html';
const SP = (process.env.SHOT_DIR || '.').replace(/\\/g, '/').replace(/\/?$/, '/');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'kyoei-extract.json'), 'utf8'));

const results = [];
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addInitScript(() => { try { localStorage.removeItem('kobFreightDraft'); localStorage.setItem('kobTheme', 'light'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#tbl tbody tr');

  const rowIndex = async desc => page.$$eval('input.desc',
    (els, d) => { const el = els.find(e => e.value === d); return el ? +el.dataset.p.split('.')[1] : -1; }, desc);
  const fill = (p, v) => page.fill(`[data-p="${p}"]`, String(v));
  const fRow = await rowIndex('O/F  (Ocean Freight)');

  // ── A. ขั้นบันไดค่าระวาง ──────────────────────────────────────────────────
  await fill('head.fx', 33); await fill('head.cbm', 6);
  const linkText = await page.$eval(`[data-tier="0"]`, b => b.textContent.trim());
  check('แถวค่าระวางหลักมีปุ่ม "+ ขั้นบันได" (แถวอื่นไม่มี)',
    linkText === '+ ขั้นบันได' && (await page.$$('#tbl tbody [data-tier]')).length === 3, linkText);
  await page.click('[data-tier="0"]');
  await page.waitForSelector('#mask:not([hidden])');
  const tierIn = (i, f, v) => page.fill(`[data-t="${i}.${f}"]`, String(v));
  await tierIn(0, 'min', 1); await tierIn(0, 'max', 2.99); await tierIn(0, 'price', 0);
  await page.click('#tAdd'); await tierIn(1, 'min', 3); await tierIn(1, 'max', 4.99); await tierIn(1, 'price', 10);
  await page.click('#tAdd'); await tierIn(2, 'min', 5); await tierIn(2, 'max', 7.99); await tierIn(2, 'price', 12);
  await page.click('#tOk');
  await page.waitForSelector('#mask', { state: 'hidden' });
  await page.waitForTimeout(150);
  const cell = async () => page.evaluate(ri => {
    const tr = [...document.querySelectorAll('#tbl tbody tr:not(.sec)')][ri];
    const tv = tr.querySelector('.tierval');
    return { tier: tv ? tv.textContent.trim() : null, out: !!tv?.classList.contains('out'),
      amt: tr.querySelector('td.amt').textContent.trim(), link: tr.querySelector('[data-tier="0"]').textContent.trim(),
      warn: document.querySelector('#cmpWarn').innerText };
  }, fRow);
  let c = await cell();
  check('CBM 6 → เลือกขั้น 5–7.99 ราคา 12 · ยอด = 6 × 12 × 33 = 2,376.00',
    c.tier === '12.00' && c.amt === '2,376.00' && /3 ขั้น/.test(c.link), JSON.stringify(c).slice(0, 120));
  await fill('head.cbm', 11.5); await page.waitForTimeout(150); c = await cell();
  check('CBM 11.5 (นอกช่วง) → ไม่คิดราคา ขึ้นคำเตือน ไม่ใช้ขั้นสุดท้ายแทน',
    c.tier === 'นอกช่วง' && c.out && c.amt === '–' && /ยังไม่มีราคาสำหรับชิปเม้นนี้/.test(c.warn) && /1\.00–7\.99/.test(c.warn),
    JSON.stringify({ tier: c.tier, amt: c.amt, warn: c.warn.slice(0, 80) }));
  await fill('head.cbm', 2); await page.waitForTimeout(150); c = await cell();
  check('CBM 2 → ขั้น "ฟรี" ราคา 0 คิดเป็น 0.00 ไม่ใช่ว่าง', c.tier === '0.00' && c.amt === '0.00' && !c.out, JSON.stringify({ tier: c.tier, amt: c.amt }));
  await fill('head.cbm', ''); await page.waitForTimeout(150); c = await cell();
  check('ยังไม่กรอก CBM → บอกว่า "รอปริมาณ" และเตือนให้กรอก', c.tier === 'รอปริมาณ' && /ยังไม่ได้กรอก/.test(c.warn), c.tier);
  await fill('head.cbm', 6);
  await page.screenshot({ path: SP + 'pw-tier.png', clip: { x: 0, y: 0, width: 1500, height: 560 } });

  // ── B. อ่าน PDF (mock ผลลัพธ์จริงของ KYOEI) ───────────────────────────────
  // คอลัมน์ 2 เป็น FCL 20'GP · ในเอกสาร Cleaning มี 2 ราคา: 300 (20'GP) กับ 600 (40'HQ)
  // ต้องได้ 300 และ 600 ต้องถูกคัดออก — ถ้าเทตามลำดับโดยไม่ดูชนิดตู้ จะได้ราคาผิดตู้
  // (fixture นี้ D/O ทั้งสองบรรทัดไม่ระบุชนิดตู้ จึงทดสอบกฎ "ระบุชนิดตู้ชนะไม่ระบุ" จากใบนี้ไม่ได้ — ตัวแรกในเอกสารชนะ)
  const thc = await rowIndex('THC  (Terminal Handling Charge)'), cfs = await rowIndex('Cleaning Fee');
  await fill(`rows.${thc}.prices.1`, 999);              // ค่าที่คนกรอกไว้ก่อน — ห้ามถูกทับ
  await page.route('**/api/freight-extract', route => route.fulfill({ json: { ok: true, filename: 'kyoei.pdf', data: FIX, usage: {} } }));
  await page.setInputFiles('#pdfInput', { name: 'KYOEI - QUOTATION IMPORT SHENZHEN.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 dummy') });
  await page.waitForSelector('#mask:not([hidden])', { timeout: 8000 });
  const pv = await page.evaluate(() => ({
    title: document.querySelector('#mTitle').textContent,
    rows: document.querySelectorAll('#mBody [data-pv]').length,
    hasTierOpt: !!document.querySelector('#pvTiers'),
    hasWarnBar: !!document.querySelector('#mBody .warnbar'),
    cols: document.querySelectorAll('#pvCol option').length,
    unmapped: (document.querySelector('#mBody').innerText.match(/ไม่ได้เติมให้ (\d+)/) || [])[1],
    conditions: /VAT 7%/.test(document.querySelector('#mBody').innerText),
  }));
  check('เปิดหน้าตรวจผล: มีรายการที่จะเติม · ตัวเลือกคอลัมน์ · แถบเตือนตรวจก่อนใช้ · เงื่อนไข VAT',
    /KYOEI/.test(pv.title) && pv.rows >= 5 && pv.cols === 3 && pv.hasWarnBar && pv.conditions, JSON.stringify(pv));
  await page.selectOption('#pvCol', '1');
  await page.waitForTimeout(150);
  const pv2 = await page.evaluate(() => {
    const t = document.querySelector('#mBody').innerText;
    return { skipHead: (t.match(/ไม่เติมลงคอลัมน์ ([^\n]+?) นี้ (\d+) รายการ/) || []).slice(1, 3),
      lclOut: /CFS[^\n]*เป็นราคาของ LCL/.test(t), dupDO: /D\/O[^\n]*ซ้ำแถว/.test(t),
      rows: document.querySelectorAll('#mBody [data-pv]').length, colSel: document.querySelector('#pvCol').value };
  });
  check('เปลี่ยนเป็นคอลัมน์ FCL 20\'GP → คัดราคา LCL ออก (CFS 350 = ราคาของ LCL) และตัด D/O 1,600 ที่ซ้ำแถว',
    pv2.colSel === '1' && /FCL 20/.test(pv2.skipHead[0] || '') && pv2.lclOut && pv2.dupDO,
    JSON.stringify(pv2));
  const pv3 = await page.evaluate(() => {
    const t = document.querySelector('#mBody').innerText;
    return { clean600Out: /Cleaning[^\n]*600[^\n]*เป็นราคาของ FCL 40'HQ/.test(t),
      flatOffer: /ใส่ค่าระวางต่อตู้ THB 250\.00/.test(t), noCbmTiers: !document.querySelector('#pvTiers') };
  });
  check('คอลัมน์ FCL 20\'GP: Cleaning 600 ของ 40\'HQ ถูกคัดออก · เสนอค่าระวางต่อตู้ 250 · ไม่เสนอ "ขั้นบันได CBM" ให้ตู้ FCL',
    pv3.clean600Out && pv3.flatOffer && pv3.noCbmTiers, JSON.stringify(pv3));
  await page.screenshot({ path: SP + 'pw-pdf-preview.png' });
  await page.click('#pvOk');
  await page.waitForSelector('#mask', { state: 'hidden' });
  await page.waitForTimeout(250);
  const after = await page.evaluate(({ thc, cfs, fRow }) => {
    const v = p => document.querySelector(`[data-p="${p}"]`);
    const src = [...document.querySelectorAll('input.price.frompdf')];
    return {
      thcKept: v(`rows.${thc}.prices.1`).value, thcMarked: v(`rows.${thc}.prices.1`).classList.contains('frompdf'),
      cfsVal: v(`rows.${cfs}.prices.1`).value, cfsMarked: v(`rows.${cfs}.prices.1`).classList.contains('frompdf'),
      cfsTitle: v(`rows.${cfs}.prices.1`).title,
      label: v('options.1.label').value,
      marked: src.length, markedCols: [...new Set(src.map(e => e.dataset.p.split('.')[3]))],
      toast: document.querySelector('#toast').textContent,
      col0Touched: [...document.querySelectorAll('input.price[data-p$=".prices.0"]')].filter(e => e.value !== '').length,
      ofVal: v(`rows.${fRow}.prices.1`)?.value, ofMarked: v(`rows.${fRow}.prices.1`)?.classList.contains('frompdf'),
      tierLink1: document.querySelector('#tbl tbody [data-tier="1"]')?.textContent.trim(),
    };
  }, { thc, cfs, fRow });
  check('ช่องที่คนกรอกไว้ (THC=999) ไม่ถูกทับ และไม่ถูกทำเครื่องหมาย', after.thcKept === '999' && !after.thcMarked, JSON.stringify({ kept: after.thcKept, marked: after.thcMarked }));
  check('ช่องว่างถูกเติม Cleaning Fee = 300 (ราคา 20\'GP) พร้อมเครื่องหมาย + tooltip ชื่อไฟล์',
    after.cfsVal === '300' && after.cfsMarked && /KYOEI/.test(after.cfsTitle), JSON.stringify({ val: after.cfsVal, title: after.cfsTitle.slice(0, 40) }));
  check('คอลัมน์ FCL: ค่าระวางต่อตู้ 250 ลงแถวค่าระวางหลักเป็นราคาตรง ๆ ไม่ใช่ขั้นบันได CBM',
    after.ofVal === '250' && after.ofMarked && after.tierLink1 === '+ ขั้นบันได', JSON.stringify({ of: after.ofVal, tierLink: after.tierLink1 }));
  check('เติมเฉพาะคอลัมน์ที่เลือก (คอลัมน์ 2) ไม่ไหลไปคอลัมน์อื่น',
    after.markedCols.length === 1 && after.markedCols[0] === '1' && after.col0Touched === 0, JSON.stringify(after.markedCols) + ' · col0=' + after.col0Touched);
  check('ชื่อคอลัมน์ว่าง → เติมชื่อ forwarder จากเอกสาร (ตัด Co., Ltd.)', /^KYOEI GLOBAL LOGISTICS/.test(after.label) && !/LTD/i.test(after.label), after.label);
  check('toast บอกจำนวนที่เติมและที่ข้าม', /เติม \d+ รายการ/.test(after.toast) && /ข้าม 1/.test(after.toast), after.toast);

  // ── C. บันทึกแล้วโหลดกลับ ขั้นบันไดและที่มาต้องยังอยู่ ─────────────────────
  await fill('head.ref', 'TEST-PDF-' + Date.now());
  page.on('dialog', d => d.accept());
  await page.click('#btnSave'); await page.waitForTimeout(700);
  const savedId = await page.evaluate(() => JSON.parse(localStorage.getItem('kobFreightDraft') || 'null')?.id || document.querySelector('#savedSel').value);
  await page.evaluate(() => { localStorage.removeItem('kobFreightDraft'); });
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#tbl tbody tr');
  await page.waitForTimeout(400);
  const opt = await page.$$eval('#savedSel option', os => os.map(o => o.value).filter(Boolean));
  await page.selectOption('#savedSel', opt[0]); await page.waitForTimeout(300);
  // อ่านจาก DOM ไม่ใช่ localStorage — การเปิดใบที่บันทึกไว้ไม่เขียน draft (dirty=false) จึงอ่านจาก storage ไม่ได้
  const reloaded = await page.evaluate(({ cfs }) => ({
    tierLink: document.querySelector('#tbl tbody [data-tier="0"]')?.textContent.trim(),
    cfsMarked: document.querySelector(`[data-p="rows.${cfs}.prices.1"]`)?.classList.contains('frompdf'),
    tierShown: !!document.querySelector('#tbl tbody .tierval'),
  }), { cfs });
  check('บันทึกแล้วเปิดใบกลับมา: ขั้นบันได 3 ขั้น + เครื่องหมายที่มายังอยู่',
    /3 ขั้น/.test(reloaded.tierLink || '') && reloaded.cfsMarked && reloaded.tierShown, JSON.stringify(reloaded));
  await page.click('#btnDel'); await page.waitForTimeout(500);   // เก็บกวาดไม่ให้ค้างในไฟล์ข้อมูลจริง
  const left = await page.$$eval('#savedSel option', os => os.filter(o => o.value).length);
  check('ลบใบทดสอบออกจาก server แล้ว', left === 0, 'เหลือ ' + left);

  check('ไม่มี pageerror / console error ตลอดการทดสอบ', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const fail = results.filter(r => !r.pass);
  results.forEach(r => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`));
  console.log(`\n${results.length - fail.length}/${results.length} ผ่าน`);
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });

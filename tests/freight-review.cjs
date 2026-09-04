// เทสจาก finding ของรอบรีวิว (Codex) — เขียนให้ "แดงก่อน" เพื่อพิสูจน์ว่าเป็นบั๊กจริง ไม่ใช่ข้อเสนอลอย ๆ
//   1. สลับแม่แบบทั้งที่มีข้อมูลที่ผู้ใช้พิมพ์ (แถวที่เพิ่มเอง / หัวเอกสาร) → ต้องถามก่อน ไม่ใช่ล้างเงียบ
//   2. ลบแถวที่เพิ่มเองซึ่งมีข้อมูลแล้ว → ต้องถามก่อน (ไม่มี undo)
//   3. prices ยาวเกินจำนวนคอลัมน์แล้วมีค่าจริงอยู่ → ตัดทิ้งได้ แต่ต้องบอก (กฎ "ห้ามตัดข้อมูลโดยไม่บอก")
//   4. ไฟล์ Excel ที่ส่งออกต้องมีคำเตือนเดียวกับที่ขึ้นบนหน้าจอ — ไฟล์คือสิ่งที่ถูกส่งต่อไปตัดสินใจ
// รันจากรากโปรเจกต์: NODE_PATH=./node_modules node tests/freight-review.cjs
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:3000/freight-comparison.html';

const results = [];
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

const newCtx = async (browser, initJson) => {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addInitScript(j => {
    try {
      localStorage.setItem('kobTheme', 'light');
      if (j) localStorage.setItem('kobFreightDraft', j); else localStorage.removeItem('kobFreightDraft');
    } catch (e) {}
  }, initJson || null);
  return ctx;
};

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // ── 1. สลับแม่แบบทั้งที่มีข้อมูลที่พิมพ์ไว้ ────────────────────────────────
  {
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('1: ' + e.message));
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message); d.dismiss(); });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#tbl tbody tr');
    await page.click('#tbl tbody tr.sec button[data-addrow]');
    await page.waitForTimeout(120);
    const idx = await page.$$eval('input.desc', els => {
      const el = els.find(e => e.value === ''); return el ? +el.dataset.p.split('.')[1] : -1;
    });
    await page.fill(`[data-p="rows.${idx}.desc"]`, 'Liftgate surcharge');
    await page.fill(`[data-p="rows.${idx}.unit"]`, 'TRIP');
    await page.fill('[data-p="head.docRef"]', 'SCM-IF-2609');
    await page.waitForTimeout(150);
    await page.click('[data-type="import-air"]');
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => ({
      type: [...document.querySelectorAll('#typeSeg button')].find(b => b.classList.contains('on'))?.dataset.type,
      hasCustom: [...document.querySelectorAll('input.desc')].some(e => e.value === 'Liftgate surcharge'),
      docRef: document.querySelector('[data-p="head.docRef"]')?.value,
    }));
    check('สลับแม่แบบทั้งที่พิมพ์แถวเอง/Document Ref. ไว้ → ต้องถามก่อน และเมื่อกดยกเลิกข้อมูลต้องอยู่ครบ',
      dialogs.length === 1 && st.type === 'import-sea' && st.hasCustom && st.docRef === 'SCM-IF-2609',
      `ถาม ${dialogs.length} ครั้ง · ` + JSON.stringify(st));
    await ctx.close();
  }

  // ── 1b. ใบใหม่ที่ยังไม่ได้พิมพ์อะไร → สลับแม่แบบต้องไม่ถาม (กันการแก้ข้อ 1 จนกวนเกิน)
  //        fx โหลดอัตโนมัติจาก /api/fx-rates และ docRef มีค่าเริ่มต้น "SCM-IF-" อยู่แล้ว
  //        ทั้งสองอย่างนี้ไม่ใช่ "ผู้ใช้พิมพ์" จึงต้องไม่นับเป็นข้อมูล
  {
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('1b: ' + e.message));
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message); d.accept(); });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#tbl tbody tr');
    await page.waitForTimeout(500);                       // ให้ loadFx เติมอัตราเสร็จก่อน
    const fxBefore = await page.$eval('[data-p="head.fx"]', e => e.value);
    await page.click('[data-type="export-sea"]');
    await page.waitForTimeout(300);
    const type = await page.evaluate(() =>
      [...document.querySelectorAll('#typeSeg button')].find(b => b.classList.contains('on'))?.dataset.type);
    check('ใบใหม่ที่ยังไม่พิมพ์อะไร → สลับแม่แบบได้เลย ไม่ถาม (fx/docRef ที่ระบบเติมเองไม่นับเป็นข้อมูล)',
      dialogs.length === 0 && type === 'export-sea', `ถาม ${dialogs.length} ครั้ง · fx="${fxBefore}" · type=${type}`);
    await ctx.close();
  }

  // ── 2. ลบแถวที่เพิ่มเองซึ่งมีข้อมูลแล้ว ───────────────────────────────────
  {
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('2: ' + e.message));
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message); d.dismiss(); });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#tbl tbody tr');
    await page.click('#tbl tbody tr.sec button[data-addrow]');
    await page.waitForTimeout(120);
    const idx = await page.$$eval('input.desc', els => {
      const el = els.find(e => e.value === ''); return el ? +el.dataset.p.split('.')[1] : -1;
    });
    await page.fill(`[data-p="rows.${idx}.desc"]`, 'Special handling');
    await page.fill(`[data-p="rows.${idx}.prices.0"]`, '2500');
    await page.waitForTimeout(150);
    const before = await page.$$eval('#tbl tbody tr:not(.sec)', r => r.length);
    await page.click('[data-delrow]');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({
      n: document.querySelectorAll('#tbl tbody tr:not(.sec)').length,
      kept: [...document.querySelectorAll('input.desc')].some(e => e.value === 'Special handling'),
    }));
    check('ลบแถวที่เพิ่มเองซึ่งกรอกข้อมูลแล้ว → ต้องถามก่อน และเมื่อกดยกเลิกแถวต้องยังอยู่',
      dialogs.length === 1 && after.n === before && after.kept,
      `ถาม ${dialogs.length} ครั้ง · ${before}→${after.n} · เหลือแถว ${after.kept}`);
    await ctx.close();
  }

  // ── 2b. ลบแถวเปล่าที่เพิ่งเพิ่ม → ไม่ต้องถาม (อย่าให้กวนเวลาไม่มีอะไรจะเสีย) ─
  {
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('2b: ' + e.message));
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message); d.accept(); });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#tbl tbody tr');
    const before = await page.$$eval('#tbl tbody tr:not(.sec)', r => r.length);
    await page.click('#tbl tbody tr.sec button[data-addrow]');
    await page.waitForTimeout(150);
    await page.click('[data-delrow]');
    await page.waitForTimeout(250);
    const n = await page.$$eval('#tbl tbody tr:not(.sec)', r => r.length);
    check('ลบแถวเปล่าที่เพิ่งเพิ่ม → ลบได้เลย ไม่ต้องถาม', dialogs.length === 0 && n === before,
      `ถาม ${dialogs.length} ครั้ง · ${before}→${n}`);
    await ctx.close();
  }

  // ── 3. prices ยาวเกินคอลัมน์และมีค่าจริง → ต้องบอกว่าตัดทิ้ง ───────────────
  {
    const seedCtx = await newCtx(browser);
    const seedPage = await seedCtx.newPage();
    await seedPage.goto(URL, { waitUntil: 'networkidle' });
    await seedPage.waitForSelector('#tbl tbody tr');
    await seedPage.fill('[data-p="rows.3.prices.0"]', '111');
    await seedPage.waitForTimeout(250);
    const seeded = await seedPage.evaluate(() => {
      const q = JSON.parse(localStorage.getItem('kobFreightDraft'));
      q.options = q.options.slice(0, 1);                 // จำลองใบที่คอลัมน์หายไป (แท็บค้าง/ใบเก่า)
      q.rows[3].prices = [111, 222, 333];                // แต่ราคายังอยู่ครบ 3 คอลัมน์
      return JSON.stringify(q);
    });
    await seedCtx.close();
    const ctx = await newCtx(browser, seeded);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('3: ' + e.message));
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#tbl tbody tr');
    await page.waitForTimeout(600);
    const t = await page.evaluate(() => ({
      toast: document.querySelector('#toast')?.textContent || '',
      shown: document.querySelector('#toast')?.classList.contains('show'),
      cols: document.querySelectorAll('#tbl thead [data-p$=".label"]').length,
    }));
    check('เปิดใบที่ราคายาวเกินจำนวนคอลัมน์ → ตัดได้ แต่ต้องบอกผู้ใช้ ไม่ตัดเงียบ',
      t.shown && /ตัด|เกินจำนวนคอลัมน์|ไม่ได้ใช้/.test(t.toast), `cols=${t.cols} · toast="${t.toast}"`);
    await ctx.close();
  }

  // ── 4. ไฟล์ Excel ต้องมีคำเตือนเดียวกับหน้าจอ ─────────────────────────────
  {
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('4: ' + e.message));
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#tbl tbody tr');
    await page.evaluate(() => {
      window.__aoa = null;
      const orig = XLSX.utils.aoa_to_sheet;
      XLSX.utils.aoa_to_sheet = a => { window.__aoa = JSON.parse(JSON.stringify(a)); return orig(a); };
      XLSX.writeFile = () => {};
    });
    await page.fill('[data-p="head.ref"]', 'REVIEW-4');
    await page.fill('[data-p="head.fx"]', '33');
    await page.fill('[data-p="head.cbm"]', '10');
    await page.fill('[data-p="rows.2.prices.0"]', '1000');
    await page.fill('[data-p="rows.3.prices.0"]', '500');
    await page.fill('[data-p="rows.4.prices.0"]', '500');
    await page.fill('[data-p="rows.2.prices.1"]', '900');   // คอลัมน์ 2 กรอกรายการเดียวแต่ยอดต่ำกว่า
    await page.waitForTimeout(300);
    const onScreen = await page.evaluate(() => document.querySelector('#cmpWarn')?.innerText || '');
    await page.click('#btnXlsx');
    await page.waitForTimeout(400);
    const aoa = await page.evaluate(() => window.__aoa);
    const flat = (aoa || []).map(r => (r || []).map(c => String(c ?? '')).join(' | ')).join('\n');
    check('หน้าจอขึ้นคำเตือน "ยังเทียบกันตรง ๆ ไม่ได้" จริง (เงื่อนไขของเทสข้อนี้)',
      /ยังเทียบกันตรงๆ ไม่ได้|ยังเทียบกันตรง ๆ ไม่ได้/.test(onScreen), onScreen.slice(0, 60));
    check('ไฟล์ Excel ที่ส่งออกต้องมีคำเตือนนั้นด้วย — ไฟล์คือสิ่งที่ถูกส่งต่อไปตัดสินใจ',
      /ยังเทียบกันตรง|กรอกราคาไว้|ยังกรอกไม่ครบ/.test(flat), flat.slice(-260).replace(/\n/g, ' ⏎ '));
    await ctx.close();
  }

  check('ไม่มี pageerror ตลอดการทดสอบ', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const fail = results.filter(r => !r.pass);
  results.forEach(r => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`));
  console.log(`\n${results.length - fail.length}/${results.length} ผ่าน`);
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });

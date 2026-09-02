// ตรวจ "รูปร่างหน้าจอ + กติกาการเตือน" ของโมดูล Freight Charges Comparison ด้วยเบราว์เซอร์จริง
// เทสนี้ไม่ตรวจยอดเงิน (freight-e2e.cjs ทำอยู่แล้ว) แต่ตรวจสิ่งที่ดูจากภาพอย่างเดียวไม่รู้:
//   1. การ์ด Make decision / Prepared by ถูกถอดออกจริง ไม่เหลือโค้ดค้าง
//   2. ตารางไม่ล้นกรอบ (ไม่ต้องเลื่อนแนวนอน) ที่ความกว้างใช้งานจริง
//   3. ชื่อรายการยาวไม่ถูกตัด · ปุ่มลบคอลัมน์ไม่ตกบรรทัด
//   4. ป้าย "ถูกที่สุด" ต้องกลายเป็นคำเตือนเมื่อคอลัมน์นั้นกรอกราคาน้อยรายการกว่าคอลัมน์อื่น
//   5. พิมพ์ราคาแล้วโฟกัสต้องไม่หลุด และค่าต้องไม่ไหลไปช่องอื่น
//   6. ลบแถวแล้วพิมพ์ต่อต้องไม่เกิด error (setPath ต้องกัน path ที่หายไป)
// รันจากรากโปรเจกต์: NODE_PATH=./node_modules node tests/freight-ui.cjs
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:3000/freight-comparison.html';
const SP = (process.env.SHOT_DIR || '.').replace(/\\/g, '/').replace(/\/?$/, '/');

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addInitScript(() => { try { localStorage.removeItem('kobFreightDraft'); localStorage.setItem('kobTheme', 'light'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#tbl tbody tr');

  // ── 1. การ์ดที่ถอดออก ─────────────────────────────────────────────────────
  const cards = await page.$$eval('.card .card-header', els => els.map(e => e.textContent.trim().split('—')[0].trim()));
  check('การ์ดเหลือ 3 ใบ (ไม่มี Make decision / Prepared by)',
    cards.length === 3 && !cards.some(c => /Make decision|Prepared by/i.test(c)), cards.join(' | '));
  const ghosts = await page.evaluate(() => ['decisionGrid', 'signGrid', 'optList'].filter(id => document.getElementById(id)));
  check('ไม่มี element ค้างของการ์ดที่ลบ', ghosts.length === 0, ghosts.join(','));

  // ── 2. ตารางไม่ล้นกรอบ ────────────────────────────────────────────────────
  const fits = async () => page.evaluate(() => {
    const w = document.querySelector('#tbl').closest('div[style*="overflow-x"]');
    return { scroll: w.scrollWidth, client: w.clientWidth, over: w.scrollWidth - w.clientWidth };
  });
  const f1400 = await fits();
  check('1400px: ตารางพอดีกรอบ ไม่ต้องเลื่อนแนวนอน', f1400.over <= 1, JSON.stringify(f1400));
  await page.setViewportSize({ width: 1180, height: 1000 });
  await page.waitForTimeout(120);
  const f1180 = await fits();
  check('1180px (เท่าความกว้าง iframe ในแอปหลัก): ตารางพอดีกรอบ', f1180.over <= 1, JSON.stringify(f1180));
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.waitForTimeout(120);

  // ── 3. ชื่อรายการไม่ถูกตัด + ปุ่มลบคอลัมน์อยู่บรรทัดเดียวกับชื่อ ─────────
  const clipped = await page.$$eval('input.desc', els =>
    els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.value));
  check('ชื่อรายการไม่ถูกตัดสักรายการ', clipped.length === 0, clipped.slice(0, 4).join(' | '));
  const sameLine = await page.evaluate(() => {
    const r = document.querySelector('#tbl thead .opt-head .r');
    const inp = r.querySelector('input'), btn = r.querySelector('button.x');
    if (!btn) return { ok: false, why: 'ไม่พบปุ่มลบคอลัมน์' };
    return { ok: Math.abs(inp.getBoundingClientRect().top - btn.getBoundingClientRect().top) < 6, why: '' };
  });
  check('ปุ่มลบคอลัมน์อยู่บรรทัดเดียวกับชื่อคอลัมน์', sameLine.ok, sameLine.why);

  // ── 4. ป้ายเตือนเมื่อกรอกไม่เท่ากัน ───────────────────────────────────────
  const fill = (p, v) => page.fill(`[data-p="${p}"]`, String(v));
  await fill('head.fx', 33); await fill('head.cbm', 10); await fill('head.qty', 1000);
  // คอลัมน์ 0 กรอก 3 รายการ · คอลัมน์ 1 กรอกรายการเดียวและถูกกว่า → ต้องขึ้นคำเตือน ไม่ใช่ป้ายเขียว
  await fill('rows.2.prices.0', 1000); await fill('rows.3.prices.0', 500); await fill('rows.4.prices.0', 500);
  await fill('rows.2.prices.1', 900);
  await page.waitForTimeout(150);
  const warnState = await page.evaluate(() => ({
    warnbar: !!document.querySelector('#cmpWarn .warnbar'),
    tagWarn: !!document.querySelector('#tbl thead .tag-warn'),
    tagBest: !!document.querySelector('#tbl thead .tag-best'),
    greenTotal: !!document.querySelector('#tbl tfoot td.amt.best'),
    shortNote: (document.querySelector('#summary').innerText.match(/กรอกน้อยกว่า/g) || []).length,
  }));
  check('กรอกไม่เท่ากัน → ขึ้นแถบเตือน', warnState.warnbar, JSON.stringify(warnState));
  check('กรอกไม่เท่ากัน → ป้ายเป็นสีเตือน ไม่ใช่ "ถูกที่สุด" สีเขียว', warnState.tagWarn && !warnState.tagBest, JSON.stringify(warnState));
  check('กรอกไม่เท่ากัน → ยอดรวมไม่ถูกไฮไลต์เขียว', !warnState.greenTotal, JSON.stringify(warnState));
  check('การ์ดสรุปบอกว่ากรอกน้อยกว่ากี่รายการ', warnState.shortNote >= 1, 'พบ ' + warnState.shortNote + ' จุด');

  // เติมให้ครบเท่ากัน → ต้องกลับเป็นป้ายเขียวและไม่มีแถบเตือน
  await fill('rows.3.prices.1', 400); await fill('rows.4.prices.1', 400);
  await page.waitForTimeout(150);
  const fairState = await page.evaluate(() => ({
    warnbar: !!document.querySelector('#cmpWarn .warnbar'),
    tagBest: !!document.querySelector('#tbl thead .tag-best'),
    tagWarn: !!document.querySelector('#tbl thead .tag-warn'),
    greenTotal: !!document.querySelector('#tbl tfoot td.amt.best'),
  }));
  check('กรอกครบเท่ากัน → กลับเป็นป้าย "ถูกที่สุด" สีเขียว',
    fairState.tagBest && !fairState.tagWarn && !fairState.warnbar && fairState.greenTotal, JSON.stringify(fairState));

  // ── 5. พิมพ์แล้วโฟกัสต้องไม่หลุด / ค่าไม่ไหล ─────────────────────────────
  const sel = '[data-p="rows.5.prices.0"]';
  await page.click(sel);
  await page.type(sel, '1234', { delay: 40 });
  const typed = await page.evaluate(s => ({
    focused: document.activeElement?.dataset?.p || '',
    val: document.querySelector(s).value,
    qty: document.querySelector('[data-p="head.qty"]').value,
  }), sel);
  check('พิมพ์ราคาแล้วโฟกัสยังอยู่ช่องเดิม', typed.focused === 'rows.5.prices.0', JSON.stringify(typed));
  check('ค่าที่พิมพ์อยู่ครบในช่องเดิม ไม่ไหลไปช่องอื่น', typed.val === '1234' && typed.qty === '1000', JSON.stringify(typed));

  // ── 6. ลบแถวแล้วพิมพ์ต่อ ต้องไม่ error ────────────────────────────────────
  const before = await page.$$eval('#tbl tbody tr:not(.sec)', r => r.length);
  await page.click('[data-delrow="8"]');
  await page.waitForTimeout(120);
  const after = await page.$$eval('#tbl tbody tr:not(.sec)', r => r.length);
  await page.fill('[data-p="rows.2.prices.0"]', '777');
  await page.waitForTimeout(150);
  const stillWorks = await page.$eval('#tbl tfoot tr td.amt', td => td.textContent.trim());
  check('ลบแถวแล้วแก้ราคาต่อได้ ยอดยังคำนวณ', after === before - 1 && stillWorks !== '–', `${before}→${after} · subtotal ${stillWorks}`);

  // ── 7. เปลี่ยนแม่แบบไป-กลับ แล้วโครงยังถูก ───────────────────────────────
  page.on('dialog', d => d.accept());
  await page.click('[data-type="import-air"]'); await page.waitForTimeout(250);
  const airOk = await page.evaluate(() => ({
    kinds: [...document.querySelectorAll('#tbl thead select.kind')].map(s => s.value),
    hasVW: !!document.querySelector('[data-p="head.vw"]'),
  }));
  check('สลับเป็นแม่แบบทางอากาศ: ทุกคอลัมน์เป็น AIR และมีช่อง Volume Weight',
    airOk.kinds.every(k => k === 'air') && airOk.hasVW, JSON.stringify(airOk));

  await page.screenshot({ path: SP + 'pw-freight-ui.png', fullPage: false });
  check('ไม่มี pageerror / console error ตลอดการทดสอบ', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  const fail = results.filter(r => !r.pass);
  results.forEach(r => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`));
  console.log(`\n${results.length - fail.length}/${results.length} ผ่าน`);
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });

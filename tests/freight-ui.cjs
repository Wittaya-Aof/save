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

  // ค่าเริ่มต้นของใบใหม่ ต้องอ่านก่อนที่เทสข้ออื่นจะพิมพ์อะไรลงไป
  const initialLabels = await page.$$eval('#tbl thead [data-p$=".label"]', els => els.map(e => e.value));

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
  const kindClip = await page.$$eval('#tbl thead select.kind', els =>
    els.filter(e => e.scrollWidth > e.clientWidth + 1).length);
  check('dropdown ชนิดคอลัมน์กว้างพอ ไม่ตัดคำ ("FCL 20\'GP")', kindClip === 0, 'ถูกตัด ' + kindClip + ' ช่อง');

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

  // พิมพ์ชื่อ forwarder ในหัวคอลัมน์ — เส้นทางหลักของโมดูลนี้ ต้องไม่ error และการ์ดสรุปต้องตามชื่อ
  const errBefore = errors.length;
  const nameSel = '[data-p="options.0.label"]';
  await page.click(nameSel);
  await page.type(nameSel, 'FR. LINKS', { delay: 30 });
  await page.waitForTimeout(200);
  const named = await page.evaluate(s => ({
    focused: document.activeElement?.dataset?.p || '',
    val: document.querySelector(s).value,
    inSummary: /FR\. LINKS/.test(document.querySelector('#summary').innerText),
  }), nameSel);
  check('พิมพ์ชื่อ forwarder ในหัวคอลัมน์: ไม่มี error · โฟกัสอยู่ · การ์ดสรุปใช้ชื่อนั้น',
    errors.length === errBefore && named.focused === 'options.0.label' && named.val === 'FR. LINKS' && named.inSummary,
    JSON.stringify(named) + ' · error ใหม่ ' + (errors.length - errBefore));

  // ── 6. แถวมาตรฐานลบไม่ได้ · แถวที่เพิ่มเองลบได้ · ลบแล้วพิมพ์ต่อไม่ error ──
  const tplDel = await page.$$('#tbl tbody button[data-delrow]');
  check('แถวมาตรฐานของแม่แบบไม่มีปุ่มลบ (กันลบแล้วหายถาวร)', tplDel.length === 0, 'พบปุ่มลบ ' + tplDel.length + ' ปุ่ม');
  const before = await page.$$eval('#tbl tbody tr:not(.sec)', r => r.length);
  await page.click('#tbl tbody tr.sec button[data-addrow]');            // + เพิ่มรายการ ในหมวดแรก
  await page.waitForTimeout(150);
  const added = await page.$$eval('#tbl tbody tr:not(.sec)', r => r.length);
  const customDel = await page.$$('#tbl tbody button[data-delrow]');
  check('เพิ่มรายการเองได้ และแถวนั้นมีปุ่มลบให้ 1 ปุ่ม', added === before + 1 && customDel.length === 1,
    `${before}→${added} · ปุ่มลบ ${customDel.length}`);
  await customDel[0].click();
  await page.waitForTimeout(150);
  const back = await page.$$eval('#tbl tbody tr:not(.sec)', r => r.length);
  await page.fill('[data-p="rows.2.prices.0"]', '777');
  await page.waitForTimeout(150);
  const stillWorks = await page.$eval('#tbl tfoot tr td.amt', td => td.textContent.trim());
  check('ลบแถวที่เพิ่มเองแล้วแก้ราคาต่อได้ ยอดยังคำนวณ', back === before && stillWorks !== '–', `${added}→${back} · subtotal ${stillWorks}`);

  // ── 6b. แถวมาตรฐานที่หายไปจากใบเก่า ต้องถูกเติมกลับตอนเปิดใบ ──────────────
  // ⚠ ห้ามใช้ page.reload() ในบริบทนี้ — addInitScript ด้านบนลบ draft ทุกครั้งที่โหลดหน้า
  //   ถ้าเผลอใช้จะได้ใบใหม่จากแม่แบบแล้วเทสผ่านทั้งที่ยังไม่ได้ทดสอบการกู้แถวเลย (เคยพลาดมาแล้ว)
  const cutDraft = await page.evaluate(() => {
    const q = JSON.parse(localStorage.getItem('kobFreightDraft'));
    const beforeN = q.rows.length;
    q.rows = q.rows.filter(r => !/Ocean Freight|EXW Charge/.test(r.desc));   // จำลองใบที่เคยกดลบทิ้ง
    q.rows[0].prices[0] = 4321;                                              // ราคาที่กรอกไว้ต้องไม่หาย
    q.rows.forEach(r => { delete r.tpl; });                                  // ใบเก่าไม่มีธง tpl
    return { beforeN, afterCut: q.rows.length, keptDesc: q.rows[0].desc, json: JSON.stringify(q) };
  });
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx2.addInitScript(j => { try { localStorage.setItem('kobFreightDraft', j); localStorage.setItem('kobTheme', 'light'); } catch (e) {} }, cutDraft.json);
  const page2 = await ctx2.newPage();
  page2.on('pageerror', e => errors.push('restore: ' + e.message));
  await page2.goto(URL, { waitUntil: 'networkidle' });
  await page2.waitForSelector('#tbl tbody tr');
  const restored = await page2.evaluate(() => {
    const descs = [...document.querySelectorAll('input.desc')].map(e => e.value);
    return {
      n: descs.length, firstTwo: descs.slice(0, 2),
      hasOF: descs.some(d => /Ocean Freight/.test(d)),
      hasEXW: descs.some(d => /EXW Charge/.test(d)),
      keptPrice: document.querySelector('[data-p="rows.2.prices.0"]')?.value,
      row2desc: document.querySelector('[data-p="rows.2.desc"]')?.value,
      delButtons: document.querySelectorAll('#tbl tbody button[data-delrow]').length,
    };
  });
  check('เปิดใบที่แถวมาตรฐานหายไป → เติมกลับครบตามลำดับเดิม',
    restored.hasOF && restored.hasEXW && restored.n === cutDraft.beforeN
    && /Ocean Freight/.test(restored.firstTwo[0]) && /EXW Charge/.test(restored.firstTwo[1]),
    `${cutDraft.afterCut} แถว → ${restored.n} แถว · ${JSON.stringify(restored.firstTwo)}`);
  check('ราคาที่กรอกไว้ในแถวที่ยังอยู่ ไม่หายไปตอนเติมแถวกลับ',
    restored.keptPrice === '4321' && /D\/O/.test(restored.row2desc || ''),
    `rows.2 = "${restored.row2desc}" ราคา "${restored.keptPrice}"`);
  check('แถวที่เติมกลับถือเป็นแถวมาตรฐาน จึงไม่มีปุ่มลบ', restored.delButtons === 0, 'ปุ่มลบ ' + restored.delButtons);

  // แก้ชื่อรายการมาตรฐานแล้วเปิดใหม่ ต้องไม่ถูกมองว่า "แถวหาย" จนแทรกแถวแม่แบบซ้ำเข้ามา
  const renamedJson = await page2.evaluate(() => {
    const q = JSON.parse(localStorage.getItem('kobFreightDraft'));
    const r = q.rows.find(x => /Terminal Handling/.test(x.desc));
    r.desc = 'THC (แก้ชื่อเอง)';
    return JSON.stringify(q);
  });
  await ctx2.close();
  const ctx3 = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx3.addInitScript(j => { try { localStorage.setItem('kobFreightDraft', j); } catch (e) {} }, renamedJson);
  const page3 = await ctx3.newPage();
  page3.on('pageerror', e => errors.push('rename: ' + e.message));
  await page3.goto(URL, { waitUntil: 'networkidle' });
  await page3.waitForSelector('#tbl tbody tr');
  const afterRename = await page3.evaluate(() => {
    const descs = [...document.querySelectorAll('input.desc')].map(e => e.value);
    return { n: descs.length, renamedKept: descs.includes('THC (แก้ชื่อเอง)'), dupTHC: descs.filter(d => /Terminal Handling/.test(d)).length };
  });
  check('แก้ชื่อรายการมาตรฐานแล้วเปิดใหม่ ไม่แทรกแถวซ้ำและชื่อที่แก้ยังอยู่',
    afterRename.renamedKept && afterRename.dupTHC === 0 && afterRename.n === restored.n,
    JSON.stringify(afterRename));
  await ctx3.close();

  // ── 6c. ข้อความและองค์ประกอบที่ต้องถูกถอด/แก้ ─────────────────────────────
  const texts = await page.evaluate(() => {
    const foot = [...document.querySelectorAll('#tbl tfoot tr')].map(tr => tr.querySelector('td').textContent.trim());
    return {
      foot,
      hasTransit: foot.some(f => /Transit time/.test(f)),
      hasNote: !!document.querySelector('.note'),
      labels: [...document.querySelectorAll('#tbl thead [data-p$=".label"]')].map(e => e.value),
      kinds: [...document.querySelectorAll('#tbl thead select.kind')].map(s => [...s.options].map(o => o.textContent)),
      kindVals: [...document.querySelectorAll('#tbl thead select.kind')].map(s => s.value),
    };
  });
  check('เปลี่ยนเป็น "* As per receipt — factor"', texts.foot.some(f => /^\* As per receipt — factor/.test(f)), texts.foot[1]);
  check('เปลี่ยนเป็น "Average Cost Per Unit (THB)"', texts.foot.includes('Average Cost Per Unit (THB)'), texts.foot[3]);
  check('ถอดแถว "Transit time / หมายเหตุต่อตัวเลือก" ออกแล้ว', !texts.hasTransit, texts.foot.join(' | '));
  check('ถอดหมายเหตุใต้ตารางออกแล้ว', !texts.hasNote);
  check('ใบใหม่: ชื่อคอลัมน์ว่างเปล่าทั้ง 3 คอลัมน์ (ไว้ใส่ชื่อ forwarder)',
    initialLabels.length === 3 && initialLabels.every(v => v === ''), JSON.stringify(initialLabels));
  check('dropdown ชนิดคอลัมน์เป็น LCL / FCL 20\'GP / FCL 40\'HQ',
    texts.kinds.every(k => k.join(',') === "LCL,FCL 20'GP,FCL 40'HQ"), JSON.stringify(texts.kinds[0]));
  check('ค่าเริ่มต้น 3 คอลัมน์ = lcl / fcl20 / fcl40hq',
    texts.kindVals.join(',') === 'lcl,fcl20,fcl40hq', texts.kindVals.join(','));

  // ── 6d. FCL ทั้งสองขนาดต้องคูณจำนวนตู้เหมือนกัน ───────────────────────────
  await page.fill('[data-p="head.cbm"]', '10');
  await page.fill('[data-p="options.1.containers"]', '2');
  await page.fill('[data-p="options.2.containers"]', '3');
  await page.fill('[data-p="rows.3.prices.0"]', '100');  // THC · LCL → 10 CBM × 100 = 1,000
  await page.fill('[data-p="rows.3.prices.1"]', '100');  // THC · FCL20 → 2 ตู้ × 100 = 200
  await page.fill('[data-p="rows.3.prices.2"]', '100');  // THC · FCL40HQ → 3 ตู้ × 100 = 300
  await page.waitForTimeout(200);
  const amts = await page.$$eval('#tbl tbody tr:not(.sec)', trs => {
    const tr = trs.find(t => /THC/.test(t.querySelector('input.desc')?.value || ''));
    return [...tr.querySelectorAll('td.amt')].map(td => td.textContent.trim());
  });
  check('LCL คูณ CBM · FCL 20\'GP และ 40\'HQ คูณจำนวนตู้ของตัวเอง',
    amts[0] === '1,000.00' && amts[1] === '200.00' && amts[2] === '300.00', amts.join(' / '));

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

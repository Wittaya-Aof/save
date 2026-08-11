// ─── e-tracking.customs.go.th (กรมศุลกากร) — ดึง Actual Arrival Date (ETA) ของเรือ ────────────
// ใช้ Playwright login ด้วยบัญชีจริง (ETS_USER/ETS_PASS ใน .env) แล้วค้นหน้า Manifest > Vessel Arrival
// ระบบนี้เป็น JSP/Servlet เก่า มี quirk หลายจุดที่ทดสอบเจอจริงและต้องจัดการ (24 ก.ค. 2569 ทดสอบ
// ด้วยมือทีละ step ผ่าน browser จริงจนกว่าจะเจอ flow ที่ใช้งานได้จริง):
//   1. privacy-policy modal (#ETSL0050) บังคับต้องกดยอมรับก่อน login ได้
//   2. **พิมพ์ Discharge Port แล้วเด้ง modal ยืนยัน (#ETSL1060) ทันที** ต้องคลิกแถวที่ตรงเลขท่า
//      ก่อน ไม่งั้นค่า Port ที่พิมพ์ไว้จะไม่ถูกใช้จริงตอนค้นหา (แถบ Port Name ข้างๆ จะว่างเปล่า)
//   3. กด Search ครั้งแรกจะเด้ง modal ยืนยันชื่อเรือ (#ETSL0070) ก่อนเสมอ (ต้องคลิกแถวที่ตรงชื่อ
//      แล้วกด Search อีกครั้งถึงจะค้นจริง) — คลิกแถวแล้ว radio Schedule/Actual Date จะรีเซ็ตกลับ
//      เป็น Schedule ด้วย จึงต้องเซ็ต Actual Date ใหม่ก่อนกด Search รอบสอง (แม้ผลลัพธ์จริงจะโชว์
//      ทั้ง Schedule Date/Time และ Actual Date/Time มาให้พร้อมกันในตารางเดียวไม่ว่า radio จะเป็นอะไร)
//   4. **เรือลำเดียวมีได้หลายเที่ยว (voyage)** — ผลลัพธ์คืนมาเป็นตารางทุกเที่ยวของเรือลำนั้นในช่วง
//      วันที่ค้นหา (เจอจริง: "SKY ORION" มี 5 เที่ยวใน 4 เดือน) **ต้องกรองด้วยเลข voyage ที่ดึงได้
//      จาก B/L เดียวกัน (ดู scan-shipment-docs.mjs::findVesselVoyageFree) ไม่งั้นได้ ETA ผิดเที่ยว**
'use strict';

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DEBUG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ets_debug');

const BASE_URL = 'https://e-tracking.customs.go.th/ETS/index.jsp';
const MODE_LABEL = { sea: 'Maritime', air: 'Air', train: 'Train' };

function ensureDebugDir() {
  try { fs.mkdirSync(DEBUG_DIR, { recursive: true }); } catch (e) {}
}

// พ.ศ. DD/MM/YYYY (ปฏิทินไทย) — ใช้กรอกช่วงวันที่ค้นหา (ปี ค.ศ. + 543)
function toBuddhistDMY(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear() + 543;
  return `${d}/${m}/${y}`;
}

// ค่าที่ระบบนี้คืนมาเป็น พ.ศ. DD/MM/YYYY เช่นกัน — แปลงกลับเป็น ISO YYYY-MM-DD (ค.ศ.)
function fromBuddhistDMY(s) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || '');
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const ceYear = parseInt(yyyy, 10) - 543;
  return `${ceYear}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

async function dismissPrivacyModal(page) {
  const modal = await page.waitForSelector('#ETSL0050', { state: 'visible', timeout: 5000 }).catch(() => null);
  if (!modal) return;
  await page.locator('#agree').check({ force: true }).catch(() => {});
  await page.locator('#UPDETL0050').click().catch(() => {});
  await page.waitForTimeout(400);
}

export async function openEtsSession() {
  const USER = process.env.ETS_USER;
  const PASS = process.env.ETS_PASS;
  if (!USER || !PASS) throw new Error('ETS_USER / ETS_PASS ไม่ได้ตั้งค่าใน .env — ข้าม ETA lookup');

  const browser = await chromium.launch({ headless: true });
  // ทุกขั้นหลัง launch ต้องครอบ try — ถ้า login/navigate ล้ม (goto timeout, หาปุ่มไม่เจอ, login fail)
  // ต้องปิด browser ก่อน throw ไม่งั้น chromium ค้างเป็น zombie สะสมทุกรอบที่ล้ม (Scheduled Task ยิงถี่)
  try {
    const page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await dismissPrivacyModal(page);

    await page.locator('input[type="text"], input:not([type])').first().fill(USER);
    await page.locator('input[type="password"]').first().fill(PASS);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      page.getByText('เข้าสู่ระบบ').first().click(),
    ]);
    await page.waitForTimeout(1200);

    if (!/SecurityServlet|ETS\/(?!index)/.test(page.url())) {
      ensureDebugDir();
      await page.screenshot({ path: path.join(DEBUG_DIR, 'login_failed.png') }).catch(() => {});
      throw new Error('ETS login ไม่สำเร็จ — ตรวจ ETS_USER/ETS_PASS หรือดู ets_debug/login_failed.png');
    }

    await page.getByText('Manifest', { exact: true }).click();
    await page.waitForTimeout(500);
    await page.getByText('Vessel Arrival', { exact: true }).first().click();
    await page.waitForTimeout(1000);

    return { browser, page };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

export async function closeEtsSession(session) {
  if (session?.browser) await session.browser.close().catch(() => {});
}

// ท่าเรือกรุงเทพ (สทก.) — ผู้ใช้ยืนยันแล้วว่านี่คือรหัสท่าที่ต้องกรอกเสมอเพื่อให้ค้นหาได้ผลจริง
// (ทดสอบแล้ว: ไม่กรอกฟิลด์นี้ การค้นหาใช้งานไม่ได้เหมือนที่ตั้งใจ)
const DISCHARGE_PORT_NUMBER = '0119';

// ค้นหา Actual Arrival Date ของเรือลำหนึ่ง — คืน { eta, status } เสมอ ไม่ throw (ให้ caller ทำงานต่อ
// กับเรือ/PO อื่นได้แม้ลำนี้หาไม่เจอ/ระบบมีปัญหา)
//   voyage: เลขเที่ยวเรือ (ดึงจาก B/L เดียวกับ vessel) — ใช้กรองแถวผลลัพธ์ให้ตรงเที่ยว ไม่ใช่แค่ชื่อเรือ
//   status: 'found' | 'not_found' | 'error'
export async function searchVesselActualDate(page, vesselName, mode = 'sea', voyage = null, etd = null) {
  const modeLabel = MODE_LABEL[mode] || 'Maritime';
  try {
    await page.locator('#modeTransportSHR').selectOption({ label: modeLabel });
    await page.locator('input[name="radioType"]').nth(1).click({ force: true }); // Actual Date
    // ช่วงวันที่ค้นหา: ถ้ารู้ ETD ของ shipment นี้ (จาก B/L) ให้ค้นรอบวันนั้น ไม่ใช่รอบ "วันนี้"
    // เดิมค้น today-120 ถึง today+14 เสมอ → shipment ที่ออกเรือเกิน 4 เดือนที่แล้วหาไม่เจอเลย
    // (เจอ 2026-08-11: KMTC SINGAPORE เที่ยว 2513S ออกเรือ 2025-12-11 อยู่นอกกรอบ 8 เดือน
    //  ระบบเลยคืนแต่เที่ยวล่าสุดของเรือชื่อเดียวกัน แล้วรายงานว่าไม่พบเที่ยวที่ตรง)
    // แคบกว่าเดิมด้วย จึงมีเที่ยวให้สับสนน้อยลง — เรือลำเดียวชื่อซ้ำกันข้ามปีเป็นเรื่องปกติ
    const today = new Date();
    const base = etd && /^\d{4}-\d{2}-\d{2}$/.test(etd) ? new Date(etd + 'T00:00:00') : null;
    let from, to;
    if (base && !isNaN(base)) {
      from = new Date(base); from.setDate(from.getDate() - 7);   // เผื่อ Shipped on Board คลาดจากวันออกจริง
      to = new Date(base); to.setDate(to.getDate() + 60);        // เผื่อเวลาเดินทาง + รอเข้าท่า
    } else {
      from = new Date(today); from.setDate(from.getDate() - 120);
      to = new Date(today); to.setDate(to.getDate() + 14);
    }
    await page.locator('#sendDateStrSHR').fill(toBuddhistDMY(from));
    await page.locator('#sendDateEndSHR').fill(toBuddhistDMY(to));
    await page.locator('#vesselNameSHR').fill(vesselName);

    // กรอก Discharge Port — พิมพ์แล้วระบบเด้ง modal ยืนยัน (#ETSL1060) ทันที ต้องคลิกแถวที่ตรง
    // เลขท่าก่อน ไม่งั้นค่าที่พิมพ์ไว้จะไม่ถูกใช้จริงตอนค้นหา (เจอจริงระหว่างทดสอบ)
    await page.locator('#portNumber').fill(DISCHARGE_PORT_NUMBER);
    const portModal = await page.waitForSelector('#ETSL1060', { state: 'visible', timeout: 3000 }).catch(() => null);
    if (portModal) {
      await page.waitForTimeout(300);
      await page.evaluate((port) => {
        const rows = document.querySelectorAll('#ETSL1060 tbody tr');
        for (const r of rows) {
          if (r.textContent.includes(port)) { r.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; }
        }
        return false;
      }, DISCHARGE_PORT_NUMBER);
      await page.waitForTimeout(400);
    }

    const clickMainSearch = () => page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(x => x.textContent.trim() === 'Search' && !x.closest('#ETSL0070') && !x.closest('#ETSL1060'));
      if (b) { b.click(); return true; }
      return false;
    });

    await clickMainSearch();
    const confirmModal = await page.waitForSelector('#ETSL0070', { state: 'visible', timeout: 6000 }).catch(() => null);
    if (confirmModal) {
      await page.waitForTimeout(400);
      const rowClicked = await page.evaluate((name) => {
        const rows = document.querySelectorAll('#ETSL0070 tbody tr');
        for (const r of rows) {
          if (r.textContent.toUpperCase().includes(name.toUpperCase())) {
            r.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, vesselName);
      if (!rowClicked) {
        // ไม่มีชื่อเรือนี้ในระบบเลย (พิมพ์ผิด/ไม่มีในฐานข้อมูล ETS) — ปิด modal แล้วถือว่าไม่พบข้อมูล
        await page.evaluate(() => {
          document.querySelectorAll('.modal-backdrop').forEach(b => b.remove());
          const m = document.getElementById('ETSL0070');
          if (m) { m.classList.remove('in', 'show'); m.style.display = 'none'; }
          document.body.classList.remove('modal-open');
        });
        return { eta: null, status: 'not_found' };
      }
      await page.waitForTimeout(600);
      // การยืนยันชื่อเรือรีเซ็ต radio กลับเป็น Schedule Date — ต้องตั้ง Actual Date ใหม่ก่อนค้นจริง
      // (ผลลัพธ์จริงมีทั้งสองคอลัมน์อยู่แล้วไม่ว่า radio จะเป็นอะไร แต่ตั้งให้ตรงเจตนาไว้เพื่อความชัดเจน)
      await page.locator('input[name="radioType"]').nth(1).click({ force: true });
      await clickMainSearch();
      await page.waitForTimeout(1800);
    }

    const bodyText = await page.evaluate(() => document.body.innerText);
    if (/ไม่พบข้อมูล/.test(bodyText)) return { eta: null, status: 'not_found' };

    // เรือลำเดียวมีได้หลายเที่ยว — ผลลัพธ์คืนมาเป็นตารางทุกเที่ยวในช่วงวันที่ค้นหา ต้องกรองด้วย
    // เลข voyage ให้ตรงเที่ยว (ถ้ามีให้) ก่อน ไม่งั้นเสี่ยงได้ ETA ของเที่ยวอื่นที่ไม่ใช่ shipment นี้
    const result = await page.evaluate(({ name, voy }) => {
      // ⚠ quirk #5 (เจอ 2026-08-11): modal ยืนยันชื่อเรือ (#ETSL0070) กับ modal ท่าเรือ (#ETSL1060)
      // ยังคาอยู่ใน DOM หลังกดยืนยัน และตารางข้างในมีคอลัมน์ "Vessel Name" ที่มีชื่อเรือด้วย
      // ของเดิมวน table ตามลำดับใน DOM แล้วเจอตารางใน modal ก่อน → ไม่มีคอลัมน์ Actual → คืน error
      // ทันทีโดยไม่ได้ดูตารางผลลัพธ์จริงที่อยู่ถัดไปเลย (ทุกครั้งที่ค้นจะล้มแบบนี้)
      const tables = Array.from(document.querySelectorAll('table'))
        .filter(t => !t.closest('#ETSL0070, #ETSL1060, #ETSL0050, .modal'));
      let sawCandidateRows = false;
      for (const t of tables) {
        const headerCells = Array.from(t.querySelectorAll('thead th, tr:first-child th, tr:first-child td'))
          .map(h => h.textContent.trim());
        const actualIdx = headerCells.findIndex(h => /actual/i.test(h));
        const voyageIdx = headerCells.findIndex(h => /voyage/i.test(h));
        const allRows = Array.from(t.querySelectorAll('tbody tr, tr'))
          .filter(r => r.textContent.toUpperCase().includes(name.toUpperCase()));
        if (!allRows.length) continue;
        sawCandidateRows = true;
        // ตารางนี้มีชื่อเรือแต่ไม่มีคอลัมน์ Actual = ไม่ใช่ตารางผลลัพธ์ → ไปดูตารางถัดไป
        // (ห้ามคืน error ทันทีเหมือนเดิม ไม่งั้นตารางผลจริงที่อยู่หลังจากนี้ไม่มีวันถูกอ่าน)
        if (actualIdx < 0) continue;

        const rowsWithCells = allRows.map(r => ({ r, cells: Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim()) }));
        // เลือกแถวให้ตรงเที่ยว:
        //  - ให้ voyage มา + ตารางมีคอลัมน์ voyage → ต้องแมตช์เป๊ะเท่านั้น ถ้าไม่ตรงเที่ยวไหน "ห้ามหยิบแถวอื่น"
        //    (เดิม fallback แถวแรกทำให้ได้ ETA ผิดเที่ยวเข้า production เงียบๆ — quirk #4 ที่จดไว้)
        //  - ให้ voyage มาแต่ตารางไม่มีคอลัมน์ voyage → กรองไม่ได้ หยิบแถวแรกแบบ best-effort (ตั้งธงไว้)
        //  - ไม่ได้ให้ voyage มา → หยิบแถวแรก
        let picked = null, voyageMismatch = false, voyageUnfilterable = false;
        if (voy && voyageIdx >= 0) {
          // B/L เขียนเลขเที่ยวว่า "V.2506S" แต่ตาราง ETS เขียน "2506S" — เดิมตัดแค่ช่องว่างจึงไม่ตรงกัน
          // (เจอ 2026-08-11: CA SAIGON V.2506S vs ตารางมี 2506S) ต้องตัดอักขระที่ไม่ใช่ตัวเลข/ตัวอักษรออกทั้งคู่
          const nv = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^V(?=\d)/, '');
          picked = rowsWithCells.find(x => nv(x.cells[voyageIdx]) === nv(voy));
          // ใส่เลขเที่ยวที่เจอจริงกลับไปด้วย เพื่อให้ log วินิจฉัยได้ว่าเป็นคนละเที่ยวหรือช่วงวันที่ผิด
          if (!picked) return { voyageMismatch: true, totalRows: rowsWithCells.length, seenVoyages: rowsWithCells.map(x => x.cells[voyageIdx]).filter(Boolean) };
        } else {
          if (voy && voyageIdx < 0) voyageUnfilterable = true;
          picked = rowsWithCells[0];
        }

        const cells = picked.cells;
        // ใช้ "เฉพาะ" คอลัมน์ Actual เท่านั้น — ไม่ fallback ไปหาเซลล์วันที่อื่น (เสี่ยงได้ Schedule Date แทน Actual)
        const actualCell = cells[actualIdx] || '';
        if (!/\d{1,2}\/\d{1,2}\/\d{4}/.test(actualCell)) {
          // เจอเที่ยวถูกแล้วแต่ยังไม่มี Actual Arrival Date (เรืออาจยังไม่ถึง) — ไม่ใช่ error
          return { pending: true, matchedVoyage: voyageIdx >= 0 ? cells[voyageIdx] : null, totalRows: rowsWithCells.length };
        }
        return { dateStr: actualCell, matchedVoyage: voyageIdx >= 0 ? cells[voyageIdx] : null, voyageUnfilterable, totalRows: rowsWithCells.length };
      }
      // วนครบทุกตารางแล้ว — เจอชื่อเรือแต่ไม่มีตารางไหนมีคอลัมน์ Actual เลย ถึงจะถือว่าผิดปกติจริง
      return sawCandidateRows ? { noActualColumn: true, totalRows: 0 } : null;
    }, { name: vesselName, voy: voyage });

    if (!result) {
      ensureDebugDir();
      const stamp = Date.now();
      await page.screenshot({ path: path.join(DEBUG_DIR, `unparsed_${stamp}.png`) }).catch(() => {});
      fs.writeFileSync(path.join(DEBUG_DIR, `unparsed_${stamp}.html`), await page.content());
      return { eta: null, status: 'error', error: 'พบผลลัพธ์แต่ parse วันที่ไม่ได้ — ดู ets_debug/unparsed_' + stamp };
    }
    // มี voyage ให้กรองแต่ไม่มีเที่ยวไหนตรง — คืน not_found ดีกว่าเดา ETA ผิดเที่ยว
    if (result.voyageMismatch) return { eta: null, status: 'not_found', reason: `ไม่พบเที่ยวที่ตรง — ในผลลัพธ์มีเที่ยว: ${(result.seenVoyages || []).join(', ') || '(ไม่มีเลขเที่ยว)'}`, totalVoyagesFound: result.totalRows };
    // ไม่มีคอลัมน์ Actual ในตารางเลย = โครงสร้างหน้าเปลี่ยน — เก็บ debug ไว้ อย่าเดา Schedule เป็น Actual
    if (result.noActualColumn) {
      ensureDebugDir();
      const stamp = Date.now();
      await page.screenshot({ path: path.join(DEBUG_DIR, `noactual_${stamp}.png`) }).catch(() => {});
      fs.writeFileSync(path.join(DEBUG_DIR, `noactual_${stamp}.html`), await page.content());
      return { eta: null, status: 'error', error: 'ไม่พบคอลัมน์ Actual ในตาราง — ดู ets_debug/noactual_' + stamp };
    }
    // เจอเที่ยวถูกแต่ยังไม่มี Actual Arrival Date (เรือยังไม่ถึง)
    if (result.pending) return { eta: null, status: 'not_found', reason: 'ยังไม่มี Actual Arrival Date (เรืออาจยังไม่ถึง)', matchedVoyage: result.matchedVoyage, totalVoyagesFound: result.totalRows };
    if (result.voyageUnfilterable) console.warn(`[ETS] ${vesselName}: มี voyage=${voyage} แต่ตารางไม่มีคอลัมน์ voyage — ใช้แถวแรกแบบ best-effort`);
    return { eta: fromBuddhistDMY(result.dateStr), status: 'found', matchedVoyage: result.matchedVoyage, totalVoyagesFound: result.totalRows };
  } catch (e) {
    ensureDebugDir();
    const stamp = Date.now();
    await page.screenshot({ path: path.join(DEBUG_DIR, `error_${stamp}.png`) }).catch(() => {});
    return { eta: null, status: 'error', error: e.message };
  }
}

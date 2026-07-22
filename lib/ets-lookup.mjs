// ─── e-tracking.customs.go.th (กรมศุลกากร) — ดึง Actual Arrival Date (ETA) ของเรือ ────────────
// ใช้ Playwright login ด้วยบัญชีจริง (ETS_USER/ETS_PASS ใน .env) แล้วค้นหน้า Manifest > Vessel Arrival
// ระบบนี้เป็น JSP/Servlet เก่า มี quirk 2 จุดที่ทดสอบเจอจริงและต้องจัดการ:
//   1. privacy-policy modal (#ETSL0050) บังคับต้องกดยอมรับก่อน login ได้
//   2. กด Search ครั้งแรกจะเด้ง modal ยืนยันชื่อเรือ (#ETSL0070) ก่อนเสมอ (ต้องคลิกแถวที่ตรงชื่อ
//      แล้วกด Search อีกครั้งถึงจะค้นจริง) — คลิกแถวแล้ว radio Schedule/Actual Date จะรีเซ็ตกลับ
//      เป็น Schedule ด้วย จึงต้องเซ็ต Actual Date ใหม่ก่อนกด Search รอบสอง
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
}

export async function closeEtsSession(session) {
  if (session?.browser) await session.browser.close().catch(() => {});
}

// ค้นหา Actual Arrival Date ของเรือลำหนึ่ง — คืน { eta, status } เสมอ ไม่ throw (ให้ caller ทำงานต่อ
// กับเรือ/PO อื่นได้แม้ลำนี้หาไม่เจอ/ระบบมีปัญหา)
//   status: 'found' | 'not_found' | 'error'
export async function searchVesselActualDate(page, vesselName, mode = 'sea') {
  const modeLabel = MODE_LABEL[mode] || 'Maritime';
  try {
    await page.locator('#modeTransportSHR').selectOption({ label: modeLabel });
    await page.locator('input[name="radioType"]').nth(1).click({ force: true }); // Actual Date
    const today = new Date();
    const from = new Date(today); from.setDate(from.getDate() - 120);
    const to = new Date(today); to.setDate(to.getDate() + 14);
    await page.locator('#sendDateStrSHR').fill(toBuddhistDMY(from));
    await page.locator('#sendDateEndSHR').fill(toBuddhistDMY(to));
    await page.locator('#vesselNameSHR').fill(vesselName);

    const clickMainSearch = () => page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(x => x.textContent.trim() === 'Search' && !x.closest('#ETSL0070'));
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
      await page.locator('input[name="radioType"]').nth(1).click({ force: true });
      await clickMainSearch();
      await page.waitForTimeout(1800);
    }

    const bodyText = await page.evaluate(() => document.body.innerText);
    if (/ไม่พบข้อมูล/.test(bodyText)) return { eta: null, status: 'not_found' };

    // best-effort: หาแถวผลลัพธ์ที่มีชื่อเรือ แล้วดึงคอลัมน์ที่มีรูปแบบวันที่ พ.ศ. ใต้หัว "Actual"
    const dateStr = await page.evaluate((name) => {
      const tables = Array.from(document.querySelectorAll('table'));
      for (const t of tables) {
        const headerCells = Array.from(t.querySelectorAll('thead th, tr:first-child th, tr:first-child td'))
          .map(h => h.textContent.trim());
        const actualIdx = headerCells.findIndex(h => /actual/i.test(h));
        const rows = Array.from(t.querySelectorAll('tbody tr, tr')).filter(r => r.textContent.toUpperCase().includes(name.toUpperCase()));
        for (const r of rows) {
          const cells = Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim());
          if (actualIdx >= 0 && cells[actualIdx] && /\d{1,2}\/\d{1,2}\/\d{4}/.test(cells[actualIdx])) return cells[actualIdx];
          const dateCell = cells.find(c => /\d{1,2}\/\d{1,2}\/\d{4}/.test(c));
          if (dateCell) return dateCell;
        }
      }
      return null;
    }, vesselName);

    if (!dateStr) {
      ensureDebugDir();
      const stamp = Date.now();
      await page.screenshot({ path: path.join(DEBUG_DIR, `unparsed_${stamp}.png`) }).catch(() => {});
      fs.writeFileSync(path.join(DEBUG_DIR, `unparsed_${stamp}.html`), await page.content());
      return { eta: null, status: 'error', error: 'พบผลลัพธ์แต่ parse วันที่ไม่ได้ — ดู ets_debug/unparsed_' + stamp };
    }
    return { eta: fromBuddhistDMY(dateStr), status: 'found' };
  } catch (e) {
    ensureDebugDir();
    const stamp = Date.now();
    await page.screenshot({ path: path.join(DEBUG_DIR, `error_${stamp}.png`) }).catch(() => {});
    return { eta: null, status: 'error', error: e.message };
  }
}

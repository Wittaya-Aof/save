'use strict';
// ─── บัญชีรายคนบน server จริง ──────────────────────────────────────────────────────────
// รัน: node tests/auth-users.cjs        (ต้องมี server ที่ port 3000)
//
// ครอบเส้นทางที่ unit test แตะไม่ถึง: server อ่าน users.json ตอนไหน · 401 ตอนไหน ·
// และ **ที่สำคัญที่สุด — ลบไฟล์แล้วต้องกลับไปสภาพเดิม** ไม่ค้างล็อกจนเข้าระบบไม่ได้
//
// ⚠ เทสนี้สร้าง users.json ชั่วคราวแล้วลบทิ้งตอนจบทุกกรณี · ถ้ามีไฟล์จริงอยู่ก่อนจะ **ไม่แตะเลย**
//   และข้ามเทสไป (ไม่เสี่ยงลบบัญชีจริงของใคร)
const fs = require('fs');
const path = require('path');
const http = require('http');
const U = require('../lib/users.cjs');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'users.json');
const REFRESH_MS = 5500;           // server เช็ค mtime อย่างมาก 1 ครั้ง/5 วินาที
const USER = 'เทสบัญชี';
const PASS = 'test-only-p@ss-9182';

let fail = 0;
const ok = (l) => console.log('  ✓ ' + l);
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function get(pathname, auth) {
  return new Promise((resolve) => {
    const headers = {};
    if (auth) headers['Authorization'] = 'Basic ' + Buffer.from(auth).toString('base64');
    const req = http.request({ hostname: '127.0.0.1', port: 3000, path: pathname, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
    req.end();
  });
}

(async () => {
  if (fs.existsSync(FILE)) {
    console.log('มี users.json จริงอยู่แล้ว — ข้ามเทสนี้เพื่อไม่ให้แตะบัญชีจริง');
    process.exit(0);
  }
  console.log('บัญชีรายคนบน server จริง\n');
  try {
    console.log('── 1. ก่อนมีบัญชี: เข้าได้ตามปกติ ──');
    if (await get('/api/tracking') === 200) ok('ไม่มี users.json = พฤติกรรมเดิมทุกประการ');
    else bad('ควรเข้าได้ 200 ตอนยังไม่มีบัญชี');

    console.log('\n── 2. สร้างบัญชีแล้ว server ต้องรู้เองโดยไม่ต้องรีสตาร์ท ──');
    U.saveUsers(FILE, { version: 1, users: { [U.normUser(USER)]: U.makeRecord(PASS) } });
    await sleep(REFRESH_MS);
    if (await get('/api/tracking') === 401) ok('ไม่ส่งรหัส → 401');
    else bad('ควรถูกปฏิเสธเมื่อไม่ส่งรหัส');
    if (await get('/api/tracking', `${USER}:${PASS}`) === 200) ok('ชื่อ+รหัสถูก → เข้าได้');
    else bad('ชื่อ+รหัสถูกแต่เข้าไม่ได้');
    if (await get('/api/tracking', `${USER}:ผิด`) === 401) ok('รหัสผิด → 401');
    else bad('รหัสผิดแต่เข้าได้');
    if (await get('/api/tracking', `ไม่มีคนนี้:${PASS}`) === 401) ok('ชื่อที่ไม่มีในระบบ → 401');
    else bad('ชื่อที่ไม่มีในระบบกลับเข้าได้');

    console.log('\n── 3. APP_PASSWORD ร่วม ต้องใช้ไม่ได้เมื่อมีบัญชีรายคนแล้ว ──');
    if (!process.env.APP_PASSWORD) ok('(เครื่องนี้ไม่ได้ตั้ง APP_PASSWORD — ไม่มีทางเข้าร่วมอยู่แล้ว)');
    else if (await get('/api/tracking', `ใครก็ได้:${process.env.APP_PASSWORD}`) === 401) ok('รหัสร่วมถูกปิดแล้ว');
    else bad('รหัสร่วมยังเข้าได้ — กลายเป็นทางเข้าเพิ่ม ไม่ใช่การปิดทางเข้าร่วม');

    console.log('\n── 4. /api/alive ต้องไม่ถูกล็อก (watchdog ใช้เช็คสถานะ) ──');
    if (await get('/api/alive') === 200) ok('watchdog ยังเช็คได้โดยไม่ต้องถือรหัส');
    else bad('/api/alive ถูกล็อกไปด้วย → watchdog จะสั่งรีสตาร์ททั้งที่ server ปกติ');

    console.log('\n── 5. ⭐ ลบไฟล์แล้วต้องกลับสภาพเดิม ไม่ค้างล็อก ──');
    fs.unlinkSync(FILE);
    await sleep(REFRESH_MS);
    if (await get('/api/tracking') === 200) ok('ลบ users.json แล้วกลับไปสภาพเดิม');
    else bad('ยังถูกล็อกอยู่ทั้งที่ลบไฟล์แล้ว — เสี่ยงล็อกตัวเองออกจากระบบ');
  } catch (e) {
    bad('เทสล้มกลางคัน: ' + e.message);
  } finally {
    try { fs.unlinkSync(FILE); } catch (e) {}
    try { fs.unlinkSync(FILE + '.tmp'); } catch (e) {}
    console.log('\n  ' + (fs.existsSync(FILE) ? '✗ users.json ทดสอบยังค้างอยู่' : '✓ เก็บกวาด users.json ทดสอบแล้ว'));
  }
  console.log(fail ? `\nauth-users: ไม่ผ่าน ${fail} ข้อ\n` : '\nauth-users: ผ่านทั้งหมด\n');
  process.exit(fail ? 1 : 0);
})();

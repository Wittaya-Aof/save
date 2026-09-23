'use strict';
// ─── เทสบัญชีรายคน (lib/users.cjs) ─────────────────────────────────────────────────────
// รัน: node tests/users.cjs        (บริสุทธิ์ — ไม่ต้องมี server · เขียนเฉพาะไฟล์ชั่วคราวใน os.tmpdir)
//
// สิ่งที่ล็อกไว้: รหัสผ่านต้องไม่ถูกเก็บเป็นข้อความ · ชื่อผู้ใช้ที่ล็อกอินได้ต้องเป็นชื่อเดียวกับที่ลง
// audit log · บัญชีที่ถูกปิดต้องเข้าไม่ได้ · ไฟล์พัง **ต้อง throw ไม่ใช่เงียบแล้วปล่อยผ่าน**
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../lib/users.cjs');

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ✓ ' + label); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'users-test-'));
const FILE = path.join(tmp, 'users.json');
const PW = 'ทดสอบ-p@ssw0rd';

console.log('\n── 1. เก็บรหัสผ่านอย่างปลอดภัย ──');

const rec = U.makeRecord(PW);
ok('ไม่เก็บรหัสผ่านเป็นข้อความที่ไหนเลยในระเบียน', () => {
  const blob = JSON.stringify(rec);
  assert.ok(!blob.includes(PW), 'พบรหัสผ่านดิบในระเบียน');
  assert.ok(rec.salt && rec.hash && rec.salt !== rec.hash);
});
ok('รหัสเดียวกันแต่คนละคน ได้ hash ไม่เหมือนกัน (salt ต่างกัน)', () =>
  assert.notStrictEqual(U.makeRecord(PW).hash, rec.hash));
ok('รหัสสั้นกว่า 8 ตัว ถูกปฏิเสธ', () =>
  assert.throws(() => U.makeRecord('1234567'), /อย่างน้อย 8/));

console.log('\n── 2. ตรวจรหัสผ่าน ──');

const store = { version: 1, users: { somchai: rec } };
ok('รหัสถูก → ผ่าน และคืนชื่อผู้ใช้กลับมา', () => {
  const v = U.verify(store, 'somchai', PW);
  assert.strictEqual(v.ok, true); assert.strictEqual(v.user, 'somchai');
});
ok('รหัสผิด → ไม่ผ่าน', () => assert.strictEqual(U.verify(store, 'somchai', PW + 'x').ok, false));
ok('ไม่มีชื่อผู้ใช้นั้น → ไม่ผ่าน และไม่บอกว่าไม่มีชื่อนี้', () => {
  const v = U.verify(store, 'ไม่มีจริง', PW);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, U.verify(store, 'somchai', 'ผิด').reason, 'ข้อความต้องเหมือนกัน ไม่งั้นเดาชื่อผู้ใช้ได้');
});
ok('รหัสว่าง/ไม่ส่งมา → ไม่ผ่าน ไม่ throw', () => {
  for (const p of ['', null, undefined]) assert.strictEqual(U.verify(store, 'somchai', p).ok, false);
});
ok('บัญชีที่ถูกปิด เข้าไม่ได้แม้รหัสถูก', () => {
  const s2 = { version: 1, users: { somchai: Object.assign({}, rec, { disabled: true }) } };
  const v = U.verify(s2, 'somchai', PW);
  assert.strictEqual(v.ok, false); assert.ok(/ปิดการใช้งาน/.test(v.reason));
});

console.log('\n── 3. ⭐ ชื่อผู้ใช้ — ต้องแยกคนออกจากกันได้จริง ──');

ok('🔴 ชื่อภาษาไทยคนละชื่อ ต้องไม่กลายเป็นคนเดียวกัน', () => {
  // บั๊กจริงตอนเขียนรอบแรก: ใช้ \w ซึ่งเป็น [A-Za-z0-9_] ล้วน → ชื่อไทยทุกชื่อกลายเป็น "_" เหมือนกันหมด
  // tests/auth-users.cjs จับได้ตอนที่ "ชื่อที่ไม่มีในระบบ" ล็อกอินผ่าน เพราะชนกับชื่อจริงในไฟล์
  const names = ['สมชาย', 'วิทยา', 'เทสบัญชี', 'ไม่มีคนนี้'];
  const out = names.map(U.normUser);
  assert.strictEqual(new Set(out).size, names.length, 'ชื่อชนกัน: ' + JSON.stringify(out));
  out.forEach((n, k) => assert.strictEqual(n, names[k], 'ชื่อไทยถูกแปลง: ' + names[k] + ' → ' + n));
});
ok('สระ/วรรณยุกต์ไทยไม่หาย (เป็น Unicode Mark ไม่ใช่ Letter)', () =>
  assert.strictEqual(U.normUser('เทสบัญชี'), 'เทสบัญชี'));
ok('ตัด ":" ทิ้งเสมอ — เป็นตัวคั่นของ Basic Auth ถ้าปล่อยไว้จะปลอมชื่อได้', () =>
  assert.ok(!U.normUser('ผู้ใช้:แอบ').includes(':')));
ok('ชื่อยาวเกิน 40 ตัวถูกตัด · ช่องว่างกลายเป็น _ · ตัดหัวท้าย', () => {
  assert.strictEqual(U.normUser('x'.repeat(60)).length, 40);
  assert.strictEqual(U.normUser('a b'), 'a_b');
  assert.strictEqual(U.normUser(' pad '), 'pad');
  assert.strictEqual(U.normUser('wittaya.s@kissofbeauty.co.th'), 'wittaya.s@kissofbeauty.co.th');
});
ok('ชื่อที่เหลือแต่ _ หรือว่าง ใช้ไม่ได้ (แยกคนไม่ออก)', () => {
  for (const b of ['___', '   ', '', null, '!!!']) assert.strictEqual(U.usableName(b), false, 'ควรปฏิเสธ: ' + b);
  for (const g of ['somchai', 'สมชาย', 'a.b@c']) assert.strictEqual(U.usableName(g), true);
});
ok('verify ปฏิเสธชื่อที่ใช้ไม่ได้ ตั้งแต่ก่อนตรวจรหัส', () =>
  assert.strictEqual(U.verify({ version: 1, users: { _: U.makeRecord(PW) } }, '___!', PW).ok, false));
ok('ล็อกอินด้วยชื่อที่มีช่องว่าง ได้ชื่อที่ normalize แล้วกลับมา', () => {
  const s3 = { version: 1, users: { a_b: U.makeRecord(PW) } };
  const v = U.verify(s3, 'a b', PW);
  assert.strictEqual(v.ok, true); assert.strictEqual(v.user, 'a_b');
});

console.log('\n── 4. อ่าน/เขียนไฟล์ ──');

ok('ไม่มีไฟล์ = ไม่มีบัญชี (ไม่ throw) → ระบบยังเริ่มได้', () => {
  const s = U.loadUsers(path.join(tmp, 'ยังไม่มี.json'));
  assert.strictEqual(U.activeCount(s), 0);
});
ok('เขียนแล้วอ่านกลับได้ และยังล็อกอินผ่าน', () => {
  U.saveUsers(FILE, store);
  assert.strictEqual(U.verify(U.loadUsers(FILE), 'somchai', PW).ok, true);
});
ok('ไม่มีไฟล์ .tmp ค้างหลังเขียน (atomic)', () => assert.ok(!fs.existsSync(FILE + '.tmp')));
ok('🔴 ไฟล์มีอยู่แต่พัง → ต้อง throw ห้ามเงียบแล้วถอยไปเปิดทางรหัสร่วม', () => {
  const bad = path.join(tmp, 'พัง.json');
  fs.writeFileSync(bad, '{ไม่ใช่ json');
  assert.throws(() => U.loadUsers(bad));
  fs.writeFileSync(bad, '{"version":1}');           // ไม่มีคีย์ users
  assert.throws(() => U.loadUsers(bad), /ผิดรูปแบบ/);
});
ok('activeCount ไม่นับบัญชีที่ถูกปิด', () => {
  const s = { version: 1, users: { a: { disabled: false }, b: { disabled: true } } };
  assert.strictEqual(U.activeCount(s), 1);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nusers: ${pass}/${pass} ผ่าน\n`);

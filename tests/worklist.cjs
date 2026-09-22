'use strict';
// ─── เทสกติกา "งานค้าง" (lib/worklist.js) ──────────────────────────────────────
// รัน: node tests/worklist.cjs     (บริสุทธิ์ — ไม่ต้องมี server/เบราว์เซอร์ ไม่แตะไฟล์ใด)
//
// ทำไมต้องมี: หน้าแรกที่บอกว่า "วันนี้ต้องทำอะไร" จะมีค่าก็ต่อเมื่อ **ไม่มีของที่ไม่ต้องทำปนเข้ามา**
// ถ้าถังหนึ่งบวมเป็นหลายร้อยใบ คนจะเลิกดูทั้งหน้า → เทสนี้ล็อกทั้ง "ต้องเข้า" และ "ห้ามเข้า"
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildWorklist, DAYS } = require('../lib/worklist.js');

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ✓ ' + label); };
const TODAY = '2026-09-22';
const sea = (o) => Object.assign({ po_so: 'PO-1', _board: 'import', stage: 'etd' }, o);
const bucket = (w, key) => (w.now.concat(w.backlog)).find(b => b.key === key);
const inB = (w, key, po) => { const b = bucket(w, key); return !!(b && b.items.some(i => i.po === po)); };
const anywhere = (w, po) => (w.now.concat(w.backlog)).some(b => b.items.some(i => i.po === po));

console.log('\n── 1. ของที่ "ไม่ใช่งาน" ต้องไม่โผล่ขึ้นมา ──');

ok('PO ที่ยังไม่ได้ส่งของ (ไม่มี B/L ไม่มี ETD) ไม่เข้าถังไหนเลย', () => {
  // วัดจริง: 829 จาก 1,080 การ์ดเป็นแบบนี้ — ถ้าปล่อยเข้ามาจะกลบงานจริงทั้งหมด
  const w = buildWorklist([sea({ po_so: 'PO-NEW', stage: 'po' })], TODAY);
  assert.strictEqual(anywhere(w, 'PO-NEW'), false);
  assert.strictEqual(w.counts.now, 0);
});
ok('การ์ดที่ปิดงานแล้ว (received) ไม่เข้าถังไหนเลย', () => {
  const w = buildWorklist([sea({ po_so: 'PO-DONE', stage: 'received', eta: '2026-09-01', bl_awb: 'B1' })], TODAY);
  assert.strictEqual(anywhere(w, 'PO-DONE'), false);
});
ok('การ์ดบอร์ด export ไม่เข้าถังไหนเลย (กติกานี้ของขาเข้า)', () => {
  const w = buildWorklist([sea({ po_so: 'EX-1', _board: 'export', eta: '2026-09-01' })], TODAY);
  assert.strictEqual(anywhere(w, 'EX-1'), false);
});
ok('เรือถึงในอนาคตไกล ยังไม่ต้องทำอะไร', () => {
  const w = buildWorklist([sea({ po_so: 'PO-FUTURE', eta: '2026-12-31' })], TODAY);
  assert.strictEqual(anywhere(w, 'PO-FUTURE'), false);
});

console.log('\n── 2. งานที่ต้องขึ้นหน้าแรก ──');

ok('เรือถึงแล้วยังไม่ปิดงาน → ถัง arrived', () =>
  assert.ok(inB(buildWorklist([sea({ po_so: 'A1', eta: '2026-09-10' })], TODAY), 'arrived', 'A1')));
ok(`เรือถึงในอีก ≤${DAYS.arrivingSoon} วัน → ถัง soon`, () =>
  assert.ok(inB(buildWorklist([sea({ po_so: 'A2', eta: '2026-09-24' })], TODAY), 'soon', 'A2')));
ok('ออกเรือแล้วยังไม่มีวันถึง → ถัง noeta', () =>
  assert.ok(inB(buildWorklist([sea({ po_so: 'A3', etd: '2026-09-12', vessel: 'V ONE' })], TODAY), 'noeta', 'A3')));
ok('ค้น ETS แล้วล้ม → ถัง etsbad', () => {
  const w = buildWorklist([sea({ po_so: 'A4', etsStatus: 'error', etsReason: 'ไม่พบคอลัมน์ Actual' })], TODAY);
  assert.ok(inB(w, 'etsbad', 'A4'));
  assert.ok(/ไม่พบคอลัมน์/.test(bucket(w, 'etsbad').items[0].why), 'ควรบอกเหตุผลที่ ETS ให้มา');
});
ok('มี B/L แต่ข้อมูลหลักขาด → ถัง incomplete พร้อมบอกว่าขาดอะไร', () => {
  const w = buildWorklist([sea({ po_so: 'A5', bl_awb: 'BL1', origin: 'NINGBO', dest: 'BKK' })], TODAY);
  assert.ok(inB(w, 'incomplete', 'A5'));
  const why = bucket(w, 'incomplete').items[0].why;
  assert.ok(/ชื่อเรือ/.test(why) && /ETD/.test(why), 'ต้องบอกชื่อฟิลด์ที่ขาด ได้: ' + why);
});

console.log('\n── 3. ⭐ แยก "งานตอนนี้" ออกจาก "ค้างสะสม" ──');

ok(`ถึงแล้ว ≤${DAYS.arrivedFresh} วัน = งานตอนนี้ · เกินกว่านั้น = ค้างสะสม`, () => {
  const fresh = buildWorklist([sea({ po_so: 'F', eta: '2026-08-25' })], TODAY);   // 28 วัน
  const old   = buildWorklist([sea({ po_so: 'O', eta: '2026-06-01' })], TODAY);   // 113 วัน
  assert.ok(inB(fresh, 'arrived', 'F') && fresh.counts.backlog === 0);
  assert.ok(inB(old, 'arrived_old', 'O') && old.counts.now === 0);
});
ok(`ออกเรือ ≤${DAYS.etdFresh} วัน = งานตอนนี้ · เกินกว่านั้น = ค้างสะสม`, () => {
  const fresh = buildWorklist([sea({ po_so: 'F2', etd: '2026-08-25', vessel: 'V' })], TODAY);
  const old   = buildWorklist([sea({ po_so: 'O2', etd: '2026-01-01', vessel: 'V' })], TODAY);
  assert.ok(inB(fresh, 'noeta', 'F2'));
  assert.ok(inB(old, 'noeta_old', 'O2') && old.counts.now === 0);
});

console.log('\n── 4. วันเรือถึงจริงจาก ETS ต้องชนะกำหนดการเสมอ ──');

ok('มีทั้ง eta และ etsActualArrivalDate → ใช้ของจริง และบอกว่าเป็นของจริง', () => {
  const w = buildWorklist([sea({ po_so: 'B1', eta: '2026-09-01', etsActualArrivalDate: '2026-09-15' })], TODAY);
  const it = bucket(w, 'arrived').items[0];
  assert.strictEqual(it.when, '2026-09-15');
  assert.ok(/เรือถึงจริง/.test(it.why), 'ต้องบอกว่าเป็นวันถึงจริง ได้: ' + it.why);
});
ok('มีแต่ eta → บอกว่าเป็น "กำหนดถึง" ไม่ใช่ของจริง', () =>
  assert.ok(/กำหนดถึง/.test(bucket(buildWorklist([sea({ po_so: 'B2', eta: '2026-09-10' })], TODAY), 'arrived').items[0].why)));

console.log('\n── 5. วันที่ใช้ไม่ได้ต้องไม่ทำให้พัง และต้องไม่เดา ──');

ok('วันที่ผิดรูปแบบ / ไม่มีอยู่จริง → ข้ามไป ไม่ crash', () => {
  for (const bad of ['2026-13-45', '2026-02-30', '22/09/2026', 'ไม่ทราบ', '', null]) {
    const w = buildWorklist([sea({ po_so: 'C', eta: bad, etd: bad })], TODAY);
    assert.strictEqual(anywhere(w, 'C'), false, 'ค่า ' + bad + ' ไม่ควรเข้าถัง');
  }
});
ok('ข้อมูลว่างเปล่า / ไม่ใช่ array → คืนโครงว่าง ไม่ throw', () => {
  for (const v of [[], null, undefined, 'x', {}]) {
    const w = buildWorklist(v, TODAY);
    assert.strictEqual(w.counts.now + w.counts.backlog, 0);
  }
});
ok('ทุกรายการต้องบอก "ทำอะไรต่อ" ไม่ใช่แค่บอกว่ามีปัญหา', () => {
  const w = buildWorklist([sea({ po_so: 'D1', eta: '2026-09-10' }), sea({ po_so: 'D2', etd: '2026-09-10', vessel: 'V' })], TODAY);
  w.now.forEach(b => b.items.forEach(i => {
    assert.ok(i.why && i.why.length > 3, b.key + ': ขาดคำอธิบายว่าทำไมถึงขึ้นมา');
    assert.ok(i.next && i.next.length > 3, b.key + ': ขาดคำแนะนำว่าต้องทำอะไรต่อ');
  }));
});

console.log('\n── 6. ข้อมูลจริง: ถังต้องไม่บวมจนใช้ไม่ได้ ──');

const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tracking_data.json'), 'utf8'));
ok('รันกับข้อมูลจริงได้ และงานตอนนี้ต้องอยู่ในขนาดที่คนดูไหว', () => {
  const w = buildWorklist(real, new Date().toISOString().slice(0, 10));
  console.log(`      ${w.counts.total} การ์ด → ต้องทำตอนนี้ ${w.counts.now} · ค้างสะสม ${w.counts.backlog}`);
  w.now.forEach(b => console.log(`        ${String(b.items.length).padStart(4)}  ${b.title}`));
  assert.ok(w.counts.now > 0, 'ไม่มีงานเลย = กติกาแคบเกินไป');
  assert.ok(w.counts.now < 200, 'งานตอนนี้ ' + w.counts.now + ' ใบ = บวมเกินกว่าคนจะดูไหว');
  w.now.forEach(b => assert.ok(b.items.length <= 100, b.title + ' มี ' + b.items.length + ' ใบ — ถังเดียวบวมเกินไป'));
});

console.log(`\nworklist: ${pass}/${pass} ผ่าน\n`);

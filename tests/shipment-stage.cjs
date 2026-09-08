'use strict';
// ─── เทสกติกาสถานะชิปเม้นนำเข้า (lib/shipment-rules.cjs) ──────────────────────────────
// รัน: node tests/shipment-stage.cjs        (ไม่ต้องมี server ไม่ต้องมีเบราว์เซอร์ ไม่แตะไฟล์ใดๆ)
//
// ที่มา: รอบรีวิว 2026-09-08 — ตัวรีวิวภายนอกรายงานว่า "สถานะอัตโนมัติอาจทับของเดิม"
// เขียนเทสให้แดงก่อนตามกฎใน REVIEW.md แล้วแดงจริง **24 ใบจากข้อมูลจริง 1,073 record**
// เทสข้อ 3 คือตัวที่เคยแดง — ถ้ามันเขียวโดยที่ไม่มีใครแก้อะไร ให้สงสัยว่าเทสเสียก่อน
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/shipment-rules.cjs');
const { STAGES, addDays, hasCoreShipmentData, autoStage, normalizeEtsResult,
        canonStage, stageRank, nextStage, coreFieldsFor } = R;

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ✓ ' + label); };

const sea = { mode:'sea', blNumber:'HBL123', vessel:'VESSEL ONE', voyage:'123S',
              portOfLoading:'NINGBO, CHINA', portOfDischarge:'LAEM CHABANG, THAILAND', etd:'2026-09-01' };

console.log('\n── 1. ฐาน: ความครบของข้อมูล + การเลื่อนตามวัน (ยกมาจากเทสรอบแรก) ──');

ok('ข้อมูลทางเรือครบ = ครบ', () => assert.strictEqual(hasCoreShipmentData(sea), true));
ok("ครบแต่ยังไม่มีวันเรือเข้า = 'etd'", () =>
  assert.strictEqual(autoStage(sea, new Date('2026-09-01T00:00:00Z')), 'etd'));
ok("วันเรือเข้าวันนี้ = 'arrived'", () =>
  assert.strictEqual(autoStage({ ...sea, etsActualArrivalDate:'2026-09-10' }, new Date('2026-09-10T00:00:00Z')), 'arrived'));
ok("เรือเข้าแล้ว 1 วัน = 'customs'", () =>
  assert.strictEqual(autoStage({ ...sea, etsActualArrivalDate:'2026-09-10' }, new Date('2026-09-11T00:00:00Z')), 'customs'));
ok("ขาดชื่อเรือ = 'po'", () =>
  assert.strictEqual(autoStage({ ...sea, vessel:'' }, new Date('2026-09-20T00:00:00Z')), 'po'));
ok('addDays ข้ามเดือนถูก', () => assert.strictEqual(addDays('2026-09-30', 1), '2026-10-01'));
ok('normalizeEtsResult เคส found', () =>
  assert.deepStrictEqual(normalizeEtsResult({ status:'found', eta:'2026-09-12', matchedVoyage:'123S' }, '2026-09-08T00:00:00Z'),
    { etsStatus:'found', etsCheckedAt:'2026-09-08T00:00:00Z', etsActualArrivalDate:'2026-09-12', eta:'2026-09-12', etsMatchedVoyage:'123S' }));

console.log('\n── 2. autoStage ไปถึงสถานะปลายทางไม่ได้ (เหตุที่ต้องมีเกราะกันถอยหลัง) ──');

ok("autoStage คืน 'received' ไม่ได้เลยทุกอินพุต", () => {
  const seen = new Set();
  for (const eta of [null, '', 'ไม่ใช่วันที่', '2026-01-10', '2026-09-01', '2030-01-01'])
    for (const d of ['2026-01-05', '2026-09-08', '2027-01-01'])
      for (const m of ['sea', 'air', 'courier'])
        seen.add(autoStage({ ...sea, mode:m, etsActualArrivalDate:eta }, new Date(d + 'T00:00:00Z')));
  assert.ok(!seen.has('received'), 'คืน received ได้: ' + [...seen].join(','));
  assert.ok(seen.size > 1, 'ควรคืนได้หลายค่า ไม่ใช่ค่าเดียว');
});

console.log('\n── 3. ⭐ เกราะหลัก: เลื่อนไปข้างหน้าได้เท่านั้น (เทสที่เคยแดง) ──');

ok('ถอยหลังถูกปฏิเสธ (คืน null = ไม่แตะ)', () => {
  assert.strictEqual(nextStage('received', 'etd'), null);
  assert.strictEqual(nextStage('received', 'po'), null);
  assert.strictEqual(nextStage('customs', 'etd'), null);
  assert.strictEqual(nextStage('customs', 'po'), null);
  assert.strictEqual(nextStage('arrived', 'etd'), null);
});
ok('เท่าเดิมก็ไม่แตะ', () => {
  assert.strictEqual(nextStage('customs', 'customs'), null);
  assert.strictEqual(nextStage('po', 'po'), null);
});
ok('ไปข้างหน้าเลื่อนได้', () => {
  assert.strictEqual(nextStage('po', 'etd'), 'etd');
  assert.strictEqual(nextStage('etd', 'arrived'), 'arrived');
  assert.strictEqual(nextStage('arrived', 'customs'), 'customs');
  assert.strictEqual(nextStage('po', 'customs'), 'customs');
});
ok('การ์ดใหม่/ไม่มีสถานะเดิม = ตั้งได้', () => {
  assert.strictEqual(nextStage(undefined, 'etd'), 'etd');
  assert.strictEqual(nextStage('', 'customs'), 'customs');
  assert.strictEqual(nextStage(null, 'po'), 'po');
});
ok('ชื่อสถานะรุ่นเก่าถูกแปลงก่อนเทียบ (ไม่หลุดเกราะ)', () => {
  assert.strictEqual(canonStage('booking'), 'etd');
  assert.strictEqual(canonStage('transit'), 'etd');
  assert.strictEqual(stageRank('transit'), stageRank('etd'));
  assert.strictEqual(nextStage('transit', 'etd'), null);   // เท่าเดิมหลังแปลง = ไม่แตะ
  assert.strictEqual(nextStage('booking', 'customs'), 'customs');
});
ok('สถานะที่ไม่รู้จัก (เช่นบอร์ด export) ไม่ถูกแตะ', () => {
  assert.strictEqual(nextStage('shipped', 'customs'), null);
  assert.strictEqual(nextStage('packing', 'etd'), null);
  assert.strictEqual(nextStage('customs', 'ค่ามั่ว'), null);
});

console.log('\n── 4. โหมดขนส่ง: ทางอากาศ/พัสดุไม่มีเรือให้กรอก ──');

const air = { mode:'air', blNumber:'AWB-160-12345675', portOfLoading:'PVG, CHINA',
              portOfDischarge:'BKK, THAILAND', etd:'2026-09-01' };
ok('ทางอากาศไม่บังคับ vessel/voyage', () => {
  assert.ok(!coreFieldsFor('air').includes('vessel'));
  assert.ok(!coreFieldsFor('courier').includes('voyage'));
  assert.ok(coreFieldsFor('sea').includes('vessel'));
  assert.strictEqual(hasCoreShipmentData(air), true);
});
ok("ทางอากาศที่เอกสารครบได้ 'etd' ไม่ใช่ 'po'", () =>
  assert.strictEqual(autoStage(air, new Date('2026-09-08T00:00:00Z')), 'etd'));
ok("ทางอากาศที่ขาดปลายทางยังได้ 'po'", () =>
  assert.strictEqual(autoStage({ ...air, portOfDischarge:'' }, new Date('2026-09-08T00:00:00Z')), 'po'));
ok("ทางเรือที่ไม่มีชื่อเรือยังได้ 'po' (ไม่ผ่อนปรนให้ผิดโหมด)", () =>
  assert.strictEqual(autoStage({ ...sea, vessel:'', voyage:'' }, new Date('2026-09-08T00:00:00Z')), 'po'));

console.log('\n── 5. normalizeEtsResult: ไม่เดา ETA เมื่อ ETS ไม่ยืนยัน ──');

ok('not_found / error ไม่ให้ ETA', () => {
  for (const st of ['not_found', 'error']) {
    const o = normalizeEtsResult({ status: st, eta:'2026-09-12' }, 'T');
    assert.strictEqual(o.etsStatus, st);
    assert.strictEqual(o.eta, undefined, st + ' ไม่ควรให้ eta');
    assert.strictEqual(o.etsActualArrivalDate, undefined);
  }
});
ok("status ที่ไม่รู้จัก / undefined ตกเป็น 'error'", () => {
  assert.strictEqual(normalizeEtsResult({ status:'weird' }, 'T').etsStatus, 'error');
  assert.strictEqual(normalizeEtsResult(undefined, 'T').etsStatus, 'error');
  assert.strictEqual(normalizeEtsResult(null, 'T').etsStatus, 'error');
});
ok('found แต่วันที่ผิดรูปแบบ = ไม่รับ', () => {
  for (const bad of ['12/09/2026', '2026-13-45', 'ไม่ทราบ', '', null])
    assert.strictEqual(normalizeEtsResult({ status:'found', eta:bad }, 'T').etsActualArrivalDate, undefined,
      'รับวันที่ผิดรูปแบบ: ' + bad);
});

console.log('\n── 6. ข้อมูลจริง: ต้องไม่มีการ์ดไหนถูกถอยสถานะ ──');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tracking_data.json'), 'utf8'));
const recs = Array.isArray(raw) ? raw : (raw.records || raw.data || []);
ok(`สแกน ${recs.length} record — ถอยหลัง 0 ใบ`, () => {
  const back = [];
  for (const r of recs) {
    if ((r._board || 'import') === 'export') continue;
    if (r._stageManual) continue;                       // มีเกราะของตัวเองอยู่แล้ว
    const proposed = autoStage({
      mode: r.mode,
      blNumber: r.bl_awb || r.bl,
      vessel: r.vessel,
      voyage: r.voyage || (String(r.vessel || '').match(/\/\s*([^/]+)$/) || [])[1],
      portOfLoading: r.origin, portOfDischarge: r.dest,
      etd: r.etd, etsActualArrivalDate: r.etsActualArrivalDate,
    });
    const advanced = nextStage(r.stage, proposed);
    if (advanced && stageRank(advanced) < stageRank(r.stage)) back.push(`${r.po_so} ${r.stage}→${advanced}`);
  }
  assert.deepStrictEqual(back, [], 'ถอยหลัง ' + back.length + ' ใบ: ' + back.slice(0, 8).join(' · '));
});

console.log('\n── 7. โค้ดฝั่ง server/scanner ยังผูกกับกติกานี้อยู่จริง ──');

const srv = fs.readFileSync(path.join(__dirname, '..', 'api-server.js'), 'utf8');
ok('api-server ใช้ nextStage เป็นเกราะ ไม่ตั้ง r.stage ตรงๆ', () => {
  assert.ok(/nextStage\(before && before\.stage, proposed\)/.test(srv), 'ไม่พบการเรียก nextStage');
  assert.ok(!/r\.stage = autoStage\(/.test(srv), 'ยังตั้ง r.stage = autoStage(...) ตรงๆ = เกราะถูกถอด');
});
ok('การเลื่อนสถานะถูกบันทึกลง audit/_src (แก้ changed ด้วย)', () =>
  assert.ok(/changed\.push\('stage'\)/.test(srv), "ไม่พบการเพิ่ม 'stage' เข้า changed → เปลี่ยนสถานะโดยไม่มีที่มา"));

const scan = fs.readFileSync(path.join(__dirname, '..', 'scan-shipment-docs.mjs'), 'utf8');
ok('documentReceivedAt ไม่ทำให้ fields ไม่ว่างตั้งแต่ต้น', () => {
  assert.ok(/if \(Object\.keys\(fields\)\.length\) fields\.documentReceivedAt/.test(scan),
    'documentReceivedAt ถูกตั้งโดยไม่เช็คว่ามีข้อมูลอื่นก่อน → สาขา "ไม่พบข้อมูลใหม่" ตาย');
  assert.ok(!/const fields = \{\};\s*\n\s*fields\.documentReceivedAt/.test(scan),
    'ยังตั้ง documentReceivedAt ทันทีหลังสร้าง fields ว่าง');
});

console.log(`\nshipment-stage: ${pass}/${pass} ผ่าน\n`);

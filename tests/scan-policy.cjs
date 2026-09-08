'use strict';
// ─── เทสนโยบายรอบสแกน (lib/scan-policy.cjs) ────────────────────────────────────────
// รัน: node tests/scan-policy.cjs      (บริสุทธิ์ — ไม่ต้องมี server / เบราว์เซอร์ / AI ไม่แตะไฟล์ใดๆ)
//
// ที่มา: รอบรีวิว 2026-09-08 finding 1 + 4 · ดู REVIEW.md
// หมวด 5-6 เป็นเทสที่ผูกกับซอร์สจริง — เคยแดงก่อนแก้ ถ้ามันเขียวโดยไม่มีใครแก้อะไร ให้สงสัยเทสก่อน
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/scan-policy.cjs');
const { classifyUpsert, folderRetryDecision, etsSessionAction, MAX_FOLDER_ATTEMPTS, MAX_ETS_REOPENS } = P;

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ✓ ' + label); };

console.log('\n── 1. อ่านผล upsert: 200 ไม่ได้แปลว่าเขียนสำเร็จ ──');

ok('เขียนสำเร็จจริง = ok', () =>
  assert.deepStrictEqual(classifyUpsert({ ok: true, applied: 1, total: 1073, rejected: [], skipped: [] }, 'KOB1'), { kind: 'ok' }));

ok('saveTracking ล้ม (ok:false) = fail ทั้งที่ HTTP 200', () => {
  const r = classifyUpsert({ ok: false, applied: 1, rejected: [], skipped: [] }, 'KOB1');
  assert.strictEqual(r.kind, 'fail');
  assert.ok(/saveTracking/.test(r.reason), r.reason);
});

ok('ค่าที่ถูกปฏิเสธของ PO นี้ = fail', () => {
  const r = classifyUpsert({ ok: true, applied: 0, rejected: [{ po_so: 'KOB1', field: 'freight', value: -5 }] }, 'KOB1');
  assert.strictEqual(r.kind, 'fail');
  assert.ok(/freight=-5/.test(r.reason), r.reason);
});

ok('ค่าที่ถูกปฏิเสธของ PO อื่น ไม่กระทบ PO เรา', () =>
  assert.deepStrictEqual(classifyUpsert({ ok: true, applied: 1, rejected: [{ po_so: 'OTHER', field: 'vat', value: -1 }] }, 'KOB1'), { kind: 'ok' }));

ok('เทียบ PO แบบไม่สนตัวพิมพ์เล็กใหญ่', () => {
  assert.strictEqual(classifyUpsert({ ok: true, applied: 0, skipped: [{ po_so: 'kob1', reason: 'คนละชิปเม้น' }] }, 'KOB1').kind, 'skip');
  assert.strictEqual(classifyUpsert({ ok: true, applied: 0, rejected: [{ po_so: 'KOB1', field: 'x', value: 1 }] }, 'kob1').kind, 'fail');
});

ok('applied=0 โดยไม่บอกเหตุผล = fail (ไม่ยอมให้เงียบ)', () => {
  const r = classifyUpsert({ ok: true, applied: 0, rejected: [], skipped: [] }, 'KOB1');
  assert.strictEqual(r.kind, 'fail');
  assert.ok(/applied=0/.test(r.reason), r.reason);
});

ok('response ที่ไม่ใช่ object = fail', () => {
  for (const bad of [null, undefined, 'ok', 42, []])
    assert.strictEqual(classifyUpsert(bad, 'KOB1').kind, 'fail', 'ยอมรับ: ' + JSON.stringify(bad));
});

console.log('\n── 2. ⭐ "ข้ามอย่างถูกต้อง" ต้องไม่ถูกนับเป็นล้มเหลว (ไม่งั้นเสียเงิน AI ทุก 20 นาที) ──');

ok('server ข้ามเพราะเป็นคนละชิปเม้น = skip ไม่ใช่ fail', () => {
  const r = classifyUpsert({ ok: true, applied: 0, rejected: [], skipped: [{ po_so: 'KOB1', reason: 'คนละชิปเม้น (เรือไม่ตรง)' }] }, 'KOB1');
  assert.strictEqual(r.kind, 'skip');
  assert.ok(/คนละชิปเม้น/.test(r.reason), r.reason);
});
ok('skip ที่ไม่บอกเหตุผลก็ยังเป็น skip', () =>
  assert.strictEqual(classifyUpsert({ ok: true, applied: 0, skipped: [{ po_so: 'KOB1' }] }, 'KOB1').kind, 'skip'));
ok('skipped มาก่อน applied — ข้าม 1 ใบ เขียนอีกใบในคำขอเดียว', () =>
  assert.strictEqual(classifyUpsert({ ok: true, applied: 1, skipped: [{ po_so: 'KOB1', reason: 'คนละชิปเม้น' }] }, 'KOB1').kind, 'skip'));

console.log('\n── 3. เพดานการลองใหม่ต่อโฟลเดอร์ — พังต้องลองใหม่ แต่ต้องไม่วนไม่รู้จบ ──');

ok('พังครั้งแรก = ลองใหม่รอบหน้า (ไม่ mark seen)', () => {
  const d = folderRetryDecision(0);
  assert.deepStrictEqual(d, { retry: true, attempts: 1, giveUp: false });
});
ok(`พังครบ ${MAX_FOLDER_ATTEMPTS} ครั้ง = ยอมแพ้ + mark seen (หยุดเผาเงิน)`, () => {
  const d = folderRetryDecision(MAX_FOLDER_ATTEMPTS - 1);
  assert.deepStrictEqual(d, { retry: false, attempts: MAX_FOLDER_ATTEMPTS, giveUp: true });
});
ok('เลยเพดานไปแล้วก็ยังยอมแพ้ (ไม่กลับไป retry)', () =>
  assert.strictEqual(folderRetryDecision(99).retry, false));
ok('ค่านับที่เพี้ยน (null/ติดลบ/ไม่ใช่เลข) ถือเป็น 0', () => {
  for (const v of [null, undefined, -5, 'x', NaN])
    assert.deepStrictEqual(folderRetryDecision(v), { retry: true, attempts: 1, giveUp: false }, 'ค่า: ' + v);
});

console.log('\n── 4. ⭐ ETS: ผลที่ต้องปิด session ทิ้ง (finding 4 — ชี้ผิดจุด แต่บั๊กจริงหนักกว่า) ──');

ok("status 'found' = ไม่ปิด", () =>
  assert.deepStrictEqual(etsSessionAction({ status: 'found', eta: '2026-09-10' }, null, 0), { close: false, giveUp: false, reopens: 0 }));
ok("status 'not_found' = ผลปกติ ห้ามปิด (เรือยังไม่ถึง / ไม่พบเที่ยวที่ตรง)", () => {
  assert.strictEqual(etsSessionAction({ status: 'not_found', reason: 'ยังไม่มี Actual Arrival Date' }, null, 0).close, false);
  assert.strictEqual(etsSessionAction({ status: 'not_found', reason: 'ไม่พบเที่ยวที่ตรง' }, null, 2).close, false);
});
ok("status 'error' = ปิดทิ้ง แม้ไม่มี exception โผล่มาเลย", () => {
  const a = etsSessionAction({ status: 'error', error: 'ไม่พบคอลัมน์ Actual ในตาราง' }, null, 0);
  assert.strictEqual(a.close, true, 'นี่คือเส้นทางที่เคยหลุด — searchVesselActualDate ไม่ throw');
  assert.strictEqual(a.giveUp, false);
});
ok('exception (เช่น timeout 90 วิ) = ปิดทิ้ง', () =>
  assert.strictEqual(etsSessionAction(null, new Error('ETS ไม่ตอบใน 90 วินาที'), 0).close, true));
ok(`พังครบ ${MAX_ETS_REOPENS} ครั้ง = เลิกค้น ETS ทั้งรอบ`, () => {
  const a = etsSessionAction({ status: 'error' }, null, MAX_ETS_REOPENS - 1);
  assert.strictEqual(a.close, true);
  assert.strictEqual(a.giveUp, true);
});
ok('นับรอบเปิดใหม่สะสมถูกต้อง', () => {
  let n = 0;
  for (let i = 0; i < 5; i++) n = etsSessionAction({ status: 'error' }, null, n).reopens;
  assert.strictEqual(n, 5);
});

console.log('\n── 5. ซอร์สจริง: scanner ต้องไม่ mark seen ทั้งที่ upsert พัง ──');

const scan = fs.readFileSync(path.join(__dirname, '..', 'scan-shipment-docs.mjs'), 'utf8');

ok('scanner ตรวจ response ก่อน แล้วจึงตัดสินว่าสำเร็จ/ข้าม/พัง', () => {
  // ต้องเก็บ response ไว้ (เดิมทิ้งทั้งก้อน) แล้วส่งให้ตัวจัดประเภท
  assert.ok(/const res = await upsertTracking\(/.test(scan), 'ยังไม่เก็บ response ของ upsert ไว้เลย');
  assert.ok(/const verdict = classifyUpsert\(res, po\);/.test(scan), 'ไม่พบการเรียก classifyUpsert กับ response');
  // ต้องแยกครบทั้งสามทาง — ถ้าขาด fail หรือ skip แปลว่ายังเหมารวมอยู่
  assert.ok(/verdict\.kind === 'fail'/.test(scan), 'ไม่มีสาขา fail');
  assert.ok(/verdict\.kind === 'skip'/.test(scan), 'ไม่มีสาขา skip → "ข้ามอย่างถูกต้อง" จะถูกนับเป็นพัง');
  // ความล้มเหลวต้องถูกนับ ไม่ใช่แค่ log ทิ้ง
  assert.ok(/folderWriteFails\+\+/.test(scan), 'ความล้มเหลวไม่ถูกนับ → saveSeen ยังตีตราโฟลเดอร์ที่พัง');
});
ok('saveSeen ผูกกับผลของโฟลเดอร์ ไม่ใช่รันทุกกรณี', () =>
  assert.ok(/folderRetryDecision\(/.test(scan), 'ไม่พบ folderRetryDecision — saveSeen ยังไม่ผูกกับความล้มเหลว'));
ok('ETS ตรวจ status ที่คืนมา ไม่ใช่รอ exception เท่านั้น', () => {
  assert.ok(/etsSessionAction\(/.test(scan), 'ไม่พบ etsSessionAction');
  assert.ok(!/if \(\/90 วินาที\/\.test\(e\.message\)\)/.test(scan),
    'ยังปิด session เฉพาะ timeout 90 วิ — เส้นทาง status:error ยังหลุด');
});

console.log('\n── 6. ซอร์สจริง: server ต้องรายงาน record ที่ข้ามไป ──');

const srv = fs.readFileSync(path.join(__dirname, '..', 'api-server.js'), 'utf8');
ok('/api/tracking/upsert ตอบ `skipped` กลับมาด้วย', () => {
  assert.ok(/skipped/.test(srv), 'ไม่พบ skipped ใน api-server.js');
  assert.ok(/jsonOk\(res, \{[^}]*\brejected\b[^}]*\bskipped\b[^}]*\}\)/.test(srv),
    'response ของ upsert ยังไม่มี skipped → scanner แยก "ข้าม" จาก "พัง" ไม่ได้');
});
ok('เส้นทางคนละชิปเม้นบันทึกเหตุผลลง skipped ก่อน return', () =>
  assert.ok(/skippedRecords\.push\(\{[^}]*reason/.test(srv), 'idMismatch ยัง return เงียบ ไม่เข้า skipped'));

// ⚠ บั๊กที่เทสจริงบน server จับได้ (ไม่ใช่จากการอ่านโค้ด): ตั้งชื่อตัวนอกว่า `skipped` แล้วชนกับ
// `const skipped = [], forced = []` ในบล็อก _fillEmptyOnly (คนละความหมาย — อันนั้นคือ "ฟิลด์"
// ที่ไม่ถูกทับ) → TDZ: "Cannot access 'skipped' before initialization" ทุกครั้งที่เข้าเส้น idMismatch
ok('ชื่อตัวแปรไม่ชนกันจนเกิด TDZ', () => {
  const outer = (srv.match(/^\s*const skippedRecords = \[\];$/m) || []).length;
  assert.strictEqual(outer, 1, 'ต้องมีตัวเก็บ record ที่ข้าม ชื่อไม่ซ้ำกับตัวในบล็อก _fillEmptyOnly');
});

console.log(`\nscan-policy: ${pass}/${pass} ผ่าน\n`);

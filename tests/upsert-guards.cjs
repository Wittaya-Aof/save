'use strict';
// ─── เกราะตรวจค่าฝั่ง server ตอน upsert — ยิง endpoint จริง ──────────────────────
// รัน: node tests/upsert-guards.cjs        (ต้องมี server ที่ port 3000)
//
// ที่มา (วัดจริง 2026-09-23): เทียบค่าที่ AI สกัดได้กับค่าที่คนกรอกเอง 1,181 คู่ แล้วพบว่า
// **38 การ์ดมีค่าที่ไม่ใช่เลขตู้ปนอยู่ในช่อง "เลขตู้"** เพราะเอกสารวางเลขตู้ เลขซีล และขนาดตู้
// ติดกัน แล้วโมเดลกวาดมาทั้งชุด:
//     CULU6348160/U963528/40HC        ← เลขตู้ + เลขซีล + ขนาด
//     TWSABKK2606004                  ← เลข booking ล้วน (เอาไปติดตามตู้ไม่ได้เลย)
// ตัวสกัดด้วย regex มี ISO 6346 คุมอยู่แล้ว แต่ **ค่าที่มาจากฟิลด์ของโมเดลตรง ๆ ไม่เคยถูกตรวจ**
//
// กฎที่เทสนี้ล็อกไว้ 3 ข้อ:
//   1. ค่าที่เครื่องสกัดมา → เก็บเฉพาะส่วนที่ผ่าน ISO 6346
//   2. ไม่เหลือเลขตู้ที่ถูกต้องเลย → **ไม่เขียนช่องนั้น** (ว่างตามความจริง ดีกว่าใส่เลข booking)
//   3. ⭐ ค่าที่ **คนกรอกเอง ห้ามแตะ** — คนอาจจงใจจดเลขอื่นไว้ (กฎ "ห้ามทับค่าที่ผู้ใช้กรอกเอง")
//   + ทุกครั้งที่ตัดต้องรายงานกลับใน `cleaned[]` (กฎ "ห้ามตัดข้อมูลโดยไม่บอก")
//
// ⚠ เทสนี้เขียนข้อมูลจริงลง tracking_data.json แล้ว **คืนค่าเดิมให้ตอนจบทุกกรณี**
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const TRACK = path.join(ROOT, 'tracking_data.json');

let fail = 0;
const ok = (label) => console.log('  ✓ ' + label);
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: 3000, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch (e) { reject(new Error(s.slice(0, 200))); } });
    });
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
    req.on('error', reject); req.write(data); req.end();
  });
}
const find = (po) => JSON.parse(fs.readFileSync(TRACK, 'utf8')).find(r => r.po_so === po);
const SCAN = 'scan:ทดสอบเกราะเลขตู้';

(async () => {
  const backup = fs.readFileSync(TRACK, 'utf8');
  const all = JSON.parse(backup);
  // ต้องเป็นการ์ดที่ช่องเลขตู้ยังว่าง จะได้คืนสภาพเป็น "ไม่มีเลขตู้" ได้สะอาด
  const target = all.find(r => (r._board || 'import') !== 'export' && r.po_so && !r.container);
  if (!target) { console.log('ไม่พบการ์ดที่ช่องเลขตู้ว่าง — ข้ามเทสนี้'); process.exit(0); }
  const PO = target.po_so;
  console.log(`เกราะ upsert — ใช้การ์ด ${PO}\n`);

  const sendScan = (fields) => post('/api/tracking/upsert', Object.assign({ po_so: PO, _origin: SCAN }, fields));
  const clearContainer = () => post('/api/tracking/upsert', { po_so: PO, container: '', _origin: 'manual:test' });

  try {
    console.log('── 1. ค่าที่เครื่องสกัดมา: เก็บเฉพาะเลขตู้จริง ──');
    let r = await sendScan({ container: 'CULU6348160/U963528/40HC' });
    let rec = find(PO);
    if (rec.container === 'CULU6348160') ok('ตัดเลขซีล + ขนาดตู้ออก เหลือ "CULU6348160"');
    else bad(`ควรได้ "CULU6348160" ได้ ${JSON.stringify(rec.container)}`);
    const c = (r.body.cleaned || [])[0];
    if (c && c.dropped.includes('U963528') && c.dropped.includes('40HC')) ok('รายงานกลับว่าตัดอะไรไปบ้าง (cleaned[])');
    else bad(`ควรรายงาน dropped ครบ ได้ ${JSON.stringify(r.body.cleaned)}`);
    await clearContainer();

    console.log('\n── 2. ไม่เหลือเลขตู้ที่ถูกต้องเลย → ไม่เขียนช่องนั้น ──');
    r = await sendScan({ container: 'TWSABKK2606004' });
    rec = find(PO);
    if (!rec.container) ok('เลข booking ไม่ถูกเขียนลงช่องเลขตู้');
    else bad(`ช่องเลขตู้ควรว่าง ได้ ${JSON.stringify(rec.container)}`);
    if ((r.body.cleaned || []).some(x => x.dropped.includes('TWSABKK2606004'))) ok('ยังรายงานว่าเจออะไรแล้วตัดทิ้ง');
    else bad('ตัดทิ้งเงียบ — ผิดกฎ "ห้ามตัดข้อมูลโดยไม่บอก"');

    console.log('\n── 3. ⭐ ค่าที่คนกรอกเอง ห้ามแตะ ──');
    const MESSY = 'TWSABKK2606004, CULU6348160/U963528';
    await post('/api/tracking/upsert', { po_so: PO, container: MESSY, _origin: 'manual:somchai' });
    rec = find(PO);
    if (rec.container === MESSY) ok('ค่าที่คนพิมพ์เองอยู่ครบทุกตัวอักษร');
    else bad(`ห้ามแก้ค่าที่คนกรอก — ส่ง "${MESSY}" ได้ "${rec.container}"`);
    await clearContainer();

    console.log('\n── 4. หลายตู้ที่ถูกต้องทั้งหมด ต้องอยู่ครบ ไม่ถูกตัด ──');
    r = await sendScan({ container: 'DFSU2854363, CMAU3487514' });
    rec = find(PO);
    if (rec.container === 'DFSU2854363, CMAU3487514') ok('เก็บครบทั้งสองตู้');
    else bad(`ควรเก็บครบ ได้ ${JSON.stringify(rec.container)}`);
    if (!(r.body.cleaned || []).length) ok('ไม่มีการตัด จึงไม่มีรายงาน cleaned');
    else bad(`ไม่ควรตัดอะไรเลย ได้ ${JSON.stringify(r.body.cleaned)}`);
    await clearContainer();

    console.log('\n── 5. เกราะเดิม: เลขตู้ห้ามหลุดเข้าช่อง B/L (ของเดิม ต้องไม่พัง) ──');
    const blBefore = find(PO).bl_awb;
    await sendScan({ bl_awb: 'NLLU4237054' });   // เลขตู้แท้ ผ่าน ISO 6346
    rec = find(PO);
    if (rec.bl_awb === blBefore) ok('ค่าที่เป็นเลขตู้ไม่ถูกเขียนลงช่อง B/L');
    else bad(`ช่อง B/L ไม่ควรเปลี่ยน ได้ ${JSON.stringify(rec.bl_awb)}`);
  } catch (e) {
    bad('เทสล้มกลางคัน: ' + e.message);
  } finally {
    fs.writeFileSync(TRACK, backup);
    const after = fs.readFileSync(TRACK, 'utf8');
    console.log('\n' + (after === backup ? '  ✓ คืนข้อมูลเดิมครบทุกไบต์' : '  ✗ ข้อมูลไม่ตรงกับก่อนเทส'));
  }
  console.log(fail ? `\nupsert-guards: ไม่ผ่าน ${fail} ข้อ\n` : '\nupsert-guards: ผ่านทั้งหมด\n');
  process.exit(fail ? 1 : 0);
})();

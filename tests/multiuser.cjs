'use strict';
// ─── เทสความพร้อมสำหรับหลายผู้ใช้ — ยิง endpoint จริง ────────────────────────────
// รัน: node tests/multiuser.cjs        (ต้องมี server ที่ port 3000)
//
// ครอบสองเรื่องที่ต้องมีก่อนขึ้น production (2026-09-22):
//   1. **บันทึกว่าใครทำ** — audit log เดิมเก็บแค่ `ip` ซึ่งพอมีหลายคนผ่าน proxy เดียวกัน
//      จะบอกอะไรไม่ได้เลย · และ **ประวัติย้อนหลังเติมกลับไม่ได้** จึงต้องเริ่มวันนี้
//   2. **กันสองคนแก้ record เดียวกันทับกัน** — client ส่ง `_baseTs` ที่ตัวเองเห็นตอนโหลด
//      ถ้าในไฟล์ใหม่กว่า = มีคนบันทึกคั่น → ไม่เขียน แล้วรายงานกลับใน `conflicts[]`
//
// ⚠ เทสนี้ **เขียนข้อมูลจริงลง tracking_data.json** แล้วคืนค่าเดิมให้ตอนจบทุกกรณี
//    (ใช้ PO ที่มีอยู่จริงใบเดียว แตะเฉพาะฟิลด์ `note` ซึ่งไม่กระทบการคำนวณใด)
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const TRACK = path.join(ROOT, 'tracking_data.json');
const AUDIT = path.join(ROOT, 'tracking_audit.jsonl');

let fail = 0;
const ok = (label) => console.log('  ✓ ' + label);
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

function post(pathname, body, user) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (user) headers['Authorization'] = 'Basic ' + Buffer.from(user + ':x').toString('base64');
    const req = http.request({ hostname: '127.0.0.1', port: 3000, path: pathname, method: 'POST', headers }, (res) => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch (e) { reject(new Error(s.slice(0, 200))); } });
    });
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
    req.on('error', reject); req.write(data); req.end();
  });
}
const load = () => JSON.parse(fs.readFileSync(TRACK, 'utf8'));
const find = (po) => load().find(r => r.po_so === po);
const auditTail = (n) => fs.readFileSync(AUDIT, 'utf8').trim().split('\n').slice(-n)
  .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);

(async () => {
  const backup = fs.readFileSync(TRACK, 'utf8');
  const all = JSON.parse(backup);
  // เลือก record ที่ไม่ใช่ export และไม่มี note (จะได้คืนค่าเป็น "ไม่มี note" ได้สะอาด)
  const target = all.find(r => (r._board || 'import') !== 'export' && !r.note && r.po_so);
  if (!target) { console.log('ไม่พบ record ที่ใช้ทดสอบได้'); process.exit(1); }
  const PO = target.po_so;
  console.log(`เทสหลายผู้ใช้ — ใช้การ์ด ${PO}\n`);

  try {
    console.log('── 1. audit log บันทึกว่าใครทำ ──');
    await post('/api/tracking/upsert', { po_so: PO, note: 'เทส A', _ts: Date.now() }, 'somchai');
    const a1 = auditTail(1)[0];
    if (a1 && a1.user === 'somchai') ok(`บันทึกชื่อจาก Basic Auth: user="${a1.user}"`);
    else bad(`ควรได้ user="somchai" ได้ ${JSON.stringify(a1 && a1.user)}`);
    if (a1 && 'ip' in a1) ok('ยังเก็บ ip ไว้ด้วย (ไม่ได้ตัดของเดิมทิ้ง)');
    else bad('ip หายไปจาก audit log');

    console.log('\n── 2. _src ติดชื่อคน ──');
    const r2 = find(PO);
    const tag = r2 && r2._src && r2._src.note;
    if (tag && /^manual:somchai@/.test(tag)) ok(`_src.note = "${tag.slice(0, 32)}…"`);
    else bad(`_src.note ควรขึ้นต้น manual:somchai@ ได้ ${JSON.stringify(tag)}`);
    if (r2 && r2._by === 'somchai') ok('record จำได้ว่าใครแก้ล่าสุด (_by)');
    else bad(`_by ควรเป็น somchai ได้ ${JSON.stringify(r2 && r2._by)}`);

    console.log('\n── 3. ⭐ สองคนแก้ใบเดียวกัน — คนที่สองต้องถูกปฏิเสธ ไม่ใช่ทับเงียบ ──');
    const seen = find(PO)._ts;            // ทั้งสองคนโหลดตอนเดียวกัน
    const rA = await post('/api/tracking/upsert', { po_so: PO, note: 'สมชายแก้', _ts: Date.now(), _baseTs: seen }, 'somchai');
    if (rA.body.applied === 1 && !(rA.body.conflicts || []).length) ok('คนแรกบันทึกผ่าน');
    else bad('คนแรกควรบันทึกผ่าน: ' + JSON.stringify(rA.body));

    const rB = await post('/api/tracking/upsert', { po_so: PO, note: 'สมหญิงแก้', _ts: Date.now(), _baseTs: seen }, 'somying');
    const c = (rB.body.conflicts || [])[0];
    if (c && c.po_so === PO) ok(`คนที่สองถูกปฏิเสธพร้อมเหตุผล: "${c.reason}"`);
    else bad('คนที่สองควรถูกปฏิเสธ ได้: ' + JSON.stringify(rB.body));
    if (rB.body.applied === 0) ok('applied = 0 (ไม่ได้เขียนอะไรเลย)');
    else bad('applied ควรเป็น 0 ได้ ' + rB.body.applied);
    if (find(PO).note === 'สมชายแก้') ok('ค่าของคนแรกยังอยู่ ไม่ถูกทับ');
    else bad('ค่าของคนแรกถูกทับ! ได้ ' + JSON.stringify(find(PO).note));

    console.log('\n── 4. โหลดใหม่แล้วบันทึกได้ตามปกติ ──');
    const fresh = find(PO)._ts;
    const rC = await post('/api/tracking/upsert', { po_so: PO, note: 'สมหญิงแก้รอบสอง', _ts: Date.now(), _baseTs: fresh }, 'somying');
    if (rC.body.applied === 1 && !(rC.body.conflicts || []).length) ok('โหลดใหม่แล้วบันทึกผ่าน');
    else bad('ควรผ่านหลังโหลดใหม่: ' + JSON.stringify(rC.body));

    console.log('\n── 5. ไม่ส่ง _baseTs = พฤติกรรมเดิม (scanner ต้องไม่กระทบ) ──');
    const rD = await post('/api/tracking/upsert',
      { po_so: PO, note: 'สแกนเนอร์', _origin: 'scan:TEST-FOLDER', _fillEmptyOnly: true }, 'somchai');
    if (!(rD.body.conflicts || []).length) ok('ไม่ส่ง _baseTs → ไม่มี conflict (ของเดิมไม่พัง)');
    else bad('ไม่ควรมี conflict เมื่อไม่ส่ง _baseTs: ' + JSON.stringify(rD.body.conflicts));
    const r5 = find(PO);
    if (r5._by === 'somying') ok('_by ไม่ถูกทับโดยการเขียนจาก scanner (_origin มีค่า)');
    else bad('_by ควรยังเป็น somying ได้ ' + JSON.stringify(r5._by));

    console.log('\n── 6. response ยังมีทุกช่องเดิมครบ ──');
    for (const k of ['ok', 'applied', 'total', 'rejected', 'skipped', 'conflicts']) {
      if (k in rD.body) ok('มีช่อง ' + k); else bad('ขาดช่อง ' + k);
    }
  } catch (e) {
    bad('เทสล้ม: ' + e.message);
  } finally {
    fs.writeFileSync(TRACK, backup, 'utf8');   // คืนข้อมูลเดิมเสมอ
    const back = find(PO);
    console.log('\n' + (back && !back.note ? '  ✓ คืนข้อมูลเดิมแล้ว (note ว่างเหมือนก่อนเทส)' : '  ✗ คืนข้อมูลไม่สำเร็จ'));
  }
  console.log(fail ? `\nmultiuser: ล้มเหลว ${fail} ข้อ` : '\nmultiuser: ผ่านทั้งหมด');
  process.exit(fail ? 1 : 0);
})();

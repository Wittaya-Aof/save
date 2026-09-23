// ─── ล้างช่อง "เลขตู้" ของการ์ดเก่าที่มีเลขซีล/ขนาดตู้/เลข booking ปนอยู่ ────────────────────
//   node tools/clean-container-field.mjs            # แสดงว่าจะทำอะไร ไม่เขียนอะไรเลย
//   node tools/clean-container-field.mjs --apply    # เขียนจริง (สำรองไฟล์ให้ก่อนเสมอ)
//   เพิ่ม --fix-transposed เพื่อแก้เลขตู้ที่พิมพ์สลับตัวที่ 3↔4 ด้วย (ดู nearMiss — ต้องให้คนยืนยันก่อน)
//
// ที่มา: เกราะฝั่ง server (2026-09-23) กันของแบบนี้ไม่ให้เข้ามาใหม่แล้ว แต่การ์ดที่บันทึกไว้ก่อนหน้า
// ยังค้างอยู่ 38 ใบ · สคริปต์นี้แตะเฉพาะใบที่ **ล้างแล้วไม่เสียข้อมูล**:
//   A. เหลือเลขตู้ที่ผ่าน ISO 6346 อยู่แล้ว → ตัดเฉพาะส่วนที่ไม่ใช่เลขตู้
//   B. ไม่เหลือเลขตู้เลย **แต่ค่านั้นซ้ำกับช่อง B/L อยู่แล้ว** → ล้างช่องเลขตู้ ของจริงอยู่ช่องที่ถูก
// ข้ามแล้วรายงานให้คนตัดสิน 2 กรณี: ค่าไม่ซ้ำที่ไหนเลย · มีโทเคนที่ "เกือบเป็นเลขตู้" ปนอยู่ (ดู nearMiss)
// วัดจริง 2026-09-23: รอบแรกแก้ 31 ข้าม 7 · รอบสอง --fix-transposed แก้อีก 2 (SKUH→SKHU) เหลือ 5
// ที่เหลือ 5 ใบคือค่าที่ไม่ซ้ำกับที่ไหนและไม่ใกล้เคียงเลขตู้เลย — ต้องให้คนดูทีละใบ
//
// `_src` **ไม่ถูกแตะ** เพราะเลขตู้ที่เหลือยังมาจากเอกสารเดิมจริง ๆ เราแค่ตัดของที่ไม่ใช่เลขตู้ทิ้ง
'use strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TRACK = path.join(ROOT, 'tracking_data.json');
const AUDIT = path.join(ROOT, 'tracking_audit.jsonl');
const LOCK  = path.join(ROOT, 'scan.lock');
const APPLY = process.argv.includes('--apply');
// แก้เลขตู้ที่พิมพ์สลับตัวที่ 3↔4 ด้วย — **ต้องให้คนยืนยันก่อนเสมอ** เพราะเป็นการแก้ค่า
// ไม่ใช่แค่ตัดของที่ไม่ใช่เลขตู้ทิ้ง · AOF อนุมัติ 2026-09-23 สำหรับ SKUH→SKHU สองใบ
const FIX_SWAP = process.argv.includes('--fix-transposed');

// ISO 6346 — ชุดเดียวกับที่ api-server.js ใช้ (ถ้าแก้ต้องแก้ให้ตรงกันทั้งสองที่)
const VAL = (() => { const m = {}; '0123456789'.split('').forEach((c, i) => { m[c] = i; });
  let n = 10; for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { if (n % 11 === 0) n++; m[c] = n++; } return m; })();
const isContainerNo = (v) => {
  const s = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(s)) return false;
  let sum = 0; for (let i = 0; i < 10; i++) sum += VAL[s[i]] * Math.pow(2, i);
  return (sum % 11) % 10 === Number(s[10]);
};
const key = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ⚠ เกราะกัน "ล้างของจริงทิ้ง" — เจอตอน dry run: BTVPO2603-03215 มี "SKUH6510577" ปนอยู่
// ซึ่งสลับตัวที่ 3↔4 แล้วเป็น "SKHU6510577" = **เลขตู้จริงที่ผ่าน ISO 6346** (สายเรือ Sinokor ใช้ SKHU)
// ถ้าล้างไปจะเสียเลขตู้จริงไปเลย → ใบไหนมีโทเคนแบบนี้ปนอยู่ ให้ข้ามแล้วรายงานให้คนตัดสิน
function nearMiss(token) {
  const s = key(token);
  const out = [];
  for (const m of s.match(/[A-Z]{4}\d{7}/g) || []) {
    const swapped = m[0] + m[1] + m[3] + m[2] + m.slice(4);
    if (isContainerNo(swapped)) out.push({ found: m, likely: swapped });
  }
  return out;
}

if (fs.existsSync(LOCK)) { console.error('🔴 scan.lock มีอยู่ = scan กำลังรัน — หยุดก่อน ไม่งั้นเขียนชนกัน'); process.exit(1); }

const raw = fs.readFileSync(TRACK, 'utf8');
const data = JSON.parse(raw);
const plan = [], skip = [];

for (const r of data) {
  const src = r._src && r._src.container;
  if (!src || !/^(docs|scan):/.test(String(src))) continue;       // แตะเฉพาะค่าที่เครื่องสกัดมา
  const cur = String(r.container || '').trim();
  if (!cur) continue;
  const parts = cur.split(/[,/;|]+/).map(s => s.trim()).filter(Boolean);
  const good = parts.filter(isContainerNo);
  const drop = parts.filter(p => !isContainerNo(p));
  if (!drop.length) continue;                                     // สะอาดอยู่แล้ว

  // ของที่จะตัดทิ้ง มีอะไรที่ "เกือบเป็นเลขตู้" ปนอยู่ไหม — ถ้ามี ห้ามล้างเอง
  const near = drop.flatMap(nearMiss);
  if (near.length) {
    // ⚠ แก้ได้เฉพาะเมื่อ **มีตัวเดียวไม่กำกวม** และคนสั่งมาแล้ว (--fix-transposed)
    // มีหลายตัว = เดาไม่ได้ว่าอันไหนคือเลขตู้ ต้องให้คนดูเอง
    if (FIX_SWAP && near.length === 1) {
      plan.push({ r, group: 'SWAP', from: cur, to: near[0].likely,
                  drop: parts.filter(p => !key(p).includes(key(near[0].found))), swap: near[0] });
    } else {
      skip.push({ po: r.po_so, cur, bl: r.bl_awb || '(ว่าง)', near });
    }
    continue;
  }

  if (good.length) { plan.push({ r, group: 'A', from: cur, to: good.join(', '), drop }); continue; }
  // ไม่เหลือเลขตู้เลย — ล้างได้ก็ต่อเมื่อค่านั้นซ้ำกับช่อง B/L (ของจริงอยู่ช่องที่ถูกแล้ว)
  const bl = key(r.bl_awb);
  if (bl && parts.some(p => key(p) === bl)) plan.push({ r, group: 'B1', from: cur, to: '', drop });
  else skip.push({ po: r.po_so, cur, bl: r.bl_awb || '(ว่าง)' });
}

const show = (t, list) => {
  console.log(`\n── ${t} (${list.length}) ──`);
  for (const p of list) console.log(`  ${String(p.r.po_so).padEnd(20)} "${p.from}"  →  ${p.to ? `"${p.to}"` : '(ว่าง)'}`);
};
show('A · เหลือเลขตู้จริง', plan.filter(p => p.group === 'A'));
show('B1 · ค่าซ้ำกับช่อง B/L อยู่แล้ว', plan.filter(p => p.group === 'B1'));
const swaps = plan.filter(p => p.group === 'SWAP');
if (swaps.length) {
  console.log(`
── ⚠ SWAP · แก้เลขตู้ที่พิมพ์สลับ (${swaps.length}) — ต้องมีคนยืนยันก่อนเท่านั้น ──`);
  for (const p of swaps) console.log(`  ${String(p.r.po_so).padEnd(20)} "${p.swap.found}" → "${p.swap.likely}"   (ทั้งช่อง: "${p.from}"  →  "${p.to}")`);
}
console.log(`\n── ข้าม · ล้างแล้วหายจริง (${skip.length}) ──`);
for (const s of skip) {
  console.log(`  ${String(s.po).padEnd(20)} เลขตู้="${s.cur}"   B/L="${s.bl}"`);
  for (const n of s.near || []) console.log(`${' '.repeat(22)}⚠ "${n.found}" สลับตัวที่ 3↔4 ได้ "${n.likely}" = เลขตู้จริง — น่าจะพิมพ์สลับ`);
}

if (!APPLY) { console.log(`\nโหมดดูอย่างเดียว — จะแก้ ${plan.length} ใบ · ใส่ --apply เพื่อเขียนจริง\n`); process.exit(0); }

// ── เขียนจริง ────────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(ROOT, 'backups', `tracking_data.pre-container-cleanup-${stamp}.json`);
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.writeFileSync(backup, raw, 'utf8');
console.log(`\nสำรองไว้ที่ ${path.relative(ROOT, backup)}`);

const now = Date.now();
for (const p of plan) {
  if (p.to) p.r.container = p.to; else delete p.r.container;
  p.r._ts = now;
  fs.appendFileSync(AUDIT, JSON.stringify({
    ts: new Date().toISOString(), action: p.swap ? 'container_typo_fix' : 'container_cleanup', po_so: p.r.po_so,
    fields: ['container'], user: 'local', ip: '',
    detail: Object.assign({ from: p.from, to: p.to, dropped: p.drop },
      p.swap ? { typo: p.swap.found, corrected: p.swap.likely, approvedBy: 'AOF' } : {}),
  }) + '\n', 'utf8');
}

const tmp = TRACK + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
fs.renameSync(tmp, TRACK);

// ── ตรวจว่าเปลี่ยนเฉพาะที่ตั้งใจจริง ๆ ───────────────────────────────────────────────────
const before = JSON.parse(raw), after = JSON.parse(fs.readFileSync(TRACK, 'utf8'));
let bad = 0;
if (before.length !== after.length) { console.error(`🔴 จำนวน record เปลี่ยน ${before.length} → ${after.length}`); bad++; }
const byPo = new Map(before.map(r => [r.po_so, r]));
const touched = new Set(plan.map(p => p.r.po_so));
for (const a of after) {
  const b = byPo.get(a.po_so); if (!b) { console.error(`🔴 มี record ใหม่โผล่มา: ${a.po_so}`); bad++; continue; }
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (k === '_ts' && touched.has(a.po_so)) continue;
    if (k === 'container' && touched.has(a.po_so)) continue;
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) { console.error(`🔴 ${a.po_so}.${k} เปลี่ยนโดยไม่ตั้งใจ`); bad++; }
  }
}
console.log(bad ? `\n🔴 พบความผิดปกติ ${bad} จุด — กู้คืนด้วย: copy "${backup}" "${TRACK}"\n`
                : `\n✓ แก้ ${plan.length} ใบ · ${after.length} record เท่าเดิม · ไม่มีฟิลด์อื่นเปลี่ยนแม้แต่ช่องเดียว\n`);
process.exit(bad ? 1 : 0);

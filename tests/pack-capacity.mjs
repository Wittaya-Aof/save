// เทสความจุพาเลท: ล็อกไว้กันการถอยหลังแบบเงียบๆ
//
// ต่างจาก pack-invariants.mjs ที่ตรวจว่า "ไม่พัง" — ไฟล์นี้ตรวจว่า "ยังได้ของเท่าเดิมหรือมากกว่า"
// เพราะกำไรจากการวางสลับทิศเป็นของที่หายง่าย: ใครแก้การให้คะแนนแผนหรือสูตรนับแถวผิดไปนิดเดียว
// จำนวนกล่องจะลดลงโดยที่ invariant ทางเรขาคณิตยังผ่านหมด (บทเรียนจริง: palBox คืน bH เป็น NaN
// ทำให้เปิดพาเลทใหม่ทุกชั้น volPct 50.7 → 8.1 แต่ไม่มีอะไรทับกันเลย invariant จึงไม่จับ)
//
// เกณฑ์ที่ใช้ **ไม่ใช่การก็อปผลรัน** แต่มาจากสองแหล่งที่ตรวจสอบได้:
//   • เพดานจำนวนพาเลท = KNOWN_MAX ใน lib/pallet-optimum.mjs (ยืนยันด้วยการค้นหาแบบ exhaustive
//     และมีขอบบนเชิงคณิตศาสตร์กำกับ) — เกินค่านี้ = รายงานเกินจริง = อันตรายกว่ารายงานต่ำ
//   • พื้นล่างจำนวนกล่อง = BASELINE_PLACED = ของที่ **เวอร์ชันก่อนมีตัววางแผน** (commit 7bcc2fb)
//     ทำได้จริง วัดจากไฟล์เวอร์ชันนั้นตรงๆ — ต่ำกว่านี้คือถอยหลัง
//
// จำนวนพาเลทที่ใช้จริง "ไม่จำเป็นต้องเท่า KNOWN_MAX" เพราะแผนถูกเลือกด้วยจำนวนกล่องที่ใส่ได้
// ไม่ใช่จำนวนพาเลท (เช่น T4W+euro: 5 ใบใส่ได้ 40 กล่อง/ชั้น ดีกว่า 6 ใบใส่ได้ 36) — เป้าคือของขึ้นตู้
// ให้มากสุด ไม่ใช่ใช้พาเลทให้มากสุด · การเช็คว่า "ตัววางแผนไปถึง optimal จริงไหม" อยู่ใน pack-plan.mjs
//
//   node tests/pack-capacity.mjs
import { chromium } from 'playwright';
import { CONTAINERS, PRESETS, KNOWN_MAX, gridBest } from './lib/pallet-optimum.mjs';

// กล่องที่เวอร์ชันก่อนมีตัววางแผนทำได้ (กล่องทดสอบ 40×30×25cm qty ไม่จำกัด) — พื้นล่างที่ห้ามต่ำกว่า
const BASELINE_PLACED = {
  '20GP|standard 1200x1000': { rot: 624, norot: 576 }, '20GP|euro 1200x800': { rot: 490, norot: 432 },
  '20GP|asia 1100x1100': { rot: 480, norot: 480 }, '20GP|us 1219x1016': { rot: 624, norot: 576 },
  '40HC|standard 1200x1000': { rot: 1440, norot: 1440 }, '40HC|euro 1200x800': { rot: 1120, norot: 1080 },
  '40HC|asia 1100x1100': { rot: 1056, norot: 1056 }, '40HC|us 1219x1016': { rot: 1440, norot: 1440 },
  '20RF|standard 1200x1000': { rot: 576, norot: 576 }, '20RF|euro 1200x800': { rot: 448, norot: 432 },
  '20RF|asia 1100x1100': { rot: 384, norot: 384 }, '20RF|us 1219x1016': { rot: 576, norot: 576 },
  '40RF|standard 1200x1000': { rot: 1296, norot: 1296 }, '40RF|euro 1200x800': { rot: 1008, norot: 972 },
  '40RF|asia 1100x1100': { rot: 960, norot: 960 }, '40RF|us 1219x1016': { rot: 1296, norot: 1296 },
  'T18W|standard 1200x1000': { rot: 1728, norot: 1536 }, 'T18W|euro 1200x800': { rot: 1680, norot: 1260 },
  'T18W|asia 1100x1100': { rot: 960, norot: 960 }, 'T18W|us 1219x1016': { rot: 1344, norot: 1296 },
  'T10W|standard 1200x1000': { rot: 864, norot: 864 }, 'T10W|euro 1200x800': { rot: 714, norot: 648 },
  'T10W|asia 1100x1100': { rot: 672, norot: 672 }, 'T10W|us 1219x1016': { rot: 864, norot: 864 },
  'T6WL|standard 1200x1000': { rot: 768, norot: 720 }, 'T6WL|euro 1200x800': { rot: 602, norot: 540 },
  'T6WL|asia 1100x1100': { rot: 576, norot: 576 }, 'T6WL|us 1219x1016': { rot: 720, norot: 720 },
  'T6WS|standard 1200x1000': { rot: 512, norot: 504 }, 'T6WS|euro 1200x800': { rot: 448, norot: 360 },
  'T6WS|asia 1100x1100': { rot: 240, norot: 240 }, 'T6WS|us 1219x1016': { rot: 512, norot: 504 },
  'T4W|standard 1200x1000': { rot: 256, norot: 256 }, 'T4W|euro 1200x800': { rot: 336, norot: 252 },
  'T4W|asia 1100x1100': { rot: 144, norot: 144 }, 'T4W|us 1219x1016': { rot: 192, norot: 144 },
  'TPK|standard 1200x1000': { rot: 12, norot: 12 }, 'TPK|euro 1200x800': { rot: 18, norot: 16 },
  'TPK|asia 1100x1100': { rot: 8, norot: 8 }, 'TPK|us 1219x1016': { rot: 12, norot: 12 },
};
// เคส "คิวต่อ" — ของที่เวอร์ชันก่อนมีตัววางแผนทำได้ (วัดจากไฟล์เวอร์ชันนั้น) ห้ามต่ำกว่านี้
const BASELINE_QUEUE = {
  '20GP|2spec': { A: 576, B: 162 }, '20GP|pal+std': { P: 576, std: 240 },
  'T6WL|2spec': { A: 600, B: 162 }, 'T6WL|pal+std': { P: 600, std: 126 },
  'T10W|2spec': { A: 600, B: 324 }, 'T10W|pal+std': { P: 600, std: 360 },
  'T18W|2spec': { A: 600, B: 400 }, 'T18W|pal+std': { P: 600, std: 900 },
};

const b = await chromium.launch();
const p = await b.newPage();
const pageErrs = [];
p.on('pageerror', e => pageErrs.push(e.message));
await p.goto('http://localhost:3000/container-loading-calculator.html', { waitUntil: 'load' });
await p.waitForTimeout(1500);

const res = await p.evaluate((PRESETS) => {
  const mk = (pal, rotH) => ({
    type: 'box', name: 'S', L: 40, W: 30, H: 25, D: 20, weight: 5, pieces: 1, pcsPerCtn: 1,
    qty: 100000, color: '#e11d48', rotL: true, rotW: true, rotH: rotH,
    maxLayers: 0, maxH2: 0, maxWt: 0, hexPack: false, usePallet: true,
    pallet: { presetKey: 'x', L: pal.L, W: pal.W, H: 2000, D: 150, maxW: 999999, tare: 5.2, color: '#8d6e63' },
  });
  const rows = [];
  CONTAINERS.forEach(c => PRESETS.forEach(pal => {
    const run = rotH => {
      const r = buildResult(c, [mk(pal, rotH)], 1);
      const man = r._palletManifest || [];
      const geo = {};
      man.forEach(m => { geo[m.L + 'x' + m.W] = (geo[m.L + 'x' + m.W] || 0) + 1; });
      return { n: man.length, rot: man.filter(m => m.rot).length, geo: Object.keys(geo).length,
        placed: man.reduce((a, m) => a + m.products.reduce((x, q) => x + q.placed, 0), 0) };
    };
    if (Math.min(pal.L, pal.W) > Math.min(c.L, c.W)) return;   // พาเลทใส่ตู้นี้ไม่ได้เลย
    // ตำแหน่งของใบหันขวาง — ใช้ตรวจว่าแผนถูกจัดให้กลุ่มสอดขัดกันอยู่ "ทางประตู"
    const r = buildResult(c, [mk(pal, true)], 1);
    const fr = r._palletFrames || [];
    const right = fr.reduce((a, f) => Math.max(a, f.x0 + f.L), 0);
    const rotX = fr.filter(f => f.rot);
    rows.push({ cont: c.id, pal: pal.k, got: run(true), gotNoRot: run(false),
      // ผลรวมตำแหน่ง x ของใบหันขวาง เทียบกับถ้าสะท้อนแผนกลับด้าน (ต้องไม่แย่กว่าแบบสะท้อน)
      rotXNow: rotX.reduce((a, f) => a + f.x0, 0),
      rotXMir: rotX.reduce((a, f) => a + (right - (f.x0 + f.L)), 0) });
  }));

  // ── เคสของ AOF โดยตรง: 20'GP + พาเลทมาตรฐาน ──
  // ของไม่เต็มแผน (ใช้ 6 ใบแรก) ต้องไม่ต้องหันขวางเลยสักใบ เพราะกลุ่มสอดขัดกันถูกดันไปทางประตู
  const c20 = CONTAINERS.find(x => x.id === '20GP');
  const palStd = { presetKey: 'x', L: 1200, W: 1000, H: 2000, D: 150, maxW: 999999, tare: 5.2, color: '#8d6e63' };
  const partial = [1, 3, 5].map(want => {
    const it = { type: 'box', name: 'S', L: 22, W: 20, H: 21.5, D: 20, weight: 5, pieces: 1, pcsPerCtn: 1,
      qty: want * 200, color: '#e11d48', rotL: true, rotW: true, rotH: true, maxLayers: 0, maxH2: 0,
      maxWt: 0, hexPack: false, usePallet: true, pallet: palStd };
    const r = buildResult(c20, [it], 1);
    const man = r._palletManifest || [];
    return { want, n: man.length, rot: man.filter(m => m.rot).length };
  });

  // ── กลุ่มที่ไม่ใช่คิวสุดท้ายห้ามใช้แผนสลับทิศ ──
  // แผนสลับทิศใช้ความยาวที่เหลือแบบไม่เต็มความกว้าง แล้ว offsetX ข้ามไปทั้งก้อน
  // ถ้าเปิดให้กลุ่มที่ยังมีคิวถัดไป กลุ่มถัดไป/ของที่ไม่ขึ้นพาเลทจะเสียพื้นที่ไปฟรีๆ
  // (เคสจริงที่เคยถอยหลัง: 20'GP พาเลท A 1200×1000 + B 800×600 → B ได้ 3 ใบ กลายเป็น 0 ใบ)
  const palOf = (L, W, D, tare) => ({ presetKey: 'x', L, W, H: 2000, D, maxW: 999999, tare, color: '#8d6e63' });
  const mkX = (n, L, W, H, qty, pl) => ({ type: 'box', name: n, L, W, H, D: 20, weight: 5, pieces: 1,
    pcsPerCtn: 1, qty, color: '#e11d48', rotL: true, rotW: true, rotH: true, maxLayers: 0, maxH2: 0,
    maxWt: 0, hexPack: false, usePallet: !!pl, pallet: pl || null });
  const queue = [];
  ['20GP', 'T6WL', 'T10W', 'T18W'].forEach(cid => {
    const c = CONTAINERS.find(x => x.id === cid);
    const shot = items => {
      const r = buildResult(c, items, 1);
      const man = r._palletManifest || [];
      const groups = {};
      man.forEach(m => m.products.forEach(q => { groups[q.name] = (groups[q.name] || 0) + q.placed; }));
      const std = (r.items || []).filter(x => !x.item.usePallet).reduce((a, x) => a + x.packed, 0);
      // ชื่อ SKU ที่อยู่บนพาเลทที่หันขวาง — ใช้ตรวจว่ามีแต่กลุ่มคิวสุดท้ายที่ได้สลับทิศ
      const rotSku = [...new Set(man.filter(m => m.rot).flatMap(m => m.products.map(q => q.name)))];
      return { pallets: man.length, rot: man.filter(m => m.rot).length, groups, std, rotSku };
    };
    queue.push({ cont: cid, kind: '2spec', lastGroup: 'B',
      got: shot([mkX('A', 40, 30, 25, 600, palOf(1200, 1000, 150, 5.2)),
                 mkX('B', 30, 25, 20, 400, palOf(800, 600, 100, 3.0))]) });
    queue.push({ cont: cid, kind: 'pal+std', lastGroup: null,
      got: shot([mkX('P', 40, 30, 25, 600, palOf(1200, 1000, 150, 5.2)),
                 mkX('S', 35, 28, 22, 900, null)]) });
  });
  return { rows, queue, partial };
}, PRESETS);
await b.close();
const { rows: capRows, queue, partial } = res;

let fail = 0, gained = 0;
console.log('ตู้     พาเลท                 ใบ/เพดาน  กล่อง(พื้นล่าง)   ห้ามหมุน       ผล');
console.log('-'.repeat(96));
for (const r of capRows) {
  const key = r.cont + '|' + r.pal;
  const cap = KNOWN_MAX[key], base = BASELINE_PLACED[key];
  const pal = PRESETS.find(x => x.k === r.pal), cont = CONTAINERS.find(x => x.id === r.cont);
  const gridOnly = gridBest(cont.L, cont.W, pal.L, pal.W, false);
  const errs = [];
  if (cap != null && r.got.n > cap) errs.push(`ใช้พาเลท ${r.got.n} ใบ เกินที่วางได้จริง ${cap}`);
  if (base && r.got.placed < base.rot) errs.push(`กล่อง ${r.got.placed} < พื้นล่าง ${base.rot} (ถอยหลัง)`);
  if (base && r.gotNoRot.placed < base.norot) errs.push(`ห้ามหมุน: กล่อง ${r.gotNoRot.placed} < ${base.norot}`);
  // ห้ามหมุน → ต้องเป็น grid ทิศเดียวล้วน (ไม่มีใบหันขวาง ไม่มีสองทิศในตู้เดียว) และไม่เกินสูตร grid
  if (r.gotNoRot.rot !== 0) errs.push(`ห้ามหมุน แต่มีใบหันขวาง ${r.gotNoRot.rot} ใบ`);
  if (r.gotNoRot.geo > 1) errs.push('ห้ามหมุน แต่มีพาเลทสองทิศในตู้เดียว');
  if (r.gotNoRot.n > gridOnly) errs.push(`ห้ามหมุน ได้ ${r.gotNoRot.n} ใบ เกิน grid ทิศเดียว ${gridOnly}`);
  // ป้าย "หันขวาง" ต้องตรงกับความจริงเสมอ: มีพาเลทสองทิศในตู้ ⇔ ต้องมีใบที่ถูกมาร์ค
  // ถ้าไม่มาร์ค คนโหลดจะวางทิศเดียวกันหมดตามความเคยชิน แล้วจำนวนจริงไม่ตรงกับแผน
  // (จำนวนพาเลทที่มากกว่าโหมดห้ามหมุน **ไม่ได้** แปลว่าใช้แผนสลับทิศ — rotH คุมทิศกล่องด้วย
  //  จึงเลือก grid คนละทิศได้ เช่น T4W+euro: อนุญาตหมุน → grid 1200 นอน 6 ใบ/336 กล่อง
  //  ห้ามหมุน → grid 800 นอน 5 ใบ/280 กล่อง ทั้งคู่เป็นทิศเดียวล้วน ไม่มีใบหันขวาง)
  if (r.got.geo > 1 && r.got.rot === 0) errs.push('มีพาเลทสองทิศในตู้ แต่ไม่มีใบไหนถูกมาร์คว่าหันขวาง');
  if (r.got.geo === 1 && r.got.rot !== 0) errs.push('พาเลททิศเดียวทั้งตู้ แต่มาร์คว่าหันขวาง ' + r.got.rot + ' ใบ');
  if (r.got.n > r.gotNoRot.n && r.got.placed <= r.gotNoRot.placed)
    errs.push('พาเลทเพิ่มแต่ของไม่เพิ่ม (พาเลทเปล่า)');
  if (r.got.placed > r.gotNoRot.placed) gained++;
  // กลุ่มที่ต้องวางสอดขัดกันต้องอยู่ "ทางประตู" ไม่ใช่ลึกสุด — คนโหลดวางจากผนังในออกมา
  // ถ้าอยู่ลึกสุดจะแก้ทีหลังไม่ได้ และของที่ไม่เต็มแผนจะต้องหันขวางทั้งที่ไม่จำเป็น
  // เทียบกับแผนเดียวกันที่สะท้อนกลับด้าน: ของจริงต้องอยู่ใกล้ประตูไม่น้อยกว่า
  if (r.rotXNow < r.rotXMir) errs.push(`ใบหันขวางอยู่ลึกเกินไป (${r.rotXNow} < สะท้อนแล้ว ${r.rotXMir})`);
  if (errs.length) fail++;
  console.log(r.cont.padEnd(7) + r.pal.padEnd(22) + `${r.got.n}/${cap ?? '-'}`.padEnd(10) +
    `${r.got.placed} (${base ? base.rot : '-'})`.padEnd(17) +
    `${r.gotNoRot.n} ใบ/${r.gotNoRot.placed} กล่อง`.padEnd(15) + (errs.length ? '✗ ' + errs.join('; ') : '✓'));
}
console.log('-'.repeat(96));
console.log(`รวม ${capRows.length} คู่ (ตู้ × พาเลท) · ของขึ้นได้มากกว่าโหมดห้ามหมุน ${gained} คู่ · ล้มเหลว ${fail}`);

console.log('\nกลุ่มที่ไม่ใช่คิวสุดท้ายห้ามใช้แผนสลับทิศ (กันแย่งที่คิวถัดไป)');
console.log('-'.repeat(96));
for (const q of queue) {
  const errs = [], base = BASELINE_QUEUE[q.cont + '|' + q.kind];
  const bad = q.got.rotSku.filter(s => s !== q.lastGroup);
  if (bad.length) errs.push('กลุ่มที่ยังมีคิวถัดไปได้สลับทิศ: ' + bad.join(','));
  if (q.kind === '2spec') {
    if (!(q.got.groups.B > 0)) errs.push('กลุ่ม B ไม่ได้พาเลทเลย (ถูกกลุ่ม A กินที่ไป)');
    if (base && (q.got.groups.A || 0) < base.A) errs.push(`A=${q.got.groups.A} < พื้นล่าง ${base.A}`);
    if (base && (q.got.groups.B || 0) < base.B) errs.push(`B=${q.got.groups.B} < พื้นล่าง ${base.B}`);
  } else {
    if (!(q.got.std > 0)) errs.push('ของที่ไม่ขึ้นพาเลทวางไม่ได้เลย');
    if (base && (q.got.groups.P || 0) < base.P) errs.push(`บนพาเลท=${q.got.groups.P} < พื้นล่าง ${base.P}`);
    if (base && q.got.std < base.std) errs.push(`นอกพาเลท=${q.got.std} < พื้นล่าง ${base.std}`);
  }
  if (errs.length) fail++;
  console.log(q.cont.padEnd(7) + q.kind.padEnd(10) + `พาเลท ${q.got.pallets}/ขวาง ${q.got.rot}`.padEnd(20) +
    (q.kind === '2spec' ? `A=${q.got.groups.A || 0} B=${q.got.groups.B || 0}`
                        : `บนพาเลท=${q.got.groups.P || 0} นอก=${q.got.std}`).padEnd(22) +
    (errs.length ? '✗ ' + errs.join('; ') : '✓'));
}
console.log('\nของไม่เต็มแผน (20\'GP + พาเลทมาตรฐาน) ต้องไม่ต้องหันขวางเลย');
console.log('-'.repeat(96));
for (const q of partial) {
  // แผน 10 ใบของตู้นี้ = กริดตรง 6 ใบ (x 0..3600) แล้วกลุ่มสอดขัดกัน 4 ใบทางประตู
  // ของที่ใช้ไม่เกิน 6 ใบจึงต้องเป็นใบตรงล้วน — ถ้าหลุดเป็นหันขวาง แปลว่าแผนถูกดันกลับไปลึกอีกแล้ว
  const bad = q.n <= 6 && q.rot > 0;
  if (bad) fail++;
  console.log(`ตั้งใจใช้ ~${q.want} พาเลท → ได้ ${q.n} ใบ / หันขวาง ${q.rot} ใบ  ` +
    (bad ? '✗ ของไม่เต็มแผนแต่ยังต้องหันขวาง' : '✓'));
}
console.log('-'.repeat(96));
console.log(`รวม ${queue.length} เคสคิวต่อ + ${partial.length} เคสของไม่เต็ม · ล้มเหลวสะสมทั้งไฟล์ ${fail}`);
console.log('pageerrors: ' + (pageErrs.join(' | ') || '(none)'));
process.exit(fail ? 1 : 0);

// เทสความจุพาเลท: ล็อกจำนวนพาเลทที่ "ควรใส่ได้" ไว้กันการถอยหลังแบบเงียบๆ
//
// ต่างจาก pack-invariants.mjs ที่ตรวจว่า "ไม่พัง" — ไฟล์นี้ตรวจว่า "ยังได้ของเท่าเดิม"
// เพราะ tail rotation (พาเลทใบท้ายตู้หันขวาง 90°) เป็นกำไรที่หายง่าย: ใครแก้ตัวเลือกทิศพาเลท
// หรือสูตรนับแถวผิดไปนิดเดียว จำนวนพาเลทจะลดลงโดยที่ invariant ทางเรขาคณิตยังผ่านหมด
//
// จำนวนที่คาดหวัง **ไม่ได้ก็อปมาจากผลรัน** — คำนวณใหม่จากขนาดตู้/พาเลทในเทสนี้เอง
// (grid ทิศที่ดีที่สุด + ใบที่ท้ายตู้ถ้าเหลือที่พอ) แล้วเทียบกับที่ packLayout ทำได้จริง
//
//   node tests/pack-capacity.mjs
import { chromium } from 'playwright';

const PRESETS = [
  { k: 'standard 1200x1000', L: 1200, W: 1000 },
  { k: 'euro 1200x800', L: 1200, W: 800 },
  { k: 'us 1219x1016', L: 1219, W: 1016 },
];

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
    // ── คาดหวัง: เลือกทิศ grid ที่ได้ตำแหน่งมากสุด แล้วบวกใบที่ท้ายตู้ถ้าเหลือที่พอ ──
    let best = null;
    [[pal.L, pal.W], [pal.W, pal.L]].forEach(d => {
      const per = Math.floor(c.L / d[0]), rows_ = Math.floor(c.W / d[1]);
      if (per < 1 || rows_ < 1) return;
      if (!best || per * rows_ > best.n) best = { along: d[0], across: d[1], per, n: per * rows_ };
    });
    if (!best) return;                       // พาเลทใส่ตู้นี้ไม่ได้เลย
    const tail = c.L - best.per * best.along;
    const extra = (tail >= best.across && best.along <= c.W) ? Math.floor(c.W / best.along) : 0;

    const run = rotH => {
      const r = buildResult(c, [mk(pal, rotH)], 1);
      const man = r._palletManifest || [];
      return { n: man.length, rot: man.filter(m => m.rot).length,
        placed: man.reduce((a, m) => a + m.products.reduce((x, q) => x + q.placed, 0), 0) };
    };
    rows.push({ cont: c.id, pal: pal.k, wantGrid: best.n, wantExtra: extra,
      got: run(true), gotNoRot: run(false) });
  }));

  // ── slot ท้ายตู้ต้องไม่แย่งพื้นที่จากคิวถัดไป ──
  // slot ท้ายตู้กินความยาวที่เหลือทั้งหมดแต่ใช้ความกว้างแค่บางส่วน แล้ว offsetX ข้ามไปหมด
  // ถ้าเปิดให้กลุ่มที่ไม่ใช่คิวสุดท้าย กลุ่มถัดไป/ของที่ไม่ขึ้นพาเลทจะเสียพื้นที่ไปฟรีๆ
  // เคสจริงที่เคยถอยหลัง: 20'GP พาเลท A 1200×1000 + B 800×600 → B ได้ 3 ใบ กลายเป็น 0 ใบ
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
      return { pallets: man.length, rot: man.filter(m => m.rot).length, groups, std };
    };
    queue.push({ cont: cid, kind: 'พาเลท 2 สเปค',
      got: shot([mkX('A', 40, 30, 25, 600, palOf(1200, 1000, 150, 5.2)),
                 mkX('B', 30, 25, 20, 400, palOf(800, 600, 100, 3.0))]) });
    queue.push({ cont: cid, kind: 'พาเลท + ของไม่ขึ้นพาเลท',
      got: shot([mkX('P', 40, 30, 25, 600, palOf(1200, 1000, 150, 5.2)),
                 mkX('S', 35, 28, 22, 900, null)]) });
  });
  return { rows, queue };
}, PRESETS);
await b.close();
const { rows: capRows, queue } = res;

let fail = 0, gained = 0;
console.log('ตู้     พาเลท                 คาด(grid+ท้าย)  ได้จริง  ขวาง   rotH=false   ผล');
console.log('-'.repeat(84));
for (const r of capRows) {
  const want = r.wantGrid + r.wantExtra;
  const errs = [];
  // ความจุต้องไม่ต่ำกว่าที่เรขาคณิตรองรับ (สูงกว่าไม่ได้เช่นกัน — พาเลทจะทับกัน)
  if (r.got.n !== want) errs.push('จำนวนพาเลท ' + r.got.n + ' ≠ ' + want);
  if (r.got.rot !== r.wantExtra) errs.push('ใบหันขวาง ' + r.got.rot + ' ≠ ' + r.wantExtra);
  // ห้ามหมุน → ห้ามมีใบหันขวาง และต้องได้เท่ากับ grid เปล่าๆ
  if (r.gotNoRot.rot !== 0) errs.push('rotH=false แต่ยังมีใบหันขวาง ' + r.gotNoRot.rot);
  if (r.gotNoRot.n !== r.wantGrid) errs.push('rotH=false ได้ ' + r.gotNoRot.n + ' ≠ grid ' + r.wantGrid);
  // ใบที่หันขวางต้องทำให้ใส่ของได้มากขึ้นจริง ไม่ใช่เพิ่มพาเลทเปล่า
  if (r.wantExtra > 0 && r.got.placed <= r.gotNoRot.placed)
    errs.push('เพิ่มพาเลทแต่ของไม่เพิ่ม (' + r.gotNoRot.placed + ' → ' + r.got.placed + ')');
  if (errs.length) fail++;
  if (r.wantExtra > 0) gained++;
  console.log(r.cont.padEnd(7) + r.pal.padEnd(22) + String(r.wantGrid).padStart(3) + '+' + r.wantExtra +
    String(r.got.n).padStart(9) + String(r.got.rot).padStart(7) + '   ' +
    (String(r.gotNoRot.n) + ' ใบ/' + r.gotNoRot.rot + ' ขวาง').padEnd(13) +
    (errs.length ? '✗ ' + errs.join('; ') : '✓'));
}
console.log('-'.repeat(84));
console.log('รวม ' + capRows.length + ' คู่ (ตู้ × พาเลท) · ได้พาเลทเพิ่มจากใบท้ายตู้ ' + gained + ' คู่ · ล้มเหลว ' + fail);

console.log('\nslot ท้ายตู้ต้องไม่แย่งพื้นที่จากคิวถัดไป');
console.log('-'.repeat(84));
for (const q of queue) {
  const errs = [];
  if (q.got.rot !== 0) errs.push('มีใบหันขวาง ' + q.got.rot + ' ใบ ทั้งที่ยังมีคิวถัดไป');
  if (q.kind === 'พาเลท 2 สเปค' && !(q.got.groups.B > 0))
    errs.push('กลุ่ม B ไม่ได้พาเลทเลย (ถูกกลุ่ม A กินที่ท้ายตู้ไป)');
  if (q.kind === 'พาเลท + ของไม่ขึ้นพาเลท' && !(q.got.std > 0))
    errs.push('ของที่ไม่ขึ้นพาเลทวางไม่ได้เลย');
  if (errs.length) fail++;
  console.log(q.cont.padEnd(7) + q.kind.padEnd(26) + ('พาเลท ' + q.got.pallets + ' ใบ/ขวาง ' + q.got.rot).padEnd(20) +
    (q.kind === 'พาเลท 2 สเปค' ? ('A=' + (q.got.groups.A || 0) + ' B=' + (q.got.groups.B || 0)).padEnd(15)
                                : ('บนพาเลท=' + (q.got.groups.P || 0) + ' นอก=' + q.got.std).padEnd(15)) +
    (errs.length ? '✗ ' + errs.join('; ') : '✓'));
}
console.log('-'.repeat(84));
console.log('รวม ' + queue.length + ' เคสคิวต่อ · ล้มเหลวสะสมทั้งไฟล์ ' + fail);
console.log('pageerrors: ' + (pageErrs.join(' | ') || '(none)'));
process.exit(fail ? 1 : 0);

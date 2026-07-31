// เทสตัววางแผนผังพื้นพาเลท (palPlanCandidates) เทียบกับ oracle อิสระใน lib/pallet-optimum.mjs
//
// ตรวจ 3 อย่างต่อ (ตู้ × พาเลท) ทั้ง 40 คู่:
//   1. **เรขาคณิต** — ทุกแผนที่เสนอ ทุก slot ต้องอยู่ในตู้ ไม่ทับกัน และขนาดเป็นพาเลทจริง
//      (ถ้าข้อนี้พลาด = วาดพาเลททับกันเหมือนบั๊ก PAL_TOL เดิม)
//   2. **ไม่เกินความเป็นจริง** — จำนวน slot มากสุด ≤ ขอบบนเชิงคณิตศาสตร์ (พิสูจน์ได้)
//      รายงานเกินจริงอันตรายกว่ารายงานต่ำ: ถ้าเชื่อแล้วไปจองตู้ ของขึ้นไม่หมด
//   3. **ไม่ถอยหลัง** — จำนวน slot มากสุด ≥ ค่าที่ DFS ยืนยันแล้วว่าวางได้จริง (KNOWN_MAX)
//      และต้อง ≥ grid ทิศเดียว (ความสามารถเดิม) เสมอ
//
//   node tests/pack-plan.mjs             # เร็ว (~20 วิ) ใช้ตาราง KNOWN_MAX ที่ยืนยันไว้แล้ว
//   node tests/pack-plan.mjs --prove     # ค้นหาใหม่ทั้งหมดด้วย DFS (นาที+) ยืนยันตารางเองอีกรอบ
import { chromium } from 'playwright';
import { CONTAINERS, PRESETS, KNOWN_MAX, upperBound, gridBest, tryPack, searchMax }
  from './lib/pallet-optimum.mjs';

const PROVE = process.argv.includes('--prove');

const b = await chromium.launch();
const p = await b.newPage();
const pageErrs = [];
p.on('pageerror', e => pageErrs.push(e.message));
await p.goto('http://localhost:3000/container-loading-calculator.html', { waitUntil: 'load' });
await p.waitForTimeout(1500);

// ดึงแผนทุกแบบที่แอปเสนอ (ทั้งอนุญาตสลับทิศและไม่อนุญาต) ออกมาตรวจตรงๆ
const app = await p.evaluate(({ CONTAINERS, PRESETS }) => {
  const out = {};
  CONTAINERS.forEach(c => PRESETS.forEach(pal => {
    out[c.id + '|' + pal.k] = {
      mix: palPlanCandidates(c.L, c.W, pal.L, pal.W, true),
      grid: palPlanCandidates(c.L, c.W, pal.L, pal.W, false),
    };
  }));
  return out;
}, { CONTAINERS, PRESETS });
await b.close();

let fail = 0, gain = 0;
console.log('ตู้    พาเลท                 grid เดิม  แอปทำได้  ยืนยันแล้ว  ขอบบน  ผล');
console.log('-'.repeat(88));
for (const c of CONTAINERS) for (const pal of PRESETS) {
  const key = c.id + '|' + pal.k;
  const got = app[key];
  const errs = [];
  const maxOf = plans => plans.reduce((a, pl) => Math.max(a, pl.length), 0);

  // 1) เรขาคณิตของทุกแผนที่เสนอ (ทั้ง mix และ grid)
  for (const [tag, plans] of [['mix', got.mix], ['grid', got.grid]])
    plans.forEach((pl, pi) => {
      pl.forEach(s => {
        if (s.x < 0 || s.y < 0 || s.x + s.along > c.L || s.y + s.across > c.W)
          errs.push(`${tag}#${pi} slot ออกนอกตู้ (${s.x},${s.y} ${s.along}×${s.across})`);
        if (!((s.along === pal.L && s.across === pal.W) || (s.along === pal.W && s.across === pal.L)))
          errs.push(`${tag}#${pi} ขนาด slot ไม่ใช่พาเลทจริง (${s.along}×${s.across})`);
      });
      for (let i = 0; i < pl.length; i++) for (let j = i + 1; j < pl.length; j++) {
        const u = pl[i], v = pl[j];
        if (u.x < v.x + v.along && v.x < u.x + u.along && u.y < v.y + v.across && v.y < u.y + u.across)
          errs.push(`${tag}#${pi} slot ทับกัน`);
      }
    });

  const nMix = maxOf(got.mix), nGrid = maxOf(got.grid);
  const ub = upperBound(c.L, c.W, pal.L, pal.W);
  const gb = gridBest(c.L, c.W, pal.L, pal.W, false);       // grid ทิศเดียวล้วน
  const gbTail = gridBest(c.L, c.W, pal.L, pal.W, true);    // + ใบท้ายตู้ (ความสามารถเดิม)

  // 2) ห้ามเกินความเป็นจริง
  if (nMix > ub) errs.push(`เสนอ ${nMix} ใบ แต่ขอบบนพิสูจน์แล้วว่าได้ไม่เกิน ${ub}`);
  // 3) ห้ามถอยหลัง
  let want = KNOWN_MAX[key];
  if (PROVE) {
    const found = searchMax(c.L, c.W, pal.L, pal.W, Math.max(1, gbTail));
    if (found.n !== want) errs.push(`ตาราง KNOWN_MAX=${want} แต่ค้นหาได้ ${found.n}`);
    want = Math.max(want, found.n);
  } else if (nMix >= want) {
    // ยืนยันว่าค่าในตารางวางได้จริง (หาคำตอบที่มีอยู่ = เร็ว) กันตารางเพี้ยน
    const r = tryPack(c.L, c.W, pal.L, pal.W, want, 3e6);
    if (!r.ok) errs.push(`KNOWN_MAX=${want} วางไม่ได้จริง (ตารางผิด)`);
  }
  if (nMix < want) errs.push(`ได้ ${nMix} ใบ ต่ำกว่าที่วางได้จริง ${want}`);
  if (nMix < gbTail) errs.push(`ได้ ${nMix} ใบ ต่ำกว่าความสามารถเดิม (grid+ท้ายตู้) ${gbTail}`);
  // grid ล้วน (ใช้ตอน rotH=false) ต้องไม่มีใบหันขวางและต้องเท่ากับสูตร grid ตรงๆ
  if (nGrid !== gb) errs.push(`โหมดห้ามหมุนได้ ${nGrid} ≠ grid ทิศเดียว ${gb}`);
  got.grid.forEach((pl, pi) => {
    const geo = new Set(pl.map(s => s.along + 'x' + s.across));
    if (geo.size > 1) errs.push(`grid#${pi} มีสองทิศในแผนที่ห้ามหมุน`);
  });

  if (errs.length) fail++;
  if (nMix > gbTail) gain++;
  console.log(c.id.padEnd(6) + pal.k.padEnd(22) + String(gbTail).padStart(7) + String(nMix).padStart(10) +
    String(want).padStart(12) + String(ub).padStart(7) + '  ' +
    (errs.length ? '✗ ' + errs.join('; ') : nMix === ub ? '✓ optimal' : '✓'));
}
console.log('-'.repeat(88));
console.log(`รวม ${CONTAINERS.length * PRESETS.length} คู่ · ได้พาเลทเพิ่มจากเดิม ${gain} คู่ · ล้มเหลว ${fail}`);
console.log('pageerrors: ' + (pageErrs.join(' | ') || '(none)'));
process.exit(fail ? 1 : 0);

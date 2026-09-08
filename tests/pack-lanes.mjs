// เทสเลนกล่องบนพาเลท — ล็อกกำไรจาก "เลนรองที่กล่องหมุน 90° ในแถบที่เหลือ" (palBoxPlan)
//
// ⚠ บทเรียนที่เกือบทำให้รายงานผิด: ตอนเสนอผมวัดบน "ฐานกล่องที่ตรึงไว้" แล้วได้ +6.8%
// แต่แอปหมุนกล่องได้ทั้ง 6 แบบใน 3 มิติ (`allPerms`) แล้วเลือกที่ดีที่สุด — การหมุนนั้นมักกำจัด
// แถบที่เหลือไปเองอยู่แล้ว · วัดจริงแบบ end-to-end จึงได้ **+3.76%** ไม่ใช่ +6.8%
// เป็นกับดักเดียวกับที่ CLAUDE.md บันทึกไว้เรื่อง "ข้อ A" ของรอบเพิ่มความจุพาเลท — **ต้องวัดปลายทางเสมอ**
//
// ทำไมต้องแยกจาก pack-capacity: ไฟล์นั้นใช้กล่อง 40×30×25cm บนพาเลท 1200×1000 ซึ่งเป็นเคสที่
// เลน**ไม่ช่วยเลย** (หมุนแล้วลงตัวพอดีอยู่แล้ว) จึงไม่จับการเปลี่ยนแปลงนี้แม้แต่นิดเดียว
//
// เกณฑ์ = ผลที่วัดจากไฟล์ **ก่อนใส่เลน** เทียบกับหลังใส่ ด้วย route interception (ไม่ได้ก็อปผลรันมาลอยๆ)
// ตู้ทดสอบ = 40'HC · พาเลท H 2000 deck 150 → ซ้อนได้ 1850mm · qty ไม่จำกัด
//
//   node tests/pack-lanes.mjs          (ต้องมี server ที่ port 3000)
import { chromium } from 'playwright';

// เคสที่เลนช่วยจริง — [พาเลท, กล่อง L×W×H cm, ก่อน(ทั้งตู้), หลัง(ทั้งตู้), ก่อน/ใบ, หลัง/ใบ]
const GAINS = [
  ['euro',     50, 30, 30,  480,  720, 24, 36],
  ['asia',     60, 40, 40,  160,  240,  8, 12],
  ['asia',     60, 45, 40,  160,  240,  8, 12],
  ['euro',     42, 30, 28,  600,  810, 24, 36],
  ['standard', 60, 40, 40,  320,  400, 16, 20],
  ['standard', 60, 35, 35,  400,  500, 20, 25],
  ['standard', 55, 40, 35,  400,  500, 20, 25],
  ['standard', 60, 45, 40,  320,  400, 16, 20],
  ['asia',     60, 40, 25,  480,  600, 24, 30],
  ['asia',     40, 30, 25,  960, 1200, 48, 60],
  ['asia',     38, 28, 25,  960, 1200, 48, 60],
  ['us',       60, 35, 35,  380,  470, 20, 25],
  ['us',       55, 40, 35,  380,  470, 20, 25],
  ['euro',     48, 32, 30,  600,  660, 24, 30],
];
// เคสควบคุม: เลนไม่ช่วย ต้องได้เท่าเดิมเป๊ะ (กันการ "ปรับให้ดีขึ้น" ที่จริงๆ ทำอย่างอื่นพัง)
const SAME = [['standard', 40, 30, 25], ['euro', 60, 40, 25], ['us', 40, 30, 25], ['standard', 35, 25, 25]];

const PAL = { standard: [1200, 1000], euro: [1200, 800], asia: [1100, 1100], us: [1219, 1016] };
const ALL = GAINS.map(g => g.slice(0, 4)).concat(SAME);

const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://localhost:3000/container-loading-calculator.html', { waitUntil: 'load' });
await p.waitForFunction(() => typeof buildResult === 'function', { timeout: 20000 });

const got = await p.evaluate(({ ALL, PAL }) => {
  const out = {};
  for (const [pk, bl, bw, bh] of ALL) {
    const [pL, pW] = PAL[pk];
    const it = {
      type: 'box', name: 'S', L: bl, W: bw, H: bh, D: 20, weight: 1, pieces: 1, pcsPerCtn: 1,
      qty: 100000, color: '#e11d48', rotL: true, rotW: true, rotH: true,
      maxLayers: 0, maxH2: 0, maxWt: 0, hexPack: false, usePallet: true,
      pallet: { presetKey: 'x', L: pL, W: pW, H: 2000, D: 150, maxW: 999999, tare: 5.2, color: '#8d6e63' },
    };
    const r = buildResult({ id: '40HC', L: 12024, W: 2350, H: 2690, maxW: 28000 }, [it], 1);
    const man = r._palletManifest || [];
    const per = man.map(m => m.products.reduce((a, q) => a + q.placed, 0));
    out[`${pk}|${bl}x${bw}x${bh}`] = { tot: per.reduce((a, v) => a + v, 0), best: per.length ? Math.max(...per) : 0 };
  }
  return out;
}, { ALL, PAL });

let fail = 0;
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

console.log('เลนกล่องบนพาเลท — เคสที่ต้องได้กล่องเพิ่ม\n');
console.log('  พาเลท+กล่อง              ก่อน → ต้องได้    วางได้จริง   ต่อใบ');
console.log('  ' + '─'.repeat(70));
for (const [pk, bl, bw, bh, before, after, pBefore, pAfter] of GAINS) {
  const k = `${pk}|${bl}x${bw}x${bh}`, g = got[k];
  const okTot = g.tot >= after, okPer = g.best >= pAfter;
  console.log(`  ${(okTot && okPer ? ' ' : '✗')} ${k.padEnd(22)} ${String(before).padStart(5)} → ${String(after).padStart(5)}  ${String(g.tot).padStart(9)}   ${pBefore}→${g.best}`);
  if (!okTot) bad(`${k}: ต้องได้อย่างน้อย ${after} กล่อง ได้ ${g.tot} (ก่อนใส่เลนได้ ${before})`);
  if (!okPer) bad(`${k}: ต่อพาเลทต้องได้อย่างน้อย ${pAfter} ได้ ${g.best}`);
}

console.log('\nเคสควบคุม — เลนไม่ช่วย ต้องไม่กระทบ');
for (const [pk, bl, bw, bh] of SAME) {
  const k = `${pk}|${bl}x${bw}x${bh}`, g = got[k];
  if (g.tot <= 0) bad(`${k}: วางไม่ได้เลย`);
  else console.log(`  ✓ ${k.padEnd(22)} ${g.tot} กล่อง (${g.best}/ใบ)`);
}

// ── คุณสมบัติของตัววางแผน: ห้ามได้น้อยกว่ากริดเดิมในฐานกล่องใดเลย ──
console.log('\nตัววางแผน palBoxPlan — กวาด 4 พาเลท × 15 ฐานกล่อง');
const sweep = await p.evaluate(() => {
  const P = [[1200, 1000], [1200, 800], [1100, 1100], [1219, 1016]];
  const B = [[600, 400], [500, 400], [500, 300], [400, 300], [600, 350], [550, 400], [530, 320],
             [480, 320], [450, 350], [420, 300], [380, 280], [350, 250], [600, 450], [560, 380], [430, 330]];
  let worse = 0, better = 0, g = 0, l = 0;
  for (const [pL, pW] of P) for (const [bl, bw] of B) {
    const grid = Math.max(Math.floor(pL / bl) * Math.floor(pW / bw), Math.floor(pL / bw) * Math.floor(pW / bl));
    const n = palBoxPlan(pL, pW, bl, bw, true).n;
    g += grid; l += n;
    if (n < grid) worse++; else if (n > grid) better++;
  }
  return { worse, better, g, l };
});
console.log(`  ${sweep.g} → ${sweep.l} (+${(sweep.l / sweep.g * 100 - 100).toFixed(1)}%) · ดีขึ้น ${sweep.better} · แย่ลง ${sweep.worse}`);
if (sweep.worse > 0) bad(`มี ${sweep.worse} ฐานกล่องที่เลนทำให้ได้น้อยลง`);
if (sweep.better < 15) bad(`ควรดีขึ้นอย่างน้อย 15 ฐานกล่อง ได้ ${sweep.better}`);

// ── rotH=false ต้องปิดเลนรอง — การหันกล่องขวางคือการสลับ L↔W บนพื้น ซึ่งเป็นสิ่งที่ธง rotH คุม ──
const noRot = await p.evaluate(() => palBoxPlan(1200, 1000, 600, 400, false).lanes.length);
if (noRot !== 1) bad('rotH=false แต่ยังเปิดเลนรอง — ขัดกับที่ผู้ใช้ติ๊กออก');
else console.log('  ✓ rotH=false → เลนเดียว ไม่หมุนกล่อง');

console.log('\npageerrors: ' + (errs.length ? errs.join(' | ') : '(none)'));
if (errs.length) fail++;
console.log(fail ? `\npack-lanes: ล้มเหลว ${fail} ข้อ` : '\npack-lanes: ผ่านทั้งหมด');
await b.close();
process.exit(fail ? 1 : 0);

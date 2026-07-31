// oracle อิสระสำหรับ "จำนวนพาเลทมากสุดที่วางบนพื้นตู้ได้จริง"
//
// ตั้งใจเขียนโดย **ไม่ยืมโค้ดจากแอปเลย** เพื่อให้เป็นคำตอบที่ตรวจสอบแอปได้จริง
// (ถ้า oracle ใช้ตัววางแผนตัวเดียวกับที่มันตรวจ ก็แค่ยืนยันว่าโค้ดเท่ากับตัวเอง)
//
//  • upperBound() = ขอบบนเชิงคณิตศาสตร์ (measure argument) — พิสูจน์ได้ ไม่ต้องค้นหา
//  • tryPack()    = ค้นหาการวางจริงแบบ exhaustive บน "normalized position"
//  • gridBest()   = grid ทิศเดียว (+ ใบท้ายตู้หันขวาง) = ความสามารถของแอปก่อนมีตัววางแผน
//
// ถ้า tryPack(n) สำเร็จ และ upperBound = n → n คือคำตอบที่ optimal พิสูจน์แล้ว

// ── ขอบบน ────────────────────────────────────────────────────────────────────
// พาเลททิศ A กว้าง a ยาว(ตามแนวกว้างตู้) b · ทิศ B สลับกัน
// ที่ตำแหน่ง x ใดๆ ถ้ามีพาเลททิศ A จำนวน i ใบ และทิศ B จำนวน j ใบ ต้องได้ i·b + j·a ≤ W
// อินทิเกรตจำนวนใบตามความยาว:  n = ∫(i/a + j/b)dx ≤ L × max{ i/a + j/b }
export function upperBound(L, W, a, b) {
  let best = 0;
  for (let i = 0; i * b <= W; i++)
    for (let j = 0; i * b + j * a <= W; j++) best = Math.max(best, i / a + j / b);
  return Math.floor(L * best + 1e-9);
}

// ── grid ทิศเดียว + ใบท้ายตู้หันขวาง (ความสามารถเดิมของแอป ใช้เทียบว่าดีขึ้นแค่ไหน) ──
export function gridBest(L, W, a, b, allowRot = true) {
  let best = 0;
  for (const [d0, d1] of [[a, b], [b, a]]) {
    const per = Math.floor(L / d0), rows = Math.floor(W / d1);
    if (per < 1 || rows < 1) continue;
    const tail = L - per * d0;
    const extra = (allowRot && tail >= d1 && d0 <= W) ? Math.floor(W / d0) : 0;
    best = Math.max(best, per * rows + extra);
  }
  return best;
}

// ── ค้นหาการวางจริง ──────────────────────────────────────────────────────────
// ทุก packing สามารถ "ดันชิดซ้ายและชิดล่าง" ได้จนขอบซ้ายของทุกใบชนผนังหรือชนขอบขวาของใบอื่น
// และขอบล่างชนพื้นหรือชนขอบบนของใบอื่น (ดันลง/ดันซ้ายสลับกันจนหยุด — พิกัดลดลงเรื่อยๆ จึงจบ)
// ดังนั้นค้นหาแค่ตำแหน่งแบบนั้นก็ครอบทุก packing ที่เป็นไปได้ · วางตามลำดับ lexicographic (x,y)
// เพื่อไม่ให้นับ packing เดิมซ้ำจากการสลับลำดับใบ (พาเลททุกใบเหมือนกัน)
export function tryPack(L, W, a, b, target, nodeCap = 3e6) {
  const orients = a === b ? [[a, b]] : [[a, b], [b, a]];
  const area = a * b;
  const placed = [];
  let nodes = 0, solution = null;

  const freeAreaFrom = (x) => {
    let used = 0;
    for (const p of placed) used += Math.max(0, Math.min(p.x + p.w, L) - Math.max(p.x, x)) * p.h;
    return (L - x) * W - used;
  };
  const overlaps = (x, y, w, h) => placed.some(p =>
    x < p.x + p.w && p.x < x + w && y < p.y + p.h && p.y < y + h);

  function dfs(lastX, lastY) {
    if (placed.length === target) { solution = placed.map(p => ({ ...p })); return true; }
    if (nodes++ > nodeCap) return false;
    const need = target - placed.length;
    if (need * area > freeAreaFrom(lastX) + 1e-9) return false;
    const xs = [...new Set([0, ...placed.map(p => p.x + p.w)])].sort((m, n) => m - n);
    const ys = [...new Set([0, ...placed.map(p => p.y + p.h)])].sort((m, n) => m - n);
    for (const x of xs) {
      if (x < lastX) continue;
      if (need * area > freeAreaFrom(x) + 1e-9) break;      // ยิ่งไปทางขวายิ่งแคบ ตัดได้เลย
      for (const y of ys) {
        if (x === lastX && y <= lastY) continue;
        for (const [w, h] of orients) {
          if (x + w > L || y + h > W) continue;
          if (overlaps(x, y, w, h)) continue;
          if (x > 0 && !placed.some(p => p.x + p.w === x && y < p.y + p.h && p.y < y + h)) continue;
          if (y > 0 && !placed.some(p => p.y + p.h === y && x < p.x + p.w && p.x < x + w)) continue;
          placed.push({ x, y, w, h });
          if (dfs(x, y)) return true;
          placed.pop();
        }
      }
    }
    return false;
  }
  const ok = dfs(0, -1);
  return { ok, solution, nodes, capped: nodes > nodeCap };
}

// จำนวนมากสุดที่ยืนยันได้ (ไล่ขึ้นจาก from จนกว่าจะวางไม่ได้) — คืน {n, proven}
// proven=true หมายถึง "n+1 วางไม่ได้จริงโดยค้นครบ" ไม่ใช่แค่ค้นไม่เจอเพราะหมดงบ
export function searchMax(L, W, a, b, from = 1, nodeCap = 3e6) {
  let n = from, proven = false;
  for (;;) {
    const r = tryPack(L, W, a, b, n + 1, nodeCap);
    if (r.ok) { n++; continue; }
    proven = !r.capped;
    break;
  }
  return { n, proven };
}

export const CONTAINERS = [
  { id: '20GP', L: 5895, W: 2350 }, { id: '40HC', L: 12192, W: 2350 },
  { id: '20RF', L: 5455, W: 2290 }, { id: '40RF', L: 11550, W: 2290 },
  { id: 'T18W', L: 12000, W: 2400 }, { id: 'T10W', L: 8000, W: 2300 },
  { id: 'T6WL', L: 7000, W: 2200 }, { id: 'T6WS', L: 5500, W: 2100 },
  { id: 'T4W', L: 4000, W: 1900 }, { id: 'TPK', L: 1800, W: 1500 },
];
export const PRESETS = [
  { k: 'standard 1200x1000', L: 1200, W: 1000 }, { k: 'euro 1200x800', L: 1200, W: 800 },
  { k: 'asia 1100x1100', L: 1100, W: 1100 }, { k: 'us 1219x1016', L: 1219, W: 1016 },
];

// ── จำนวนที่ยืนยันแล้วว่าวางได้จริง (วัดด้วย tryPack ทุกค่าในตารางนี้ ไม่ได้ก็อปจากผลของแอป) ──
// ใช้เป็น ratchet: แอปต้องทำได้ **ไม่น้อยกว่านี้** และต้องไม่เกิน upperBound
// 25 จาก 40 คู่นี้มากกว่าที่ grid ทิศเดียวทำได้ — คือช่องว่างที่ตัววางแผนแบบสลับทิศปิดไป
export const KNOWN_MAX = {
  '20GP|standard 1200x1000': 10, '20GP|euro 1200x800': 11, '20GP|asia 1100x1100': 10, '20GP|us 1219x1016': 10,
  '40HC|standard 1200x1000': 22, '40HC|euro 1200x800': 25, '40HC|asia 1100x1100': 22, '40HC|us 1219x1016': 22,
  '20RF|standard 1200x1000': 9, '20RF|euro 1200x800': 10, '20RF|asia 1100x1100': 8, '20RF|us 1219x1016': 9,
  '40RF|standard 1200x1000': 20, '40RF|euro 1200x800': 23, '40RF|asia 1100x1100': 20, '40RF|us 1219x1016': 20,
  'T18W|standard 1200x1000': 24, 'T18W|euro 1200x800': 30, 'T18W|asia 1100x1100': 20, 'T18W|us 1219x1016': 21,
  'T10W|standard 1200x1000': 14, 'T10W|euro 1200x800': 16, 'T10W|asia 1100x1100': 14, 'T10W|us 1219x1016': 14,
  'T6WL|standard 1200x1000': 12, 'T6WL|euro 1200x800': 14, 'T6WL|asia 1100x1100': 12, 'T6WL|us 1219x1016': 10,
  'T6WS|standard 1200x1000': 8, 'T6WS|euro 1200x800': 10, 'T6WS|asia 1100x1100': 5, 'T6WS|us 1219x1016': 8,
  'T4W|standard 1200x1000': 4, 'T4W|euro 1200x800': 6, 'T4W|asia 1100x1100': 3, 'T4W|us 1219x1016': 3,
  'TPK|standard 1200x1000': 1, 'TPK|euro 1200x800': 2, 'TPK|asia 1100x1100': 1, 'TPK|us 1219x1016': 1,
};

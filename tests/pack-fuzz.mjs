import { chromium } from 'playwright';
const N = Number(process.argv[2] || 400);
const b = await chromium.launch();
const p = await b.newPage();
const pageErrs = [];
p.on('pageerror', e => pageErrs.push(e.message));
await p.goto('http://localhost:3000/container-loading-calculator.html', { waitUntil: 'load' });
await p.waitForTimeout(1500);

const res = await p.evaluate((N) => {
  // PRNG แบบมี seed เพื่อให้เคสที่พังกลับมาทำซ้ำได้ (mulberry32)
  const rng = (s) => () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const PAL_PRESETS = [{ L: 1200, W: 1000 }, { L: 1200, W: 800 }, { L: 1219, W: 1016 }];
  const COL = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7e22ce', '#0891b2'];
  const TYPES = ['box', 'box', 'box', 'drum', 'roll', 'pipe'];

  const violations = [];
  let ok = 0;

  for (let seed = 1; seed <= N; seed++) {
    const R = rng(seed);
    const pick = a => a[Math.floor(R() * a.length)];
    const ri = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
    const c = pick(CONTAINERS);
    const nSku = ri(1, 6);
    const mixMode = R() < 0.35;   // true = สุ่ม usePallet แยกต่อ SKU
    const usePalAll = R() < 0.4;
    const items = [];
    for (let i = 0; i < nSku; i++) {
      const ty = pick(TYPES);
      const up = mixMode ? (R() < 0.5) : usePalAll;
      const pp = pick(PAL_PRESETS);   // ต่าง SKU อาจได้พาเลทคนละขนาด (จำลองหลาย group)
      items.push({
        type: ty, name: 'S' + i, L: ri(15, 120), W: ri(10, 90), H: ri(8, 110), D: ri(20, 90),
        weight: ri(1, 40), pieces: 1, pcsPerCtn: 1, qty: pick([1, 5, 40, 200, 800, 3000]),
        color: COL[i % COL.length],
        rotL: R() < 0.8, rotW: R() < 0.8, rotH: R() < 0.8,
        maxLayers: R() < 0.35 ? ri(1, 5) : 0, maxH2: R() < 0.25 ? ri(50, 200) : 0,
        maxWt: 0, hexPack: R() < 0.5,
        usePallet: up,
        pallet: up ? { presetKey: 'x', L: pp.L, W: pp.W, H: ri(60, 260) * 10, D: pick([100, 150, 200]), maxW: 1500, tare: 5.2, color: '#8d6e63' } : null,
      });
    }
    let r, lay;
    try { r = buildResult(c, items); lay = packLayout(r); }
    catch (e) { violations.push({ seed, kind: 'THREW', msg: e.message, cont: c.id, nSku, mixMode }); continue; }
    if (!lay) { violations.push({ seed, kind: 'NO_LAYOUT', cont: c.id }); continue; }

    const blocks = lay.blocks, boxes = blocks.filter(x => !x.isPallet), decks = blocks.filter(x => x.isPallet);
    const bad = [];
    blocks.forEach((x, i) => {
      if (!(x.x0 >= -0.01 && x.x0 + x.L <= c.L + 0.01)) bad.push('bounds-x');
      if (!(x.y0 >= -0.01 && x.y0 + x.W <= c.W + 0.01)) bad.push('bounds-y');
      if (!(x.z0 >= -0.01 && x.z0 + x.H <= c.H + 0.01)) bad.push('bounds-z');
      if (!(x.L > 0 && x.W > 0 && x.H > 0)) bad.push('degenerate');
    });
    const ov3 = (a, d) => Math.min(a.x0 + a.L, d.x0 + d.L) - Math.max(a.x0, d.x0) > 0.01
                       && Math.min(a.y0 + a.W, d.y0 + d.W) - Math.max(a.y0, d.y0) > 0.01
                       && Math.min(a.z0 + a.H, d.z0 + d.H) - Math.max(a.z0, d.z0) > 0.01;
    for (let i = 0; i < blocks.length && bad.indexOf('intersect') < 0; i++)
      for (let j = i + 1; j < blocks.length; j++) if (ov3(blocks[i], blocks[j])) { bad.push('intersect'); break; }
    const deckTops = new Set(decks.map(d => d.z0 + d.H));
    boxes.forEach(bx => {
      if (bx.z0 < 0.01 || deckTops.has(bx.z0)) return;
      const sup = blocks.some(o => o !== bx && Math.abs(o.z0 + o.H - bx.z0) < 0.01
        && Math.min(o.x0 + o.L, bx.x0 + bx.L) - Math.max(o.x0, bx.x0) > 0.01
        && Math.min(o.y0 + o.W, bx.y0 + bx.W) - Math.max(o.y0, bx.y0) > 0.01);
      if (!sup) bad.push('floating');
    });
    const perColor = {};
    boxes.forEach(bx => { perColor[bx.color] = (perColor[bx.color] || 0) + (bx.nL || 1) * (bx.nW || 1) * (bx.nH || 1); });
    items.forEach((it, idx) => {
      const st = lay.stats[idx] || { placed: 0, layers: 0 };
      if ((perColor[it.color] || 0) !== st.placed) bad.push('count-mismatch');
      if (st.placed > r.items[idx].needed) bad.push('over-placed');
      if (it.maxLayers > 0 && st.layers > it.maxLayers) bad.push('maxLayers-violated');
    });
    if (bad.length) violations.push({ seed, kinds: [...new Set(bad)], cont: c.id, nSku, mixMode,
      items: items.map(i => `${i.type} ${i.L}x${i.W}x${i.H} q${i.qty} ml${i.maxLayers} mh${i.maxH2} pal${i.usePallet?(i.pallet.L+'x'+i.pallet.W+'h'+i.pallet.H):'-'}`) });
    else ok++;
  }
  return { ok, violations };
}, N);

console.log(`fuzz ${N} เคส → ผ่าน ${res.ok} | พบปัญหา ${res.violations.length}`);
const byKind = {};
res.violations.forEach(v => (v.kinds || [v.kind]).forEach(k => byKind[k] = (byKind[k] || 0) + 1));
console.log('แยกตามชนิด:', JSON.stringify(byKind));
res.violations.slice(0, 6).forEach(v => console.log('  seed=' + v.seed, JSON.stringify(v)));
console.log('pageerrors:', pageErrs.length ? [...new Set(pageErrs)].join(' | ') : '(none)');
await b.close();

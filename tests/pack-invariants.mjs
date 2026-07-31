import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
const pageErrs = [];
p.on('pageerror', e => pageErrs.push(e.message));
await p.goto('http://localhost:3000/container-loading-calculator.html', { waitUntil: 'load' });
await p.waitForTimeout(1500);

const out = await p.evaluate(() => {
  const PAL = { presetKey: 'standard', L: 1200, W: 1000, H: 2000, D: 150, maxW: 1500, tare: 5.2, color: '#8d6e63' };
  const COL = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7e22ce', '#0891b2', '#be123c', '#4d7c0f'];
  const mk = (o, i) => ({
    type: o.type || 'box', name: o.name || ('S' + i), L: o.L, W: o.W, H: o.H, D: o.D || 20,
    weight: o.weight || 5, pieces: 1, pcsPerCtn: 1, qty: o.qty, color: COL[i % COL.length],
    rotL: o.rotL !== false, rotW: o.rotW !== false, rotH: o.rotH !== false,
    maxLayers: o.maxLayers || 0, maxH2: o.maxH2 || 0, maxWt: 0, hexPack: !!o.hexPack,
    usePallet: !!o.usePallet, pallet: o.usePallet ? { ...PAL } : null,
  });

  const scen = [];
  const add = (name, contId, items) => scen.push({ name, contId, items: items.map(mk) });

  // ── std path (no pallet) ──
  add('std 1 SKU exact fit', '20GP', [{ L: 40, W: 30, H: 25, qty: 500 }]);
  add('std 1 SKU overflow', '20GP', [{ L: 60, W: 50, H: 40, qty: 5000 }]);
  add('std 3 SKU mixed sizes', '40HC', [
    { L: 60, W: 45, H: 38, qty: 300 }, { L: 35, W: 30, H: 22, qty: 800 }, { L: 90, W: 25, H: 25, qty: 200 }]);
  add('std 5 SKU odd sizes', '40RF', [
    { L: 53, W: 37, H: 29, qty: 400 }, { L: 41, W: 41, H: 41, qty: 250 }, { L: 77, W: 23, H: 19, qty: 600 },
    { L: 31, W: 28, H: 47, qty: 300 }, { L: 65, W: 55, H: 15, qty: 150 }]);
  add('std no rotation allowed', '20GP', [{ L: 55, W: 45, H: 35, qty: 400, rotL: false, rotW: false, rotH: false }]);
  add('std maxLayers=1', '20GP', [{ L: 40, W: 30, H: 25, qty: 400, maxLayers: 1 }]);
  add('std maxLayers=3 + maxH2', '40HC', [{ L: 40, W: 30, H: 25, qty: 900, maxLayers: 3, maxH2: 120 }]);
  add('std box taller than container', '20GP', [{ L: 40, W: 30, H: 300, qty: 10 }]);
  add('std box wider than container', '20GP', [{ L: 40, W: 300, H: 25, qty: 10 }]);
  add('std qty 1', '20GP', [{ L: 40, W: 30, H: 25, qty: 1 }]);
  add('std drum hex', '40HC', [{ type: 'drum', D: 58, H: 90, qty: 300, hexPack: true }]);
  add('std roll', '40HC', [{ type: 'roll', L: 200, D: 40, H: 40, qty: 120 }]);
  add('std drum+box', '40HC', [{ type: 'drum', D: 60, H: 85, qty: 100 }, { L: 45, W: 35, H: 30, qty: 400 }]);

  // ── pallet path ──
  add('pal 1 SKU', '20GP', [{ L: 40, W: 30, H: 25, qty: 400, usePallet: true }]);
  add('pal 2 SKU', '20GP', [{ L: 40, W: 30, H: 25, qty: 400, usePallet: true }, { L: 50, W: 40, H: 30, qty: 100, usePallet: true }]);
  add('pal 3 SKU 40HC', '40HC', [
    { L: 40, W: 30, H: 25, qty: 900, usePallet: true }, { L: 50, W: 40, H: 30, qty: 300, usePallet: true },
    { L: 30, W: 20, H: 15, qty: 500, usePallet: true }]);
  add('pal maxLayers=2', '20GP', [{ L: 40, W: 30, H: 25, qty: 300, usePallet: true, maxLayers: 2 }]);

  // ── MIXED: pallet + std in the same container ──
  add('MIX pal+std', '40HC', [
    { L: 40, W: 30, H: 25, qty: 300, usePallet: true }, { L: 55, W: 40, H: 35, qty: 300 }]);
  add('MIX pal+std+drum', '40HC', [
    { L: 40, W: 30, H: 25, qty: 200, usePallet: true }, { L: 50, W: 35, H: 30, qty: 250 },
    { type: 'drum', D: 55, H: 80, qty: 60 }]);

  // ── พาเลทหลายสเปคในตู้เดียว (pallet ผูกกับ group ผู้ใช้ตั้งคนละขนาดได้) ──
  const mkPal = (L,W,H,D,tare,color) => ({presetKey:'x',L,W,H,D,maxW:1500,tare,color});
  const mk2 = (o,i,pal) => { const x = mk(o,i); x.usePallet = true; x.pallet = pal; return x; };
  scen.push({name:'MULTIPAL 2 specs', contId:'40HC', items:[
    mk2({L:40,W:30,H:25,qty:400},0, mkPal(1200,1000,2000,150,5.2,'#8d6e63')),
    mk2({L:35,W:25,H:20,qty:300},1, mkPal(800,600,1000,100,3.0,'#a1887f'))]});
  scen.push({name:'MULTIPAL 3 specs + std', contId:'40HC', items:[
    mk2({L:40,W:30,H:25,qty:200},0, mkPal(1200,1000,2000,150,5.2,'#8d6e63')),
    mk2({L:30,W:25,H:20,qty:200},1, mkPal(1000,800,1400,120,4.0,'#a1887f')),
    mk2({L:25,W:20,H:15,qty:200},2, mkPal(600,400,800,80,2.0,'#6d4c41')),
    mk({L:50,W:40,H:35,qty:150},3)]});
  scen.push({name:'MULTIPAL tiny truck', contId:'TPK', items:[
    mk2({L:30,W:20,H:15,qty:100},0, mkPal(800,600,600,100,3.0,'#8d6e63')),
    mk2({L:25,W:15,H:10,qty:100},1, mkPal(600,400,400,80,2.0,'#a1887f'))]});

  ['20GP','40HC','20RF','40RF','T18W','T10W','T6WL','T6WS','T4W','TPK'].forEach(id=>{
    add('ALL '+id+' std 2SKU', id, [{L:45,W:35,H:30,qty:600},{L:33,W:24,H:19,qty:400}]);
    add('ALL '+id+' pallet', id, [{L:40,W:30,H:25,qty:600,usePallet:true}]);
  });

  const results = [];
  scen.forEach(sc => {
    const c = CONTAINERS.find(x => x.id === sc.contId);
    let r, lay, err = null;
    try { r = buildResult(c, sc.items); lay = packLayout(r); }
    catch (e) { err = e.message; }
    if (err) { results.push({ name: sc.name, error: err }); return; }
    results.push({
      name: sc.name, cont: { L: c.L, W: c.W, H: c.H },
      colorToIdx: sc.items.map((it, i) => ({ color: it.color, idx: i })),
      stats: lay.stats,
      needed: r.items.map(ir => ir.needed),
      effH: r.items.map((ir, i) => {
        const it = ir.item; const palD = it.usePallet && it.pallet ? (it.pallet.D || 150) : 0;
        let e = c.H - palD;
        if (it.usePallet && it.pallet && (it.pallet.H || 0) > palD) e = Math.min(e, (it.pallet.H || 0) - palD);
        if (it.maxH2 > 0) e = Math.min(e, it.maxH2 * 10);
        return e;
      }),
      maxLayers: sc.items.map(it => it.maxLayers || 0),
      frames: r._palletFrames || [],
      blocks: lay.blocks.map(bl => ({ x0: bl.x0, y0: bl.y0, z0: bl.z0, L: bl.L, W: bl.W, H: bl.H,
        nL: bl.nL, nW: bl.nW, nH: bl.nH, isPallet: !!bl.isPallet, color: bl.color })),
    });
  });
  return results;
});

let totalFail = 0;
const summary = [];
for (const R of out) {
  const fail = [];
  if (R.error) { summary.push(`✗ ${R.name}: THREW ${R.error}`); totalFail++; continue; }
  const { cont, blocks, frames } = R;
  const boxes = blocks.filter(b => !b.isPallet);
  const decks = blocks.filter(b => b.isPallet);
  const ck = (c, m) => { if (!c) fail.push(m); };

  // 1) bounds
  blocks.forEach((b, i) => {
    ck(b.x0 >= -0.01 && b.x0 + b.L <= cont.L + 0.01, `bounds-x #${i} ${b.x0}..${b.x0 + b.L} > ${cont.L}`);
    ck(b.y0 >= -0.01 && b.y0 + b.W <= cont.W + 0.01, `bounds-y #${i} ${b.y0}..${b.y0 + b.W} > ${cont.W}`);
    ck(b.z0 >= -0.01 && b.z0 + b.H <= cont.H + 0.01, `bounds-z #${i} ${b.z0}..${b.z0 + b.H} > ${cont.H}`);
    ck(b.L > 0 && b.W > 0 && b.H > 0, `degenerate #${i} ${b.L}x${b.W}x${b.H}`);
  });
  // 2) no 3D intersections at all (decks + boxes together)
  const ov3 = (a, b) => Math.min(a.x0 + a.L, b.x0 + b.L) - Math.max(a.x0, b.x0) > 0.01
                     && Math.min(a.y0 + a.W, b.y0 + b.W) - Math.max(a.y0, b.y0) > 0.01
                     && Math.min(a.z0 + a.H, b.z0 + b.H) - Math.max(a.z0, b.z0) > 0.01;
  let inter = 0;
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) if (ov3(blocks[i], blocks[j])) inter++;
  ck(inter === 0, `${inter} block pairs INTERSECT in 3D`);
  // 3) no floating: supported by floor(0), a deck top, or another box
  const deckTops = new Set(decks.map(d => d.z0 + d.H));
  boxes.forEach((bx, i) => {
    if (bx.z0 < 0.01) return;
    if (deckTops.has(bx.z0)) return;
    const sup = blocks.some(o => o !== bx && Math.abs(o.z0 + o.H - bx.z0) < 0.01
      && Math.min(o.x0 + o.L, bx.x0 + bx.L) - Math.max(o.x0, bx.x0) > 0.01
      && Math.min(o.y0 + o.W, bx.y0 + bx.W) - Math.max(o.y0, bx.y0) > 0.01);
    ck(sup, `FLOATING box #${i} z0=${bx.z0}`);
  });
  // 4) carton count in blocks must equal stats.placed, per SKU
  const perColor = {};
  boxes.forEach(bx => { perColor[bx.color] = (perColor[bx.color] || 0) + (bx.nL || 1) * (bx.nW || 1) * (bx.nH || 1); });
  R.colorToIdx.forEach(({ color, idx }) => {
    const drawn = perColor[color] || 0;
    const placed = R.stats[idx] ? R.stats[idx].placed : 0;
    ck(drawn === placed, `SKU${idx} drawn=${drawn} but stats.placed=${placed}`);
    ck(placed <= R.needed[idx], `SKU${idx} placed=${placed} > needed=${R.needed[idx]}`);
  });
  // 5) layers reported must not exceed what the height/maxLayers physically allows
  R.colorToIdx.forEach(({ idx }) => {
    const st = R.stats[idx]; if (!st || !st.placed) return;
    const cap = R.maxLayers[idx] > 0 ? R.maxLayers[idx] : Infinity;
    ck(st.layers <= cap, `SKU${idx} layers=${st.layers} > maxLayers=${cap}`);
  });
  // 6) real max stack depth per SKU must match reported layers
  R.colorToIdx.forEach(({ color, idx }) => {
    const st = R.stats[idx]; if (!st || !st.placed) return;
    const mine = boxes.filter(b => b.color === color);
    const zs = [...new Set(mine.map(b => b.z0))];
    ck(st.layers <= zs.length, `SKU${idx} layers=${st.layers} but only ${zs.length} distinct z levels drawn`);
  });

  if (fail.length) { totalFail += fail.length; summary.push(`✗ ${R.name}  (${fail.length})`); [...new Set(fail)].slice(0, 6).forEach(f => summary.push(`      ${f}`)); }
  else summary.push(`✓ ${R.name}`);
}
console.log(summary.join('\n'));
console.log(`\n================\nscenarios=${out.length}  violations=${totalFail}`);
console.log('pageerrors:', pageErrs.length ? [...new Set(pageErrs)].join(' | ') : '(none)');
await b.close();

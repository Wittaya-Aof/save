const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const {test}=require('node:test');
const html=fs.readFileSync(require('node:path').join(__dirname,'../container-loading-calculator.html'),'utf8');
const code=html.slice(html.indexOf('var groups='),html.lastIndexOf('</script>')).replace(/\binit\(\);\s*$/,'');
const ctx=vm.createContext({console,document:{getElementById:()=>({addEventListener(){}})},window:{addEventListener(){}},localStorage:{getItem:()=>null},setTimeout:()=>0});vm.runInContext(code,ctx);
const cargo=(extra={})=>({type:'box',name:'A',L:40,W:30,H:25,weight:60,qty:500,pieces:500,pcsPerCtn:1,color:'#123456',rotL:true,rotW:true,rotH:true,maxLayers:0,maxWt:0,...extra});
const c=ctx.CONTAINERS.find(x=>x.id==='20GP');
test('payload splits reviewed 30 tonne cargo into safe physical units',()=>{const r=ctx.buildResult(c,[cargo()]);assert.equal(r.allFit,false);assert.ok(r.totWt<=c.maxW);assert.equal(r.geometryAllFit,true);const chain=ctx.chainResults([c],[cargo()]);assert.equal(chain.length,2);assert.equal(chain.reduce((n,r)=>n+r.totPkg,0),500);assert.ok(chain.every(r=>r.totWt<=c.maxW));});
test('item max total weight constrains per-unit placement',()=>{const r=ctx.buildResult(c,[cargo({weight:10,qty:50,maxWt:100})]);assert.equal(r.items[0].packed,10);assert.equal(r.allFit,false);});
test('pallet maximum and tare constrain packing and reported payload',()=>{const it=cargo({weight:60,qty:30,usePallet:true,pallet:{L:1200,W:1000,H:2000,D:150,maxW:130,tare:10,color:'#765432'}});const r=ctx.buildResult(c,[it]);assert.ok(r._palletManifest.length);assert.ok(r._palletManifest.every(p=>p.gw<=130));assert.equal(r.totWt,r.items[0].wt+r._palletManifest.reduce((n,p)=>n+p.tare,0));});
test('weight-unconstrained capacity and layout counts remain intact',()=>{const r=ctx.buildResult(c,[cargo({weight:1})]);assert.equal(r.allFit,true);assert.equal(r.items[0].packed,500);assert.equal(ctx.packLayout(r).stats[0].placed,500);});
test('pallet whose tare exceeds its maximum cannot carry even zero-weight cargo',()=>{const r=ctx.buildResult(c,[cargo({weight:0,qty:1,usePallet:true,pallet:{L:1200,W:1000,H:2000,D:150,maxW:5,tare:10}})]);assert.equal(r.totPkg,0);assert.equal(r.allFit,false);});
test('weight constrained mixed packing retains geometry, manifest counts and support',()=>{
  for(let i=1;i<=30;i++){
    const items=[cargo({name:'A',qty:30+i,weight:30+i,color:'#123456',usePallet:true,pallet:{L:1200,W:1000,H:2000,D:150,maxW:100+i,tare:10}}),cargo({name:'B',qty:10+i,weight:20+i,color:'#abcdef',maxWt:150})];
    const r=ctx.buildResult({...c,maxW:500+i},items),layout=ctx.packLayout(r);
    assert.ok(r.totWt<=500+i);assert.ok(r._palletManifest.every(p=>p.gw<=100+i));assert.ok(r.items[1].wt<=150);
    for(const b of layout.blocks){assert.ok(b.x0>=0&&b.x0+b.L<=c.L+.01&&b.y0+b.W<=c.W+.01&&b.z0+b.H<=c.H+.01);if(!b.isPallet&&b.z0>0)assert.ok(layout.blocks.some(o=>o!==b&&Math.abs(o.z0+o.H-b.z0)<.01&&Math.min(o.x0+o.L,b.x0+b.L)>Math.max(o.x0,b.x0)&&Math.min(o.y0+o.W,b.y0+b.W)>Math.max(o.y0,b.y0)));}
    r.items.forEach((ir,n)=>assert.equal(layout.blocks.filter(b=>!b.isPallet&&b.color===ir.item.color).reduce((s,b)=>s+b.nL*b.nW*b.nH,0),ir.packed));
  }
});
module.exports={ctx,c,cargo};

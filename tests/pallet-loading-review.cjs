'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,mk,fullySupported}=require('./container-correctness.cjs');
const pal={L:1200,W:1000,H:2000,D:150,maxW:1500,tare:5.2};
const cargo=x=>mk({usePallet:true,pallet:pal,rotH:true,...x});
test('new cargo has unknown mass and requires explicit tipping permission',()=>{
 const c=fixture(),it=c.makeDefaultItem();assert.equal(it.weight,0);assert.equal(it.rotL,false);assert.equal(it.rotW,false);assert.equal(it.rotH,true);
});
test('explicit zero pallet tare remains zero',()=>{
 const c=fixture(),r=c.buildResult(c.CONTAINERS[0],[cargo({pallet:{...pal,tare:0}})]);assert.equal(r._palletManifest[0].tare,0);
});
test('mixed pallet places heavier cartons below light cartons with identical footprints',()=>{
 const c=fixture(),r=c.buildResult(c.CONTAINERS[0],[cargo({name:'Light',L:50,W:50,H:10,qty:20,weight:1}),cargo({name:'Heavy',L:50,W:50,H:10,weight:100,color:'#abcdef'})]);
 assert.equal(r._layout.blocks.find(b=>b.idx===1).z0,150);
 r._layout.blocks.forEach(b=>assert.ok(fullySupported(b,r._layout.blocks)));
});
test('known maximum top load is checked including zero; missing strength is pending',()=>{
 const c=fixture(),sea=c.CONTAINERS[0];
 const r=c.buildResult(sea,[cargo({L:100,W:100,H:50,qty:3,weight:10,maxTopLoad:5})]);
 assert.equal(r.loading.status,'blocked');assert.ok(r.loading.issues.some(x=>x.code==='carton-load'));
 const zero=c.buildResult(sea,[cargo({L:100,W:100,H:50,qty:2,maxTopLoad:0})]);assert.ok(zero.loading.issues.some(x=>x.code==='carton-load'));
 const unknown=c.buildResult(sea,[cargo()]);assert.ok(unknown.loading.issues.some(x=>x.code==='strength-unknown'));
});
test('pallet door passage uses both possible horizontal orientations and rejects too tall',()=>{
 const c=fixture(),sea={...c.CONTAINERS[0],doorW:1100,doorH:2100};
 const r=c.buildResult(sea,[cargo({L:100,W:100,H:220,pallet:{...pal,H:2392}})]);
 assert.ok(r.loading.issues.some(x=>x.code==='door-height'));
 const narrow=c.buildResult({...sea,doorW:900},[cargo()]);assert.ok(narrow.loading.issues.some(x=>x.code==='door-width'));
});
test('40HC uses carrier reference internal length and payload distinct from gross',()=>{
 const c=fixture(),hc=c.CONTAINERS.find(c=>c.id==='40HC');assert.equal(hc.L,12032);assert.equal(hc.maxW,hc.maxGross-hc.tare);assert.ok(hc.doorH<hc.H);
 assert.equal(c.buildResult(hc,[mk({L:1210,W:100,H:100,weight:1000})]).totPkg,0);
});
test('loose cartons exceeding the door are blocked even when they fit inside',()=>{
 const c=fixture(),r=c.buildResult(c.CONTAINERS[0],[mk({L:590,W:235.2,H:230,weight:10,maxTopLoad:0})]);
 assert.equal(r.totPkg,1);assert.equal(r.loading.status,'blocked');assert.ok(r.loading.issues.some(x=>x.code==='door-height'));
});
test('mass attribution uses SKU index, not display colour; screenshot counts and support preserved',()=>{
 const c=fixture(),r=c.buildResult(c.CONTAINERS[0],[cargo({name:'KMC088',L:30,W:20,H:13.5,qty:625,pieces:15000,pcsPerCtn:24,weight:5}),cargo({name:'SBB275',L:28,W:21,H:23.5,qty:667,pieces:8000,pcsPerCtn:12,weight:5})]);
 assert.equal(r.totPkg,1292);assert.ok(Math.abs(r.totWt-6506.8)<1e-6);assert.equal(r._palletManifest.length,9);
 assert.ok(r.loading.cg);assert.ok(Math.abs(r.loading.mass-r.totWt)<1e-6);
 assert.ok(Math.abs(r.loading.cg.y-r.c.W/2)<193.3);
 for(const b of r._layout.blocks)assert.ok(fullySupported(b,r._layout.blocks));
 const dup=c.buildResult(c.CONTAINERS[0],[cargo({weight:1}),cargo({weight:10})]);assert.ok(Math.abs(dup.loading.mass-dup.totWt)<1e-6);
});
test('top-load invalid numeric values rejected',()=>{
 const c=fixture();for(const maxTopLoad of [-1,NaN,Infinity])assert.throws(()=>c.buildResult(c.CONTAINERS[0],[cargo({maxTopLoad})]),/invalid/i);
});
test('CSV roundtrip preserves pallet specifications, zero tare and carton constraints',()=>{
 const c=fixture();let csv='';c.renderGroups=()=>{};
 c.document.createElement=tag=>tag==='a'?{href:'',click(){csv=decodeURIComponent(this.href.slice(this.href.indexOf(',')+1));}}:{click(){this.onchange({target:{files:[{text:csv}]}});}};
 c.FileReader=class{readAsText(f){this.onload({target:{result:f.text}});}};
 c.alert=()=>{};c.groups=[{name:'Mixed pallet',usePallet:true,pallet:{...pal,tare:0,D:120},items:[cargo({maxTopLoad:0,maxLayers:2,rotL:false,rotW:false,rotH:true})]}];
 c.doExport();c.groups=[];c.doImport();
 assert.equal(c.groups[0].usePallet,true);assert.equal(c.groups[0].pallet.tare,0);assert.equal(c.groups[0].pallet.D,120);
 assert.equal(c.groups[0].items[0].maxTopLoad,0);assert.equal(c.groups[0].items[0].maxLayers,2);assert.equal(c.groups[0].items[0].rotL,false);
});

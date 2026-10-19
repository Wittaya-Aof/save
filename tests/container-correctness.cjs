'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {test}=require('node:test');
const html=fs.readFileSync(path.join(__dirname,'../container-loading-calculator.html'),'utf8');
const code=html.slice(html.indexOf('var groups='),html.lastIndexOf('</script>')).replace(/\binit\(\);\s*$/,'');
function fixture(){
  const elements=new Map();
  const ctx=vm.createContext({console,document:{getElementById(id){if(!elements.has(id))elements.set(id,{innerHTML:'',addEventListener(){}});return elements.get(id);}},window:{addEventListener(){}},localStorage:{getItem:()=>null},setTimeout:()=>0,alert(){}});
  vm.runInContext(code,ctx);ctx.openCIPLModal=()=>{};return ctx;
}
const mk=(x={})=>({type:'box',name:'Fixture',L:40,W:30,H:25,D:20,weight:1,pieces:1,pcsPerCtn:1,qty:1,color:'#123456',rotL:false,rotW:false,rotH:false,maxLayers:0,maxH2:0,maxWt:0,hexPack:false,...x});
const pal={L:1200,W:1000,H:2000,D:150,maxW:1500,tare:5.2};
const {fullySupported}=require('./lib/packing-support.cjs');
test('C1 wide carton cannot balance on a narrow supporting strip',()=>{
  const c=fixture(),truck=c.CONTAINERS.find(x=>x.id==='TPK');
  const r=c.buildResult(truck,[mk({L:180,W:10,H:40,color:'#ff0000'}),mk({L:180,W:150,H:1,color:'#0000ff'})]);
  assert.equal(r.items[1].packed,0);assert.equal(r.allFit,false);
});
test('C1 mixed standard and pallet packing has complete footprint support',()=>{
  const c=fixture(),sea=c.CONTAINERS.find(x=>x.id==='20GP');
  for(const usePallet of [false,true])for(let n=1;n<=12;n++){
    const r=c.buildResult(sea,[mk({L:40,W:30,H:25,qty:20+n,pieces:20+n,usePallet,pallet:pal}),mk({L:50,W:40,H:30,qty:10+n,pieces:10+n,color:'#abcdef',usePallet,pallet:pal})]);
    for(const b of r._layout.blocks)assert.ok(fullySupported(b,r._layout.blocks),`unsupported ${JSON.stringify(b)}`);
  }
});
test('C2 table and CI/PL preserve the partial last carton',()=>{
  const c=fixture(),sea=c.CONTAINERS.find(x=>x.id==='20GP');
  const r=c.buildResult(sea,[mk({pieces:13,pcsPerCtn:12,qty:2})]);
  c.renderResults([r]);c.doExportCIPL(0);
  assert.equal(c.window._ciplDraft.data.items[0].qty_pcs,13);
  assert.match(c.document.getElementById('results-area').innerHTML,/<td class="r">13<\/td>/);
});
test('C2 chained load and pallet lots allocate the partial carton once',()=>{
  const c=fixture(),small={id:'fixture',L:400,W:300,H:250,maxW:100,vol:.03};
  const rr=c.chainResults([small],[mk({pieces:13,pcsPerCtn:12,qty:2})]);
  c.window._lastResults=rr;
  assert.deepEqual(Array.from(rr,(_,i)=>{c.doExportCIPL(i);return c.window._ciplDraft.data.items[0].qty_pcs;}),[12,1]);
  const sea=c.CONTAINERS.find(x=>x.id==='20GP');
  const r=c.buildResult(sea,[mk({pieces:13,pcsPerCtn:12,qty:2,usePallet:true,pallet:{...pal,L:400,W:300,H:400}})]);
  c.window._lastResults=[r];c.doExportCIPL(0);
  assert.equal(r._palletManifest.reduce((n,p)=>n+p.products[0].pcs,0),13);
  assert.equal(c.window._ciplDraft.data.items[0].lots.reduce((n,l)=>n+l.qty_pcs,0),13);
});
test('C3 mixed pallet SKU height limit applies above other SKUs and after repacking',()=>{
  const c=fixture(),sea=c.CONTAINERS.find(x=>x.id==='20GP');
  const r=c.buildResult(sea,[mk({name:'Bottom',H:100,qty:9,pieces:9,usePallet:true,pallet:pal}),mk({name:'Low ceiling',H:25,maxH2:25,usePallet:true,pallet:pal,color:'#abcdef'})]);
  assert.equal(r.items[1].packed,1);
  for(const b of r._layout.blocks.filter(b=>b.color==='#abcdef'))assert.ok(b.z0+b.H<=400,'SKU top exceeds deck + 250mm');
});
test('C4 selected later vehicle is attempted after an empty earlier vehicle',()=>{
  const c=fixture(),pickup=c.CONTAINERS.find(x=>x.id==='TPK'),sea=c.CONTAINERS.find(x=>x.id==='40HC');
  const r=c.chainResults([pickup,sea],[mk({L:200,W:100,H:60})]);
  assert.equal(r.reduce((n,x)=>n+x.totPkg,0),1);assert.equal(r.at(-1).c.id,'40HC');
  assert.equal(c.chainResults([pickup],[mk({L:200,W:100,H:60})]).length,1);
});
test('C5 drum prediction respects allowed rotations and actual orientation',()=>{
  const c=fixture(),sea=c.CONTAINERS.find(x=>x.id==='20GP');
  const fixed=mk({type:'drum',D:60,H:250});
  assert.equal(c.calcFit(fixed,sea).fits,0);
  const rot={...fixed,rotW:true,qty:18,pieces:18};
  const r=c.buildResult(sea,[rot]);assert.equal(c.calcFit(rot,sea).fits,18);assert.equal(r.totPkg,18);
  for(const b of r._layout.blocks)assert.ok(b.z0+b.H<=sea.H);
});
test('C6 actual CSV export and import roundtrip punctuation newlines BOM and legacy fields',()=>{
  const c=fixture(),name='A "quoted"\nname',group='Oil, fresh';
  let csv='';
  c.document.createElement=(tag)=>tag==='a'?{href:'',click(){csv=decodeURIComponent(this.href.slice(this.href.indexOf(',')+1));}}:{click(){this.onchange({target:{files:[{text:csv}]}});}};
  c.FileReader=class {readAsText(f){this.onload({target:{result:f.text}});}};
  c.renderGroups=()=>{};
  c.groups=[{name:group,items:[mk({name,pieces:13,pcsPerCtn:12,qty:2})]}];
  c.doExport();c.groups=[];c.doImport();
  assert.equal(c.groups[0].name,group);assert.equal(c.groups[0].items[0].name,name);
  assert.equal(c.groups[0].items[0].pieces,13);assert.equal(c.groups[0].items[0].pcsPerCtn,12);
  csv='\ufeffGroup,Type,Name,L,W,H,D,Weight,Qty,Color\r\n__proto__,box,Legacy,40,30,25,20,0,3,#123456\r\n';
  c.groups=[];c.doImport();assert.equal(c.groups[0].name,'__proto__');assert.equal(c.groups[0].items[0].qty,3);assert.equal(c.groups[0].items[0].weight,0);
});
test('C7 invalid cargo and vehicle values cannot bypass payload validation',()=>{
  const c=fixture(),sea=c.CONTAINERS.find(x=>x.id==='20GP');
  for(const bad of [{weight:-100},{weight:NaN},{weight:Infinity},{L:Infinity},{H:-1},{qty:1.5},{pieces:-1},{pcsPerCtn:0},{maxWt:-1},{usePallet:true,pallet:{...pal,tare:-100}}]){
    assert.throws(()=>c.buildResult(sea,[mk(bad)]),/invalid|finite|positive|negative/i,JSON.stringify(bad));
  }
  for(const maxW of [-100,NaN,Infinity])assert.throws(()=>c.buildResult({...sea,maxW},[mk()]),/invalid|finite|positive/i);
});
test('C7 unknown weight remains visibly unconfirmed and is never recommended safe',()=>{
  const c=fixture(),sea=c.CONTAINERS.find(x=>x.id==='20GP'),r=c.buildResult(sea,[mk({weight:0})]);
  assert.equal(r.weightValid,null);assert.equal(r.allFit,false);c.LANG='en';c.renderResults([r]);
  assert.match(c.document.getElementById('results-area').innerHTML,/weight.*(?:unknown|not provided|unconfirmed)/i);
});
module.exports={fixture,mk,fullySupported};

'use strict';
// Independent coverage oracle: slice the upper footprint by every supporting x edge,
// then require the union of touching y intervals to cover each complete slice.
function fullySupported(b,blocks){
  if(b.z0===0)return true;
  const ss=blocks.filter(o=>o!==b&&Math.abs(o.z0+o.H-b.z0)<.001&&o.x0<b.x0+b.L&&o.x0+o.L>b.x0&&o.y0<b.y0+b.W&&o.y0+o.W>b.y0);
  const xs=[b.x0,b.x0+b.L,...ss.flatMap(o=>[Math.max(b.x0,o.x0),Math.min(b.x0+b.L,o.x0+o.L)])].sort((a,b)=>a-b);
  for(let i=1;i<xs.length;i++){
    if(xs[i]-xs[i-1]<.001)continue;
    const ys=ss.filter(o=>o.x0<=xs[i-1]+.001&&o.x0+o.L>=xs[i]-.001).map(o=>[o.y0,o.y0+o.W]).sort((a,b)=>a[0]-b[0]);
    let y=b.y0;
    for(const [lo,hi] of ys){if(lo>y+.001)break;y=Math.max(y,hi);}
    if(y<b.y0+b.W-.001)return false;
  }
  return true;
}
module.exports={fullySupported};

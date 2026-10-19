'use strict';
// Intercepts EVERY request before a socket can be opened, including the legacy
// suites' hardcoded URL. Writes only to this in-memory fixture collection.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
function fixtureRouter(){
  let quotes=[];let pending=null;let revision=0;
  const fixture=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/kyoei-extract.json'),'utf8'));
  async function route(requestRoute){
    const request=requestRoute.request(),url=new URL(request.url());
    const json=body=>requestRoute.fulfill({json:body});
    if(url.pathname==='/freight-comparison.html')return requestRoute.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'freight-comparison.html'),'utf8')});
    if(url.pathname==='/vendor/auth.js')return requestRoute.fulfill({contentType:'application/javascript',body:''});
    if(url.pathname==='/vendor/xlsx.full.min.js')return requestRoute.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(root,'vendor/xlsx.full.min.js'),'utf8')});
    if(url.pathname==='/api/me')return json({ok:true,canWrite:true,role:'admin'});
    if(url.pathname==='/api/fx-rates')return json({ok:true,rows:[{currency:'USD',company_id:1,thb_per_unit:33,as_of:'2026-10-19'}]});
    if(url.pathname==='/api/import-pos'||url.pathname==='/api/vendors')return json({ok:true,rows:[]});
    if(url.pathname==='/api/freight-quotes')return json({ok:true,rows:quotes});
    if(url.pathname==='/api/freight-extract')return json({ok:true,filename:'fixture.pdf',data:fixture});
    if(url.pathname==='/api/freight-quotes/upsert'){
      const q=request.postDataJSON();if(pending)await pending.promise;
      q.updatedAt=new Date(Date.parse('2026-10-19T00:00:00.000Z')+(++revision)*1000).toISOString();quotes=quotes.filter(x=>x.id!==q.id).concat(q);return json({ok:true,row:q});
    }
    if(url.pathname==='/api/freight-quotes/delete'){
      const q=request.postDataJSON();if(pending)await pending.promise;quotes=quotes.filter(x=>x.id!==q.id);return json({ok:true});
    }
    // Fonts and all unrecognized content are fulfilled locally too.
    return requestRoute.fulfill({contentType:'text/plain',body:''});
  }
  return {route,hold(){let release;const promise=new Promise(r=>{release=r;});pending={promise};return ()=>{pending=null;release();};}};
}
module.exports={fixtureRouter};

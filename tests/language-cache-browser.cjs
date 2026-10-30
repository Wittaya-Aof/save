'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{chromium}=require('playwright');
const {fixture}=require('./persistence-permissions.cjs');
test('language assets update correctly for returning users with a cached previous release',async t=>{
 const app=await fixture();let browser,proxy,deployed=false,languageRequests=0;
 const current=fs.readFileSync(path.join(__dirname,'../vendor/language.js'),'utf8');
 const legacy=current.replace(/addDictionary\(th,en\)\{.*?buildPattern\(\);\},/,'');
 assert.notEqual(legacy,current,'the fixture must represent the earlier language API');
 try{
  await t.test('the mutable language asset must not be cached for one day',async()=>{
   const r=await fetch(app.base+'/vendor/language.js',{headers:{authorization:'Basic '+Buffer.from('admin:fixture-admin').toString('base64')}});
   assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);
  });
  await t.test('a cached old language script cannot break the current calculator on navigation',async()=>{
   proxy=http.createServer((req,res)=>{
    if(new URL(req.url,'http://fixture').pathname==='/vendor/language.js'){
     languageRequests++;
     if(!deployed){res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'public, max-age=86400'});res.end(legacy);return;}
    }
    const upstream=http.request(app.base+req.url,{method:req.method,headers:req.headers},response=>{
     if((response.headers['content-type']||'').includes('text/html')){
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{const headers={...response.headers};delete headers['content-length'];res.writeHead(response.statusCode,headers);res.end(Buffer.concat(chunks).toString('utf8').replace(/<link[^>]+href="https:\/\/fonts\.(?:googleapis|gstatic)\.com[^\"]*"[^>]*>/g,''));});
     }else{res.writeHead(response.statusCode,response.headers);response.pipe(res);}
    });
    upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
   });
   await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+proxy.address().port;
   browser=await chromium.launch({headless:true});const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/login');await page.evaluate(()=>localStorage.setItem('controlLanguage','en'));
   // Warm the actual browser HTTP cache. Playwright routing is intentionally not used.
   await page.goto(base+'/vendor/language.js');deployed=true;
   await page.goto(base+'/login');await page.locator('#username').fill('admin');await page.locator('#password').fill('fixture-admin');await page.locator('#submit').click();await page.waitForURL(base+'/',{waitUntil:'domcontentloaded'});
   await page.getByRole('button',{name:'Container Calculator',exact:true}).click();
   const handle=await page.locator('iframe[title="Container Calculator"]').elementHandle(),frame=await handle.contentFrame();await frame.waitForURL('**/container-loading-calculator.html',{waitUntil:'domcontentloaded'});
   const state=await frame.evaluate(()=>({groups:typeof groups==='undefined'?0:groups.length,lang:typeof LANG==='undefined'?'missing':LANG}));
   assert.ok(state.groups>0,'the calculator must finish initializing after an update');assert.equal(state.lang,'en');
   await frame.getByText('Products',{exact:true}).waitFor();await frame.getByRole('button',{name:'+ Add Group',exact:true}).waitFor();
   assert.deepEqual((await frame.locator('.tabs .tab').allTextContents()).map(x=>x.trim()),['Products','Containers & Trucks','Stuffing Result']);
   assert.ok(languageRequests>=2,'the updated page must bypass the stale unversioned asset');assert.deepEqual(errors,[]);
   // Even a partially updated host must not crash the calculator when the optional API is absent.
   deployed=false;await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'Container Calculator',exact:true}).click();
   const fallback=page.frameLocator('iframe[title="Container Calculator"]');await fallback.getByText('Products',{exact:true}).waitFor();await fallback.locator('.group-name-input').first().waitFor();
   assert.deepEqual(errors,[]);
   await context.close();
  });
 }finally{if(browser)await browser.close();if(proxy)await new Promise(resolve=>proxy.close(resolve));await app.close();}
});

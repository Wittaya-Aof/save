'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {fixture}=require('./persistence-permissions.cjs');
test('browser login/logout use revocable cookies and preserve existing role rules',async()=>{
 const f=await fixture();
 const request=(route,options={})=>fetch(f.base+route,{redirect:'manual',...options});
 const post=(route,data,cookie,headers={})=>request(route,{method:'POST',headers:{'content-type':'application/json','x-control-request':'1',...(cookie?{cookie}:{}),...headers},body:JSON.stringify(data)});
 try{
  const page=await request('/login');assert.equal(page.status,200,'a login page must replace the browser password dialog');
  assert.match(await page.text(),/autocomplete="current-password"/);
  const anonymous=await request('/',{headers:{'sec-fetch-mode':'navigate'}});assert.equal(anonymous.status,303);assert.match(anonymous.headers.get('location'),/^\/login/);assert.equal(anonymous.headers.has('www-authenticate'),false);
  assert.equal((await request('/api/tracking')).status,401);
  assert.equal((await post('/api/auth/login',{username:'viewer',password:'wrong'})).status,401);
  const login=await post('/api/auth/login',{username:'viewer',password:'fixture-viewer',next:'https://evil.invalid/'},null,{'x-forwarded-proto':'https'});
  assert.equal(login.status,200);const payload=await login.json();assert.equal(payload.canWrite,false);assert.equal(payload.next,'/');
  const set=login.headers.get('set-cookie');assert.match(set,/HttpOnly/);assert.match(set,/SameSite=Lax/);assert.match(set,/Secure/);assert.match(login.headers.get('cache-control'),/no-store/);
  const cookie=set.split(';')[0];
  assert.equal((await request('/api/tracking',{headers:{cookie}})).status,200);
  assert.equal((await post('/api/tracking/upsert',{po_so:'PO-FIXTURE',_baseTs:100},cookie)).status,403);
  assert.equal((await post('/api/auth/logout',{},cookie,{origin:'https://evil.invalid'})).status,403);
  assert.equal((await request('/api/auth/logout',{headers:{cookie}})).status,405);
  assert.equal((await post('/api/auth/refresh',{},cookie)).status,200);
  const logout=await post('/api/auth/logout',{},cookie);assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await request('/api/tracking',{headers:{cookie}})).status,401,'replaying the old cookie after logout must fail');
  const cachedBasic='Basic '+Buffer.from('viewer:fixture-viewer').toString('base64');
  assert.equal((await request('/api/tracking',{headers:{authorization:cachedBasic,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors'}})).status,401,'cached browser Basic credentials must not bypass logout');
  assert.equal((await request('/api/tracking',{headers:{authorization:cachedBasic,'user-agent':'Mozilla/5.0'}})).status,401,'insecure-origin browser metadata omissions must not re-enable cached Basic');
  const admin=await post('/api/auth/login',{username:'admin',password:'fixture-admin',next:'/freight-comparison.html'});assert.equal(admin.status,200);const me=await admin.json();assert.equal(me.canWrite,true);assert.equal(me.next,'/freight-comparison.html');
  const second=await post('/api/auth/login',{username:'viewer',password:'fixture-viewer'});assert.notEqual(second.headers.get('set-cookie').split(';')[0],cookie,'each login rotates the random session token');
  for(let i=0;i<10;i++)await post('/api/auth/login',{username:'bad-attempt',password:'wrong'});
  assert.equal((await post('/api/auth/login',{username:'bad-attempt',password:'wrong'})).status,429);
  const gate=await require('../tools/verify-staging.cjs').verifyStaging({base:f.base,loginChecks:true,env:{APP_USER:'admin',APP_PASSWORD:'fixture-admin',VIEWER_USER:'viewer',VIEWER_PASSWORD:'fixture-viewer'}});
  assert.equal(gate.loginVerified,true,'the actual staging gate must verify login/logout before production');
 }finally{await f.close();}
});

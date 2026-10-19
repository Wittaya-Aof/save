'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('guardian recovers only its configured failed service, respects maintenance and cooldown',async()=>{
 const {checkServices}=require('../tools/service-guardian.cjs');let healthy=false,proxy=true,maintenance=false;const actions=[];
 const deps={inspect:async()=>({running:true,ip:'127.0.0.1'}),probe:async kind=>kind==='app'?{ok:healthy}:{ok:proxy,recoverable:true},restart:async name=>actions.push(name),maintenance:()=>maintenance};
 const config={appContainer:'fixture-app',proxyContainer:'fixture-proxy'};let state={};
 for(let n=0;n<2;n++)state=await checkServices(config,state,deps,1000000+n*60000);assert.deepEqual(actions,[]);
 state=await checkServices(config,state,deps,1120000);assert.deepEqual(actions,['fixture-app']);
 state=await checkServices(config,state,deps,1180000);assert.equal(actions.length,1);
 healthy=true;state=await checkServices(config,state,deps,1240000);assert.equal(state.app.failures,0);
 maintenance=true;healthy=false;state=await checkServices(config,state,deps,2000000);assert.equal(state.skipped,'maintenance');assert.equal(actions.length,1);
 maintenance=false;healthy=true;proxy=false;for(let n=0;n<3;n++)state=await checkServices(config,state,deps,2100000+n*60000);assert.equal(actions.at(-1),'fixture-proxy');
});
test('invalid direct application health is recoverable even when HTTP transport itself succeeded',async()=>{
 const {checkServices}=require('../tools/service-guardian.cjs');const actions=[];let state={};
 const deps={inspect:async()=>({running:true,ip:'127.0.0.1'}),probe:async()=>({ok:false,recoverable:false}),restart:async name=>actions.push(name),maintenance:()=>false};
 for(let n=0;n<3;n++)state=await checkServices({appContainer:'fixture-app'},state,deps,1000000+n*60000);
 assert.deepEqual(actions,['fixture-app']);
});
test('integration/DNS/TLS failures and unrelated containers do not trigger restarts',async()=>{
 const {checkServices}=require('../tools/service-guardian.cjs');const actions=[];let state={};
 const deps={inspect:async()=>({running:true,ip:'127.0.0.1'}),probe:async kind=>kind==='app'?{ok:true}:{ok:false,recoverable:false},restart:async n=>actions.push(n),maintenance:()=>false};
 for(let n=0;n<10;n++)state=await checkServices({appContainer:'fixture-app',proxyContainer:'fixture-proxy'},state,deps,1000000+n*60000);
 assert.deepEqual(actions,[]);assert.equal(state.app.failures,0);assert.equal(state.proxy.status,'external-error');
});

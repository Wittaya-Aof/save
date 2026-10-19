'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test');
const {fixture}=require('./persistence-permissions.cjs');
test('readiness distinguishes stale/failed Odoo from process liveness',async()=>{
 const f=await fixture();try{
  const live=await(await fetch(f.base+'/api/alive')).json();assert.equal(live.service,'import-export-control-cloud');
  assert.equal((await fetch(f.base+'/api/ready')).status,401);
  assert.equal((await f.request('/api/ready',undefined,'viewer')).status,503,'no live board checks yet');
  await f.request('/api/import-pos?force=1');await f.request('/api/export-sos?force=1');
  const ready=await f.request('/api/ready',undefined,'viewer');assert.equal(ready.status,200);assert.equal(ready.body.ready,true);
 }finally{await f.close();}
});
test('recovery policy never restarts on integration failure and requires repeated liveness failure',()=>{
 const {decideRecovery,integrationReadiness}=require('../lib/availability.cjs');
 assert.equal(decideRecovery({healthy:true,failures:9,now:10000}).action,'none');
 assert.equal(decideRecovery({healthy:false,failures:0,now:10000}).action,'none');
 assert.equal(decideRecovery({healthy:false,failures:2,now:10000}).action,'restart');
 assert.equal(decideRecovery({healthy:false,failures:9,now:10000,lastActionAt:9000}).action,'none');
 const status=integrationReadiness({timestamps:{import:new Date(1000).toISOString(),export:new Date(1000).toISOString()},errors:{import:'AUTHENTICATION_REJECTED'},now:2000});
 assert.equal(status.ready,false);assert.equal(status.odoo.code,'AUTHENTICATION_REJECTED');
 const expired=integrationReadiness({timestamps:{import:new Date(1000).toISOString(),export:new Date(1000).toISOString()},now:2000,keyExpiresAt:new Date(1500).toISOString()});assert.equal(expired.ready,false);
});

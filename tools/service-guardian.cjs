'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),https=require('node:https'),{execFileSync}=require('node:child_process');
const {decideRecovery}=require('../lib/availability.cjs');
const {httpProbe}=require('../lib/http-probe.cjs');
async function checkServices(config,state={},deps,now=Date.now()){
 if(deps.maintenance()){return{...state,skipped:'maintenance',checkedAt:new Date(now).toISOString()};}
 state={...state,skipped:null,checkedAt:new Date(now).toISOString()};
 const app=await deps.inspect(config.appContainer);const live=app?.running?await deps.probe('app',app):{ok:false};
 async function check(kind,name,result,exists){
  const previous=state[kind]||{};
  if(!exists){state[kind]={...previous,status:'container-missing'};return;}
  if(!result.ok&&result.recoverable===false){state[kind]={...previous,failures:0,status:'external-error'};return;}
  const policy=decideRecovery({healthy:result.ok,failures:previous.failures||0,lastActionAt:previous.lastActionAt||0,now,cooldownMs:config.cooldownMs||300000});
  state[kind]={...policy,status:result.ok?'healthy':'failed'};
  if(policy.action==='restart'){// Record attempt before invoking recovery, even when Docker fails.
   state[kind].lastActionAt=now;try{await deps.restart(name);state[kind].status='restarted';}catch{state[kind].status='restart-failed';}
  }
 }
 // The direct probe reaches the explicitly owned container, so invalid/500
 // health responses are local failures. Proxy TLS/DNS errors stay separate.
 await check('app',config.appContainer,{...live,recoverable:true},!!app);
 if(live.ok&&config.proxyContainer){const proxy=await deps.inspect(config.proxyContainer);const routed=proxy?.running?await deps.probe('proxy',proxy):{ok:false};await check('proxy',config.proxyContainer,routed,!!proxy);}
 return state;
}
async function request(url,extra={},allowLegacy=false){
 const result=await httpProbe(url,extra),body=result.body;
 const expected=body?.service==='import-export-control-cloud';
 const legacy=allowLegacy&&body&&!body.service&&Math.abs(Date.now()-Date.parse(body.ts))<60000;
 return{...result,ok:result.ok&&body?.ok===true&&(expected||legacy)};
}
async function runGuardian(config){
 for(const name of [config.appContainer,config.proxyContainer].filter(Boolean))if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name))throw Error('Explicit container names required');
 const dir=path.resolve(config.stateDir),file=path.join(dir,'guardian.json'),lease=path.join(dir,'maintenance.json');
 let state={};try{state=JSON.parse(fs.readFileSync(file));}catch(e){if(e.code!=='ENOENT')throw e;}
 const deps={maintenance(){try{const value=JSON.parse(fs.readFileSync(lease));return value.expiresAt>Date.now();}catch(e){return e.code!=='ENOENT';}},
  async inspect(name){try{const data=JSON.parse(execFileSync('docker',['inspect',name],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','ignore']}))[0];return{running:data.State.Running,ip:Object.values(data.NetworkSettings.Networks).map(n=>n.IPAddress).find(Boolean)};}catch{return null;}},
  async probe(kind,container){return kind==='app'?container.ip?request('http://'+container.ip+':'+(config.appPort||3000)+'/api/alive',{},config.allowLegacyLiveness===true):{ok:false}:request('https://'+config.domain+'/api/alive',{family:4,lookup:(_host,options,cb)=>options.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4)},config.allowLegacyLiveness===true);},
  async restart(name){execFileSync('docker',['restart','--time','15',name],{timeout:45000,stdio:'ignore'});}
 };
 state=await checkServices(config,state,deps);const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);console.log(JSON.stringify({checkedAt:state.checkedAt,app:state.app?.status,proxy:state.proxy?.status,skipped:state.skipped}));return state;
}
if(require.main===module){try{const [file,...rest]=process.argv.slice(2);if(!file||rest.length)throw Error('Usage: service-guardian.cjs PRIVATE_CONFIG.json');const config=JSON.parse(fs.readFileSync(file));if(!require('../lib/operation-lock.cjs').withOperationLock(config.stateDir,__filename,[file]))runGuardian(config).catch(()=>{console.error('Guardian check failed; inspect private service state');process.exitCode=1;});}catch{console.error('Guardian configuration/lock failed');process.exitCode=1;}}
module.exports={checkServices,runGuardian};

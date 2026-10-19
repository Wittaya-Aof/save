'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {loadProjectEnv}=require('../lib/config-env.cjs');
const {decideRecovery}=require('../lib/availability.cjs');
const {httpProbe}=require('../lib/http-probe.cjs');
async function startSupervisor({root=path.resolve(__dirname,'..'),intervalMs=30000,timeoutMs=5000,cooldownMs=60000,nodePath=process.execPath}={}) {
 root=fs.realpathSync(root);
 const key=crypto.createHash('sha256').update(process.platform==='win32'?root.toLowerCase():root).digest('hex').slice(0,24);
 const socket=process.platform==='win32'?'\\\\.\\pipe\\control-cloud-'+key:'\0control-cloud-'+key;
 const lock=net.createServer(s=>s.end());
 const acquired=await new Promise((resolve,reject)=>{lock.once('error',e=>e.code==='EADDRINUSE'?resolve(false):reject(e));lock.listen(socket,()=>resolve(true));});
 if(!acquired)return {alreadyRunning:true};
 const env={...process.env};loadProjectEnv(root,env);
 Object.assign(env,{DISABLE_SCHEDULED_MUTATIONS:'1',MAIL_DISABLED:'1',ALERT_EMAIL_TO:'',OPENAI_API_KEY:''});
 const port=Number(env.PORT||3002),ops=path.join(root,'data','ops');fs.mkdirSync(ops,{recursive:true,mode:0o700});
 const logFile=path.join(ops,'local-service.log'),stateFile=path.join(ops,'local-supervisor.json');
 const state={supervisorPid:process.pid,childPid:null,restarts:0,failures:0,lastActionAt:0,status:'starting'};
 let child,timer,stopped=false,busy=false,startedAt=0;
 function save(){const tmp=stateFile+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify({...state,checkedAt:new Date().toISOString()}),{mode:0o600});fs.renameSync(tmp,stateFile);}
 function log(data){try{if(fs.existsSync(logFile)&&fs.statSync(logFile).size>2*1024*1024)fs.renameSync(logFile,logFile+'.1');fs.appendFileSync(logFile,data,{mode:0o600});}catch{}}
 function probe(){return httpProbe('http://127.0.0.1:'+port+'/api/alive',{timeoutMs});}
 async function terminate(){const owned=child;if(!owned)return;await new Promise(resolve=>{const hard=setTimeout(()=>owned.kill('SIGKILL'),3000);owned.once('close',()=>{clearTimeout(hard);resolve();});if(owned.exitCode===null&&owned.signalCode===null)owned.kill('SIGTERM');});}
 function launch(){
  if(stopped)return;
  const id=crypto.randomUUID();state.instanceId=id;startedAt=Date.now();state.failures=0;state.status='starting';
  child=spawn(nodePath,[path.join(__dirname,'local-child.cjs'),path.join(root,'api-server.js')],{cwd:root,env:{...env,APP_INSTANCE_ID:id},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  const owned=child;state.childPid=owned.pid;owned.stdout.on('data',log);owned.stderr.on('data',log);
  owned.on('error',()=>{if(child===owned){state.status='start-failed';save();}});
  owned.once('close',()=>{if(child===owned){child=null;state.childPid=null;state.status='exited';save();}});save();
 }
 async function tick(){if(busy||stopped)return;busy=true;try{
  const health=await probe();
  if(stopped)return;
  if(!child){
   // A listener not owned by this supervisor must never be killed or displaced.
   if(health.reachable){state.status='port-in-use';save();return;}
   if(Date.now()-state.lastActionAt<cooldownMs)return;
   if(state.status!=='starting')state.restarts++;state.lastActionAt=Date.now();launch();return;
  }
  const healthy=health.ok&&health.body?.service==='import-export-control-cloud'&&health.body.instanceId===state.instanceId&&health.body.pid===state.childPid;
  if(!healthy&&Date.now()-startedAt<Math.min(intervalMs*2,10000))return;
  const policy=decideRecovery({healthy,failures:state.failures,lastActionAt:state.lastActionAt,cooldownMs});state.failures=policy.failures;state.status=healthy?'healthy':'unresponsive';
  if(policy.action==='restart'){state.lastActionAt=Date.now();await terminate();if(!stopped){state.restarts++;launch();}}
  save();
 }catch(e){log('Supervisor check failed: '+e.code+'\n');}finally{busy=false;}}
 timer=setInterval(tick,intervalMs);await tick();
 return{state,alreadyRunning:false,async stop(){stopped=true;clearInterval(timer);await terminate();await new Promise(r=>lock.close(r));}};
}
if(require.main===module){const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--root'){console.error('Usage: local-supervisor.cjs --root PROJECT');process.exitCode=1;}else startSupervisor({root:args[1]}).then(service=>{if(service.alreadyRunning)return;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>service.stop().then(()=>process.exit(0)));}).catch(()=>{console.error('Local supervisor failed to start; check private service log');process.exitCode=1;});}
module.exports={startSupervisor};

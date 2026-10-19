'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
test('local service survives child exit and hangs; duplicate supervisors cannot take over',async()=>{
 const {startSupervisor}=require('../tools/local-supervisor.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'control-supervisor-'));let service;
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 fs.writeFileSync(path.join(root,'.env'),'HOST=127.0.0.1\nPORT='+port+'\n');
 fs.writeFileSync(path.join(root,'api-server.js'),`const http=require('http');let hang=false;http.createServer((q,r)=>{if(q.url==='/hang'){hang=true;r.end('ok');return;}if(hang)return;r.setHeader('content-type','application/json');r.end(JSON.stringify({ok:true,service:'import-export-control-cloud',instanceId:process.env.APP_INSTANCE_ID,pid:process.pid}));}).listen(+process.env.PORT,'127.0.0.1');`);
 const wait=async(fn)=>{for(let n=0;n<150;n++){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,40));}throw Error('fixture supervisor did not recover');};
 try{service=await startSupervisor({root,intervalMs:60,timeoutMs:100,cooldownMs:100});assert.equal((await startSupervisor({root})).alreadyRunning,true);
  const url='http://127.0.0.1:'+port;await wait(async()=>service.state.childPid&&(await fetch(url)).ok);const pid=service.state.childPid;process.kill(pid);await wait(async()=>service.state.childPid&&service.state.childPid!==pid&&(await fetch(url)).ok);
  const second=service.state.childPid;await fetch(url+'/hang');await wait(async()=>service.state.childPid&&service.state.childPid!==second&&(await fetch(url)).ok);assert(service.state.restarts>=2);
 }finally{if(service)await service.stop();fs.rmSync(root,{recursive:true,force:true});}
});
test('supervisor crash does not leave an orphan app and an unrelated listener is preserved',async()=>{
 const {spawn}=require('node:child_process'),{startSupervisor}=require('../tools/local-supervisor.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'control-supervisor-owner-'));const server=require('node:http').createServer((_q,r)=>r.end('{"ok":true}'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 fs.writeFileSync(path.join(root,'.env'),'HOST=127.0.0.1\nPORT='+port+'\n');fs.writeFileSync(path.join(root,'api-server.js'),`require('http').createServer((_q,r)=>r.end(JSON.stringify({ok:true,service:'import-export-control-cloud',pid:process.pid,instanceId:process.env.APP_INSTANCE_ID}))).listen(+process.env.PORT,'127.0.0.1');`);
 let service,parent,childPid;try{service=await startSupervisor({root,intervalMs:50,cooldownMs:100});assert.equal(service.state.status,'port-in-use');assert.equal(service.state.childPid,null);assert.equal((await fetch('http://127.0.0.1:'+port)).status,200);await service.stop();service=null;await new Promise(r=>server.close(r));
 parent=spawn(process.execPath,[path.resolve(__dirname,'../tools/local-supervisor.cjs'),'--root',root],{stdio:'ignore'});const wait=async(fn)=>{for(let n=0;n<100;n++){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('ownership recovery failed');};await wait(()=>{try{childPid=JSON.parse(fs.readFileSync(path.join(root,'data/ops/local-supervisor.json'))).childPid;return !!childPid;}catch{return false;}});await wait(async()=>{try{return(await fetch('http://127.0.0.1:'+port)).ok;}catch{return false;}});
 const exited=new Promise(r=>parent.once('exit',r));parent.kill('SIGKILL');await exited;await wait(()=>{try{process.kill(childPid,0);return false;}catch{return true;}});
 service=await startSupervisor({root,intervalMs:50,cooldownMs:100});assert.equal(service.alreadyRunning,false);await wait(async()=>{try{return(await fetch('http://127.0.0.1:'+port)).ok;}catch{return false;}});
 }finally{if(service)await service.stop();parent?.kill();if(server.listening)await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});

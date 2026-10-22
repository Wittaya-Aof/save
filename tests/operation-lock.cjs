'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
test('guardian and release operation lock excludes another process and is released after exit',{skip:process.platform!=='linux'},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'control-operation-')),script=path.join(root,'holder.cjs'),marker=path.join(root,'locked');
 fs.writeFileSync(script,`const {withOperationLock}=require(${JSON.stringify(path.resolve(__dirname,'../lib/operation-lock.cjs'))});if(!withOperationLock(${JSON.stringify(root)},__filename,[])){require('fs').writeFileSync(${JSON.stringify(marker)},'locked');setTimeout(()=>{},1000);}`);
 const run=()=>{const child=spawn(process.execPath,[script],{windowsHide:true,stdio:'ignore'});return{child,done:new Promise(r=>child.once('exit',r))};};let first;
 try{first=run();for(let n=0;n<100&&!fs.existsSync(marker);n++)await new Promise(r=>setTimeout(r,20));assert(fs.existsSync(marker));const second=run();assert.equal(await second.done,75);assert.equal(await first.done,0);const third=run();assert.equal(await third.done,0);}finally{first?.child.kill();fs.rmSync(root,{recursive:true,force:true});}
});

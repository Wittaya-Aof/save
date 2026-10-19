'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
// Kernel-owned lock survives neither a crash nor a reboot. Release and guardian
// use the same inode; a directory lock alone can remain stale after SIGKILL.
function withOperationLock(stateDir,script,args){
 if(process.platform==='win32'||process.env.CONTROL_OPERATION_LOCKED===path.resolve(stateDir))return false;
 stateDir=path.resolve(stateDir);let ancestor=stateDir;
 for(;;){if(fs.existsSync(ancestor)&&fs.lstatSync(ancestor).isSymbolicLink())throw Error('Operation state cannot use symbolic links');const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
 fs.mkdirSync(stateDir,{recursive:true,mode:0o700});const file=path.join(stateDir,'operation.lock');
 const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);fs.closeSync(fd);
 const result=spawnSync('flock',['-n','-E','75',file,process.execPath,script,...args],{stdio:'inherit',env:{...process.env,CONTROL_OPERATION_LOCKED:stateDir}});
 if(result.error)throw Error('Operation lock unavailable');process.exitCode=result.status??1;return true;
}
module.exports={withOperationLock};

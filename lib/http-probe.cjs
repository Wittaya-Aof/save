'use strict';
const http=require('node:http'),https=require('node:https');
function httpProbe(url,{timeoutMs=5000,...options}={}){return new Promise(resolve=>{
 let settled=false,req;const finish=value=>{if(settled)return;settled=true;clearTimeout(deadline);resolve(value);};
 const fail=code=>finish({ok:false,reachable:code!=='ECONNREFUSED',recoverable:['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EHOSTUNREACH','TRUNCATED','TOO_LARGE'].includes(code)});
 const deadline=setTimeout(()=>{fail('ETIMEDOUT');req?.destroy();},timeoutMs);
 try{req=(url.startsWith('https:')?https:http).get(url,options,res=>{
  let body='';res.on('data',b=>{body+=b;if(body.length>16384){fail('TOO_LARGE');req.destroy();}});
  res.on('aborted',()=>fail('TRUNCATED'));res.on('error',()=>fail('TRUNCATED'));res.on('close',()=>{if(!res.complete)fail('TRUNCATED');});
  res.on('end',()=>{let data;try{data=JSON.parse(body);}catch{}finish({ok:res.statusCode===200,reachable:true,body:data,status:res.statusCode,recoverable:[502,503,504].includes(res.statusCode)});});
 });req.on('error',e=>fail(e.code));}catch{fail('INVALID_REQUEST');}
});}
module.exports={httpProbe};

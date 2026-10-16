'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('temporary initial session-check failure retries instead of losing logout permanently',async()=>{
 let calls=0,tick;const window={self:{},top:{},addEventListener(){},fetch:async()=>{calls++;if(calls===1)throw Error('temporary disconnect');return{ok:true,status:200,json:async()=>({ok:true,session:true,user:'viewer',canWrite:false,expiresAt:Date.now()+1800000})};}};
 const document={readyState:'complete',body:{style:{}},getElementById(){return null;}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../vendor/auth.js'),'utf8'),{window,document,URL,Date,location:{href:'http://fixture/'},setInterval(fn){tick=fn;},localStorage:{setItem(){}},AbortSignal});
 await new Promise(resolve=>setImmediate(resolve));await tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2,'session startup must recover after temporary network failure');
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');const {httpProbe}=require('../lib/http-probe.cjs');
test('probes always settle on truncated, hung and oversized responses and support Node lookup',async()=>{
 const sockets=new Set();const server=http.createServer((q,r)=>{if(q.url==='/hang')return;if(q.url==='/partial'){r.writeHead(200,{'content-type':'application/json','content-length':'500'});r.write('{');return setTimeout(()=>r.destroy(),10);}if(q.url==='/large')return r.end('a'.repeat(20000));r.end('{"ok":true}');});server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{for(const route of ['/partial','/hang','/large']){const result=await httpProbe(base+route,{timeoutMs:100});assert.equal(result.ok,false);assert.equal(result.recoverable,true);}
 const result=await httpProbe('http://fixture.invalid:'+server.address().port,{family:4,lookup:(_host,options,cb)=>options.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4)});assert.equal(result.ok,true);assert.equal(result.body.ok,true);
 }finally{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}
});

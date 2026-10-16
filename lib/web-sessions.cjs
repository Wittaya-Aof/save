'use strict';
const crypto=require('node:crypto');
const COOKIE='control_session';
function createSessionStore({now=Date.now,idleMs=30*60*1000,absoluteMs=12*60*60*1000,max=2000}={}) {
  const rows=new Map(),key=token=>crypto.createHash('sha256').update(token).digest('hex');
  function expired(row) { const t=now();return t>=row.touched+idleMs||t>=row.created+absoluteMs; }
  function get(token,proof) {
    if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;
    const k=key(token),row=rows.get(k);if(!row)return null;
    if(expired(row)||row.proof!==(typeof proof==='function'?proof(row.identity):proof)){rows.delete(k);return null;}
    return {identity:{...row.identity},expiresAt:Math.min(row.touched+idleMs,row.created+absoluteMs),idleMs};
  }
  return {
    create(identity,proof) {
      for(const [k,row]of rows)if(expired(row))rows.delete(k);
      if(rows.size>=max)throw Error('SESSION_CAPACITY');
      const token=crypto.randomBytes(32).toString('hex');rows.set(key(token),{identity:{...identity},proof,created:now(),touched:now()});return token;
    },get,
    touch(token,proof){if(!get(token,proof))return null;rows.get(key(token)).touched=now();return get(token,proof);},
    revoke(token){if(typeof token==='string'&&/^[a-f0-9]{64}$/.test(token))rows.delete(key(token));},
  };
}
function tokenFromCookie(header='') {
  const values=String(header).split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+'='));
  return values.length===1?values[0].slice(COOKIE.length+1):null;
}
function sessionCookie(token,secure=false) {
  return COOKIE+'='+token+'; Path=/; HttpOnly; SameSite=Lax'+(secure?'; Secure':'')+(token?'':'; Max-Age=0');
}
function safeNext(value) {
  if(typeof value!=='string'||value.length>1024||!value.startsWith('/')||value.startsWith('//')||/[\\\r\n]/.test(value))return '/';
  try{const u=new URL(value,'http://control.local');return u.origin==='http://control.local'&&['/','/index.html','/import-export-os.html','/freight-comparison.html','/container-loading-calculator.html'].includes(u.pathname)?u.pathname+u.search+u.hash:'/';}catch{return '/';}
}
function createLoginLimiter({now=Date.now,max=10,windowMs=15*60*1000,capacity=5000}={}) {
  const attempts=new Map();
  return {
    blocked(key){for(const [k,v]of attempts)if(now()>=v.until)attempts.delete(k);return attempts.size>=capacity||((attempts.get(key)?.count||0)>=max);},
    failed(key){const v=attempts.get(key);attempts.set(key,v&&now()<v.until?{...v,count:v.count+1}:{count:1,until:now()+windowMs});},
    clear(key){attempts.delete(key);},
  };
}
module.exports={createSessionStore,tokenFromCookie,sessionCookie,safeNext,createLoginLimiter};

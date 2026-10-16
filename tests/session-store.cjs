'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test');
test('session tokens expire on idle/absolute time and revoke when account proof changes',()=>{
 let api;assert.doesNotThrow(()=>{api=require('../lib/web-sessions.cjs');},'a revocable server session store is required');
 let now=0;const sessions=api.createSessionStore({now:()=>now,idleMs:100,absoluteMs:250,max:2});
 const identity={user:'viewer',role:'viewer',canWrite:false};const token=sessions.create(identity,'proof');
 assert.match(token,/^[a-f0-9]{64}$/);assert.equal(sessions.get(token,'proof').identity.user,'viewer');
 now=90;assert(sessions.get(token,'proof'));now=101;assert.equal(sessions.get(token,'proof'),null,'polling must not extend idle expiry');
 now=200;const fresh=sessions.create(identity,'proof');now=280;assert(sessions.touch(fresh,'proof'));now=360;assert(sessions.touch(fresh,'proof'));now=440;assert(sessions.touch(fresh,'proof'));now=451;assert.equal(sessions.get(fresh,'proof'),null,'activity cannot exceed absolute session life');
 const revoked=sessions.create(identity,'old');assert.equal(sessions.get(revoked,'new'),null,'password/role/disable changes must invalidate the session');
 const last=sessions.create(identity,'proof');sessions.revoke(last);assert.equal(sessions.get(last,'proof'),null);
 assert.equal(sessions.get('invalid','proof'),null);
});
test('redirect targets stay in the application and session cookies cannot be read by scripts',()=>{
 const {safeNext,sessionCookie}=require('../lib/web-sessions.cjs');
 for(const bad of ['https://evil.invalid','//evil.invalid','/\\evil.invalid','/%2f%2fevil.invalid','/login','/api/tracking','/bad\r\nHeader:x'])assert.equal(safeNext(bad),'/');
 assert.equal(safeNext('/freight-comparison.html'),'/freight-comparison.html');
 assert.match(sessionCookie('abc',true),/HttpOnly.*SameSite=Lax.*Secure/);
});

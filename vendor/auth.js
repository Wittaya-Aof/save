/* Session controls shared by every application page. No credentials in browser storage. */
(function(){
 'use strict';
 const originalFetch=window.fetch.bind(window);let leaving=false,deadline=Infinity,lastActivity=Date.now(),lastRefresh=Date.now(),sessionActive=false,lastDataCheck=0;
 async function checkData(){const label=document.getElementById('controlDataStatus');if(!label)return;lastDataCheck=Date.now();try{
  const r=await originalFetch('/api/ready',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(8000)});if(![200,503].includes(r.status))return;const report=await r.json();
  let text=report.ready?'ข้อมูล Odoo ล่าสุด':'ข้อมูล Odoo ยังไม่อัปเดต · กำลังใช้ข้อมูลที่บันทึกไว้';
  const days=report.odoo&&report.odoo.keyDaysRemaining;if(report.ready&&Number.isFinite(days)&&days<=7)text+=' · สิทธิ์เชื่อมต่อ'+(days<=0?'หมดอายุแล้ว':'หมดอายุใน '+days+' วัน');
  label.textContent=text;label.style.color=report.ready&&!(Number.isFinite(days)&&days<=7)?'inherit':'#ffd27a';
 }catch{label.textContent='ยังตรวจการเชื่อมต่อข้อมูลไม่ได้';}}
 const topPage=()=>{try{return window.top.location;}catch{return window.location;}};
 function redirect(reason){if(leaving)return;leaving=true;if(document.body)document.body.style.visibility='hidden';const target=topPage();target.replace('/login?reason='+reason+'&next='+encodeURIComponent(target.pathname+target.search));}
 async function logout(reason){if(leaving)return;
   if(document.body)document.body.style.visibility='hidden';
   try{const response=await originalFetch('/api/auth/logout',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-control-request':'1'},body:'{}',signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('Logout failed');}catch{if(reason==='expired'){redirect('expired');return;}if(document.body)document.body.style.visibility='visible';const b=document.getElementById('controlLogout');if(b){b.disabled=false;b.textContent='เชื่อมต่อไม่ได้ · ลองออกอีกครั้ง';}return;}
   try{localStorage.setItem('controlLogout',Date.now()+':'+Math.random());}catch{}
   redirect(reason||'logout');
 }
 window.fetch=async function(input,options){const response=await originalFetch(input,options);let url;try{url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);}catch{}
   if(response.status===401&&url&&url.origin===location.origin&&url.pathname.startsWith('/api/'))redirect('expired');return response;
 };
 async function check(){try{const r=await originalFetch('/api/me',{cache:'no-store',credentials:'same-origin'});if(r.status===401){redirect('expired');return;}if(!r.ok)return;const me=await r.json();if(!me.ok||!me.session)return;sessionActive=true;deadline=me.expiresAt;if(document.body)document.body.style.visibility='visible';
   if(window.self!==window.top||document.getElementById('controlSessionBar'))return;
   const bar=document.createElement('div');bar.id='controlSessionBar';bar.style.cssText='box-sizing:border-box;display:flex;align-items:center;justify-content:flex-end;gap:12px;height:44px;padding:6px 16px;background:var(--color-surface,#17262d);color:var(--color-text,#f2f6f7);border-bottom:1px solid var(--color-border,#405158);font:13px system-ui,sans-serif;position:relative;z-index:10000;flex-shrink:0';
   const status=document.createElement('span');status.id='controlDataStatus';status.setAttribute('role','status');status.style.cssText='margin-right:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';status.textContent='กำลังตรวจข้อมูล Odoo';
   const who=document.createElement('span');who.textContent=me.user+' · '+(me.canWrite?'ผู้ดูแลระบบ':'ดูข้อมูลอย่างเดียว');
   const button=document.createElement('button');button.id='controlLogout';button.type='button';button.textContent='ออกจากระบบ';button.style.cssText='font:inherit;flex-shrink:0;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;padding:4px 10px;cursor:pointer';button.onclick=()=>{button.disabled=true;logout('logout');};bar.append(status,who,button);document.body.prepend(bar);document.documentElement.style.setProperty('--control-app-height','calc(100dvh - 44px)');checkData();
 }catch{} }
 ['pointerdown','keydown','scroll','touchstart'].forEach(name=>window.addEventListener(name,()=>{lastActivity=Date.now();},{passive:true,capture:true}));
 window.addEventListener('storage',e=>{if(e.key==='controlLogout')redirect('logout');});
 window.addEventListener('pageshow',event=>{if(event.persisted){if(document.body)document.body.style.visibility='hidden';check();}});
 setInterval(async()=>{if(leaving)return;if(!sessionActive){await check();return;}if(!document.hidden&&Date.now()-lastDataCheck>=60000)checkData();if(Date.now()>=deadline){await check();if(Date.now()>=deadline)logout('expired');return;}
  if(!document.hidden&&lastActivity>lastRefresh&&Date.now()-lastRefresh>=60000){lastRefresh=Date.now();try{const r=await window.fetch('/api/auth/refresh',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-control-request':'1'},body:'{}'});if(r.ok){const j=await r.json();deadline=j.expiresAt;}}catch{}}
 },15000);
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',check);else check();
})();

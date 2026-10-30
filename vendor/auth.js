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
 async function check(){try{const r=await originalFetch('/api/me',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(8000)});if(r.status===401){redirect('expired');return;}if(!r.ok)return;const me=await r.json();if(!me.ok||!me.session)return;sessionActive=true;deadline=me.expiresAt;if(document.body)document.body.style.visibility='visible';
   if(window.self!==window.top||document.getElementById('controlSessionBar'))return;
   const bar=document.createElement('div');bar.id='controlSessionBar';bar.style.cssText='box-sizing:border-box;display:flex;align-items:flex-start;justify-content:flex-end;gap:16px;min-height:76px;padding:8px 16px;background:var(--color-surface,#17262d);color:var(--color-text,#f2f6f7);border-bottom:1px solid var(--color-border,#405158);font:13px system-ui,sans-serif;position:relative;z-index:10000;flex-shrink:0';
   const status=document.createElement('span');status.id='controlDataStatus';status.setAttribute('role','status');status.style.cssText='margin-right:auto;min-width:0;line-height:30px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';status.textContent='กำลังตรวจข้อมูล Odoo';
   const who=document.createElement('span');who.id='controlIdentity';who.style.cssText='line-height:30px;white-space:nowrap';const username=document.createElement('span');username.setAttribute('translate','no');username.textContent=me.user;const roleLabel=document.createElement('span');roleLabel.textContent=me.canWrite?'ผู้ดูแลระบบ':'ดูข้อมูลอย่างเดียว';who.append(username,' · ',roleLabel);
   const button=document.createElement('button');button.id='controlLogout';button.type='button';button.textContent='ออกจากระบบ';button.style.cssText='font:inherit;flex-shrink:0;box-sizing:border-box;height:30px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;padding:0 10px;cursor:pointer';button.onclick=()=>{button.disabled=true;logout('logout');};
   const controls=document.createElement('div');controls.style.cssText='display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0';
   const accountRow=document.createElement('div');accountRow.style.cssText='display:flex;align-items:center;gap:12px;height:30px';accountRow.append(who,button);controls.append(accountRow);
   if(window.ControlLanguage){
    const language=document.createElement('div');language.id='controlLanguage';language.setAttribute('role','group');language.setAttribute('aria-label','Language / ภาษา');language.setAttribute('data-control-language','');language.style.cssText='display:flex;align-items:center;gap:9px;height:24px;font:13px system-ui,sans-serif;line-height:24px;white-space:nowrap';
    const buttons={};
    for(const [value,label] of [['en','English'],['th','ภาษาไทย']]){
     if(value==='th'){const separator=document.createElement('span');separator.textContent='|';separator.setAttribute('aria-hidden','true');separator.style.color='var(--color-border,#405158)';language.append(separator);}
     const choice=document.createElement('button');choice.type='button';choice.lang=value;choice.textContent=label;choice.dataset.language=value;choice.style.cssText='font:inherit;line-height:24px;border:0;border-radius:3px;background:transparent;padding:0 2px;cursor:pointer';choice.onclick=()=>window.ControlLanguage.set(value);buttons[value]=choice;language.append(choice);
    }
    const flag=document.createElementNS('http://www.w3.org/2000/svg','svg');flag.setAttribute('viewBox','0 0 30 20');flag.setAttribute('width','24');flag.setAttribute('height','16');flag.setAttribute('role','img');flag.style.cssText='display:block;flex-shrink:0;border-radius:2px;box-shadow:0 0 0 1px var(--color-border,#405158)';language.append(flag);controls.append(language);
    window.ControlLanguage.register(value=>{
     language.dataset.language=value;
     for(const [code,choice] of Object.entries(buttons)){choice.setAttribute('aria-pressed',String(code===value));choice.style.color=code===value?'var(--color-brand,#24b47e)':'var(--color-text-tertiary,#63757b)';choice.style.fontWeight=code===value?'500':'400';}
     flag.setAttribute('aria-label',value==='th'?'Thailand':'United Kingdom');
     flag.innerHTML=value==='th'?'<path fill="#a51931" d="M0 0h30v20H0z"/><path fill="#fff" d="M0 3.33h30v13.34H0z"/><path fill="#2d2a4a" d="M0 6.67h30v6.66H0z"/>':'<path fill="#012169" d="M0 0h30v20H0z"/><path stroke="#fff" stroke-width="4" d="m0 0 30 20M30 0 0 20"/><path stroke="#c8102e" stroke-width="1.5" d="m0 0 30 20M30 0 0 20"/><path stroke="#fff" stroke-width="6" d="M15 0v20M0 10h30"/><path stroke="#c8102e" stroke-width="3" d="M15 0v20M0 10h30"/>';
    });
   }
   bar.append(status,controls);document.body.prepend(bar);document.documentElement.style.setProperty('--control-app-height','calc(100dvh - 76px)');document.documentElement.style.setProperty('--control-session-height','76px');checkData();
 }catch{} }
 ['pointerdown','keydown','scroll','touchstart'].forEach(name=>window.addEventListener(name,()=>{lastActivity=Date.now();},{passive:true,capture:true}));
 window.addEventListener('storage',e=>{if(e.key==='controlLogout')redirect('logout');});
 window.addEventListener('pageshow',event=>{if(event.persisted){if(document.body)document.body.style.visibility='hidden';check();}});
 setInterval(async()=>{if(leaving)return;if(!sessionActive){await check();return;}if(!document.hidden&&Date.now()-lastDataCheck>=60000)checkData();if(Date.now()>=deadline){await check();if(Date.now()>=deadline)logout('expired');return;}
  if(!document.hidden&&lastActivity>lastRefresh&&Date.now()-lastRefresh>=60000){lastRefresh=Date.now();try{const r=await window.fetch('/api/auth/refresh',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-control-request':'1'},body:'{}',signal:AbortSignal.timeout(8000)});if(r.ok){const j=await r.json();deadline=j.expiresAt;}}catch{}}
 },15000);
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',check);else check();
})();

'use strict';
function decideRecovery({healthy,failures=0,lastActionAt=0,now=Date.now(),threshold=3,cooldownMs=300000,missing=false}) {
  if(healthy)return{action:'none',failures:0,lastActionAt};
  const next=failures+1;
  const due=!lastActionAt||now-lastActionAt>=cooldownMs;
  return{action:due&&(missing||next>=threshold)?'restart':'none',failures:next,lastActionAt};
}
function integrationReadiness({timestamps={},errors={},now=Date.now(),maxAgeMs=600000,keyExpiresAt}={}) {
  const dates=['import','export'].map(k=>Date.parse(timestamps[k]||''));
  const age=dates.every(Number.isFinite)?Math.max(0,now-Math.min(...dates)):null;
  const expiry=Date.parse(keyExpiresAt||'');const days=Number.isFinite(expiry)?Math.ceil((expiry-now)/86400000):null;
  const code=Object.values(errors).find(Boolean)||(days!==null&&days<=0?'API_KEY_EXPIRED':age===null?'NOT_CHECKED':age>maxAgeMs?'STALE_DATA':null);
  return{ready:!code,odoo:{ok:!code,code,ageMs:age,keyDaysRemaining:days,keyExpiryKnown:days!==null}};
}
module.exports={decideRecovery,integrationReadiness};

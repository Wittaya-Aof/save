'use strict';
function classifyLogisticsCosts(billRows,poRows=[]){
const INS_RE   = /insurance|ประกันภัย|ประกัน/i;
const VAT_RE   = /custom\s*\(?\s*vat|\bvat\b|ภาษีมูลค่าเพิ่ม|ภพ\.?\s*30|ภาษีนำเข้า/i;
const DUTY_RE  = /custom\s*\(?\s*duty|\bduty\b|อากร|tariff|ภาษีขาเข้า|import\s*duty/i;
const CLR_RE   = /clearance|พิธีการ|เดินพิธี|ชิปปิ้ง|shipping\s*service|\bbroker|clearing|d\/o|delivery\s*order|เอกสารนำเข้า|customs\s*service/i;
const FRT_RE   = /freight|ขนส่ง|shipping|transport|cargo|courier|express|ระวาง/i;
function lineCat(name) {
  const t = (name || '').toLowerCase();
  if (INS_RE.test(t))  return 'insurance';
  if (VAT_RE.test(t))  return 'vat';
  if (DUTY_RE.test(t)) return 'duty';
  if (CLR_RE.test(t))  return 'clearance';
  return 'freight';
}
function wholeBillCat(text, partner, tax) {
  const t = (text || '').toLowerCase(), p = (partner || '').toLowerCase();
  if (INS_RE.test(t) || INS_RE.test(p)) return 'insurance';
  if (VAT_RE.test(t))  return 'vat';
  if (DUTY_RE.test(t)) return 'duty';
  if (CLR_RE.test(t) || CLR_RE.test(p)) return 'clearance';
  if (/กรมศุลกากร|customs|ศุลกากร/.test(p)) return tax > 0 ? 'vat' : 'duty';
  return 'freight';
}
const zero5  = () => ({ freight: 0, clearance: 0, insurance: 0, duty: 0, vat: 0 });
const money = n => Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;
const round5 = (c,total) => { Object.keys(c).forEach(k => { c[k] = money(c[k]); }); const key=argmax(c); c[key]=money(c[key]+money(total-Object.values(c).reduce((a,b)=>a+b,0))); return c; };
const argmax = c => Object.keys(c).reduce((a, b) => Math.abs(c[b]) > Math.abs(c[a]) ? b : a);

const out = [];
const billedPoNames = new Set();
// แปลงเป็นบาทเสมอตาม rate_thb ของแต่ละบิล/PO — เดิมไม่แปลงเลย บิลสกุลต่างประเทศ (เช่น DHL/forwarder
// ที่ออกบิลเป็น USD) ถูกนับเป็นบาทตรงๆ ผิดขนาด ~30 เท่า (bug จริงที่เจอและแก้ 13 ก.ค. 2569 — คนละจุด
// กับ bug currency_rate ของ export SO ที่แก้ไปก่อนหน้านี้ แต่เป็น "โรค" เดียวกัน: ดึงยอดสกุลเงินมาโดยไม่แปลง)
const thbRate = r => { if (r.currency === 'THB') return 1; const v=Number(r.rate_thb); return Number.isFinite(v)&&v>0?v:null; };
const scopeKey=(r,v)=>JSON.stringify([r.company_id??null,String(v||'').trim()]);
const rememberBill=r=>[r.invoice_origin,r.ref].forEach(v=>{if(v)billedPoNames.add(scopeKey(r,v));});
function unknown(r,kind,original){return {id:kind==='bill'?r.id:'po_'+r.id,company_id:r.company_id??null,kind,bill:r.bill_name||r.po_number,partner:r.partner,ref:r.ref||r.origin,origin:r.invoice_origin||r.origin,amount:null,currency:r.currency,origAmount:original,fxRate:null,fxStatus:'missing',date:r.doc_date,category:'freight',freight:null,clearance:null,insurance:null,duty:null,vat:null};}
billRows.forEach(r => {
  const fx   = thbRate(r);
  // ใบลดหนี้ (in_refund) เก็บยอดใน Odoo เป็นบวกเสมอ (ความหมาย "เครดิต" มาจาก move_type ไม่ใช่เครื่องหมาย)
  // ต้องกลับเครื่องหมายลบเองตอนแสดงผล ไม่งั้นใบลดหนี้จะดูเหมือนบิลจ่ายเพิ่มอีกใบ
  const sign = r.move_type === 'in_refund' ? -1 : 1;
  const origAmount = (parseFloat(r.amount_total) || 0) * sign;
  if(fx===null){rememberBill(r);out.push(unknown(r,'bill',origAmount));return;}
  const total = money(origAmount * fx);
  const tax   = (parseFloat(r.amount_tax) || 0) * fx * sign;
  const lines = Array.isArray(r.lines) ? r.lines : [];
  const text  = lines.map(l => l.name || '').join(' ');
  const c = zero5();
  // ลองแยกตาม line ก่อน — ใช้ได้เมื่อยอด line บวกรวมแล้วเป็นยอดจริง (ไม่หักล้างกัน)
  // เฉพาะใบที่ total ไม่ติดลบ (ไม่ใช่ in_refund) — Math.max(0,...) ด้านล่างสมมติว่าแต่ละหมวดไม่ติดลบ
  // สมมติฐานนี้ใช้ไม่ได้กับใบลดหนี้ (total ติดลบทั้งใบ) เลยส่งใบลดหนี้ไปทาง wholeBillCat แทนเสมอ
  let lineTotal = 0;
  const lineSums = zero5();
  lines.forEach(l => { const a = (parseFloat(l.amount) || 0) * fx * sign; lineTotal += a; lineSums[lineCat(l.name)] += a; });
  let cat;
  if (lines.length && Math.abs(lineTotal) > Math.abs(total) * 0.5 && lineTotal * total > 0) {
    // scale ยอด line (ก่อน VAT) ให้เท่ายอดจ่ายจริงทั้งใบ
    const f = total / lineTotal;
    Object.keys(lineSums).forEach(k => { c[k] = lineSums[k] * f; });
    cat = argmax(c);
  } else {
    cat = wholeBillCat(text, r.partner, tax);
    if (cat === 'vat' && tax !== 0) { c.vat = tax; c.duty = total - tax; }
    else c[cat] = total;
  }
  rememberBill(r);
  out.push({ id: r.id, kind: 'bill', bill: r.bill_name, partner: r.partner,
    ref: r.ref, origin: r.invoice_origin, amount: total, currency: r.currency,
    origAmount: r.currency !== 'THB' ? origAmount : null, fxRate: r.currency !== 'THB' ? fx : null,
    company_id:r.company_id??null,fxStatus:r.currency==='THB'?'native':'converted',
    date: r.doc_date, category: cat, ...round5(c,total) });
});
poRows.forEach(r => {
  // PO ที่มีบิลอ้างถึงแล้ว → ข้าม (ใช้ยอดจากบิลจริงแทน)
  if (billedPoNames.has(scopeKey(r,r.po_number))) return;
  const fx = thbRate(r);
  const origAmount = parseFloat(r.amount_total) || 0;
  if(fx===null){out.push(unknown(r,'po',origAmount));return;}
  const total = money(origAmount * fx);
  const text  = (r.main_product || '') + ' ' + (r.cat_name || '');
  const cat   = wholeBillCat(text, r.partner, 0);
  const c = zero5(); c[cat] = total;
  out.push({ id: 'po_' + r.id, kind: 'po', bill: r.po_number, partner: r.partner,
    ref: r.origin, origin: r.origin, amount: total, currency: r.currency,
    origAmount: r.currency !== 'THB' ? origAmount : null, fxRate: r.currency !== 'THB' ? fx : null,
    company_id:r.company_id??null,fxStatus:r.currency==='THB'?'native':'converted',
    date: r.doc_date, category: cat, ...round5(c,total) });
});
out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
return out;
}
module.exports={classifyLogisticsCosts};

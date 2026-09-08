'use strict';
// ─── นโยบายของรอบสแกนเอกสาร — แยกออกมาเป็นฟังก์ชันบริสุทธิ์เพื่อให้เทสได้โดยไม่ต้องมี AI/เบราว์เซอร์ ──
// ใช้โดย `scan-shipment-docs.mjs` · เทสที่ `tests/scan-policy.cjs`
//
// ที่มา: รอบรีวิว 2026-09-08 finding 1 + 4 (ดู REVIEW.md)
// ทั้งสองข้อเป็นบั๊กชนิดเดียวกัน — **ระบบเดินต่อเหมือนไม่มีอะไรผิด ทั้งที่ผิดไปแล้ว**

// ═══ 1) ผลของการ upsert 1 record ═══════════════════════════════════════════════════
// เดิม scanner ทิ้ง response ทั้งก้อนแล้ว log "สำเร็จ" ทุกครั้งที่ HTTP เป็น 2xx
// แต่ server ตอบ 200 ได้ทั้งตอนเขียนสำเร็จ ตอนปฏิเสธค่า และตอนข้าม record ทั้งใบ
//
// ⭐ กุญแจของการแก้: ต้องแยก **"ล้มเหลวจริง"** (ควรลองใหม่รอบหน้า) ออกจาก
//    **"ข้ามอย่างถูกต้อง"** (จบแล้ว ไม่ต้องลองใหม่) — ถ้าเหมารวมเป็นล้มเหลวทั้งหมด
//    โฟลเดอร์ที่เป็นคนละชิปเม้นโดยธรรมชาติจะถูกสแกนซ้ำทุก 20 นาทีตลอดไป = **เสียเงิน AI ฟรี**
function classifyUpsert(res, po) {
  if (!res || typeof res !== 'object' || Array.isArray(res)) {
    return { kind: 'fail', reason: 'server ตอบไม่ใช่ JSON object' };
  }
  // ok = ผลของ saveTracking() → false คือเขียนไฟล์ข้อมูลไม่สำเร็จ (ดิสก์เต็ม/ล็อก) = หนักสุด
  if (res.ok === false) return { kind: 'fail', reason: 'server บันทึกไฟล์ข้อมูลไม่สำเร็จ (saveTracking = false)' };

  const same = (a) => !!po && String(a || '').toUpperCase() === String(po).toUpperCase();
  const arr = (v) => (Array.isArray(v) ? v : []);

  const rej = arr(res.rejected).find((x) => x && same(x.po_so));
  if (rej) return { kind: 'fail', reason: `server ปฏิเสธค่าที่ผิดปกติ: ${rej.field}=${rej.value}` };

  const sk = arr(res.skipped).find((x) => x && same(x.po_so));
  if (sk) return { kind: 'skip', reason: sk.reason || 'server ข้าม record นี้' };

  if (!(Number(res.applied) > 0)) {
    // server ไม่เขียนอะไรเลยและไม่บอกเหตุผล — เกิดได้เมื่อ server ยังเป็นรุ่นก่อนที่จะรายงาน `skipped`
    // จัดเป็น fail เพื่อไม่ให้เงียบ แต่เพดานการลองใหม่ต่อโฟลเดอร์ (ข้อ 2) กันไม่ให้วนไม่รู้จบ
    return { kind: 'fail', reason: 'server ไม่ได้เขียน record ใดเลย (applied=0) และไม่บอกเหตุผล' };
  }
  return { kind: 'ok' };
}

// ═══ 2) เพดานการลองใหม่ต่อโฟลเดอร์ ════════════════════════════════════════════════
// เดิม `saveSeen()` อยู่นอก try/catch ของ upsert → โฟลเดอร์ถูก mark ว่าประมวลผลแล้ว
// **แม้ upsert พังทุกใบ** จึงไม่เคยถูกลองใหม่เลย (ข้อมูลหายเงียบ)
//
// แต่ "ไม่ mark เมื่อพัง" เฉยๆ ก็อันตรายอีกทาง — โฟลเดอร์ที่พังด้วยเหตุถาวรจะเรียก AI
// ซ้ำทุก 20 นาทีตลอดไป · จึงต้องมีเพดาน แล้วยอมแพ้อย่างมีเสียง (ไม่ใช่ยอมแพ้เงียบ)
const MAX_FOLDER_ATTEMPTS = 5;

function folderRetryDecision(fails, max = MAX_FOLDER_ATTEMPTS) {
  const n = Math.max(0, Number(fails) || 0) + 1;   // นับรวมรอบที่พังครั้งนี้
  return n >= max
    ? { retry: false, attempts: n, giveUp: true }   // ถึงเพดาน → mark seen + log เสียงดัง
    : { retry: true,  attempts: n, giveUp: false }; // ยังไม่ถึง → ไม่ mark seen จะลองใหม่รอบหน้า
}

// ═══ 3) จะปิด ETS session ทิ้งเมื่อไหร่ ═════════════════════════════════════════════
// ⚠ `searchVesselActualDate()` **ไม่ throw เลย** — จับ exception ทุกตัวแล้วคืน
//   `{status:'error', error}` (lib/ets-lookup.mjs:274-279) จึงไม่มีทางที่ `catch` ในสแกนเนอร์
//   จะเห็นความพังของหน้าเว็บ · ผลคือ session ที่ค้างกลางทางถูกใช้ต่อทุกโฟลเดอร์ที่เหลือ
//   แล้วทุกการ์ดได้ `etsStatus:'error'` **อย่างเงียบสนิท** ตลอดรอบ
//
// `not_found` = ผลปกติ (เรือยังไม่ถึง / ไม่พบเที่ยวที่ตรง) → **ห้ามปิด session**
// `error`     = หน้าเว็บ/ตารางไม่เป็นไปตามที่คาด → ปิดทิ้ง เปิดใหม่รอบถัดไป
const MAX_ETS_REOPENS = 3;

function etsSessionAction(result, err, reopens, max = MAX_ETS_REOPENS) {
  const broken = !!err || !!(result && result.status === 'error');
  if (!broken) return { close: false, giveUp: false, reopens: Number(reopens) || 0 };
  const n = Math.max(0, Number(reopens) || 0) + 1;
  // ถึงเพดาน = เลิกค้น ETS ทั้งรอบ (เปิด chromium ใหม่แพง และถ้าพัง 3 ครั้งคือพังเชิงระบบ)
  return { close: true, giveUp: n >= max, reopens: n };
}

module.exports = {
  MAX_FOLDER_ATTEMPTS, MAX_ETS_REOPENS,
  classifyUpsert, folderRetryDecision, etsSessionAction,
};

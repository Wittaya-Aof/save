'use strict';
// ─── กติกาสถานะชิปเม้นนำเข้า ────────────────────────────────────────────────────────
// ใช้ร่วมกันระหว่าง api-server.js (ตอน upsert) กับชุดเทส `tests/shipment-stage.cjs`
// ⚠ ไฟล์นี้ตัดสิน "สถานะบนการ์ด" ซึ่งเป็นข้อมูลที่คนเอาไปตัดสินใจงานจริง — แก้ต้องมีเทสกำกับเสมอ

const STAGES = ['po', 'etd', 'arrived', 'customs', 'received'];

// ชื่อสถานะรุ่นเก่าที่ยังค้างอยู่ใน tracking_data.json — frontend แปลงให้ตอนแสดงผลแล้ว
// (`legacyStage` ใน import-export-os.html) แต่ไฟล์ข้อมูลยังเก็บของเดิมไว้
// ⚠ ต้องแปลงก่อนเทียบลำดับเสมอ ไม่งั้นสถานะเก่าจะกลายเป็น "ไม่รู้จัก" แล้วหลุดเกราะกันถอยหลัง
const LEGACY_STAGE = { booking: 'etd', transit: 'etd' };

// ฟิลด์ที่ต้องครบก่อนถือว่า "รู้จักชิปเม้นนี้มากพอจะเลื่อนสถานะอัตโนมัติ"
// ⭐ แยกตามโหมดขนส่ง: ทางเรือต้องมีชื่อเรือ+เที่ยว · ทางอากาศ/พัสดุ **ไม่มีเรือให้กรอกตั้งแต่ต้น**
// ถ้าบังคับ vessel/voyage กับทุกโหมด ชิปเม้นทางอากาศที่เอกสารครบจะได้ 'po' เสมอ ซึ่งเป็นคำตอบที่ผิด
const CORE_FIELDS = ['blNumber', 'vessel', 'voyage', 'portOfLoading', 'portOfDischarge', 'etd'];
const CORE_FIELDS_AIR = ['blNumber', 'portOfLoading', 'portOfDischarge', 'etd']; // blNumber = เลข AWB

function nonEmpty(value) { return value !== undefined && value !== null && String(value).trim() !== ''; }
// ⚠ ต้องตรวจว่าเป็นวันที่ที่มีอยู่จริง ไม่ใช่แค่ "หน้าตาถูกรูปแบบ"
// รูปแบบล้วนจะรับ '2026-13-45' ผ่าน แล้ว addDays() ได้ Invalid Date → toISOString() โยน RangeError
// → upsert ทั้งคำขอพังเป็น 400 · เทียบกลับหลังแปลงจึงกัน 2026-02-30 (JS เลื่อนเป็น 03-02) ได้ด้วย
// (บทเรียนเดิมของโปรเจกต์: parseFlexibleDate ก็เคยพลาดเรื่องนี้ ดู CLAUDE.md)
function isoDate(value) {
  const s = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function addDays(iso, days) {
  if (!isoDate(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function coreFieldsFor(mode) {
  const m = String(mode || '').toLowerCase();
  return (m === 'air' || m === 'courier') ? CORE_FIELDS_AIR : CORE_FIELDS;
}
function hasCoreShipmentData(s) {
  return coreFieldsFor(s && s.mode).every((key) => nonEmpty(s && s[key]));
}

function canonStage(v) {
  const s = String(v == null ? '' : v).trim();
  return LEGACY_STAGE[s] || s;
}
// -1 = ไม่รู้จัก (ค่าว่าง, สถานะบอร์ด export, หรือค่าที่พิมพ์มาผิด)
function stageRank(v) { return STAGES.indexOf(canonStage(v)); }

// ─── ⭐ เกราะหลัก: สถานะอัตโนมัติเลื่อนได้เฉพาะ "ไปข้างหน้า" ─────────────────────────
// ตรงกับหลักที่บันทึกไว้ใน CLAUDE.md ว่าสถานะที่ระบบเดาให้เป็น **"พื้น" ไม่ใช่ "เพดาน"**
// เหตุผลที่ต้องมี (วัดจากข้อมูลจริง 1,073 record):
//   · autoStage คืนได้แค่ po/etd/arrived/customs — **คืน 'received' ไม่ได้เลย**
//     การ์ดที่รับเข้าคลังแล้วจึงถูกดึงถอยหลังทุกครั้งที่ scanner แตะ
//   · ธง `_stageManual` มีอยู่ 0 จาก 1,073 record — ข้อมูลเดิมไม่มีเกราะนั้นสักใบ
// คืน null = ไม่ต้องเปลี่ยนอะไร (ผู้เรียกต้องไม่เขียนฟิลด์ stage ลงไปเลย)
function nextStage(current, proposed) {
  const p = stageRank(proposed);
  if (p < 0) return null;                       // เสนอค่าที่ไม่รู้จัก = ไม่แตะ
  const cur = canonStage(current);
  if (!cur) return proposed;                    // การ์ดใหม่/ยังไม่มีสถานะ = ตั้งได้
  const c = STAGES.indexOf(cur);
  if (c < 0) return null;                       // สถานะเดิมไม่รู้จัก (เช่นบอร์ด export) = ไม่แตะ
  return p > c ? proposed : null;               // เท่าเดิมหรือถอยหลัง = ไม่แตะ
}

// ─── ⭐ เกราะชั้นสอง: ไม่เขียนค่าที่ "ไม่ได้บอกอะไรใหม่" ────────────────────────────────
// การ์ด import ที่ยังไม่มีฟิลด์ `stage` เลย **หน้าเว็บแสดงเป็น 'po' ให้อยู่แล้ว**
// (`stage:o.stage||(o._board==='export'?'draft':'po')` ใน import-export-os.html)
// วัดจริง 2026-09-08: 1,027 จาก 1,073 record ไม่มีฟิลด์นี้ · ถ้าเขียน 'po' ลงไปจะได้
//   · 838 ใบที่ได้ค่าเท่ากับที่ UI แสดงอยู่แล้ว = **ข้อมูลใหม่ศูนย์**
//   · แต่ละใบกินแถว audit log 1 แถว → ดันการแก้ไขจริงตกออกจากแผงที่โชว์ 40 รายการ
//     (ปัญหาเดิมที่เคยแก้มาแล้วรอบ 2026-07-31)
//   · และติด `_src.stage = scan:<โฟลเดอร์>@<เวลา>` = **อ้างว่าค่านี้มาจากเอกสารใบนั้น**
//     ทั้งที่จริงมาจาก "ไม่มีข้อมูล" แล้วตกค่า default → ผิดหลัก provenance ของโปรเจกต์เอง
// ส่วน 189 ใบที่ได้ 'etd'/'customs' เป็นข้อมูลใหม่จริง ยังเขียนตามปกติ
const DEFAULT_STAGE = 'po';   // ค่า default ของบอร์ด import (export = 'draft' แต่เส้นนี้ไม่แตะ export)

function stageWriteNeeded(current, proposed) {
  const next = nextStage(current, proposed);
  if (!next) return null;
  if (!canonStage(current) && next === DEFAULT_STAGE) return null;
  return next;
}

function autoStage(s, today = new Date()) {
  if (!hasCoreShipmentData(s)) return 'po';
  if (!isoDate(s.etsActualArrivalDate)) return 'etd';
  const customsDate = addDays(s.etsActualArrivalDate, 1);
  const todayIso = today instanceof Date ? today.toISOString().slice(0, 10) : String(today).slice(0, 10);
  return todayIso >= customsDate ? 'customs' : 'arrived';
}

function normalizeEtsResult(result, checkedAt = new Date().toISOString()) {
  const status = result && ['found', 'not_found', 'error'].includes(result.status) ? result.status : 'error';
  const out = { etsStatus: status, etsCheckedAt: checkedAt };
  if (status === 'found' && isoDate(result.eta)) {
    out.etsActualArrivalDate = result.eta.slice(0, 10);
    out.eta = out.etsActualArrivalDate;
  }
  if (result && result.matchedVoyage) out.etsMatchedVoyage = String(result.matchedVoyage);
  if (result && result.reason) out.etsReason = String(result.reason);
  return out;
}

module.exports = {
  CORE_FIELDS, CORE_FIELDS_AIR, STAGES, LEGACY_STAGE,
  addDays, coreFieldsFor, hasCoreShipmentData,
  canonStage, stageRank, nextStage, stageWriteNeeded, DEFAULT_STAGE, autoStage, normalizeEtsResult,
};

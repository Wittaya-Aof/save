'use strict';
const fs = require('node:fs');
function readArray(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw unavailable(error); }
  try {
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw Error('Invalid records');
    return rows;
  } catch (error) { throw unavailable(error); }
}
function unavailable(cause) {
  const error = new Error('อ่านข้อมูลที่จัดเก็บไว้ไม่สำเร็จ — หยุดการเขียนเพื่อรักษาข้อมูลเดิม');
  error.code = 'OPERATIONAL_STORAGE_UNAVAILABLE'; error.cause = cause;
  return error;
}
function nextRevision(before, now = Date.now()) {
  const n = Number(before);
  if (Number.isFinite(n) && (!Number.isSafeInteger(n) || n < 0 || n >= Number.MAX_SAFE_INTEGER)) throw Error('Invalid stored revision');
  return Math.max(Number.isSafeInteger(now) ? now : Date.now(), Number.isFinite(n) ? n + 1 : 1);
}
function matchesRevision(before, base) {
  const expected = before && before._ts != null ? Number(before._ts) : 0;
  return base != null && Number.isSafeInteger(Number(base)) && Number(base) === expected;
}
module.exports = { readArray, nextRevision, matchesRevision };

'use strict';
// ─── บัญชีรายคน — แทน APP_PASSWORD ตัวเดียวที่ใช้ร่วมกัน ────────────────────────────────
// ทำไมต้องมีก่อนเปิดให้คนนอกเข้า (CLAUDE.md 2026-09-22):
//   รหัสผ่านตัวเดียวใช้ร่วมกัน = ถอนสิทธิ์คนคนเดียวไม่ได้ (ต้องเปลี่ยนรหัสแล้วแจ้งทุกคนใหม่)
//   และ `actorOf()` ที่บันทึก "ใครทำ" ลง audit เชื่อชื่อที่ client พิมพ์มาดื้อ ๆ — ใครก็อ้างเป็นใครก็ได้
//   พอมีบัญชีรายคน ชื่อใน audit log จะ **ผ่านการพิสูจน์ด้วยรหัสผ่านของคนนั้น** ทันที
//
// เก็บที่ `users.json` (gitignored) — ไม่เก็บรหัสผ่าน เก็บแต่ scrypt hash + salt ต่อคน
// โมดูลนี้ **บริสุทธิ์** (ไม่ผูก http/express) จึงเทสได้ตรง ๆ ด้วย tests/users.cjs
const crypto = require('crypto');
const fs = require('fs');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;

// ชื่อผู้ใช้ต้องผ่านตัวกรองเดียวกับ actorOf() ใน api-server.js ไม่งั้นชื่อที่ล็อกอินได้
// กับชื่อที่ลงใน audit log จะไม่ใช่ตัวเดียวกัน แล้วสาวกลับไม่ได้
//
// 🔴 เดิมใช้ `\w` ซึ่งเป็น [A-Za-z0-9_] ล้วน → **ชื่อภาษาไทยทุกชื่อกลายเป็น "_" เหมือนกันหมด**
//    "สมชาย" กับ "วิทยา" จึงเป็นคนเดียวกันในสายตาระบบ (tests/auth-users.cjs จับได้ตอนเขียนเทสรอบแรก)
//    → ใช้ \p{L}\p{M}\p{N} รับตัวอักษรทุกภาษา · ยังตัด ":" ทิ้งเพราะเป็นตัวคั่นของ Basic Auth
//    ⚠ ต้องมี \p{M} ด้วย — สระ/วรรณยุกต์ไทย (ั ี ่ ้) เป็น Mark ไม่ใช่ Letter
//      ถ้าลืม "เทสบัญชี" จะกลายเป็น "เทสบ_ญช_" (เจอตอนรันเทสครั้งแรกหลังแก้)
const NAME_BAD = /[^\p{L}\p{M}\p{N}._@-]+/gu;
function normUser(v) {
  return String(v == null ? '' : v).trim().replace(NAME_BAD, '_').slice(0, 40);
}
// ชื่อที่เหลือแต่ "_" หรือว่างเปล่า = แยกคนไม่ออก ห้ามใช้เป็นบัญชี
const usableName = (v) => { const n = normUser(v); return n.length > 0 && /[\p{L}\p{N}]/u.test(n); };

function derive(password, saltHex) {
  return crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,           // ค่า default 32MB ไม่พอกับ N=16384 → ต้องยกเพดานเอง
  }).toString('hex');
}

function makeRecord(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
  }
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  return { salt, hash: derive(password, salt), disabled: false, created: new Date().toISOString() };
}

// ⚠ ต้องใช้เวลาเท่ากันไม่ว่าจะมีชื่อผู้ใช้นั้นอยู่จริงหรือไม่ ไม่งั้นเวลาตอบจะบอกว่า
//   "ชื่อนี้มีอยู่ในระบบ" ให้คนเดาไปทีละชื่อได้ฟรี → ชื่อที่ไม่มีก็ยัง derive ด้วย salt หลอก
const DUMMY_SALT = crypto.randomBytes(SALT_BYTES).toString('hex');
function verify(store, username, password) {
  const u = normUser(username);
  if (!usableName(u)) return { ok: false, user: null, reason: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  const rec = store && store.users && Object.prototype.hasOwnProperty.call(store.users, u) ? store.users[u] : null;
  const salt = rec && rec.salt ? rec.salt : DUMMY_SALT;
  const got = Buffer.from(derive(password == null ? '' : password, salt), 'hex');
  const want = rec && rec.hash ? Buffer.from(rec.hash, 'hex') : Buffer.alloc(got.length);
  const same = got.length === want.length && crypto.timingSafeEqual(got, want);
  if (!rec || !same) return { ok: false, user: null, reason: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  if (rec.disabled) return { ok: false, user: u, reason: 'บัญชีนี้ถูกปิดการใช้งาน' };
  return { ok: true, user: u, reason: null };
}

function emptyStore() { return { version: 1, users: {} }; }

// อ่านไฟล์แบบ "ไม่มีไฟล์ = ไม่มีบัญชี" ไม่ throw — ระบบต้องเริ่มได้เสมอแม้ยังไม่ได้ตั้งบัญชีใคร
// แต่ถ้าไฟล์ **มีอยู่แล้วพัง** ต้อง throw เพราะการเงียบแล้วถอยไปใช้รหัสร่วมคือการเปิดประตูทิ้งไว้
function loadUsers(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return emptyStore(); throw e; }
  const o = JSON.parse(raw);
  if (!o || typeof o !== 'object' || !o.users || typeof o.users !== 'object') {
    throw new Error(`${file} ผิดรูปแบบ — ต้องเป็น {"version":1,"users":{…}}`);
  }
  return o;
}

// atomic เหมือนไฟล์ข้อมูลอื่นในโปรเจกต์นี้ — ไฟล์รหัสผ่านที่เขียนค้างกลางคัน = ล็อกอินไม่ได้ทั้งระบบ
function saveUsers(file, store) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

const activeCount = (store) =>
  Object.values((store && store.users) || {}).filter(u => u && !u.disabled).length;

module.exports = { normUser, usableName, makeRecord, verify, loadUsers, saveUsers, emptyStore, activeCount, SCRYPT };

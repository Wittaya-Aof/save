#!/usr/bin/env node
// ─── จัดการบัญชีผู้ใช้ของระบบ ──────────────────────────────────────────────────────────────
//   node manage-users.mjs list
//   node manage-users.mjs add <ชื่อผู้ใช้>
//   node manage-users.mjs passwd <ชื่อผู้ใช้>
//   node manage-users.mjs disable <ชื่อผู้ใช้> | enable <ชื่อผู้ใช้> | remove <ชื่อผู้ใช้>
//
// ⚠ รหัสผ่าน **พิมพ์สดในเทอร์มินัลเท่านั้น** ตั้งใจไม่รับทาง argument และไม่รับทาง stdin ที่ไม่ใช่ TTY
//   เพราะรหัสที่ผ่าน argv จะไปค้างใน history ของ shell และมองเห็นได้จาก tasklist/ps ของทุกโปรเซส
//   ตัวอักษรที่พิมพ์ไม่ถูกแสดงบนจอ และไม่ถูกเขียนลงไฟล์ใด ๆ — เก็บแต่ scrypt hash
'use strict';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const U = require('./lib/users.cjs');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(ROOT, 'users.json');

function ask(question, hidden) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('ต้องรันในเทอร์มินัลจริง (ไม่รับรหัสผ่านผ่าน pipe/argument)'));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!hidden) { rl.question(question, (a) => { rl.close(); resolve(a); }); return; }
    // ซ่อนสิ่งที่พิมพ์: ดักการเขียนออกจอของ readline แล้วไม่ปล่อยอะไรออกไปเลยหลังพิมพ์คำถามจบ
    process.stdout.write(question);
    let armed = false;
    const origWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    rl._writeToOutput = (s) => { if (!armed) { armed = true; } if (origWrite && s.includes('\n')) origWrite('\n'); };
    rl.question('', (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function askPasswordTwice(who) {
  const a = await ask(`รหัสผ่านใหม่ของ ${who}: `, true);
  if (a.length < 8) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
  const b = await ask('พิมพ์ซ้ำอีกครั้ง: ', true);
  if (a !== b) throw new Error('รหัสผ่านสองครั้งไม่ตรงกัน — ยังไม่บันทึกอะไร');
  return a;
}

const [, , cmd, rawName] = process.argv;
const name = U.normUser(rawName || '');

function mustName() {
  if (!name) { console.error('ต้องระบุชื่อผู้ใช้'); process.exit(1); }
  if (rawName && name !== rawName) console.log(`(ชื่อถูกปรับเป็น "${name}" ให้ตรงกับที่ audit log บันทึกได้)`);
  return name;
}

(async () => {
  let store;
  try { store = U.loadUsers(FILE); }
  catch (e) { console.error('อ่าน users.json ไม่สำเร็จ: ' + e.message); process.exit(1); }

  switch (cmd) {
    case 'list': {
      const names = Object.keys(store.users).sort();
      if (!names.length) {
        console.log('ยังไม่มีบัญชีผู้ใช้ — ระบบจะใช้ APP_PASSWORD ร่วมกันแบบเดิม');
        console.log('สร้างคนแรกด้วย:  node manage-users.mjs add <ชื่อผู้ใช้>');
        break;
      }
      console.log(`บัญชีทั้งหมด ${names.length} คน (ใช้งานได้ ${U.activeCount(store)}):`);
      for (const n of names) {
        const u = store.users[n];
        console.log(`  ${n.padEnd(22)} ${u.disabled ? '⏸ ปิดใช้งาน' : '✓ ใช้งานได้'}   สร้าง ${String(u.created || '').slice(0, 10)}`);
      }
      break;
    }
    case 'add': {
      mustName();
      if (store.users[name]) { console.error(`มี "${name}" อยู่แล้ว — ใช้ passwd เพื่อเปลี่ยนรหัส`); process.exit(1); }
      const pw = await askPasswordTwice(name);
      store.users[name] = U.makeRecord(pw);
      U.saveUsers(FILE, store);
      console.log(`✓ เพิ่ม "${name}" แล้ว (เก็บเฉพาะ scrypt hash ไม่ได้เก็บรหัสผ่าน)`);
      if (U.activeCount(store) === 1) {
        console.log('\n⚠ นี่คือบัญชีแรก — ตั้งแต่รีสตาร์ทรอบหน้า ระบบจะขอชื่อผู้ใช้+รหัสผ่านรายคน');
        console.log('  และ APP_PASSWORD ที่ใช้ร่วมกันจะ **ใช้ไม่ได้อีก** (ตั้ง ALLOW_SHARED_PASSWORD=1 ถ้ายังอยากให้ใช้ได้ชั่วคราว)');
      }
      break;
    }
    case 'passwd': {
      mustName();
      if (!store.users[name]) { console.error(`ไม่มีบัญชี "${name}"`); process.exit(1); }
      const pw = await askPasswordTwice(name);
      const keep = store.users[name];
      store.users[name] = Object.assign(U.makeRecord(pw), { disabled: !!keep.disabled, created: keep.created });
      U.saveUsers(FILE, store);
      console.log(`✓ เปลี่ยนรหัสผ่านของ "${name}" แล้ว`);
      break;
    }
    case 'disable':
    case 'enable': {
      mustName();
      if (!store.users[name]) { console.error(`ไม่มีบัญชี "${name}"`); process.exit(1); }
      const off = cmd === 'disable';
      if (off && U.activeCount(store) === 1 && !store.users[name].disabled) {
        console.error('นี่เป็นบัญชีที่ใช้งานได้บัญชีสุดท้าย — ปิดแล้วจะไม่มีใครเข้าระบบได้เลย');
        process.exit(1);
      }
      store.users[name].disabled = off;
      U.saveUsers(FILE, store);
      console.log(`✓ ${off ? 'ปิด' : 'เปิด'}การใช้งานบัญชี "${name}" แล้ว`);
      break;
    }
    case 'remove': {
      mustName();
      if (!store.users[name]) { console.error(`ไม่มีบัญชี "${name}"`); process.exit(1); }
      // ลบบัญชีไม่ลบประวัติ — audit log ยังอ้างชื่อนี้อยู่ และต้องอ้างต่อไปได้
      delete store.users[name];
      U.saveUsers(FILE, store);
      console.log(`✓ ลบบัญชี "${name}" แล้ว (ประวัติใน tracking_audit.jsonl ยังอยู่ครบตามเดิม)`);
      if (!U.activeCount(store)) console.log('⚠ ไม่เหลือบัญชีที่ใช้งานได้ — ระบบจะกลับไปใช้ APP_PASSWORD ร่วมกัน');
      break;
    }
    default:
      console.log(`จัดการบัญชีผู้ใช้ — เก็บที่ ${FILE}

  node manage-users.mjs list
  node manage-users.mjs add <ชื่อผู้ใช้>
  node manage-users.mjs passwd <ชื่อผู้ใช้>
  node manage-users.mjs disable <ชื่อผู้ใช้>
  node manage-users.mjs enable <ชื่อผู้ใช้>
  node manage-users.mjs remove <ชื่อผู้ใช้>

รหัสผ่านพิมพ์สดในเทอร์มินัลเท่านั้น (ไม่รับทาง argument เพราะจะค้างใน history)`);
  }
})().catch((e) => { console.error('ผิดพลาด: ' + e.message); process.exit(1); });

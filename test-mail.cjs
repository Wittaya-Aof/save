// ทดสอบการตั้งค่าอีเมลแจ้งเตือน — รองรับทั้ง Microsoft Graph และ SMTP (เลือกเองอัตโนมัติ)
//   node test-mail.cjs          → ตรวจการตั้งค่า + ขอ token / ล็อกอิน (ไม่ส่งอีเมล)
//   node test-mail.cjs --send   → ส่งอีเมลทดสอบจริงไปที่ ALERT_EMAIL_TO
'use strict';
const fs = require('fs');
const path = require('path');

fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
  const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
});

const { sendMail, verifyMail, mailMode, mailFrom } = require('./lib/mailer.cjs');

const HINTS = {
  graph: [
    'AADSTS7000215  → GRAPH_CLIENT_SECRET ผิด (ระวังคัดลอก "Secret ID" มาแทน "Value")',
    'AADSTS700016   → GRAPH_CLIENT_ID ผิด หรือแอปไม่ได้อยู่ใน tenant นี้',
    'AADSTS900023   → GRAPH_TENANT_ID ผิด',
    'HTTP 403 / Access denied → ยังไม่ได้ให้สิทธิ์ Mail.Send (Application) หรือแอดมินยังไม่กด Grant admin consent',
    'HTTP 404 → MAIL_FROM ไม่ใช่ mailbox ที่มีอยู่จริงใน tenant',
  ],
  smtp: [
    '535 5.7.139 locked by security defaults → องค์กรปิด SMTP legacy auth ทั้ง tenant ใช้ Graph แทน',
    '535 ทั่วไป → บัญชี M365 ต้องเปิด Authenticated SMTP ต่อ mailbox / บัญชีที่เปิด MFA ต้องใช้ App password',
  ],
};

(async () => {
  const mode = mailMode();
  if (!mode) {
    console.log('❌ ยังไม่ได้ตั้งค่าอีเมลเลย — ดูหัวข้อ "อีเมลแจ้งเตือน" ใน .env.example');
    process.exit(1);
  }
  console.log(`โหมด: ${mode === 'graph' ? 'Microsoft Graph API' : 'SMTP'} · ส่งจาก ${mailFrom()}`);
  if (mode === 'graph') console.log(`tenant=${(process.env.GRAPH_TENANT_ID || '').slice(0, 8)}… client=${(process.env.GRAPH_CLIENT_ID || '').slice(0, 8)}…`);

  const v = await verifyMail();
  if (!v.ok) {
    console.log('❌ ตรวจไม่ผ่าน:', String(v.error).split('\n')[0]);
    console.log('   สาเหตุที่พบบ่อย:');
    (HINTS[mode] || []).forEach(h => console.log('   · ' + h));
    process.exit(1);
  }
  console.log(mode === 'graph' ? '✅ ขอ access token จาก Azure AD สำเร็จ' : '✅ ล็อกอิน SMTP สำเร็จ');

  if (!process.argv.includes('--send')) { console.log('(เพิ่ม --send เพื่อส่งอีเมลทดสอบจริง)'); return; }
  const to = process.env.ALERT_EMAIL_TO || mailFrom();
  try {
    await sendMail({ to, subject: '[Logistics Tracking] ทดสอบระบบแจ้งเตือน',
      text: `อีเมลทดสอบจาก import-export-os (ส่งผ่าน ${mode === 'graph' ? 'Microsoft Graph' : 'SMTP'})\nถ้าได้รับฉบับนี้แปลว่าการแจ้งเตือนกลับมาทำงานแล้ว` });
    console.log('✅ ส่งอีเมลทดสอบไปที่', to, 'แล้ว — เช็ค inbox');
  } catch (e) {
    console.log('❌ ส่งไม่สำเร็จ:', String(e.message).split('\n')[0]);
    (HINTS[mode] || []).forEach(h => console.log('   · ' + h));
    process.exit(1);
  }
})();

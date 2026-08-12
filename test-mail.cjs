// ทดสอบการตั้งค่าอีเมลแจ้งเตือน — ใช้หลังกรอก MAIL_USER/MAIL_PASS ใน .env
//   node test-mail.cjs          → ทดสอบล็อกอิน SMTP อย่างเดียว (ไม่ส่งอีเมล)
//   node test-mail.cjs --send   → ส่งอีเมลทดสอบจริงไปที่ ALERT_EMAIL_TO
'use strict';
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
  const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
});

const user = process.env.MAIL_USER, pass = process.env.MAIL_PASS;
if (!user || !pass) { console.log('❌ ยังไม่ได้ตั้ง MAIL_USER / MAIL_PASS ใน .env'); process.exit(1); }

const host = process.env.MAIL_HOST || 'smtp.office365.com';
const port = parseInt(process.env.MAIL_PORT, 10) || 587;
const t = nodemailer.createTransport({ host, port, secure: false, auth: { user, pass } });

(async () => {
  console.log(`ทดสอบ ${host}:${port} ด้วยบัญชี ${user} ...`);
  try { await t.verify(); console.log('✅ ล็อกอิน SMTP สำเร็จ'); }
  catch (e) {
    console.log('❌ ล็อกอินไม่ผ่าน:', String(e.message).split('\n')[0]);
    if (/535|SmtpClientAuthentication/i.test(e.message)) {
      console.log('   → บัญชีองค์กร M365: แอดมินต้องเปิด "Authenticated SMTP" ให้ mailbox นี้ก่อน');
      console.log('   → บัญชีที่เปิด MFA: ต้องใช้ App password แทนรหัสผ่านปกติ');
    }
    process.exit(1);
  }
  if (!process.argv.includes('--send')) { console.log('(เพิ่ม --send เพื่อส่งอีเมลทดสอบจริง)'); return; }
  const to = process.env.ALERT_EMAIL_TO || user;
  await t.sendMail({ from: user, to, subject: '[Logistics Tracking] ทดสอบระบบแจ้งเตือน',
    text: 'อีเมลทดสอบจาก import-export-os — ถ้าได้รับฉบับนี้แปลว่าการแจ้งเตือนกลับมาทำงานแล้ว' });
  console.log('✅ ส่งอีเมลทดสอบไปที่', to, 'แล้ว — เช็ค inbox');
})();

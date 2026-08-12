// ─── ตัวส่งอีเมลแจ้งเตือน — รองรับ 3 ทาง เลือกอัตโนมัติตามที่ตั้งค่าไว้ ────────────────────
//   1. Microsoft Graph API  (แนะนำสำหรับบัญชี Microsoft 365 ขององค์กร)
//   2. SMTP                 (Gmail App password / SMTP server อื่น)
//   3. ไม่ได้ตั้งค่า        → ข้ามการแจ้งเตือนเงียบๆ ไม่ throw
//
// ทำไมต้องมี Graph: องค์กรที่เปิด "Security Defaults" ของ M365 จะบล็อกการล็อกอิน SMTP
// ด้วยรหัสผ่าน (legacy auth) ทั้ง tenant — ล็อกอินจะได้ 535 5.7.139 "user is locked by your
// organization's security defaults policy" ต่อให้รหัสถูกและใช้ App password ก็ตาม
// (เจอจริง 2026-08-12 กับ wittaya.s@kissofbeauty.co.th) ทางที่ Microsoft รองรับคือ Graph API
// ด้วย client credentials ซึ่งไม่ใช้รหัสผ่านของผู้ใช้เลย และแอดมินคุมสิทธิ์ได้ละเอียดกว่า
'use strict';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const TOKEN_SKEW_MS = 60 * 1000; // ต่ออายุ token ก่อนหมดจริง 1 นาที กันหมดอายุคาระหว่างส่ง

let tokenCache = null; // { token, expiresAt }

function graphConfigured() {
  return !!(process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID
    && process.env.GRAPH_CLIENT_SECRET && (process.env.MAIL_FROM || process.env.MAIL_USER));
}
function smtpConfigured() {
  return !!((process.env.MAIL_USER && process.env.MAIL_PASS)
    || (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD));
}
function mailMode() { return graphConfigured() ? 'graph' : smtpConfigured() ? 'smtp' : null; }
function mailFrom() { return process.env.MAIL_FROM || process.env.MAIL_USER || process.env.GMAIL_USER; }

async function fetchWithTimeout(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// client credentials flow — ไม่มีผู้ใช้เกี่ยวข้อง สิทธิ์มาจาก Mail.Send (Application) ที่แอดมินอนุมัติ
async function getGraphToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const url = `https://login.microsoftonline.com/${encodeURIComponent(process.env.GRAPH_TENANT_ID)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: process.env.GRAPH_CLIENT_ID,
    client_secret: process.env.GRAPH_CLIENT_SECRET,
    scope: GRAPH_SCOPE,
    grant_type: 'client_credentials',
  });
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, 20000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    // ข้อความจาก Azure AD บอกสาเหตุตรงๆ (AADSTS…) เก็บไว้ให้เห็นเพื่อวินิจฉัยได้ทันที
    throw new Error(`ขอ token จาก Azure AD ไม่สำเร็จ (HTTP ${r.status}): ${j.error_description || j.error || '(ไม่มีรายละเอียด)'}`);
  }
  tokenCache = {
    token: j.access_token,
    expiresAt: Date.now() + Math.max(0, (parseInt(j.expires_in, 10) || 3600) * 1000 - TOKEN_SKEW_MS),
  };
  return tokenCache.token;
}

async function sendViaGraph({ to, subject, text }) {
  const token = await getGraphToken();
  const from = mailFrom();
  // ใช้ /users/{from}/sendMail ไม่ใช่ /me/sendMail — client credentials ไม่มี "me"
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`;
  const recipients = String(to).split(/[,;]/).map(s => s.trim()).filter(Boolean)
    .map(address => ({ emailAddress: { address } }));
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { subject, body: { contentType: 'Text', content: text }, toRecipients: recipients },
      saveToSentItems: true,
    }),
  }, 30000);
  if (r.status === 202) return;                    // Graph ตอบ 202 Accepted เมื่อรับคิวส่งแล้ว
  const body = await r.text().catch(() => '');
  if (r.status === 401 || r.status === 403) tokenCache = null; // token อาจถูกเพิกถอน — บังคับขอใหม่รอบหน้า
  throw new Error(`Graph sendMail ล้มเหลว (HTTP ${r.status}): ${body.slice(0, 300)}`);
}

let transporter;
function getTransporter() {
  if (transporter !== undefined) return transporter;
  const nodemailer = require('nodemailer');
  if (process.env.MAIL_USER && process.env.MAIL_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST || 'smtp.office365.com',
      port: parseInt(process.env.MAIL_PORT, 10) || 587,
      secure: false, // 587 = STARTTLS
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
    });
  } else if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  } else transporter = null;
  return transporter;
}

// คืน true = ส่งแล้ว · false = ยังไม่ได้ตั้งค่าอีเมล (ไม่ใช่ error) · throw = ตั้งค่าแล้วแต่ส่งไม่สำเร็จ
async function sendMail({ to, subject, text }) {
  const dest = to || process.env.ALERT_EMAIL_TO;
  if (!dest) return false;
  const mode = mailMode();
  if (!mode) return false;
  if (mode === 'graph') { await sendViaGraph({ to: dest, subject, text }); return true; }
  const t = getTransporter();
  if (!t) return false;
  await t.sendMail({ from: mailFrom(), to: dest, subject, text });
  return true;
}

// ตรวจว่าตั้งค่าถูกและใช้งานได้จริงหรือยัง โดยไม่ส่งอีเมล
async function verifyMail() {
  const mode = mailMode();
  if (!mode) return { ok: false, mode: null, error: 'ยังไม่ได้ตั้งค่าอีเมล' };
  try {
    if (mode === 'graph') { await getGraphToken(); return { ok: true, mode, from: mailFrom() }; }
    await getTransporter().verify();
    return { ok: true, mode, from: mailFrom() };
  } catch (e) { return { ok: false, mode, from: mailFrom(), error: e.message }; }
}

module.exports = { sendMail, verifyMail, mailMode, mailFrom };

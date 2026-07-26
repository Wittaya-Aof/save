# Project: import-export-os

## วัตถุประสงค์
ต่อยอดงานระบบ import/export logistics เดิมให้เป็นระบบรวมศูนย์ (OS) สำหรับงานนำเข้า-ส่งออก
เชื่อมโยงเครื่องมือที่มีอยู่เข้าด้วยกัน

## สร้างเมื่อ
2026-07-24

## สถานะ
กำลังดำเนินการ (เพิ่งเริ่ม — ยังต้องนิยาม scope ให้ชัด)

## งานเดิมที่ต่อยอด (ดู memory ประกอบ)
- **logistics-api** (`C:\Users\User\logistics-api`) — API server, ต่อ Odoo ผ่าน MCP proxy, port 3000 (ห้าม bind ทับ)
- **scan-shipment-docs.mjs** — auto-scan โฟลเดอร์เอกสาร shipment + AI + ดึง ETA จาก ETS
- **verify-shipment** (skill) — ตรวจทั้งโฟลเดอร์ shipment แล้วออกรายงาน cross-check (Word/Excel)
- **customs-clearance** (agent) — ตรวจเอกสารพิธีการศุลกากรไทย (CI/PL/BL/AWB, กศก.99/1, 101/1)
- **Odoo** — เข้าผ่าน MCP proxy เท่านั้น (direct RDS ต่อไม่ได้จากเครื่องนี้)

## Scope ที่ต้องนิยามต่อ
- [ ] ระบบนี้จะรวมอะไรบ้าง / จุดตัดกับ logistics-api อยู่ตรงไหน
- [ ] เป็น service ใหม่ หรือ orchestration layer ครอบของเดิม
- [ ] UI / CLI / API

## Security & Reliability Hardening (2026-07-27)
รอบตรวจ+แก้ช่องโหว่/บั๊ก/เสถียรภาพครบชุด (ทุกไฟล์ผ่าน `node --check` + unit test logic ผ่าน 15/15):
- **Atomic writes** ทุกไฟล์ข้อมูล (tracking_data, snapshot, integrity, doc_scan_seen) — temp+rename กัน corrupt
- **Excel hang (C1)** — port `computeUsedRange` ไป verify-shipment.js + verify-shipment-local.js (กันชีตบวมค้าง)
- **Playwright leak** — ets-lookup ครอบ try/close, scan-shipment-docs ปิด session ใน finally
- **ETS voyage mismatch (H5)** — ไม่หยิบแถวแรกเมื่อ voyage ไม่ตรง, ใช้เฉพาะคอลัมน์ Actual (ไม่เดา Schedule)
- **Security** — timing-safe compare (APP/DELETE_PASSWORD), บังคับ APP_PASSWORD เมื่อ bind ไม่ใช่ loopback,
  RDS TLS verify ผ่าน DB_SSL_CA, security headers, rate limit verify-shipment (10/นาที), cache/clear เป็น POST,
  จำกัด+sanitize search param `q`
- **Timeout** — upsert (15s), MCP fetch (30s+retry), Anthropic client (120s/maxRetries 2)
- **บั๊กอื่น** — AWB check-digit validation, parseFlexibleDate validate ช่วงเดือน/วัน, MAX_TOTAL_BYTES cap,
  pdf-worker flush ก่อน exit, acquireLock atomic (wx flag) + แยก EPERM/ESRCH, log rotation
- **watchdog.mjs** (ใหม่) — poll /api/alive, restart ผ่าน `pm2 restart` (ถ้ามี) หรือ kill PID ที่ถือ port 3000
  "เจาะจงตัวเดียว" (ยืนยัน api-server.js ก่อน) แล้ว vbs respawn — *ไม่* kill node เหมารวม
  ตั้ง Scheduled Task เรียกทุก 3-5 นาที + `--restart` (ExecutionTimeLimit=0)

## Supervisor / Deploy (สถานะจริง ยืนยัน 2026-07-27)
- **supervisor ที่ใช้จริง = `start-server.vbs`** (ผูก Startup shortcut, loop sh.Run wait=True) — ไม่ใช่ pm2
- pm2 daemon รันอยู่ในเครื่องแต่ **ไม่ได้จัดการ** import-export-os (คนละ project) → ปัจจุบันไม่มีการชน port
- `ecosystem.config.js` เป็นทางเลือกสำรอง — ถ้าจะย้ายไป pm2 ต้อง **ปิด vbs (ลบ Startup shortcut) ก่อน**
  ห้ามรันทั้งคู่พร้อมกัน (EADDRINUSE → crash loop; มี guard+backoff บรรเทาแล้ว)

## Notes
- ✅ xlsx อัปเดตเป็น **0.20.3** (จาก cdn.sheetjs.com) แก้ Prototype Pollution/ReDoS แล้ว (0 vulnerabilities)
- ⚠️ production: ควรตั้ง `DB_SSL_CA` ใน .env เพื่อ verify RDS cert (ดู .env.example)
- restart วิธีปลอดภัยกับ vbs setup: `taskkill /PID <pid ที่ถือ 3000> /F` แล้ว vbs respawn โค้ดใหม่เอง

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

## รอบ review ทุก module (2026-07-31)
ตรวจทั้ง 4 module (Logistics Board/Dashboard, Container Calculator, ตรวจเอกสาร Shipment, API server) แล้วแก้:

**⭐ เรื่องใหญ่สุด — endpoint ที่ตายเงียบเพราะไม่มี MCP fallback**
`direct RDS (5432) หลุดถาวร` บนเครื่องนี้ (IP dynamic ไม่อยู่ใน security-group allowlist) — ยืนยันจาก
server.log ว่า AutoProbe ล้มทุกรอบ แต่ MCP bridge สำเร็จทุกรอบ ผลคือ 4 endpoint ที่มีแต่ทาง direct
ตอบ 500 **ตลอดเวลา**: `/api/vendors`, `/api/vendor-scorecard`, `/api/gl-reconciliation`, `/api/fx-rates`
→ Dashboard มี 2 panel ว่างเปล่าเงียบๆ (Vendor Scorecard, GL Reconciliation), autocomplete forwarder
ไม่มีรายชื่อ, และอัตราแลกเปลี่ยนตกไปใช้ `rateGuess()` ที่ฮาร์ดโค้ดไว้ (USD 33.3 vs จริง 33.72)
**แก้:** ย้าย MCP fallback เข้าไปใน `cachedQuery(key, sql, force, mcp)` เลย — endpoint ส่ง
`{orderCols, maxRows}` มาก็ได้ทาง bridge ฟรี (ยืนยันแล้ว: 500/23/78/8 แถว ไม่มีแถวซ้ำ/หาย)

**บั๊กอื่นที่แก้ในรอบนี้**
- `readJsonBody` ใช้ `body += chunk` (Buffer+string) → ตัวอักษรไทย 3 ไบต์ที่คร่อมขอบ chunk เสียเป็น U+FFFD
  → เปลี่ยนเป็นเก็บ Buffer แล้ว `Buffer.concat().toString('utf8')` (ทดสอบ: หมายเหตุไทย 90,000 ตัว / body
  216KB กลับมาเหมือนเดิมทุกไบต์)
- circuit breaker เปิดจาก error ที่ไม่ใช่ปัญหาการเชื่อมต่อ (เช่น `/api/shipments` ตอนไม่มีตาราง →
  "relation does not exist") ปิดทุก endpoint ทิ้ง 2.5 นาที → เพิ่ม `isConnFailure()` gate ทุกจุดที่ `markDbDown()`
- `?months=-6` ผ่าน `|| 8` ได้ (ค่า truthy) → `INTERVAL '-6 months'` → คืนลิสต์ว่างเงียบๆ → clamp ขั้นต่ำ 1
- `jsonErr` ไม่มี charset (ข้อความไทย) + ไม่มี security headers ที่ทาง success มีครบ
- static HTML ไม่มี `Cache-Control` → หลัง deploy ยังเห็นโค้ดเก่า (ตอนนี้ html=no-cache, vendor/*=1 วัน)
- audit log เขียนแถว "แก้ไข (ไม่มีฟิลด์สำคัญเปลี่ยน)" ทุกครั้งที่ upsert เข้ามาแม้ไม่มีอะไรต่าง (43/540 แถว
  = 8% ของ log) ดันการแก้ไขจริงตกออกจากแผงประวัติที่โชว์ 40 รายการ → ข้ามเมื่อไม่มีฟิลด์เปลี่ยนจริง
- `/api/ping` เช็คแต่ direct → รายงาน `{direct, mcp}` แยกกัน (วินิจฉัยถูกทางเวลา direct หลุดแต่ bridge ยังดี)
- ลบ dead code: `SQL_STATS` (ไม่มีใครใช้), 2 query ใน `/api/debug/expense-structure` ที่ยิงแล้วไม่เคยคืนผล

**frontend**
- `/api/import-plan` **ไม่มีอยู่จริง** — ตอบ 404 ทุกรอบโหลด (ทุก 3 นาที) โค้ดที่พึ่ง plan
  (`applyPlan`/`planFor` + สาขาเงื่อนไขใน `deriveImportStage`/`deriveExportStage`) เป็น dead code ทั้งชุด → ตัดทิ้ง
- `submitCreate` ไม่เช็ค `res.ok` → ขึ้น toast "เพิ่มรายการสำเร็จ" แม้ server ตอบ 400/500 (จุดอื่นเช็คอยู่แล้ว)
- **สี stage ต้องเป็น hex ล้วน ห้าม `var(--…)`** — โค้ดต่อสตริงทำพื้นจาง (`stg.color+'15'`, `color+'12'`,
  `color+'33'`) ซึ่งกับ `var()` จะได้ CSS ไม่ถูกต้อง เบราว์เซอร์ทิ้ง property เงียบๆ → ปุ่มปรับสถานะ 3 ขั้น
  สุดท้ายและกล่อง Transit Time ตอนล่าช้าหายพื้น/หายกรอบ
- เพิ่ม token `--color-brand-text` / `--color-warn-border` แล้วแทนสีฮาร์ดโค้ด 15 จุดที่อ่านไม่ออกใน dark mode
  (ที่หนักสุด: `#1e293b` บนพื้น brand-soft ในกล่อง "ต้นทุนรวม" กับชื่อผู้ขายในตัวเลือกบิล + `#fbcfe8`/`#f5f0f3`/
  `#eee5ea` ที่เป็นเศษธีมชมพูเดิม)
- โหมดตัวอย่างเตือนแค่จุดสีเล็กๆ ทั้งที่ข้อมูลตัวอย่างใช้ชื่อผู้ขาย/เลข PO หน้าตาเหมือนจริง → เพิ่มแถบเตือน
  เต็มความกว้าง (เสี่ยงมีคนอ่านตัวเลขไปทำรายงาน)
- ป้ายสถานะกระพริบเป็น "กำลังโหลด…" ทุก 3 นาทีจาก auto-refresh → โชว์เฉพาะรอบแรก/กด Sync เอง
- `loadVendors` ไม่มี timeout + set `[]` เมื่อพลาด ทำให้ไม่มีโอกาสลองใหม่ตลอดอายุแท็บ
- เพิ่ม: ค้นหาครอบเลขตู้/ชื่อเรือ/forwarder/ท่า (เดิมมีแค่ PO/คู่ค้า/BL), Escape ปิดแผงทีละชั้น,
  `as_of` ใช้เวลาที่เก่ากว่าของสองบอร์ด (เดิมหยิบของ import เท่านั้น = โกหกว่าสดกว่าจริง)

**ตรวจเอกสาร Shipment (lib/verify-shipment-local.js)**
- เลขตู้/HS code/เลข invoice ที่มีหลายค่าต่อ shipment (เรื่องปกติมาก) ถูกฟันธงเป็น error "ไม่ตรงกันระหว่างไฟล์"
  → หมวด "ต้องแก้ไข" มี error ปลอมแทบทุกรอบจนเชื่อถือไม่ได้ **แก้:** ใส่ธง `multi` + เทียบเป็น "ชุดค่าต่อไฟล์"
  (ทดสอบจริง: ไฟล์เหมือนกัน 2 ตู้ 2 HS → 0 error ตามเดิมควรเป็น; PO ต่างกัน → ยัง error ถูกต้อง)
- เหตุผลที่อ่านไฟล์ไม่ได้ถูกกลืนเป็นข้อความเดียว "อาจเป็น PDF สแกน" ทั้งที่อาจเป็น worker timeout 20 วิ
- ลบ `textUpper` (สำเนา uppercase ทั้งไฟล์ที่ไม่มีใครอ่าน — เปลืองแรมเท่าตัว ×15 ไฟล์)

**Container Calculator**
- สูตรนับแถว hex-pack ของถัง: `floor((W - d/2)/rowH)+1` ให้แถวสุดท้ายเหลือที่แค่ครึ่งเส้นผ่าศูนย์กลาง →
  โอเวอร์เคานต์ 1 แถวผี + ไม่มี guard ว่าถังกว้างกว่าตู้ (ถัง Ø3000mm ในตู้กว้าง 2350mm ยังคืนค่าบวก)
  แก้เป็น `floor((W - d)/rowH)+1` + guard `d<=W && d<=L` (เทียบ brute force ตรงทุกเคส)

**ยังไม่แก้ (ตั้งใจ) — ควรคุยก่อน**
- `/api/debug/expense-structure` เป็น scaffolding สมัยสำรวจ schema ไม่มี UI ใช้ ยิง ILIKE ไม่มี index บน
  account_move 4 ล้านแถว 5 query/ครั้ง — เสนอลบทั้ง endpoint
- `/api/expense-pos` (LIMIT 8000), `/api/costs-for-po`, `/api/shipments` ยังไม่มี MCP fallback เพราะ**ไม่มี UI
  เรียกใช้เลย** (expense-pos ถ้าจะทำต้อง paginate 67 รอบ — ควรลด LIMIT ก่อน)
- Odoo JSON-RPC ยังต่อ port 80 (`ODOO.port: 80`) = ส่ง user/pass เป็น cleartext — ควรย้ายเป็น 443/https
- ตรวจ algorithm จัดเรียงตู้ (packLayout/calcBox) แบบละเอียดยังไม่ได้ทำ — เป็นงานก้อนแยก

## Notes
- ✅ xlsx อัปเดตเป็น **0.20.3** (จาก cdn.sheetjs.com) แก้ Prototype Pollution/ReDoS แล้ว (0 vulnerabilities)
- ⚠️ production: ควรตั้ง `DB_SSL_CA` ใน .env เพื่อ verify RDS cert (ดู .env.example)
- restart วิธีปลอดภัยกับ vbs setup: `taskkill /PID <pid ที่ถือ 3000> /F` แล้ว vbs respawn โค้ดใหม่เอง

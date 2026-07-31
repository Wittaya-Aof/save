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

## ลบ dead code ก้อนใหญ่ (2026-07-31 — AOF อนุมัติแล้ว)
ตัดออก **570 บรรทัด** (api-server.js 2334 → 1764 บรรทัด, −24%) หลังยืนยันด้วยหลักฐานว่าไม่มีใครใช้:

| ที่ลบ | หลักฐานว่าตายจริง |
|---|---|
| Odoo JSON-RPC layer ทั้งชุด (`ODOO`, `odooPost`, `odooLogin`, `odooKw`, `isOdooSessionExpired`) | `odooKw` ถูกเรียก 3 จุด เป็น `logistics.shipment` ทั้งหมด · `odoo.kissofbeauty.co.th` **ไม่ resolve ใน DNS** · `ODOO_USER`/`ODOO_PASS` ไม่ได้ตั้งใน .env ด้วยซ้ำ (odooLogin throw ก่อนยิง request) |
| `SQL_SHIPMENTS` + `/api/shipments` GET/POST/PATCH/DELETE | ตาราง `logistics_shipment` **ไม่มีอยู่ใน Odoo** (เช็คแล้ว: `to_regclass` = false, ตาราง `logistics%` = 0 ตัว) · ไม่มี UI เรียก · AOF ยืนยันไม่มีแผนติดตั้ง module |
| `/api/debug/expense-structure` | scaffolding สมัยสำรวจ schema · ไม่มี UI เรียก · ยิง ILIKE ไม่มี index บน account_move 4 ล้านแถว 5 query/ครั้ง |
| `/api/expense-pos` (LIMIT 8000) + `/api/costs-for-po` | ถูกแทนที่ด้วย `/api/logistics-bills` + bill picker แล้ว · ไม่มี UI เรียก · ตัวเก่าตอบ 500 ตลอดเพราะไม่มี MCP fallback |

**เหลือ 17 endpoint** = 16 ตัวที่ frontend เรียกจริง + `/api/alive` (watchdog) — ทดสอบแล้ว 200 ทุกตัว
พร้อมข้อมูลจริง, ตัวที่ลบตอบ 404 ทุกตัว, Playwright ทั้ง light+dark = 0 pageerror ผลเหมือนก่อนลบเป๊ะ
`.env.example` ถอด `ODOO_USER`/`ODOO_PASS` ออกแล้ว · banner ตอน start เปลี่ยนแถว "Odoo RPC" เป็น "MCP"

> ผลข้างเคียงที่ดี: ตอนนี้ **ไม่มี code path ไหนเขียนกลับเข้า Odoo เลย** — แอปนี้อ่านอย่างเดียว
> (Postgres direct → MCP bridge) ส่วนที่เขียนได้มีแค่ `tracking_data.json` ในเครื่อง ลด blast radius ลงมาก

## แก้บั๊กพาเลทใน Container Calculator (2026-07-31 — AOF สังเกตเจอจากภาพ 3D)
AOF รายงานว่า "เรียงได้ตรง แต่การ on pallet ดูแปลก" — ตรวจด้วย harness วัด invariant เรขาคณิตจาก
`packLayout()` จริง (ไม่ดูจากภาพ) แล้วยืนยันว่ามีบั๊กจริง **แต่ไม่ได้อยู่ที่การจัดเรียงบนพาเลท**:

**ต้นเหตุเดียว: `PAL_TOL=60` ถูกบวกเข้ากับความกว้างตู้ตอนนับจำนวนแถวพาเลท**
`pRows = floor((c.W + PAL_TOL)/across)` ทำให้ระบบเชื่อว่าใส่ได้ 2 แถวในกรณีที่ใส่ไม่ได้จริง แล้ว
`rowY()` ดันแถวแรกชิดผนังด้านหนึ่ง แถวสุดท้ายชิดผนังอีกด้าน → **พาเลทสองแถวทับกันเอง**
- ตู้ 20'GP กว้าง 2350mm + พาเลท 1200mm สองแถว = ต้องใช้ 2400mm → เกิน 50mm
- วัดจริง: deck ทับกัน 1000×50mm ทุกคู่แถว + กล่องบนพาเลทคนละแถวทะลุกัน **37 คู่**
- **ซ้อนกันภายในพาเลทเดียวกัน = 0 คู่** → การ pack บนพาเลทถูกต้องอยู่แล้ว ตรงกับที่ AOF สังเกต
- tolerance แบบนี้ไม่มีทางถูก เพราะจะ "ช่วย" ก็ต่อเมื่อพาเลทใส่ไม่ได้จริงเท่านั้น → ถอด PAL_TOL ออก
  ทั้งใน `packLayout` และ `calcBox` (ต้องตรงกัน ไม่งั้น capacity กับ layout จะไม่ตรง)

**บั๊กที่ 2 (คนละตัว): คอลัมน์ "ชั้น" ในตารางผลลัพธ์แสดงค่าเพี้ยน**
pallet path เก็บ `zSeen["<พาเลทที่>:<z>"]` แล้วนับ `Object.keys().length` → ได้ "ชั้น × จำนวนพาเลท"
(เช่น 7 ชั้นบน 7 พาเลท = **50**) โชว์ตรงๆ ในตาราง ทั้งที่ความสูงพาเลทจำกัดให้ซ้อนได้ 7 ชั้น
(ฝั่ง std ไม่มีปัญหาเพราะ key เป็น z เปล่าๆ) → ติด `idx` ไปกับทุก place แล้วนับชั้นต่อพาเลทจาก
layout สุดท้าย (หลัง rebalance/re-pack) ตอนนี้แสดง 7 / 6 ถูกต้อง

**⚠ ผลกระทบต่อจำนวนพาเลทที่รายงาน — ตัวเลขเดิมสูงเกินจริง (อันตรายกว่าต่ำเกิน)**
| ตู้ | พาเลท | เดิม | ใหม่ | แถวทับกันเดิม |
|---|---|---|---|---|
| 20'GP | standard 1200×1000 | 10 | **8** | 50mm |
| 20'GP | euro 1200×800 | 14 | **8** | 50mm |
| 40'GP/40'HC | standard | 24 | **20** | 50mm |
| 40'GP/40'HC | euro | 30 | **20** | 50mm |
| ทุกตู้ | us 1219×1016 | 8/18/20 | เท่าเดิม | ไม่ทับ (ไม่เคยพึ่ง tolerance) |

เลข 14 ใบของ Euro ในตู้ 20'GP = ใช้พื้น 97% ของพื้นตู้ ซึ่งเป็นไปไม่ได้ทางกายภาพ — ถ้าใครเชื่อเลขนี้
ไปจองตู้ จะจองน้อยกว่าที่ต้องใช้จริงแล้วของขึ้นไม่หมด **การรายงานเกินจริงอันตรายกว่ารายงานต่ำ**
ตรวจแล้วว่าทุกตู้ × ทุก pallet preset ตอนนี้ `rows × across <= ความกว้างตู้` ครบทุก combination

**ทางปรับปรุงต่อ (พิสูจน์เรขาคณิตแล้ว แต่เป็นฟีเจอร์ใหม่ ไม่ใช่ bug fix): tail rotation → 8 เป็น 9 ใบ**
20'GP + standard: grid วาง 1200(ยาว)×1000(กว้าง) ได้ 4 คอลัมน์ × 2 แถว = 8 ใบ (ใช้ x 0..4800)
เหลือท้ายตู้ x 4800..5895 = **1095mm** ซึ่งวางพาเลทสลับทิศ (1000 ตามยาว × 1200 ตามกว้าง) ได้อีก 1 ใบ
พอดี (1000 ≤ 1095 และ 1200 ≤ 2350) → 9 ใบ ที่เหลือหลังจากนั้นใส่ไม่ได้จริง (y เหลือ 1150 < 1200)
ต้องเขียน placement แบบผสมทิศ ไม่ใช่แค่แก้สูตร grid

## รอบตรวจ packer ให้ครบทุก path (2026-07-31 รอบ 2)
สร้างชุดทดสอบถาวรที่ `tests/` (ดู `tests/README.md`) แล้วตรวจ **invariant ทางเรขาคณิต** จาก
`packLayout()` โดยตรง — วิธีนี้เจอบั๊กที่มองจากภาพ 3D ไม่ออก
**ผลสุดท้าย: 42 scenario + fuzz 3000 เคส = 0 violation**

```bash
node tests/pack-invariants.mjs      # 42 scenario ครอบทุกตู้ + ทุก path
node tests/pack-fuzz.mjs 3000       # สุ่ม 3000 เคส (มี seed ทำซ้ำได้)
```

เจอ + แก้เพิ่ม 4 บั๊ก (นอกจาก 2 ตัวของรอบแรก):

**1. pallet packer ไม่เคารพ `maxLayers` ที่ผู้ใช้ตั้ง** (scenario จับได้)
มีแต่เพดานความสูง (`capOf`) ไม่มีเพดานจำนวนชั้น → ตั้ง "ซ้อนไม่เกิน 2 ชั้น" (ของเปราะ/ข้อกำหนดลูกค้า)
แต่แผนวางให้ 4 ชั้นเงียบๆ ทั้งที่ฝั่ง std เช็คอยู่แล้ว และ `calcBox` ก็คิด `nz` รวม maxLayers ไว้แล้ว
→ เพิ่ม `palLayersUsed()` นับชั้นต่อ SKU **ต่อพาเลทหนึ่งใบ** แล้วเทียบกับ `P.nH`

**2. ความสูงพาเลทไม่ดูความสูงตู้เลย** (fuzz จับได้ 5 เคส — bounds-z)
`availH = palMaxH - palD0` ไม่มี `c.H` อยู่ในสมการ → พาเลท default ซ้อนได้ 2000mm แต่รถ 6 ล้อเล็ก
สูง 1900mm และกระบะ (TPK) สูงแค่ **500mm** → ของทะลุหลังคาออกไปนอกตู้
→ `availH = Math.min(palMaxH, c.H) - palD0` + ถ้า `availH<=0` ไม่สร้างพาเลทเลย

**3. กล่องกว้างกว่าตัวพาเลทยังถูกวางลงไป** (fuzz จับได้ 4 เคส — bounds-y)
`Math.max(1, Math.floor(across/bW))` บังคับ "วางได้อย่างน้อย 1 ใบต่อแถว" เสมอ → กล่องล้นออกนอก
พาเลทและนอกตู้ → ถอด `Math.max(1,…)` ออก + เช็ค `bW<=across` ตอนเลือก segment
+ เลือกทิศพาเลทโดยดูว่า **รองรับ SKU ได้กี่ชนิด** ก่อนดูจำนวนตำแหน่ง (เดิมดูจำนวนตำแหน่งล้วน
ทำให้บางทีเลือกทิศที่วางของไม่ได้เลยทั้งที่ทิศอีกแบบวางได้)

**4. ⭐ พาเลทหลายสเปคในตู้เดียวถูกยุบเป็นสเปคเดียว — over-report (อันตรายสุดในรอบนี้)**
`pal0 = palItems[0].it.pallet` ใช้สเปคของ SKU แรกกับพาเลท **ทุกใบ** ทั้งที่ `pallet` ผูกกับ *group*
ผู้ใช้ตั้งคนละขนาดได้จริงจากหน้าจอ → วัดจริง: group B ตั้งพาเลท **800×600 ซ้อน 1000mm tare 3.0**
แต่แผนวางบน **1200×1000 tare 5.2** แล้วรายงานว่าใส่ได้ **48 กล่อง/ใบ** ซึ่งพาเลทจริงรับได้ 16
(น้ำหนัก tare ที่เอาไปคิด gross weight ก็ผิดด้วย → เสี่ยงเกินพิกัดรถ)
→ จัดกลุ่มตามสเปคพาเลทแล้ว **วางแยกโซนกันไปตามความยาวตู้** (`perRow` หักโซนก่อนหน้าออก,
เลขพาเลทเดินต่อข้ามกลุ่ม, frames/manifest สะสมข้ามกลุ่ม)
ยืนยันภาพ 3D: โซนพาเลทใหญ่ (deck 150mm) → โซนพาเลทเล็ก (deck 100mm, 3 แถว) → ของไม่ขึ้นพาเลท
แยกกันชัด ไม่ทับกัน และ manifest รายงานขนาด/tare ตรงตามที่ตั้งไว้จริงทั้งสองสเปค

## ธีม UI: Supabase design system (2026-07-31)
ปรับใช้ `C:/Users/User/Projects/supabase.design.md` — **เป็นระบบดีไซน์เดียวของโปรเจกต์นี้**
backup ก่อนเปลี่ยนธีมถูกลบทิ้งตามที่ AOF สั่ง (ยกเลิกธีมที่ทดลองไว้ก่อนหน้า) — ถ้าต้องย้อนดู
ให้ใช้ git: `7532051` (Mural) / `ca23a1a` (Mintlify) / `732f144` (Supabase = ปัจจุบัน)

**ท่าเด่น 3 อย่างที่ทำให้ตรง**
1. **emerald `#3ecf8e` เป็นสีเดียวในหน้า** — spec: "the only chromatic event across the entire page"
   ที่เหลือเป็นเกรย์สเกลล้วน ไล่จาก `#ededed` ถึง ink `#171717`
2. **อักษรบนปุ่มเขียวเป็น "เกือบดำ" ไม่ใช่ขาว** — spec: "near-black #171717 text on the emerald
   button (not white) — the green reads as a 'lit' surface with dark type, which is the brand's
   idiosyncratic choice" · **วัดจริง: ink บน emerald = 8.98 / ขาวบน emerald = 2.00** สเปคถูกกว่าชัดเจน
3. **ปุ่ม 6px ห้ามเป็น pill** — spec: "square-ish and technical, never pill-shaped"
   `--radius` = **6px** ทั้งระบบ, pill สงวนไว้ให้ tag/avatar เท่านั้น

**⚠ ข้อจำกัดที่วัดได้และต้องระวังเวลาแก้ต่อ: emerald บนพื้นขาว = 2.00**
ตกทั้งเกณฑ์ข้อความ (4.5) และกราฟิก (3.0) → **ห้ามใช้ `--color-brand` เป็นสีตัวอักษรหรือเส้นขอบบนพื้นสว่าง**
ใช้ได้แค่ 3 แบบตามที่ spec ระบุ: **พื้นปุ่ม CTA / จุด accent / ตัวชี้สถานะเป็นครั้งคราว**
จึงตั้ง `--color-brand-text` = ink (ไม่ใช่ emerald) และสถานะ active ทั้งหมดเป็น ink
ตอน dark mode ใช้ `primary-soft #4ade80` ของ spec แทน (บน `#1c1c1c` = 9.78 ผ่านสบาย)

**`--color-on-brand` = `#171717` ทั้งธีมสว่างและมืด** เพราะปุ่มเขียวมีอักษรเกือบดำเสมอ ไม่ต้องพลิกค่า
ตามธีม — แต่ปุ่มยังต้องใช้ `color:var(--color-on-brand)` ห้ามฮาร์ดโค้ด

**ยกมาตรงตาม spec (อื่นๆ)**
| ส่วน | ค่า |
|---|---|
| ink | `#171717` — spec ย้ำ "near-black, never pure black" |
| ไล่โทนอักษร | ink `#171717` → ink-secondary `#212121` → ink-mute `#707070` → ink-mute-2 `#9a9a9a` |
| พื้น | canvas `#fff` / canvas-soft `#fafafa` / hairline-cool `#ededed` |
| เส้น | hairline `#dfdfdf` + hairline-strong `#c7c7c7` |
| **น้ำหนักตัวอักษร** | **มีแค่ 400 (body) กับ 500 (display/button)** — spec ไม่มี 600/700 เลย ("display weights capped at 500") → แปลง 600→500 (**111 จุด**) และ 700→500 (**32 จุด**) ทั้งสองไฟล์ |
| ฟอนต์ | Circular เป็น proprietary — **spec แนะนำตัวแทนเอง**: "use Inter at weight 500" → ใช้ Inter + Noto Sans Thai (Inter ไม่มีอักษรไทย) |
| code/mono | `typography.code` เป็น **system mono stack** (ui-monospace/Menlo/Monaco/Consolas) ไม่ใช่ webfont — แคบพอให้เลข PO บนการ์ดอยู่บรรทัดเดียวครบ 327 ใบ |
| radius | 4 / 6 / 8 / 12 / 16 / pill · การ์ด 12px · ปุ่ม+อินพุต 6px |
| เงา | spec ไม่ระบุเงาเลย ใช้ "subtle 1px hairlines" → `--shadow-card:none` เหลือเงาเฉพาะแผงลอย |

**ส่วนขยาย / จุดที่เบี่ยงจาก spec (พร้อมเหตุผล)**
1. **dark mode** — spec Known Gap: "the marketing site commits to white; the inverse mapping ...
   isn't captured" → สร้างจากโทนเข้มที่ spec มีจริง (ใช้กับ code block / featured tier / mockup):
   ink `#171717` เป็นพื้นล่างสุด, canvas-night `#1c1c1c` เป็นการ์ด, canvas-night-soft `#202020` เป็นพื้นรอง
2. **สีสถานะ danger/success/warn** — spec Known Gap: "Toast and inline-alert system — semantic
   info/success/warning/error treatments aren't represented" (และ `accent-*` ของ spec สงวนไว้ให้
   กราฟ/โลโก้) → **เลือกค่าที่ผ่านเกณฑ์ contrast เองโดยคุมให้อยู่ในโทนเดียวกับระบบ ไม่เดาจาก spec**
3. **จุดสีบอกสถานะ shipment 6 ขั้น (เทา→ฟ้า→น้ำเงิน→อำพัน→เขียว) ยังเป็นสี** — เบี่ยงจาก
   "only chromatic event" อย่างตั้งใจ เพราะ (ก) มันเข้ารหัสสถานะงานที่ผู้ใช้อ่านจากบอร์ดด้วยสายตา
   ไม่ใช่การตกแต่ง (ข) spec เองระบุว่า `accent-*` "reserved for chart and logo work" คือการเข้ารหัสข้อมูล
   (ค) ถ้า remap ไปใช้ accent ของ spec จะได้ `accent-yellow #ffdb13` บนจุด 7px = contrast 1.2 มองไม่เห็น
4. **focus ring** — spec Known Gap ("not the focus-ring color") + emerald ใช้เป็นเส้นไม่ได้ → ใช้ ink
5. **`--color-text-muted` = ink-mute-2 `#9a9a9a` ได้ contrast 2.81** บนพื้นขาว — เป็นจุดเดียวที่ความ
   ซื่อตรงต่อ spec แลกมาด้วย contrast ที่ต่ำลง — ใช้กับ caption เล็ก (วันที่/จำนวนรายการ) เท่านั้น
   **ถ้าอ่านยากให้เปลี่ยนบรรทัดเดียว**: `--color-text-muted:#707070` (ink-mute = 4.95)
   ส่วน `ink-faint #b2b2b2` (2.12) จงใจไม่ใช้เลย

**ทดสอบแล้ว**: light/dark = 0 pageerror · น้ำหนักที่เรนเดอร์จริงเหลือ **400/500 เท่านั้น** · ปุ่ม emerald
ทั้ง 2 ปุ่ม อักษร `rgb(23,23,23)` radius `6px` contrast **8.98** ทั้งสองธีม · เลข PO 327 ใบไม่ตัด/ไม่ถูกตัดขอบ ·
ข้อมูลจริง 327/106 · **packer suite 42 scenario + fuzz 600 เคส = 0 violation** · endpoint หลักตอบ 200

## ยังไม่แก้ (ตั้งใจ)
- **pinwheel / tail rotation สำหรับพาเลท** — พิสูจน์แล้วว่าได้ 9 ใบแทน 8 ในตู้ 20'GP (ดูหัวข้อด้านบน)
  เป็นฟีเจอร์ใหม่ ต้องเขียน placement แบบผสมทิศ
- `calcBox` ตอนใช้พาเลทคิด `bpp` จากการวางกล่องแนวเดียว **ไม่ลองหมุนกล่องภายในพาเลท** และไม่คิด
  overhang → ประเมินจำนวนกล่องต่อพาเลท**ต่ำกว่าจริง** (ปลอดภัยกว่าเกิน แต่อาจสั่งตู้เกินจำเป็น)
  ยังไม่แก้เพราะต้องตัดสินใจก่อนว่ายอมให้กล่องล้นขอบพาเลทได้กี่ mm (นโยบายธุรกิจ ไม่ใช่เรื่องโค้ด)
- ~~ตรวจ `packLayout` ฝั่ง std แบบละเอียด~~ **ทำแล้ว** (2026-07-31 รอบ 2) — std path ผ่านทุก
  invariant ตั้งแต่รอบแรกที่ยิงเทส ไม่พบบั๊ก บั๊กทั้ง 4 ตัวที่เจอเพิ่มอยู่ฝั่งพาเลททั้งหมด
- std packer นับเพดานชั้น (`nH`) จาก `Object.keys(zSeen).length` ซึ่งเป็น "จำนวนระดับ z ที่ต่างกัน
  ทั้งตู้" ไม่ใช่ "จำนวนชั้นในกองเดียว" → เมื่อ SKU ต่างความสูงวางสลับกัน อาจหยุดเติมเร็วกว่าที่ควร
  (**under-fill ทางที่ปลอดภัย** ไม่ใช่ over-report) จงใจไม่แก้ในรอบนี้เพราะการแก้ heuristic แกนกลาง
  ของ packer เสี่ยงกลายเป็น over-report ซึ่งอันตรายกว่า — ถ้าจะแก้ต้องมีเคสจริงยืนยันว่าเสียโอกาสจริง

## ถ้า deploy ขึ้น Hostinger (AOF บอกว่าอาจทำ)
- `HOST=0.0.0.0` **บังคับต้องตั้ง `APP_PASSWORD`** ไม่งั้น server ปฏิเสธ start (guard มีอยู่แล้ว ตั้งใจ)
- direct RDS (5432) **อาจใช้ได้จริงบน Hostinger** เพราะ IP นิ่งกว่า → เอาเข้า security-group allowlist ได้
  ถ้าได้ MCP bridge จะกลายเป็น fallback จริงๆ ไม่ใช่ทางหลักแบบบนเครื่องนี้ (เช็คด้วย `/api/ping`)
- ต้องขน `.env` + `rds-ca.pem` ไปด้วย (ไม่อยู่ใน git) และตั้ง `DB_SSL_CA` ให้ชี้ path ใหม่
- `start-server.vbs` เป็นของ Windows — บน Linux ต้องใช้ pm2 (`ecosystem.config.js` มีอยู่แล้ว) หรือ systemd
- `vendor/*.js` + in-browser Babel: โหลดช้ากว่าที่ควรบน production แต่ทำให้เปิดได้แม้เน็ตล่ม (ตั้งใจ)

## Notes
- ✅ xlsx อัปเดตเป็น **0.20.3** (จาก cdn.sheetjs.com) แก้ Prototype Pollution/ReDoS แล้ว (0 vulnerabilities)
- ⚠️ production: ควรตั้ง `DB_SSL_CA` ใน .env เพื่อ verify RDS cert (ดู .env.example)
- restart วิธีปลอดภัยกับ vbs setup: `taskkill /PID <pid ที่ถือ 3000> /F` แล้ว vbs respawn โค้ดใหม่เอง

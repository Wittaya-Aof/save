# Logistics Tracking Web App — Dev Log
**Date:** 2026-05-21 → 2026-05-22  
**Project:** `C:\Users\User\logistics-api\` (ย้ายมาจาก OneDrive\My Claude\)  
**Server:** `http://localhost:3000` — pm2 process `logistics-api`  
**DB:** AWS RDS `kiss-production` (read-only user `bim_read_only`)

---

## สรุปงานที่ทำในช่วงนี้

### 1. Bug Fix — Date Filter ไม่ทำงาน

**อาการ:** พิมพ์ "2025" ในช่องค้นหาปี → แสดงข้อมูลปี 2026 ทั้งหมด 181 รายการ ไม่มีการกรอง

**Root cause:**  
Date filter เดิมถูกซ่อนอยู่ใน dropdown "Order Date" ผู้ใช้ต้องเลือก dropdown ก่อน แล้วค้นหา ถ้าข้ามขั้นตอนนี้ `sfType` ยังคือ `'all'` → `matchSearch()` ไม่เช็ค date เลย

**Fix (`logistics_webapp_prototype.html`):**
- แยก date picker ออกมาให้ **มองเห็นตลอดเวลา** (ไม่ขึ้นกับ dropdown)
- `matchSearch()` — เช็ค `sfDate` ก่อนเสมอ โดยไม่สนว่า `sfType` เป็นอะไร
- `onSfInput()` — อ่าน `sfDateInp` และ `sfText` พร้อมกันทุกครั้ง

```javascript
function matchSearch(s) {
  // Date filter — always active when sfDate is set
  if (sfDate) {
    const d = (s.created || '').substring(0, 10);
    if (!d || !d.startsWith(sfDate)) return false;
  }
  // Text filter ...
}
```

---

### 2. Bug Fix — Import Board แสดง Domestic Vendor

**อาการ:** "บริษัท เจ.เค.บรรจุภัณฑ์ กรุ๊ป จำกัด" ยังปรากฏใน Import Board ทั้งที่เป็น vendor ในประเทศ

**Root cause:**  
`PK_KW` array มีคำว่า `'บรรจุ'` → ชื่อบริษัทไทยที่มีคำนี้ถูก classify เป็น `pk` (import)

**Fix:**
- ลบ `'บรรจุ'` ออกจาก `PK_KW`
- เพิ่ม re-classify logic ใน `setShipments()` เพื่อแก้ records เก่าที่บันทึกผิด
- `syncOdoo()` — เพิ่ม **post-sync purge**: ลบ PO_* records ที่ไม่อยู่ใน SQL result ออกจาก storage

---

### 3. Feature — Export Board กรอง Domestic SOs ออก

**อาการ:** Export Board แสดง SO ที่ขายในประเทศ เช่น Employee, KOL: Facebook, Brand Giveaway, FG and PK for Test

**Fix (2 ชั้น):**

**ชั้นที่ 1 — SQL Level (`api-server.js`):**
```sql
-- SQL_EXPORT เพิ่ม filter overseas เท่านั้น
AND (
  rco.code IS NOT NULL AND rco.code != 'TH'
  OR (rco.code IS NULL AND cu.name NOT IN ('THB'))
)
```

**ชั้นที่ 2 — Storage Level (`setShipments()` + purge):**
```javascript
// getExp() กรอง domestic ออก
return shipments.filter(s => s.type === 'export'
  && s.source_type !== 'domestic'
  ...
);

// syncOdoo() — purge SO records ที่ SQL ใหม่ไม่ return มา
const freshSoIds = new Set(er.rows.map(r => `SO_${r.id}`));
shipments = shipments.filter(s =>
  s.type !== 'export' || !s.odoo_id || freshSoIds.has(s.odoo_id)
);
```

---

### 4. Critical Bug — Server ไม่ start หลัง Reboot

#### 4.1 อาการ
Browser เปิด `localhost:3000` → "ERR_CONNECTION_REFUSED" ทุกครั้งที่เปิดเครื่องใหม่

#### 4.2 การสืบสวน (chronological)

| ขั้น | สิ่งที่พบ |
|------|-----------|
| ตรวจ pm2 list | Empty — daemon respawned ใหม่ ไม่มี process |
| ตรวจ log file | **ไม่มีไฟล์ log เลย** → script ไม่ได้รันเลยสักบรรทัด |
| รัน script โดยตรง | Exit code 1, ไม่มี output |
| รัน แบบไม่ hidden | พบ error ชัดเจน |

#### 4.3 Root Cause — Thai Characters ใน PowerShell Script

```
At start-api.ps1:28 char:33
Missing closing '}' in statement block
The string is missing the terminator: "
```

**กลไกความเสีย:**

```
ตัวอักษร ไ (U+0E44)
  → UTF-8 bytes: E0 B9 84
  → PowerShell 5.1 อ่านเป็น Windows-1252
  → byte 0x84 = „ (LOW DOUBLE QUOTATION MARK)
  → parser มองว่า string ปิดตรงกลางประโยค
  → parse error ทั้ง script — ไม่มีบรรทัดไหนทำงานเลย
```

บรรทัดที่ทำให้พัง:
```powershell
# บรรทัดที่ 28 — Thai ใน string literal
if (-not (Test-Path $script)) {
  Write-Log "ERROR: api-server.js not found (OneDrive ยังไม่ sync?)"
}                                                    # ^^^^ ไ = 0x84 = „ ทำให้ string "ปิด" ผิดที่
```

#### 4.4 Fix

**Step 1 — สร้าง startup script ใหม่ที่ local path (ASCII-only):**

```
C:\Users\User\AppData\Local\logistics-api\start.ps1
```

- ไม่มีภาษาไทยเลย (ทุก comment และ string เป็น English)
- Path แบบ hardcoded ทั้งหมด ไม่ใช้ `$env:APPDATA` (ป้องกัน env var ไม่ expand ใน startup context)
- Log file อยู่ที่: `C:\Users\User\AppData\Local\logistics-api\startup.log`

**Step 2 — อัพเดท trigger ทั้งหมดให้ชี้ไป local script:**

| Trigger | เดิม | ใหม่ |
|---------|------|------|
| Registry `HKCU\Run\LogisticsAPI` | OneDrive `start-api.ps1` | Local `start.ps1` |
| Startup folder `.bat` | OneDrive `start-api.ps1` | Local `start.ps1` |
| Task Scheduler (ใหม่) | — | Local `start.ps1` (At Logon, 30s delay) |

**Step 3 — แก้ `start-api.ps1` บน OneDrive:**  
ลบ Thai text ออก เปลี่ยนให้ delegate ไปยัง local script แทน

---

### 5. Architecture Decision — Option B Migration

#### 5.1 ปัญหาเชิงโครงสร้าง

OneDrive path: `C:\Users\User\OneDrive - Kiss of Beauty Co.,Ltd\My Claude\`

| Tool | ปัญหา |
|------|-------|
| `cmd.exe` | Comma ใน `Co.,Ltd` ทำให้ path แตกเป็นหลาย argument |
| PowerShell 5.1 `-File` | Thai chars → Windows-1252 misparse |
| pm2 resurrect | Path ถูก split → dump.pm2 บันทึก path ผิด |

#### 5.2 ทางเลือกที่พิจารณา

| Option | คำอธิบาย | ข้อดี | ข้อเสีย |
|--------|-----------|-------|---------|
| A | ไม่ย้าย (คง OneDrive) | Backup อัตโนมัติ | Latent path risks ยังอยู่ |
| **B** ✅ | ย้าย runtime files ออก | Simple path, stable startup | ต้อง backup api-server.js เอง |
| C | ย้ายทั้งหมด | ง่ายที่สุด | ไม่มี backup |

#### 5.3 ผลลัพธ์ Option B

**โครงสร้างใหม่:**

```
C:\Users\User\logistics-api\          ← server runtime (simple path)
├── api-server.js                     ← pm2 exec_path
├── tracking_data.json                ← server อ่าน/เขียนที่นี่
├── package.json
└── node_modules\pg\

C:\Users\User\AppData\Local\logistics-api\
└── start.ps1                         ← startup script (ASCII-only)

OneDrive\My Claude\                   ← source + backup
└── logistics_webapp_prototype.html   ← server serve จาก path นี้ (STATIC_ROOT)
```

**การเปลี่ยนแปลงใน `api-server.js`:**

```javascript
// เพิ่ม STATIC_ROOT แยกจาก ROOT
const ROOT = __dirname;  // C:\Users\User\logistics-api (tracking_data.json)
const STATIC_ROOT = 'C:\\Users\\User\\OneDrive - Kiss of Beauty Co.,Ltd\\My Claude';

// static file serving ใช้ STATIC_ROOT แทน ROOT
let filePath = reqUrl === '/' ? '/logistics_webapp_prototype.html' : reqUrl;
filePath = path.join(STATIC_ROOT, filePath);  // ← เปลี่ยนจาก ROOT
```

**pm2 dump path ใหม่:**
```
pm_exec_path: C:\Users\User\logistics-api\api-server.js
```

---

### 6. Permanent Fix — Replace pm2 with watchdog.js (2026-05-22)

#### 6.1 ปัญหา
pm2 daemon ตายทุกครั้งที่ Claude Code เปิด session ใหม่และรันคำสั่ง pm2 ใดก็ตาม → daemon respawn → empty process list → server หายไป

#### 6.2 Root Cause
pm2 architecture มี daemon process แยก: เมื่อ daemon เก่าถูก kill แล้ว spawn ใหม่ โดย daemon ใหม่ไม่รู้จัก process เดิม (logistics-api) → server หายจาก pm2 list → ต้อง resurrect หรือ start ใหม่ทุกครั้ง

#### 6.3 Fix — watchdog.js

**แนวคิด:** แทนที่ pm2 ทั้งหมดด้วย `watchdog.js` — Node.js script 62 บรรทัดที่:
- spawn `api-server.js` เป็น child process
- restart อัตโนมัติหลัง crash (5s delay)
- log ลง `watchdog.log`
- ไม่มี daemon แยก, ไม่มี IPC socket

```
Task Scheduler → node.exe watchdog.js → api-server.js (child)
                  (watchdog loops forever)
```

**ผลการทดสอบ:**
- pm2 list → pm2 spawn daemon ใหม่ → server ยังทำงาน ✅
- Kill api-server.js ตรงๆ → watchdog restart ภายใน 5s ✅
- Server ping หลัง crash: `{"ok":true,"db":"kiss-production"}` ✅

**Files:**
- `C:\Users\User\logistics-api\watchdog.js` (new)
- `C:\Users\User\AppData\Local\logistics-api\start.ps1` (updated — ใช้ watchdog แทน pm2)
- Task Scheduler `LogisticsAPIStartup` (updated — execute: `node.exe`, args: `watchdog.js` โดยตรง)

---

### 7. Session Continuity Fix (2026-05-22 — session 2)

หลังจาก context หมด session ใหม่พบว่า `C:\Users\User\logistics-api\` ถูกลบไป (สาเหตุไม่ชัดเจน) และ `logistics_webapp_prototype.html` หายไปด้วย

**Root cause:** ไฟล์ HTML ถูก write ไปที่ `logistics-api\` path ที่ไม่ถาวร + directory ถูก clean ขึ้น

**Fix:**
1. Reconstruct `logistics_webapp_prototype.html` จาก JSONL transcript (base write + 14 edits) → เขียนด้วย UTF-8 no-BOM ถูกต้อง
2. สร้าง `C:\Users\User\logistics-api\` ใหม่ + สร้าง `watchdog.js` ที่ hardcode path ไป OneDrive `api-server.js`
3. Run server จาก OneDrive path (`__dirname` = OneDrive → `tracking_data.json` + HTML served จากที่นั่น)
4. ยืนยัน Task Scheduler ชี้มาที่ `C:\Users\User\logistics-api\watchdog.js` ถูกต้องแล้ว

**Watchdog architecture (final):**
```
Task Scheduler → node.exe C:\Users\User\logistics-api\watchdog.js
                   └─→ spawns node.exe "...\OneDrive\My Claude\api-server.js"
                         cwd = OneDrive\My Claude  (tracking_data.json + HTML ที่นี่)
```

**Export Board toolbar fix:**
selects (`expCompanyFilter`, `expStateFilter`) อยู่นอก `toolbar-right` → เป็น grid items แยก → toolbar เป็น 2 แถว
Fixed: ย้าย selects เข้าไปใน `toolbar-right` + เพิ่ม empty `toolbar-left` div

**Encoding fix:**
HTML file เขียนด้วย UTF-8 with BOM แต่ content เป็น mojibake — fixed โดย extract จาก JSONL transcript ด้วย PowerShell `ConvertFrom-Json` แล้ว `WriteAllText(..., UTF8NoBOM)` ตรงๆ

---

## สถานะปัจจุบัน

| รายการ | สถานะ | Path / หมายเหตุ |
|--------|--------|----------------|
| Server | ✅ Online | `http://localhost:3000` |
| watchdog.js | ✅ Running | `C:\Users\User\logistics-api\watchdog.js` → spawns OneDrive api-server.js |
| api-server.js | ✅ | `OneDrive\My Claude\api-server.js` (cwd = OneDrive path) |
| Web UI HTML | ✅ | `OneDrive\My Claude\logistics_webapp_prototype.html` (served by api-server) |
| tracking_data.json | ✅ | `OneDrive\My Claude\tracking_data.json` (read/write by api-server) |
| pg module | ✅ | `OneDrive\My Claude\node_modules\pg` |
| pm2 | ⚠️ Running (daemon idle) | dump.pm2 ชี้ path เก่า — ไม่ได้ใช้งาน ไม่กระทบ |
| Startup — Task Scheduler | ✅ Ready | At Logon + 30s → `node.exe C:\...\logistics-api\watchdog.js` |
| Startup — start.ps1 (backup) | ✅ | `AppData\Local\logistics-api\start.ps1` → ping → watchdog ถ้า server ไม่ up |
| Watchdog log | ✅ | `C:\Users\User\logistics-api\watchdog.log` |
| Startup log | ✅ | `AppData\Local\logistics-api\startup.log` |
| Import Board toolbar | ✅ Fixed | Single row — pills left, controls right (CSS grid) |
| Export Board toolbar | ✅ Fixed | Single row — all controls in toolbar-right |
| Import Board date filter | ✅ Fixed | Always-visible, independent |
| Import Board domestic vendor | ✅ Fixed | keyword + purge |
| Export Board domestic SOs | ✅ Fixed | SQL filter + storage purge |
| Crash-restart test | ✅ Verified | Kill api-server → watchdog restarts in 5s |

---

## ขั้นตอนถัดไป

- [ ] **Reboot test** — restart เครื่อง → เปิด browser ไปที่ `localhost:3000` ทันที (ไม่ต้องทำอะไร)
- [ ] **Verify Sync Odoo** หลัง reboot — กด Sync Odoo ใน browser ตรวจว่า domestic records ถูกลบออก
- [ ] **Odoo Module** — copy `Tools\logistics_tracking\` ไปวางบน Odoo server + install ผ่าน Apps menu

---

## Quick Reference — คำสั่งที่ใช้บ่อย

```powershell
# เช็ค server status
Invoke-RestMethod 'http://localhost:3000/api/ping'

# เช็ค watchdog ยังทำงานอยู่
Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*watchdog*' } | Select-Object ProcessId, CommandLine

# ดู watchdog log
Get-Content "C:\Users\User\logistics-api\watchdog.log" -Tail 20

# ดู startup log (บันทึกตอน boot)
Get-Content "C:\Users\User\AppData\Local\logistics-api\startup.log" -Tail 20

# Start watchdog manually (ถ้า server หยุดและ watchdog ไม่ทำงาน)
$node = "C:\Program Files\nodejs\node.exe"
Start-Process -FilePath $node -ArgumentList "C:\Users\User\logistics-api\watchdog.js" -WorkingDirectory "C:\Users\User\logistics-api" -WindowStyle Hidden
```

---

## Key Files

| ไฟล์ | Path |
|------|------|
| Watchdog (process manager) | `C:\Users\User\logistics-api\watchdog.js` |
| Watchdog log | `C:\Users\User\logistics-api\watchdog.log` |
| Server | `OneDrive\My Claude\api-server.js` |
| Tracking data | `OneDrive\My Claude\tracking_data.json` |
| Web UI | `OneDrive\My Claude\logistics_webapp_prototype.html` |
| pg module | `OneDrive\My Claude\node_modules\pg` |
| Startup script (backup) | `AppData\Local\logistics-api\start.ps1` |
| Startup log | `AppData\Local\logistics-api\startup.log` |

---

### 8. KOB Brand Theme — Kiss of Beauty Visual Identity (2026-05-22)

**Request:** เปลี่ยน template dashboard ให้เข้ากับลุคของบริษัท Kiss of Beauty Co.,Ltd.

**Brand reference:** kissmybody.co / malissakiss.com — Pure black logo, white surfaces, hot pink accent

**Changes applied to `logistics_webapp_prototype.html`:**

#### CSS Tokens
| Token | Before | After |
|---|---|---|
| `--kob` | `#e91e8c` | `#c91253` (KOB deep rose) |
| `--bg` | `#f0f4f8` (cool blue-gray) | `#f7f3f5` (warm blush off-white) |
| `--border` | `#e2e8f0` | `#e8dde4` (warm-tinted) |
| `--primary` | `#2563eb` (blue) | `#c91253` (KOB rose-pink) |
| `--primary-lt` | `#eff6ff` (light blue) | `#fce7f3` (light rose) |

#### Navbar
- Background: `#0f172a` (dark navy) -> `#0a0a0a` (true black)
- Brand icon gradient: blue-purple -> KOB pink `#c91253->#e91e8c`

#### KPI Cards
- c1 Import: `#2563eb->#7c3aed` -> `#c91253->#e91e8c` (KOB rose)
- c2 Export: -> `#7c3aed->#a78bfa` (violet)
- c3 Active: -> `#f59e0b->#ea580c` (amber)
- c4 Pending: -> `#059669->#10b981` (emerald)

#### Company split
- KOB bar: `#2563eb` (blue) -> `#c91253` (KOB pink)
- BTV bar: `#e91e8c` (pink) -> `#7c3aed` (violet)

#### Preserved (semantic)
- `--oversea: #2563eb` — overseas shipment type color
- Kanban status colors (IMP_STATES, EXP_STATES)

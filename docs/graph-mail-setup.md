# ตั้งค่าอีเมลแจ้งเตือนผ่าน Microsoft Graph API

เอกสารนี้ส่งให้แอดมิน Microsoft 365 / Azure ได้เลย — ทำครั้งเดียวจบ ใช้เวลาประมาณ 10 นาที

## ทำไมต้องใช้วิธีนี้

องค์กรเปิด **Security Defaults** ของ Microsoft 365 อยู่ ซึ่งบล็อกการล็อกอิน SMTP ด้วยรหัสผ่าน
(legacy authentication) ทั้ง tenant ทดสอบแล้วได้:

```
535 5.7.139 Authentication unsuccessful,
user is locked by your organization's security defaults policy.
```

ต่อให้ใช้ App password ก็ไม่ผ่าน เพราะช่องทางถูกปิดทั้งหมด — **Graph API เป็นวิธีที่ Microsoft
รองรับสำหรับกรณีนี้** และปลอดภัยกว่าเพราะ:

- ไม่ต้องใช้รหัสผ่านของผู้ใช้เลย
- จำกัดสิทธิ์ได้เฉพาะ "ส่งอีเมล" อย่างเดียว (อ่านเมลไม่ได้)
- **จำกัดได้ถึงระดับว่าส่งจาก mailbox ไหนได้บ้าง** (ดูขั้นตอนที่ 5 — สำคัญ)
- เพิกถอนได้ทันทีโดยไม่กระทบผู้ใช้คนไหน

---

## ขั้นตอนสำหรับแอดมิน

### 1. สร้าง App registration

Azure Portal → **Microsoft Entra ID** → **App registrations** → **New registration**

| ช่อง | ค่า |
|---|---|
| Name | `import-export-os-alerts` |
| Supported account types | **Single tenant** (Accounts in this organizational directory only) |
| Redirect URI | ปล่อยว่าง (ไม่ใช้) |

กด Register แล้วจดค่า 2 ตัวจากหน้า Overview:
- **Application (client) ID**
- **Directory (tenant) ID**

### 2. สร้าง Client secret

ในแอปที่เพิ่งสร้าง → **Certificates & secrets** → **Client secrets** → **New client secret**

- Description: `import-export-os`
- Expires: ตามนโยบายองค์กร (แนะนำ 12–24 เดือน — **ต้องจดวันหมดอายุไว้ ไม่งั้นแจ้งเตือนจะเงียบไปเฉยๆ ตอนหมดอายุ**)

> ⚠️ คัดลอกค่าในคอลัมน์ **Value** (ไม่ใช่ **Secret ID**) และคัดลอกทันที — ปิดหน้าแล้วดูไม่ได้อีก

### 3. ให้สิทธิ์ Mail.Send

**API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions**
(ไม่ใช่ Delegated) → ค้น `Mail.Send` → เลือก → **Add permissions**

### 4. กด Grant admin consent

ในหน้า API permissions กด **Grant admin consent for <ชื่อองค์กร>**
ต้องขึ้นเครื่องหมายถูกสีเขียวในคอลัมน์ Status จึงจะใช้งานได้

### 5. ⚠️ จำกัด mailbox ที่ส่งได้ (ควรทำอย่างยิ่ง)

**ค่าเริ่มต้นของ `Mail.Send` (Application) คือส่งแทน mailbox ไหนก็ได้ในองค์กร** ควรจำกัดให้เหลือ
mailbox เดียว รันคำสั่งนี้ใน Exchange Online PowerShell:

```powershell
# 1) สร้างกลุ่มที่มีเฉพาะ mailbox ที่อนุญาตให้ส่ง
New-DistributionGroup -Name "GraphMailSenders" -Type Security -Members "wittaya.s@kissofbeauty.co.th"

# 2) จำกัดแอปให้ส่งได้เฉพาะสมาชิกในกลุ่มนั้น (ใส่ Application (client) ID จากขั้นตอนที่ 1)
New-ApplicationAccessPolicy -AppId "<APPLICATION_CLIENT_ID>" `
  -PolicyScopeGroupId "GraphMailSenders@kissofbeauty.co.th" `
  -AccessRight RestrictAccess `
  -Description "import-export-os alerts only"

# 3) ตรวจว่าใช้ได้จริง (ควรได้ AccessCheckResult = Granted)
Test-ApplicationAccessPolicy -Identity "wittaya.s@kissofbeauty.co.th" -AppId "<APPLICATION_CLIENT_ID>"
```

> policy ใช้เวลามีผลประมาณ 30 นาทีหลังสร้าง

### 6. ส่งค่ากลับมา 3 ตัว

```
Directory (tenant) ID    = ...
Application (client) ID  = ...
Client secret Value      = ...
```

**ส่งผ่านช่องทางที่ปลอดภัย** (password manager / ช่องทางภายในองค์กร) — ไม่ใช่แชทหรืออีเมลธรรมดา

---

## ขั้นตอนฝั่งเรา (หลังได้ค่ามาแล้ว)

เปิด `.env` แล้วเพิ่ม 4 บรรทัด (ลบ `MAIL_USER`/`MAIL_PASS` เดิมทิ้งได้เลย):

```
GRAPH_TENANT_ID=<Directory (tenant) ID>
GRAPH_CLIENT_ID=<Application (client) ID>
GRAPH_CLIENT_SECRET=<Client secret Value>
MAIL_FROM=wittaya.s@kissofbeauty.co.th
ALERT_EMAIL_TO=wittaya.s@kissofbeauty.co.th
```

ทดสอบ:

```bash
node test-mail.cjs          # ตรวจการตั้งค่า + ขอ token (ยังไม่ส่งอีเมล)
node test-mail.cjs --send   # ส่งอีเมลทดสอบจริง
```

แล้วรีสตาร์ท server หนึ่งครั้ง

## ถ้าเจอ error

| ข้อความ | สาเหตุ |
|---|---|
| `AADSTS7000215` | client secret ผิด — มักเกิดจากคัดลอก **Secret ID** มาแทน **Value** |
| `AADSTS700016` | client ID ผิด หรือแอปไม่ได้อยู่ใน tenant นี้ |
| `AADSTS900023` | tenant ID ผิด |
| `HTTP 403 / Access denied` | ยังไม่ได้กด **Grant admin consent** หรือ ApplicationAccessPolicy ไม่ครอบ mailbox นี้ |
| `HTTP 404` | `MAIL_FROM` ไม่ใช่ mailbox ที่มีอยู่จริงใน tenant |

## สิ่งที่ต้องตามต่อในอนาคต

**client secret มีวันหมดอายุ** — พอหมดอายุระบบแจ้งเตือนจะเงียบไปเฉยๆ ตั้งเตือนในปฏิทินไว้ล่วงหน้า
1 เดือน แล้วสร้าง secret ใหม่มาแทนใน `.env` (ขั้นตอนที่ 2 ซ้ำอีกครั้ง)

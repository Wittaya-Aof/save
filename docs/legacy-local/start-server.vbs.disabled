' ─── Logistics API auto-start + watchdog ───
' เปิด api-server.js แบบซ่อนหน้าต่าง และคอยรีสตาร์ทให้เองถ้าโปรเซสหลุด/ล่ม
' ผูกกับ Startup shortcut → ทำงานทันทีทุกครั้งที่ login และอยู่ค้างคอยเฝ้า
Option Explicit
Dim sh, fso, Q, nodeExe, script, logPath, logf, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Const LOG_MAX = 5242880   ' 5 MB
Q = Chr(34)
nodeExe = Q & "C:\Program Files\nodejs\node.exe" & Q
script  = Q & "C:\Users\User\Projects\import-export-os\api-server.js" & Q
logPath = "C:\Users\User\Projects\import-export-os\server.log"
logf    = Q & logPath & Q
' ต้องครอบ quote รอบทั้งคำสั่ง (Q ... Q) เพราะ path node มีช่องว่าง
' ไม่งั้น cmd /c จะตัด quote ผิดแล้วมองว่า C:\Program ไม่มีอยู่
cmd = "cmd /c " & Q & nodeExe & " " & script & " >> " & logf & " 2>&1" & Q

' ⚠️ หมายเหตุ: อย่ารัน supervisor ตัวนี้พร้อมกับ pm2 (ecosystem.config.js) — ทั้งคู่ autorestart process
' เดียวกันบน port 3000 จะชนกัน (EADDRINUSE → crash loop) เลือกใช้ตัวเดียวเท่านั้น
' ─── หมุน server.log ──────────────────────────────────────────────────────────────────────
' ต้องทำ ที่นี่ เท่านั้น — เป็นจุดเดียวที่ไฟล์ว่างจากการถูกจับ
' cmd /c ... >> server.log เปิดไฟล์ค้างไว้ตลอดอายุ process โดยไม่เปิด FILE_SHARE_WRITE
' (วัดจริง 2026-09-23: สั่ง truncate จากสคริปต์อื่นระหว่าง server รันอยู่ ได้ EBUSY ทุกครั้ง
'  ส่วน copy ผ่านเพราะอ่านได้ — จึงหมุนจาก watchdog ไม่ได้ ได้แค่เตือน)
' หลัง sh.Run ... wait=True คืนค่า = cmd จบแล้ว handle ถูกปล่อย จึง rename ได้
' เก็บย้อนหลัง 1 รุ่น (.1) เหมือน watchdog.log กับ doc_scan.log
Sub RotateLog(p)
  On Error Resume Next
  If fso.FileExists(p) Then
    If fso.GetFile(p).Size > LOG_MAX Then
      If fso.FileExists(p & ".1") Then fso.DeleteFile p & ".1", True
      fso.MoveFile p, p & ".1"
    End If
  End If
  On Error GoTo 0
End Sub

Dim startTime, elapsed, delayMs, failCount
failCount = 0
Do
  RotateLog logPath
  startTime = Timer
  ' wait=True: บล็อกจนกว่า node จะจบ แล้วจึงวนรีสตาร์ท
  sh.Run cmd, 0, True
  elapsed = Timer - startTime
  If elapsed < 30 Then
    ' ตายเร็ว (<30 วิ) = น่าจะ start ไม่ขึ้น (.env ผิด/port ชน) — เพิ่ม backoff แบบทวีคูณ กันสปินถี่
    failCount = failCount + 1
    delayMs = 5000 * failCount
    If delayMs > 300000 Then delayMs = 300000  ' cap ที่ 5 นาที
  Else
    ' รันได้นานพอควรแล้วค่อยตาย = crash ปกติ รีสตาร์ทไว รีเซ็ตตัวนับ
    failCount = 0
    delayMs = 5000
  End If
  WScript.Sleep delayMs
Loop

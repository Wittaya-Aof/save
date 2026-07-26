' ─── Logistics API auto-start + watchdog ───
' เปิด api-server.js แบบซ่อนหน้าต่าง และคอยรีสตาร์ทให้เองถ้าโปรเซสหลุด/ล่ม
' ผูกกับ Startup shortcut → ทำงานทันทีทุกครั้งที่ login และอยู่ค้างคอยเฝ้า
Option Explicit
Dim sh, Q, nodeExe, script, logf, cmd
Set sh = CreateObject("WScript.Shell")
Q = Chr(34)
nodeExe = Q & "C:\Program Files\nodejs\node.exe" & Q
script  = Q & "C:\Users\User\Projects\import-export-os\api-server.js" & Q
logf    = Q & "C:\Users\User\Projects\import-export-os\server.log" & Q
' ต้องครอบ quote รอบทั้งคำสั่ง (Q ... Q) เพราะ path node มีช่องว่าง
' ไม่งั้น cmd /c จะตัด quote ผิดแล้วมองว่า C:\Program ไม่มีอยู่
cmd = "cmd /c " & Q & nodeExe & " " & script & " >> " & logf & " 2>&1" & Q

' ⚠️ หมายเหตุ: อย่ารัน supervisor ตัวนี้พร้อมกับ pm2 (ecosystem.config.js) — ทั้งคู่ autorestart process
' เดียวกันบน port 3000 จะชนกัน (EADDRINUSE → crash loop) เลือกใช้ตัวเดียวเท่านั้น
Dim startTime, elapsed, delayMs, failCount
failCount = 0
Do
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

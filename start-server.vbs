' ─── Logistics API auto-start + watchdog ───
' เปิด api-server.js แบบซ่อนหน้าต่าง และคอยรีสตาร์ทให้เองถ้าโปรเซสหลุด/ล่ม
' ผูกกับ Startup shortcut → ทำงานทันทีทุกครั้งที่ login และอยู่ค้างคอยเฝ้า
Option Explicit
Dim sh, Q, nodeExe, script, logf, cmd
Set sh = CreateObject("WScript.Shell")
Q = Chr(34)
nodeExe = Q & "C:\Program Files\nodejs\node.exe" & Q
script  = Q & "C:\Users\User\Projects\logistics-api\api-server.js" & Q
logf    = Q & "C:\Users\User\Projects\logistics-api\server.log" & Q
' ต้องครอบ quote รอบทั้งคำสั่ง (Q ... Q) เพราะ path node มีช่องว่าง
' ไม่งั้น cmd /c จะตัด quote ผิดแล้วมองว่า C:\Program ไม่มีอยู่
cmd = "cmd /c " & Q & nodeExe & " " & script & " >> " & logf & " 2>&1" & Q

Do
  ' wait=True: บล็อกจนกว่า node จะจบ แล้วจึงวนรีสตาร์ท (กันสปินถี่ด้วยการรอ 5 วิ)
  sh.Run cmd, 0, True
  WScript.Sleep 5000
Loop

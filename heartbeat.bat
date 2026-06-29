@echo off
REM heartbeat.bat — Task Scheduler entry point
REM Log to debug file FIRST so we can prove the .bat itself ran (even if PowerShell fails)
echo %DATE% %TIME% bat_start pid=%RANDOM% >> "C:\Users\User\logistics-api\heartbeat-debug.log"

REM Use absolute path to powershell.exe (PATH may not include System32 in some task scheduler contexts)
"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "C:\Users\User\logistics-api\heartbeat.ps1" >> "C:\Users\User\logistics-api\heartbeat-debug.log" 2>&1

echo %DATE% %TIME% bat_end exit=%ERRORLEVEL% >> "C:\Users\User\logistics-api\heartbeat-debug.log"
exit /b %ERRORLEVEL%

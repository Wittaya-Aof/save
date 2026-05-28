@echo off
REM start.bat — Task Scheduler entry point at logon / unlock
echo %DATE% %TIME% start_bat invoked >> "C:\Users\User\logistics-api\heartbeat-debug.log"

REM Use absolute path to powershell.exe
"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "C:\Users\User\AppData\Local\logistics-api\start.ps1" >> "C:\Users\User\logistics-api\heartbeat-debug.log" 2>&1

echo %DATE% %TIME% start_bat done exit=%ERRORLEVEL% >> "C:\Users\User\logistics-api\heartbeat-debug.log"
exit /b %ERRORLEVEL%

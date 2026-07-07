Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c node ""C:\Users\User\logistics-api\api-server.js"" >> ""C:\Users\User\logistics-api\server.log"" 2>&1", 0, False

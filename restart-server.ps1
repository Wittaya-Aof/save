# restart-server.ps1 - restart api-server safely: kill ONLY the PID holding port 3000
# after verifying its command line is api-server.js. start-server.vbs then respawns it
# with the new code. Never kills node.exe broadly.
$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (-not $conn) { Write-Output "Nothing listening on port 3000 - vbs may already be respawning"; exit 0 }
$pid3000 = $conn.OwningProcess | Select-Object -First 1
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pid3000"
Write-Output "PID $pid3000 : $($proc.CommandLine)"
if ($proc.CommandLine -match 'api-server\.js') {
  Stop-Process -Id $pid3000 -Force
  Write-Output "killed PID $pid3000 - start-server.vbs will respawn with new code (wait ~7s)"
} else {
  Write-Output "PID $pid3000 is NOT api-server.js - not killing (check manually)"
}

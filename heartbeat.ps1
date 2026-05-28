# heartbeat.ps1 - Logistics API health check + auto-restart
# Runs every 5 minutes via Task Scheduler.
# Pings http://localhost:3000/ - if dead, starts watchdog.js

$ErrorActionPreference = 'Continue'

# Use absolute paths — Task Scheduler context can have different $env: variables
$logFile  = "C:\Users\User\logistics-api\heartbeat.log"
$node     = "C:\Program Files\nodejs\node.exe"
$watchdog = "C:\Users\User\logistics-api\watchdog.js"
$workdir  = "C:\Users\User\logistics-api"
$port     = 3000

function Write-Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    # Rotate at 512 KB
    if ((Get-Item $logFile -ErrorAction SilentlyContinue).Length -gt 512KB) {
        Move-Item $logFile "$logFile.old" -Force -ErrorAction SilentlyContinue
    }
}

# DEBUG: prove the script ran (Task Scheduler sometimes silently fails before this)
Write-Log "TICK  heartbeat script started (PID=$PID, user=$env:USERNAME)"

# Healthy if port 3000 has a listener AND a known watchdog process is alive.
# No HTTP probe - that caused false-positive restarts on 4xx responses.
$listening = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) -ne $null

$watchdogAlive = $null -ne (Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
                            Where-Object { $_.CommandLine -like "*watchdog.js*" })

if ($listening -and $watchdogAlive) {
    # Healthy - exit quietly (don't spam log on success)
    exit 0
}

if (-not $listening)     { Write-Log "DOWN  Port $port has no listener" }
if (-not $watchdogAlive) { Write-Log "DOWN  No watchdog.js process found" }

# Server is dead or unhealthy - relaunch watchdog
Write-Log "RESTART  Launching watchdog.js"
try {
    Start-Process -FilePath $node `
                  -ArgumentList $watchdog `
                  -WorkingDirectory $workdir `
                  -WindowStyle Hidden
    Start-Sleep -Seconds 5
    $up = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) -ne $null
    if ($up) {
        Write-Log "OK       Watchdog started, port $port listening"
    } else {
        Write-Log "FAIL     Watchdog launched but port $port still down after 5s"
    }
} catch {
    Write-Log "ERROR    Start-Process failed: $($_.Exception.Message)"
}

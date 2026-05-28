# start.ps1 -- Logistics API watchdog launcher (English-only; Thai chars break PS5.1 parser)
# Triggered by: Task Scheduler (primary) + Startup folder bat (backup)
# Strategy: launch watchdog.js as a detached hidden process; watchdog keeps api-server.js alive.
# No pm2 dependency -- just node.exe + watchdog.js.
$ErrorActionPreference = 'Continue'

$node     = "C:\Program Files\nodejs\node.exe"
$watchdog = "C:\Users\User\logistics-api\watchdog.js"
$workDir  = "C:\Users\User\logistics-api"
$logDir   = "C:\Users\User\AppData\Local\logistics-api"
$log      = "$logDir\startup.log"

# Ensure log directory exists
$null = New-Item -ItemType Directory -Path $logDir -Force -ErrorAction SilentlyContinue

function L {
    param([string]$msg)
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $log -Value "$ts  $msg" -Encoding UTF8
}

L "=== Startup begin ==="
L "node:     $node"
L "watchdog: $watchdog"

# Verify required files
if (-not (Test-Path $node))     { L "ERROR: node.exe not found"; exit 1 }
if (-not (Test-Path $watchdog)) { L "ERROR: watchdog.js not found"; exit 1 }
L "Files verified OK"

# Wait for network / system to settle (skip on manual runs via registry if you like)
L "Waiting 30s for system ready..."
Start-Sleep -Seconds 30

# Check if server is already up (watchdog may already be running from a previous trigger)
$alreadyUp = $false
try {
    $resp = Invoke-RestMethod -Uri 'http://localhost:3000/api/ping' -TimeoutSec 4 -ErrorAction Stop
    $alreadyUp = $true
    L "Server already responding (ts=$($resp.ts)) -- nothing to do"
} catch {
    L "Server not responding -- will start watchdog"
}

if (-not $alreadyUp) {
    # Launch watchdog as a detached hidden process so it survives this script exiting.
    # -WindowStyle Hidden keeps it off the taskbar.
    # Start-Process returns immediately; watchdog loops forever managing api-server.js.
    try {
        Start-Process -FilePath $node `
                      -ArgumentList $watchdog `
                      -WorkingDirectory $workDir `
                      -WindowStyle Hidden `
                      -ErrorAction Stop
        L "watchdog.js launched (hidden)"
    } catch {
        L "ERROR launching watchdog: $_"
        exit 1
    }

    # Give the server a moment to start, then confirm
    Start-Sleep -Seconds 8
    try {
        $resp2 = Invoke-RestMethod -Uri 'http://localhost:3000/api/ping' -TimeoutSec 5 -ErrorAction Stop
        L "Server ping OK after launch (ts=$($resp2.ts))"
    } catch {
        L "WARNING: Server did not respond after launch -- watchdog is still starting (check watchdog.log)"
    }
}

L "=== Startup done ==="

param([string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw 'Install the supported Node.js runtime before installing this service.' }
$runtime = Join-Path $ProjectRoot 'data\ops\service-runtime'
New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'tools'), (Join-Path $runtime 'lib') | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'tools\local-supervisor.cjs') -Destination (Join-Path $runtime 'tools\local-supervisor.cjs') -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'tools\local-child.cjs') -Destination (Join-Path $runtime 'tools\local-child.cjs') -Force
foreach ($name in @('config-env.cjs','availability.cjs','http-probe.cjs')) { Copy-Item -LiteralPath (Join-Path $ProjectRoot "lib\$name") -Destination (Join-Path $runtime "lib\$name") -Force }
$arguments = '"' + (Join-Path $runtime 'tools\local-supervisor.cjs') + '" --root "' + $ProjectRoot + '"'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskName = 'ImportExportControlCloud'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$wrapper = Join-Path $runtime 'start-service.vbs'
$command = ('"' + $node + '" ' + $arguments).Replace('"','""')
$vbs = 'Set shell = CreateObject("WScript.Shell")' + "`r`n" + 'Do' + "`r`n" + '  result = shell.Run("' + $command + '", 0, True)' + "`r`n" + '  If result = 0 Then Exit Do' + "`r`n" + '  WScript.Sleep 5000' + "`r`n" + 'Loop' + "`r`n"
[IO.File]::WriteAllText($wrapper, $vbs)
try {
    # Hidden=true in Task Scheduler hides its listing, not a console window.
    # WScript keeps the supervisor attached while starting its console hidden.
    $action = New-ScheduledTaskAction -Execute $wscript -Argument ('//B //NoLogo "' + $wrapper + '"') -WorkingDirectory $ProjectRoot
    $triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $identity), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)))
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Output 'Installed hidden current-user service with scheduled recovery.'
} catch {
    # A normal Windows account can always install its own logon entry without UAC.
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    New-Item -Path $runKey -Force | Out-Null
    New-ItemProperty -Path $runKey -Name $taskName -Value ('"' + $wscript + '" //B //NoLogo "' + $wrapper + '"') -PropertyType String -Force | Out-Null
    Start-Process -FilePath $wscript -ArgumentList ('//B //NoLogo "' + $wrapper + '"') -WindowStyle Hidden
    Write-Output 'Installed current-user logon service with hidden recovery launcher.'
}

# Run interactively on your own Windows computer. The password is copied to the
# clipboard without being displayed or written to a local file.
param([ValidateSet('admin','viewer')][string]$Role = 'admin')
$ErrorActionPreference = 'Stop'
$sshPath = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$remoteCommand = if ($Role -eq 'viewer') { 'sed -n "s/^VIEWER_PASSWORD=//p" /srv/import-export-control-cloud/.env.hostinger' } else { 'sed -n "s/^APP_PASSWORD=//p" /srv/import-export-control-cloud/.env.hostinger' }
$passwordValue = & $sshPath -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes root@76.13.208.248 $remoteCommand
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($passwordValue)) {
    throw 'Could not retrieve the deployment password through your authorized SSH connection.'
}
try {
    Set-Clipboard -Value $passwordValue
    Write-Host "$Role password copied to your clipboard. Paste it into the login prompt."
} finally {
    $passwordValue = $null
}

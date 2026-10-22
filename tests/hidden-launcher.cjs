'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('Windows service registers a hidden waiting launcher before starting the task',{skip:process.platform!=='win32'},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'control hidden launcher-')),script=path.join(temp,'verify.ps1'),marker=path.join(temp,'launched.json');
 fs.mkdirSync(path.join(temp,'tools'));fs.mkdirSync(path.join(temp,'lib'));
 for(const name of ['local-supervisor.cjs','local-child.cjs'])fs.copyFileSync(path.join(root,'tools',name),path.join(temp,'tools',name));
 fs.writeFileSync(path.join(temp,'tools/local-supervisor.cjs'),`require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)));`);
 for(const name of ['config-env.cjs','availability.cjs','http-probe.cjs'])fs.copyFileSync(path.join(root,'lib',name),path.join(temp,'lib',name));
 const literal=s=>"'"+s.replaceAll("'","''")+"'";
 fs.writeFileSync(script,`$ErrorActionPreference='Stop'
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) @{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory} }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User,[switch]$Once,$At,$RepetitionInterval) @{} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) @{} }
function New-ScheduledTaskSettingsSet { param($MultipleInstances,$ExecutionTimeLimit,$RestartCount,$RestartInterval,[switch]$StartWhenAvailable,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries) @{} }
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Principal,$Settings,[switch]$Force)
 if([IO.Path]::GetFileName($Action.Execute) -ne 'wscript.exe'){throw 'Task directly launches a console executable'}
 $wrapper=Join-Path ${literal(temp)} 'data/ops/service-runtime/start-service.vbs'
 if(!(Test-Path -LiteralPath $wrapper)){throw 'Hidden wrapper missing at registration'}
 $content=[IO.File]::ReadAllText($wrapper)
 if(!$content.Contains(', 0, True)')){throw 'Wrapper must hide console and wait for supervisor'}
 if(!$content.Contains('If result = 0 Then Exit Do') -or !$content.Contains('WScript.Sleep 5000')){throw 'Recovery loop missing'}
 if(!$Action.Arguments.Contains($wrapper)){throw 'Wrong wrapper path'}
 if($Settings -eq $null){throw 'Recovery settings missing'}
 $script:registered=$true
}
function Start-ScheduledTask { param($TaskName) if(!$script:registered){throw 'Unverified start'}; $script:started=$true }
function Start-Process { throw 'Unexpected fallback process' }
function New-ItemProperty { throw 'Registry mutation forbidden in fixture' }
. ${literal(path.join(root,'tools/install-local-service.ps1'))} -ProjectRoot ${literal(temp)}
if(!$script:registered -or !$script:started){throw 'Task did not pass hidden launcher gate'}
`);
 try{const r=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr||r.stdout);
 const launch=spawnSync(path.join(process.env.SystemRoot,'System32/wscript.exe'),['//B','//NoLogo',path.join(temp,'data/ops/service-runtime/start-service.vbs')],{windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(launch.status,0,launch.stderr||launch.error?.message);assert.deepEqual(JSON.parse(fs.readFileSync(marker)),['--root',temp]);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('installer scheduled task routes through Windows Script Host, not node console',()=>{
 const source=fs.readFileSync(path.join(root,'tools/install-local-service.ps1'),'utf8');
 assert.match(source,/New-ScheduledTaskAction -Execute \$wscript/);
 assert(source.indexOf('[IO.File]::WriteAllText($wrapper, $vbs)')<source.indexOf('Register-ScheduledTask'));
});

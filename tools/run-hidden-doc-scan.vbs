' Run the scheduled shipment-document scan without showing a console window.
' The scanner writes detailed progress to doc_scan.log itself.
Option Explicit

Dim fso, shell, toolsDir, projectRoot, nodeExe, scanScript, command, result
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

toolsDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(toolsDir)
nodeExe = shell.ExpandEnvironmentStrings("%IMPORT_EXPORT_NODE_EXE%")
If nodeExe = "%IMPORT_EXPORT_NODE_EXE%" Or nodeExe = "" Then
  nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
End If
scanScript = shell.ExpandEnvironmentStrings("%IMPORT_EXPORT_SCAN_SCRIPT%")
If scanScript = "%IMPORT_EXPORT_SCAN_SCRIPT%" Or scanScript = "" Then
  scanScript = fso.BuildPath(projectRoot, "scan-shipment-docs.mjs")
End If

If Not fso.FileExists(nodeExe) Then WScript.Quit 2
If Not fso.FileExists(scanScript) Then WScript.Quit 3

shell.CurrentDirectory = projectRoot
command = Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & scanScript & Chr(34)
' WindowStyle 0 hides Node's console; wait=True keeps Task Scheduler's running state accurate.
result = shell.Run(command, 0, True)
WScript.Quit result

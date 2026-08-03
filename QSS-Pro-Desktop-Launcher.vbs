Option Explicit

Dim shell, fso, http, appFolder, command, workerCommand, url, ready, i, edgePath, psExe

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appFolder = "C:\Users\RICPL\Documents\Codex\2026-06-23\use-github-linear-or-my-uploaded-3\outputs\quantity-survey-app"
url = "http://127.0.0.1:4175/"
shell.CurrentDirectory = appFolder

Function ServerReady()
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.open "GET", url & "api/server-status", False
  http.send
  ServerReady = (Err.Number = 0 And http.status = 200)
  Err.Clear
  On Error GoTo 0
End Function

If Not ServerReady() Then
  psExe = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
  workerCommand = """" & psExe & """ -NoProfile -ExecutionPolicy Bypass -File """ & appFolder & "\qss-cad-conversion-worker.ps1"""
  shell.Run workerCommand, 0, False

  command = "cmd /c cd /d """ & appFolder & """ && set QSS_PRO_WINDOWS_LAUNCHER=1&&set PORT=4175&&node server.js >> server-4175.out.log 2>> server-4175.err.log"
  shell.Run command, 0, False
End If

ready = False
For i = 1 To 45
  If ServerReady() Then
    ready = True
    Exit For
  End If
  WScript.Sleep 1000
Next

If ready Then
  edgePath = shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
  If Not fso.FileExists(edgePath) Then
    edgePath = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"
  End If

  If fso.FileExists(edgePath) Then
    shell.Run """" & edgePath & """ --new-window """ & url & """", 1, False
  Else
    shell.Run url, 1, False
  End If
Else
  MsgBox "QSS Pro could not start the local drawing reader on 127.0.0.1:4175. Check server-4175.err.log in the app folder.", vbCritical, "QSS Pro"
End If

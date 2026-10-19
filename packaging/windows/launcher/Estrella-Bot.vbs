' ============================================================================
'  Estrella Bot - installed launcher (shortcut target).
'
'  ASCII-only / LF-only. The shortcut points wscript.exe at this file, so no
'  console window is created. The real work is in tools\launcher.mjs; this
'  wrapper only waits for it and shows a readable message if it fails.
' ============================================================================
Option Explicit

Dim fso, ws, root, nodeExe, scriptFile, logFile, cmd, rc

Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
nodeExe = root & "\runtime\node\node.exe"
scriptFile = root & "\tools\launcher.mjs"
logFile = ws.ExpandEnvironmentStrings("%TEMP%") & "\Estrella-Bot-launch.log"

If Not fso.FileExists(nodeExe) Then
  MsgBox "Estrella Bot: runtime\node\node.exe is missing." & vbCrLf & _
         "Please reinstall the application.", 16, "Estrella Bot"
  WScript.Quit 2
End If

If Not fso.FileExists(scriptFile) Then
  MsgBox "Estrella Bot: tools\launcher.mjs is missing." & vbCrLf & _
         "Please reinstall the application.", 16, "Estrella Bot"
  WScript.Quit 2
End If

cmd = "cmd /c " & Chr(34) & Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & scriptFile & Chr(34) & _
      " --install-root " & Chr(34) & root & Chr(34) & _
      " >> " & Chr(34) & logFile & Chr(34) & " 2>&1" & Chr(34)

ws.CurrentDirectory = root
rc = ws.Run(cmd, 0, True)

If rc <> 0 Then
  MsgBox "Estrella Bot failed to start (exit " & rc & ")." & vbCrLf & _
         "See the log for details:" & vbCrLf & logFile, 16, "Estrella Bot"
End If

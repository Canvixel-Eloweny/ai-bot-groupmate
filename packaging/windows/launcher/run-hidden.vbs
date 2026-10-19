' ============================================================================
'  Generic hidden runner.
'
'  Usage: wscript //B //Nologo run-hidden.vbs "<command line>" [wait]
'
'  The caller passes a complete command line (including redirections). Window
'  style 0 creates a hidden console, which is the only reliable way to hide
'  console programs on Windows 11 when Windows Terminal is the default host.
'  ASCII-only / LF-only.
' ============================================================================
Option Explicit

Dim cmd, waitFlag, ws, rc

If WScript.Arguments.Count < 1 Then
  WScript.Quit 2
End If

cmd = WScript.Arguments(0)
waitFlag = False
If WScript.Arguments.Count >= 2 Then
  If LCase(WScript.Arguments(1)) = "wait" Then
    waitFlag = True
  End If
End If

Set ws = CreateObject("WScript.Shell")

If waitFlag Then
  rc = ws.Run(cmd, 0, True)
Else
  ws.Run cmd, 0, False
  rc = 0
End If

WScript.Quit rc

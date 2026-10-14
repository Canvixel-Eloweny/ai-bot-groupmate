' ============================================================================
'  Estrella Bot - start the QQ protocol side (NapCat) with NO window.
'
'  Why a VBScript and not Node's windowsHide:
'    NapCatWinBootMain.exe is a CONSOLE program. Node's `windowsHide: true`
'    maps to CREATE_NO_WINDOW, i.e. the child gets NO console at all - and a
'    console program with no console ALLOCATES ITS OWN, which is a visible
'    window. `WScript.Shell.Run` with window style 0 creates a HIDDEN console
'    instead, so the protocol side inherits one that is never shown.
'    Same mechanism as launch-hidden.vbs for the panel, proven in production.
'
'  What actually broke here (2026-10-13, cost hours - read this before editing):
'    NOT the console mechanism. The two Node call sites omitted the QQ argument
'    when there was no QQ number, and `WScript.Arguments` does NOT include the
'    script name - so every argument shifted by one: the log path landed in the
'    QQ slot, the log redirection silently vanished, and the launcher received
'    a bogus argv. NapCat quit with code 0 and zero output, which looks exactly
'    like "the protocol side crashed for no reason".
'    Fix: always pass three arguments, with "-" as the QQ placeholder.
'    If this ever misbehaves again, the exit code now tells you which check
'    failed (3 = arguments, 2 = launcher missing) instead of dying silently.
'  !!! 2026-10-13 (real machine) - THE ACTUAL ROOT CAUSE, read this first:
'    This file had never been executed even once, and it contained TWO VBA-style
'    mistakes. EITHER ONE IS FATAL, and under `wscript //B` a fatal script error
'    produces NO dialog, NO output and an EXIT CODE OF 0 - which looks exactly
'    like "the protocol side died for no reason":
'      1) `argErr = Err.Number` while `argErr` was not in the Dim list. Under
'         `Option Explicit` an undeclared identifier is a fatal error, and
'         `On Error Resume Next` does NOT catch it (it is not a runtime error).
'      2) `IIf(...)` used twice to build the command line. VBScript HAS NO IIf -
'         that is VBA / ASP. Use plain If/Then (see the command building below).
'    How to catch this class in two seconds, after EVERY edit of this file:
'        cscript //Nologo launch-napcat-hidden.vbs "<launcher>" - "<log>"
'    cscript prints the error WITH the line number and the text, e.g.
'        (39, 1) Microsoft VBScript runtime error: Variable is undefined: 'argErr'
'    Two rules for this file: (a) under Option Explicit every assigned
'    identifier must be Dim'ed; (b) no IIf, and no other VBA-only function.

' ============================================================================
Option Explicit

Dim fso, ws, launcher, qq, logFile, cmd, rc, argErr, qqArg, redir
Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")

' Loud failure instead of a silent one: this script runs with //B, so a VBScript
' error quits with no output at all - which is exactly how the argument
' misalignment bug hid for hours. Exit codes are the only channel we have, so
' they are distinctive: 3 = arguments missing, 2 = launcher not found.
On Error Resume Next
launcher = WScript.Arguments(0)
qq = WScript.Arguments(1)
logFile = WScript.Arguments(2)
argErr = Err.Number
On Error GoTo 0
If argErr <> 0 Or WScript.Arguments.Count < 3 Then WScript.Quit 3

' "-" means "no QQ number" (see the warning above - the slot must stay filled)
If qq = "-" Then qq = ""

If launcher = "" Then
  WScript.Quit 3
End If
If Not fso.FileExists(launcher) Then
  WScript.Quit 2
End If

ws.CurrentDirectory = fso.GetParentFolderName(launcher)

' Shape: cmd /d /c ""<launcher>" "<qq>" >> "<log>" 2>&1 < nul"
'   /d   = skip AutoRun commands, so the environment is deterministic
'   <nul = the official launcher-user.bat ends with "pause"; with stdin at
'          EOF that returns at once instead of waiting forever in a console
'          the user can never see or type into.
' NOTE: built with plain If/Then - no IIf (VBScript does not have it; see the
'       warning at the top of this file). This pair of IIf calls, together with
'       the undeclared argErr above, is why this chain never started.
qqArg = ""
If qq <> "" Then qqArg = " " & Chr(34) & qq & Chr(34)
redir = ""
If logFile <> "" Then redir = " >> " & Chr(34) & logFile & Chr(34) & " 2>&1"
cmd = "cmd /d /c " & Chr(34) & Chr(34) & launcher & Chr(34) & _
      qqArg & redir & " < nul" & Chr(34)

' 0 = hidden window - True = wait, so this process lives exactly as long as the
' protocol side does and can hand its exit code back to the caller.
rc = ws.Run(cmd, 0, True)
WScript.Quit rc

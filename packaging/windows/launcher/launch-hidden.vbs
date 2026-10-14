' ============================================================================
'  Estrella Bot - start the console with NO window.
'
'  Why this file exists (and why it is VBScript, not another .bat):
'    node.exe is a *console* program on Windows - launching it from a shortcut
'    always flashes a black console window, and that window is exactly what the
'    user complained about ("it never closes and the folder cannot be deleted").
'    A .lnk has no "hide window" flag, so the hiding has to be done by the host:
'    wscript.exe runs this script with no window at all, and WScript.Shell.Run
'    with window-style 0 starts the real command hidden too.
'
'    VBScript was chosen over PowerShell only because it starts instantly and
'    needs no execution-policy override - this runs on a double-click.
'
'  ASCII-only on purpose: VBScript files are read using the system ANSI code
'  page unless they carry a UTF-16 BOM, so any Chinese in here could turn into
'  mojibake on a non-Chinese Windows. All user-facing text lives in the scripts.
' ============================================================================
Option Explicit

Dim fso, ws, root, node, script, logFile, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
node = root & "\runtime\node\node.exe"
script = root & "\tools\start.mjs"
logFile = root & "\app\panel\start.log"

If Not fso.FileExists(node) Then
  ' Last resort: use whatever node is on PATH so the user still gets an error
  ' they can read (in the log) instead of a silent no-op.
  node = "node"
End If

' Output goes to a file: a hidden process has nowhere to print to, and without
' this the only symptom of a failure would be "nothing happened".
cmd = "cmd /c " & Chr(34) & Chr(34) & node & Chr(34) & " " & Chr(34) & script & Chr(34) & _
      " >> " & Chr(34) & logFile & Chr(34) & " 2>&1" & Chr(34)

ws.CurrentDirectory = root
ws.Run cmd, 0, False

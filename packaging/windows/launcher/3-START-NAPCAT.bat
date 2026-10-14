@echo off
rem ==========================================================================
rem  AI Groupmate - portable Windows package : START NAPCAT (protocol side only)
rem  CHANGED 2026-10-13: it used to run the protocol side in the FOREGROUND,
rem  which meant "close this window = kill the protocol side = lose the login".
rem  Now it starts in the background (no window at all) and exits at once, so
rem  closing anything can never log the account out.
rem  Where to look instead:
rem    QR code to scan -> console page, "open QR login" button
rem    live output     -> console page, "terminal" tab
rem  Everyday use: 2-START.bat (it starts this automatically, in background).
rem  ASCII-only / LF-only on purpose - see the note in 1-SETUP.bat.
rem
rem  CHANGED 2026-10-14: it used to pause ONLY on error (`if errorlevel 1 pause`).
rem  On success the window therefore vanished before the user could read one line,
rem  and "it flashed and disappeared" is indistinguishable from "I double-clicked
rem  and nothing happened" - the exact confusion this project keeps fighting.
rem  Same lesson as 4-DIAG.bat (a result you cannot read is not a result), so it
rem  now ALWAYS pauses and prints what you should have seen.
rem  Safe to change: nothing calls this file (2-START.bat goes through
rem  tools\start.mjs instead), so a lingering window cannot break any chain.
rem ==========================================================================
setlocal
"%~dp0runtime\node\node.exe" "%~dp0tools\start-napcat.mjs" %*
echo.
echo ------------------------------------------------------------
echo  Done. What you should have seen above:
echo    "already running"        = OK, the protocol side was up, nothing to do
echo    "3001 is answering"      = OK, it just started it
echo    an error or a stack      = send me a screenshot of this window
echo ------------------------------------------------------------
echo.
pause
endlocal

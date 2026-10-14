@echo off
rem ==========================================================================
rem  AI Groupmate - portable Windows package : COLLECT DIAGNOSTICS
rem  Gathers everything needed to debug "QR broken / black window / not logged
rem  in" into diag-out\diag-<time>.txt, and copies it to the shared folder
rem  when that folder exists, so it can be read from the other side.
rem  Read-only: it never starts, stops or reconfigures anything.
rem  ASCII-only / LF-only on purpose - see the note in 1-SETUP.bat.
rem
rem  CHANGED 2026-10-13: it used to close the moment it finished, so the user
rem  could not read the result (or notice that the shared-folder copy failed).
rem  A diagnostic that vanishes is not a diagnostic - it now always pauses.
rem ==========================================================================
setlocal
echo Collecting diagnostics, please wait a few seconds...
echo.
"%~dp0runtime\node\node.exe" "%~dp0tools\diag.mjs" %*
echo.
echo ------------------------------------------------------------
echo  Done. The report is at:
echo    %~dp0diag-out\diag-<time>.txt
echo  It was also copied to the shared folder if that folder exists.
echo  If it does not show up on the other side, drag that file over.
echo ------------------------------------------------------------
echo.
pause
endlocal

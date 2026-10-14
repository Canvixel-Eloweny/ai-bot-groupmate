@echo off
rem ==========================================================================
rem  AI Groupmate - portable Windows package : START (everyday entry point)
rem  Starts the QQ protocol side, then the console, then opens the browser.
rem  ASCII-only / LF-only on purpose - see the note in 1-SETUP.bat.
rem ==========================================================================
setlocal
"%~dp0runtime\node\node.exe" "%~dp0tools\start.mjs" %*
if errorlevel 1 pause
endlocal

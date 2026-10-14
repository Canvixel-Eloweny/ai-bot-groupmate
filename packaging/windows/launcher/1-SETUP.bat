@echo off
rem ==========================================================================
rem  AI Groupmate - portable Windows package : FIRST-TIME SETUP
rem  This file is intentionally ASCII-only, LF-only, and free of labels,
rem  parenthesised blocks and for-loops. The repo this came from forbids CRLF,
rem  and LF is only safe for .bat files that stay this simple.
rem  All Chinese guidance lives inside the scripts (Node writes UTF-8) and in
rem  README.html - not here.
rem ==========================================================================
setlocal
"%~dp0runtime\node\node.exe" "%~dp0tools\setup.mjs" %*
if errorlevel 1 pause
endlocal

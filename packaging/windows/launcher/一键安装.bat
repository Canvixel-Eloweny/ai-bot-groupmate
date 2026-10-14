@echo off
rem ==========================================================================
rem  Estrella Bot - ONE-KEY INSTALL (the only command you need to run)
rem
rem  It does four things in order:
rem    1. detect what is already on this PC (Node / NapCat / QQ)
rem    2. check the versions against what this package needs
rem    3. fix what is missing or outdated (Node + NapCat automatically;
rem       QQ can only be guided - we never install a chat app for you)
rem    4. start the console (no black window) and open it in your browser
rem
rem  Optional arguments:
rem    一键安装.bat --qq 123456      skip the "which QQ number" question
rem    一键安装.bat --yes            answer yes to everything
rem    一键安装.bat --only=check     only run step 1+2, change nothing
rem
rem  This file is intentionally ASCII-only, LF-only, and free of labels,
rem  parenthesised blocks and for-loops. All Chinese guidance is printed by
rem  tools\onekey.mjs (Node writes UTF-8), which is why you can read it here.
rem ==========================================================================
setlocal
"%~dp0runtime\node\node.exe" "%~dp0tools\onekey.mjs" %*
if errorlevel 1 pause
endlocal

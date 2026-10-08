@echo off
rem QQ-BOT-CONTROL - Windows one-click launcher.
rem The real logic lives in scripts\win-launcher.mjs; this file stays ASCII-only,
rem LF-only, and free of labels / parenthesised blocks on purpose: .bat files are
rem safest with CRLF, but this repo forbids CRLF in tracked text files, so the
rem .bat is kept simple enough that LF is safe too.
rem If "node" is not recognised, install Node.js 22 or newer from https://nodejs.org
node "%~dp0scripts\win-launcher.mjs"
if errorlevel 1 pause

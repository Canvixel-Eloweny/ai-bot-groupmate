@echo off
setlocal
rem Open the fake QQ chat (no real QQ / NapCat needed). ASCII only, LF.
rem Type a line to send a group message. Slash commands: /at /private /group /as /log /where /quit
cd /d "%~dp0app"
set NODE=..\runtime\node\node.exe
if not exist "%NODE%" set NODE=node
"%NODE%" scripts\fake-qq.mjs %*
pause

@echo off
setlocal
rem Estrella Bot feature self-checks (ASCII only, LF). See packaging/windows/README.md.
rem Runs the ten feature checks plus the main smoke suite. No network is required
rem for the feature checks; smoke uses local mocks only.
cd /d "%~dp0app"
set NODE=..\runtime\node\node.exe
if not exist "%NODE%" set NODE=node
set FAIL=0

for %%f in (check-persona-grade check-anti-template check-card-scope check-peak check-friends check-nightly check-fake-panel check-persona-adopt check-heat-patrol check-wait-images) do (
  echo.
  echo ---- %%f ----
  "%NODE%" "test\%%f.mjs"
  if errorlevel 1 set FAIL=1
)

echo.
echo ---- smoke ----
"%NODE%" test\smoke.js
if errorlevel 1 set FAIL=1

echo.
if "%FAIL%"=="1" (
  echo RESULT: FAILED - see the section above.
  pause
  exit /b 1
)
echo RESULT: all feature checks passed.
pause

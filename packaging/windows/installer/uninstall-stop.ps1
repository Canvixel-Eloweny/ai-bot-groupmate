# ASCII-only PowerShell fallback for the NSIS uninstaller.
# It does not depend on the installed Node runtime: if the program folder is
# damaged, this still stops the panel/bot and NapCat before files are removed.
param(
  [string]$InstallRoot = "",
  [string]$UserRoot = ""
)

$ErrorActionPreference = "SilentlyContinue"
if (-not $InstallRoot) { exit 0 }

$procs = Get-CimInstance Win32_Process
$prefix = $InstallRoot + "\versions\"

foreach ($p in $procs) {
  $cmd = [string]$p.CommandLine
  if (-not $cmd) { continue }
  if (-not $cmd.Contains($prefix)) { continue }
  $isPanel = $cmd.Contains("\app\panel\server.js")
  $isBot = $cmd.Contains("\app\src\index.js")
  if ($isPanel -or $isBot) {
    taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null
  }
}

if ($UserRoot) {
  # Close the dedicated Edge app window first: its console-profile lives under
  # USER_ROOT/panel/console-profile and would keep user data locked during delete.
  $profile = $UserRoot + "\panel\console-profile"
  foreach ($p in $procs) {
    $cmd = [string]$p.CommandLine
    if (-not $cmd) { continue }
    if ($cmd.Contains($profile)) {
      taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null
    }
  }

  $nap = $UserRoot + "\napcat"
  foreach ($p in $procs) {
    $cmd = [string]$p.CommandLine
    if (-not $cmd) { continue }
    if (-not $cmd.Contains($nap)) { continue }
    $first = ($cmd -split '"')[0]
    if ($first -match "node(js)?(\.exe)?\s*$") { continue }
    taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null
  }
  Start-Sleep -Seconds 1
}

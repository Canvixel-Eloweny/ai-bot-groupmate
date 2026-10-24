param(
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$UserRoot,
  [Parameter(Mandatory=$true)][int]$LauncherPid,
  [Parameter(Mandatory=$true)][string]$Stamp,
  [string]$TaskName = '',
  [string]$TempCmd = ''
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $UserRoot 'update\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$logFile = Join-Path $logDir ('rollback-restore-' + $Stamp + '.log')

function Say([string]$msg) {
  $line = ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $msg)
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  Write-Output $line
}

function WriteJson([string]$file, $obj) {
  # PowerShell 5.1 Set-Content -Encoding UTF8 writes a BOM. Write to a temp file
  # with UTF8Encoding($false), then replace, so a crash cannot leave half a pointer.
  $json = $obj | ConvertTo-Json -Depth 20
  $tmp = $file + '.tmp-' + $PID
  [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $file -Force
}

function Cleanup {
  if ($TaskName) {
    try { & schtasks /Delete /TN $TaskName /F | Out-Null } catch { }
  }
  if ($TempCmd -and (Test-Path $TempCmd)) {
    try { Remove-Item $TempCmd -Force -ErrorAction SilentlyContinue } catch { }
  }
}

$runtime = Join-Path $InstallRoot 'runtime'
$node = Join-Path $runtime 'node'
$prev = Join-Path $runtime 'node.previous'
$failed = Join-Path $runtime ('node.failed-' + $Stamp)
$marker = Join-Path $runtime '.swap.json'
$requestFile = Join-Path $UserRoot 'update\rollback-request.json'
$currentFile = Join-Path $InstallRoot 'current.json'
$rollbackFile = Join-Path $UserRoot 'update\rollback.json'

try {
  if ($LauncherPid -gt 0) {
    Say ('waiting for launcher pid ' + $LauncherPid)
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
      $p = Get-Process -Id $LauncherPid -ErrorAction SilentlyContinue
      if (-not $p) { break }
      Start-Sleep -Milliseconds 300
    }
  }
  Start-Sleep -Milliseconds 600

  if (-not (Test-Path $requestFile)) { throw 'rollback-request.json missing' }
  $request = Get-Content $requestFile -Raw | ConvertFrom-Json
  if (-not (Test-Path $prev)) { throw ('runtime/node.previous missing: ' + $prev) }
  if (-not (Test-Path $node)) { throw ('runtime/node missing: ' + $node) }
  if (Test-Path $failed) { throw ('runtime target already exists: ' + $failed) }

  $panels = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like ('*' + $InstallRoot + '*') }
  if ($panels) {
    $ids = ($panels | ForEach-Object { $_.ProcessId }) -join ','
    throw ('panel still running: ' + $ids)
  }

  Say ('swap: ' + $node + ' -> ' + $failed)
  Move-Item -Path $node -Destination $failed -ErrorAction Stop
  try {
    Say ('restore: ' + $prev + ' -> ' + $node)
    Move-Item -Path $prev -Destination $node -ErrorAction Stop
  } catch {
    Say ('restore failed: ' + $_.Exception.Message)
    try {
      Move-Item -Path $failed -Destination $node -ErrorAction Stop
      Say 'reverted new runtime back to node'
    } catch {
      Say ('revert also failed: ' + $_.Exception.Message)
    }
    throw
  }

  WriteJson $marker ([pscustomobject]@{
    schema = 1
    from = [string]$request.from
    to = [string]$request.to
    failures = [int]$request.failures
    phase = 'swapped'
    evidenceDir = [string]$request.evidenceDir
    stamp = $Stamp
    helperPid = $PID
    at = (Get-Date).ToUniversalTime().ToString('o')
  })
  Say 'runtime swapped; writing current.json'

  WriteJson $currentFile ([pscustomobject]@{
    schema = 1
    current = [string]$request.to
    previous = $null
    health = 'pending'
    failures = 0
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  })
  WriteJson $rollbackFile ([pscustomobject]@{
    schema = 1
    at = (Get-Date).ToUniversalTime().ToString('o')
    from = [string]$request.from
    to = [string]$request.to
    reason = [string]$request.reason
    failures = [int]$request.failures
    runtimeRestored = $true
    result = 'ok'
    evidenceDir = [string]$request.evidenceDir
    configBackup = ''
  })

  Remove-Item $marker -Force -ErrorAction SilentlyContinue
  Remove-Item $requestFile -Force -ErrorAction SilentlyContinue
  Say 'rollback restored; restarting launcher'

  $vbs = Join-Path $InstallRoot 'launcher\Estrella-Bot.vbs'
  if (Test-Path $vbs) {
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden | Out-Null
  } else {
    $nodeExe = Join-Path $node 'node.exe'
    $launcher = Join-Path $InstallRoot 'tools\launcher.mjs'
    Start-Process -FilePath $nodeExe -ArgumentList @($launcher, '--install-root', $InstallRoot) -WindowStyle Hidden | Out-Null
  }
  Cleanup
  exit 0
} catch {
  $msg = $_.Exception.Message
  Say ('FAILED: ' + $msg)
  try {
    WriteJson $marker ([pscustomobject]@{
      schema = 1
      from = ''
      to = ''
      failures = 0
      phase = 'failed'
      error = $msg
      stamp = $Stamp
      helperPid = $PID
      at = (Get-Date).ToUniversalTime().ToString('o')
    })
  } catch { }
  try {
    WriteJson $rollbackFile ([pscustomobject]@{
      schema = 1
      at = (Get-Date).ToUniversalTime().ToString('o')
      from = ''
      to = ''
      reason = ('runtime restore failed: ' + $msg)
      failures = 0
      runtimeRestored = $false
      result = 'failed'
      evidenceDir = ''
      configBackup = ''
    })
  } catch { }
  Cleanup
  exit 1
}

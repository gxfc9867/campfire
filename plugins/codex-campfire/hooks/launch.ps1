# Campfire Codex ignition hook.
# Fires on Codex Desktop SessionStart(startup). Launches the persistent adapter
# as a DETACHED, WINDOWLESS process that survives the short-lived hook lifecycle.
# First run (no config) pops a GUI setup window instead of asking the user to
# edit hidden files. Idempotent.

$ErrorActionPreference = 'Continue'
$configDir = Join-Path $env:USERPROFILE '.campfire-codex'
$lockFile  = Join-Path $configDir 'adapter.pid'
$logFile   = Join-Path $configDir 'ignite.log'
$pluginRoot = $PSScriptRoot                              # hooks/
$pluginHome = Split-Path $PSScriptRoot -Parent
$adapter   = Join-Path $pluginHome 'adapter\run.ps1'
$setup     = Join-Path $PSScriptRoot 'setup.ps1'

function Log([string]$m) {
  try { Add-Content -LiteralPath $logFile -Value ("[" + (Get-Date -Format 'HH:mm:ss') + "] " + $m) -Encoding UTF8 } catch {}
}
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
Log "ignition triggered"

# ---- Start a powershell script DETACHED with NO console window ----
# WMI Win32_Process.Create with a hidden VBS launcher: the cmd/powershell window
# never flashes on screen.
function Start-HiddenScript([string]$script, [string]$arguments) {
  $vbs = Join-Path $configDir 'launch-hidden.vbs'
  $psArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`""
  if ($arguments) { $psArgs += " $arguments" }
  $vbsBody = 'Set ws = CreateObject("Wscript.Shell")' + "`r`n" +
             'ws.Run "powershell.exe ' + ($psArgs -replace '"','""') + '", 0, False'
  # WSH 按系统 ANSI 读 .vbs；UTF-16 LE(带 BOM) 才能让中文用户名路径正确解析
  [System.IO.File]::WriteAllText($vbs, $vbsBody, [System.Text.Encoding]::Unicode)
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = 'wscript.exe "' + $vbs + '"'
  }
  return $r
}

# ---- 1) no config -> do nothing silently ----
# Configuration is user-initiated via the $campfire-setup skill, never auto-popped.
if (-not (Test-Path -LiteralPath (Join-Path $configDir '.env'))) {
  Log "no config yet; waiting for user to run `$campfire-setup (no auto popup)"
  exit 0
}

# ---- 2) idempotency: look for a live adapter process by command line ----
$running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'adapter\\run\.ps1.*ConfigDir|codex-desktop.*run\.ps1' }
if ($running) {
  $pids = (@($running) | ForEach-Object { $_.ProcessId }) -join ','
  Log "adapter already running (pid=$pids); skip"
  exit 0
}

if (-not (Test-Path -LiteralPath $adapter)) { Log "adapter script missing: $adapter"; exit 1 }

# ---- 3) launch adapter, windowless ----
$r = Start-HiddenScript $adapter "-ConfigDir `"$configDir`""
if ($r.ReturnValue -eq 0) {
  Log "launched adapter (windowless) via wscript return=$($r.ReturnValue)"
  # wscript exits immediately; record a marker instead of a reliable pid
  'windowless' | Out-File -LiteralPath $lockFile -Encoding ascii
} else {
  Log "FAILED to launch adapter return=$($r.ReturnValue)"
}

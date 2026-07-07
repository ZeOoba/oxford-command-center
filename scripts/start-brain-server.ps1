<#
.SYNOPSIS
  Hidden-window launcher for the Oxford Command Center (Brain Server + web app).

.DESCRIPTION
  Wraps `npm run dev` (Brain Server on :8911 + Vite dev server on :5273) so it runs
  detached from any visible console window, with combined stdout/stderr captured to
  logs/brain-server.log for diagnosis after the fact.

  This is the action invoked by the "ORA Command Center - Brain Server" scheduled task
  (see register-brain-server-task.ps1) on every logon -- it is not meant to be run
  interactively and watched, since it detaches immediately and returns.

  Writes the launcher's own process id to run/brain-server.pid so stop-brain-server.ps1
  can find and kill the whole process tree (cmd -> npm -> concurrently -> tsx/vite).

.EXAMPLE
  pwsh -File scripts/start-brain-server.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$logDir = Join-Path $repo 'logs'
$runDir = Join-Path $repo 'run'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$logFile = Join-Path $logDir 'brain-server.log'
$pidFile = Join-Path $runDir 'brain-server.pid'

# Defensive: if a previous run is still alive, don't start a second copy. The scheduled
# task's -MultipleInstances IgnoreNew setting already prevents overlap from re-firing
# logon triggers, but this guards manual re-runs too.
if (Test-Path $pidFile) {
  $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
    Write-Host "Brain Server already running (pid $existingPid) -- not starting a second copy."
    return
  }
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -Path $logFile -Value "`n[$stamp] --- starting npm run dev ---"

# Route through cmd.exe so a single redirect (`>>...2>&1`) captures both streams into
# one file -- Start-Process -RedirectStandardOutput/-Error refuse to share one path.
$cmdArgs = "/c npm run dev >> `"$logFile`" 2>&1"
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdArgs -WorkingDirectory $repo -WindowStyle Hidden -PassThru

Set-Content -Path $pidFile -Value $proc.Id
Write-Host "Brain Server + web app starting in background (pid $($proc.Id)); logs -> $logFile"

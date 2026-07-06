<#
.SYNOPSIS
  Stop the background Brain Server + web app started by start-brain-server.ps1.

.DESCRIPTION
  Kills the full process tree recorded in run/brain-server.pid (taskkill /T catches the
  cmd -> npm -> concurrently -> tsx/vite descendants that a plain Stop-Process would miss).
  Safe to run even if nothing is running -- reports and exits cleanly.

  Note: the scheduled task (see register-brain-server-task.ps1) will restart it at your
  next logon regardless -- to stop it long-term, also run
  `Disable-ScheduledTask -TaskName 'ORA Command Center - Brain Server'`.

.EXAMPLE
  pwsh -File scripts/stop-brain-server.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $repo 'run\brain-server.pid'

if (-not (Test-Path $pidFile)) {
  Write-Host 'No run/brain-server.pid found -- nothing to stop.'
  exit 0
}

$targetPid = Get-Content $pidFile -ErrorAction SilentlyContinue
if (-not $targetPid -or -not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
  Write-Host "pid $targetPid is not running -- already stopped."
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  exit 0
}

taskkill /PID $targetPid /T /F | Out-Null
Remove-Item $pidFile -ErrorAction SilentlyContinue
Write-Host "Stopped Brain Server + web app (was pid $targetPid)."

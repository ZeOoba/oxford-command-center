<#
.SYNOPSIS
  Register the "ORA Command Center - Brain Server" Windows scheduled task.

.DESCRIPTION
  Runs scripts/start-brain-server.ps1 at every logon of the current user, so the Brain
  Server (:8911, reads the live OneDrive workbook) and the web app (:5273) come up
  automatically -- no manual `npm run dev` required ever again. If either process dies,
  Windows restarts the task automatically; the task also has no execution time limit,
  since a dev server is meant to keep running, not finish (Scheduled Tasks otherwise
  kill anything still running after 3 days by default).

  Uses an "at logon" trigger for the CURRENT user (deliberately not "run whether user
  is logged on or not"): the workbook path resolves against this user's profile (see
  server/config.ts's homedir()-based default, and OneDrive itself needs the interactive
  session to be synced), and a logon trigger needs no stored password and no UAC
  elevation -- it just runs invisibly in your normal desktop session, same as if you'd
  typed `npm run dev` yourself.

  Run this ONCE (not invoked automatically). No admin rights required. Re-running
  updates the existing task (idempotent) if you ever move the repo or change machines.

.EXAMPLE
  pwsh -File scripts/register-brain-server-task.ps1
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'ORA Command Center - Brain Server'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo 'scripts\start-brain-server.ps1'
# Prefer PowerShell 7 (pwsh) for the task action; fall back to Windows PowerShell.
# (Avoid the PS7-only ?. operator so this script also parses under Windows PowerShell 5.1.)
$pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
$pwsh = if ($pwshCmd) { $pwshCmd.Source } else { (Get-Command powershell).Source }

$action = New-ScheduledTaskAction -Execute $pwsh `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
  -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger -AtLogOn

# No execution time limit -- this is a standing background service, not a one-shot job.
# Restart automatically if it ever crashes; ignore duplicate fires if already running
# (e.g. a fast logoff/logon cycle). Survive battery/idle the same way the mirror task does.
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -StartWhenAvailable

# Default RunLevel (Limited) is left as-is deliberately -- "highest privileges" would
# trigger a UAC prompt on every logon; Limited runs with your normal desktop rights,
# which is all this needs (reads OneDrive under your own profile, binds 127.0.0.1 only).
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force `
  -Description 'Starts the Oxford Command Center Brain Server + web app at logon and keeps it running (auto-restart on crash). See scripts/start-brain-server.ps1 / stop-brain-server.ps1.'

Write-Host "Registered '$TaskName': starts $script at every logon, auto-restarts on crash, no execution time limit."
Write-Host 'Starting it now too, so this session has it running without waiting for the next logon...'
Start-ScheduledTask -TaskName $TaskName

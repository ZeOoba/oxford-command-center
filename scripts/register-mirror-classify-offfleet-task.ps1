<#
.SYNOPSIS
  Register the "ORA Mirror Deploy Classifier" Windows scheduled task (OI-197 fix (a),
  2026-08-21) -- the off-fleet redundant layer for the CC/MCP fleet's
  ora-command-center-mirror-drift-check task, which cannot run during a fleet pause.

.DESCRIPTION
  Runs scripts/mirror-classify-offfleet.ps1 on the same weekday 10:40 AM ET cadence as
  the fleet task it backs up, natively via Windows Task Scheduler -- so classification
  and alerting survive a full CC/MCP fleet pause (2026-08-17 incident: the fleet task
  went dark with everything else, per open-items-tracker.md#OI-197).

  Run this ONCE (not invoked automatically). Re-running updates the existing task.

  KNOWN: mirror-run-classify.ps1 (the shared classifier both this task and the fleet
  task call) took ~5 minutes on a 2026-08-21 test run coinciding with an in-flight
  deploy -- correct result (RUN_IN_PROGRESS, no false alarm), but slower than a
  weekday-cadence check should need. Not investigated or fixed here (pre-existing,
  tested, production code); ExecutionTimeLimit below is set generously (15 min) to
  avoid this task self-terminating on a slow run, not as an endorsement of the runtime.

.EXAMPLE
  pwsh -File scripts/register-mirror-classify-offfleet-task.ps1
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'ORA Mirror Deploy Classifier'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo 'scripts\mirror-classify-offfleet.ps1'
$pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
$pwsh = if ($pwshCmd) { $pwshCmd.Source } else { (Get-Command powershell).Source }

$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory $repo
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

# Weekday 10:40 AM ET -- matches ora-command-center-mirror-drift-check's own cadence
# (40 10 * * 1-5), so both layers cover the same window.
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 10:40am

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force -Description 'Off-fleet redundant classifier + alert for ORA Command Center - Mirror Deploy (OI-197 fix (a)). Runs independently of the CC/MCP fleet so classification survives a fleet pause. See open-items-tracker.md#OI-197.'
Write-Host "Registered '$TaskName': weekday 10:40 AM ET -> $script"

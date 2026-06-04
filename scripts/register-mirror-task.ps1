<#
.SYNOPSIS
  Register the "ORA Command Center — Mirror Deploy" Windows scheduled task.

.DESCRIPTION
  Runs scripts/deploy-mirror.ps1 on two triggers:
    1. Hourly all day (keeps data fresh throughout the day).
    2. Daily at 06:45 ET (guarantees the daily-brief fires after overnight data update).

  The lastBriefDate gate inside the bake ensures the brief fires only once per calendar day
  even though the bake runs every hour.

  Run this ONCE (not invoked automatically) after confirming `wrangler` is authenticated and
  `npm run gate` is green. Re-running updates the existing task.

.EXAMPLE
  pwsh -File scripts/register-mirror-task.ps1
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'ORA Command Center - Mirror Deploy'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo 'scripts\deploy-mirror.ps1'
# Prefer PowerShell 7 (pwsh) for the task action; fall back to Windows PowerShell.
# (Avoid the PS7-only ?. operator so this script also parses under Windows PowerShell 5.1.)
$pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
$pwsh = if ($pwshCmd) { $pwshCmd.Source } else { (Get-Command powershell).Source }

$action   = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory $repo
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

# Hourly all day + a guaranteed 06:45 brief trigger. The lastBriefDate gate makes the brief fire once/day.
$hourly  = New-ScheduledTaskTrigger -Once -At 12:00am -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$morning = New-ScheduledTaskTrigger -Daily -At 6:45am
$triggers = @($hourly, $morning)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Force -Description 'Hourly bake + deploy of the Oxford Command Center mirror (+ guaranteed 06:45 ET brief trigger); verifies the Cloudflare Access gate after deploy.'
Write-Host "Registered '$TaskName': hourly bake + 06:45 ET brief trigger -> $script"

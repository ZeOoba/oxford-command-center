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
# Get-MirrorTaskArguments lives in lib/mirror-task-action.ps1 (shared with
# register-mirror-task.smoke-test.ps1) -- see that file for the 2026-09-16 -> 09-18
# incident (no window style on this action's launch meant every hourly/06:45 fire opened a
# focus-stealing console on the interactive desktop, which then got closed mid-run) that
# motivated -WindowStyle Hidden.
. (Join-Path $PSScriptRoot 'lib\mirror-task-action.ps1')
# Prefer PowerShell 7 (pwsh) for the task action; fall back to Windows PowerShell.
# (Avoid the PS7-only ?. operator so this script also parses under Windows PowerShell 5.1.)
$pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
$pwsh = if ($pwshCmd) { $pwshCmd.Source } else { (Get-Command powershell).Source }

$action   = New-ScheduledTaskAction -Execute $pwsh -Argument (Get-MirrorTaskArguments -ScriptPath $script) -WorkingDirectory $repo
# Run regardless of power state — a laptop won't always be on AC at 06:45, and the default
# DisallowStartIfOnBatteries/StopIfGoingOnBatteries would silently queue/kill the brief.
# -WakeToRun: this machine is S0 Modern Standby and sleeps overnight. Without it the hourly
# trigger simply does not fire while asleep and the "guaranteed" 06:45 brief trigger is not
# guaranteed at all — on 2026-08-12 the mirror served an 08-11 19:00 bake until 11:06, a
# 16-hour gap that StartWhenAvailable only recovered ~6 min after the lid was opened.
# Caveat: WakeToRun is not sufficient on its own — it is gated by the active power plan's
# "Allow wake timers" setting, which is stored separately for AC and DC, so the task can wake
# the machine on one and silently not on the other. Do not assume; read the live values with:
#   powercfg /query SCHEME_CURRENT SUB_SLEEP BD3B718A-0680-4D9D-8AB2-E1D2B4AC806D
# (0x0 = Disable, 0x1 = Enable, 0x2 = Important Wake Timers Only.)
# -Priority 5 (normal CPU, I/O and memory priority): the Task Scheduler default is 7 (below-normal
# CPU, very-low I/O and memory priority), which starved this task whenever normal-priority work
# saturated the laptop. On 2026-11-13 the 11:00 and 12:00 runs took 9 and 15 minutes just to reach
# their first script line (PowerShellCore engine events: every phase ~100x slower; the same work
# took 4 s at Normal vs 13-90 s at BelowNormal under 100% CPU) and were killed at the 30-minute limit.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -Priority 5

# Hourly all day + a guaranteed 06:45 brief trigger. The lastBriefDate gate makes the brief fire once/day.
$hourly  = New-ScheduledTaskTrigger -Once -At 12:00am -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$morning = New-ScheduledTaskTrigger -Daily -At 6:45am
$triggers = @($hourly, $morning)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Force -Description 'Hourly bake + deploy of the Oxford Command Center mirror (+ guaranteed 06:45 ET brief trigger); verifies the Cloudflare Access gate after deploy.'
Write-Host "Registered '$TaskName': hourly bake + 06:45 ET brief trigger -> $script"

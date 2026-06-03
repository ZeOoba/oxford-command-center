<#
.SYNOPSIS
  Register the daily "ORA Command Center — Mirror Deploy" Windows scheduled task.

.DESCRIPTION
  Runs scripts/deploy-mirror.ps1 daily at the given time on the ORA machine. Run this ONCE
  (it is not invoked automatically) after confirming `wrangler` is authenticated and
  `npm run gate` is green. Re-running updates the existing task.

.EXAMPLE
  pwsh -File scripts/register-mirror-task.ps1 -At 06:30
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'ORA Command Center - Mirror Deploy',
  [string]$At = '06:30'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo 'scripts\deploy-mirror.ps1'
# Prefer PowerShell 7 (pwsh) for the task action; fall back to Windows PowerShell.
# (Avoid the PS7-only ?. operator so this script also parses under Windows PowerShell 5.1.)
$pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
$pwsh = if ($pwshCmd) { $pwshCmd.Source } else { (Get-Command powershell).Source }

$action  = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force -Description 'Daily bake + deploy of the Oxford Command Center mirror; verifies the Cloudflare Access gate after deploy.'
Write-Host "Registered '$TaskName' to run daily at $At -> $script"

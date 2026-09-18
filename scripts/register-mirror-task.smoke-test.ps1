<#
  Manual regression smoke test for scripts/lib/mirror-task-action.ps1's
  Get-MirrorTaskArguments. This repo has no Pester/.Tests.ps1 convention for PowerShell (see
  deploy-mirror.smoke-test.ps1's header), so this is a plain, run-by-hand assertion script
  rather than wired into `npm test`. Deliberately does NOT call Register-ScheduledTask --
  this asserts the built argument string only, so it can run repeatedly with zero side
  effects and without touching the live Windows Task Scheduler registry.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-mirror-task.smoke-test.ps1
  Exits 0 if all assertions pass, 1 otherwise.
#>
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\mirror-task-action.ps1')

$failures = @()
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { $script:failures += $Message; Write-Host "FAIL: $Message" }
  else { Write-Host "pass: $Message" }
}

$scriptPath = 'C:\Users\Owner\oxford-command-center\scripts\deploy-mirror.ps1'
$argString = Get-MirrorTaskArguments -ScriptPath $scriptPath

# The regression this guards against: 2026-09-16 -> 09-18 kills traced to the action having
# NO window style, so the hourly/06:45 fire opened a focus-stealing console that got closed
# from the desktop mid-run. -WindowStyle Hidden is the fix; verify it's actually present.
Assert-True ($argString -match '(^|\s)-WindowStyle\s+Hidden(\s|$)') `
  "argument string includes -WindowStyle Hidden (got: $argString)"

# -WindowStyle Hidden must come before -File -- PowerShell.exe stops parsing named switches
# once it hits the first positional/unrecognized token, so a -WindowStyle placed AFTER -File
# would silently do nothing (the exact kind of bug this test exists to catch, not just the
# flag's mere presence in the string).
$fileIndex = $argString.IndexOf('-File')
$windowStyleIndex = $argString.IndexOf('-WindowStyle')
Assert-True ($windowStyleIndex -ge 0 -and $fileIndex -ge 0 -and $windowStyleIndex -lt $fileIndex) `
  "-WindowStyle Hidden appears before -File (windowStyleIndex=$windowStyleIndex, fileIndex=$fileIndex)"

# Existing behavior must survive: -NoProfile, -ExecutionPolicy Bypass, and the quoted script
# path all still present and correct.
Assert-True ($argString -match '(^|\s)-NoProfile(\s|$)') "argument string includes -NoProfile"
Assert-True ($argString -match '(^|\s)-ExecutionPolicy\s+Bypass(\s|$)') "argument string includes -ExecutionPolicy Bypass"
Assert-True ($argString -match [regex]::Escape("`"$scriptPath`"")) "argument string includes the quoted script path"

if ($failures.Count -gt 0) {
  Write-Host "`n$($failures.Count) assertion(s) failed:"
  $failures | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
Write-Host "`nAll assertions passed."
exit 0

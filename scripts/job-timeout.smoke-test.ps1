<#
  Manual regression smoke test for scripts/lib/job-timeout.ps1's Invoke-ScriptBlockWithTimeout.
  Companion to native-command-timeout.smoke-test.ps1 (same "no Pester convention here, run-by-hand
  assertion script" pattern) -- that test covers the EXTERNAL-process case
  (Invoke-NativeCommandWithTimeout); this one covers the IN-PROCESS-cmdlet case, added 2026-09-18
  after finding mirror-run-classify.ps1's four live Get-WinEvent calls had no bound of their own
  (see scripts/lib/job-timeout.ps1's header for the full incident writeup).

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/job-timeout.smoke-test.ps1
  Exits 0 if all assertions pass, 1 otherwise.
#>
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\job-timeout.ps1')

$failures = @()
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { $script:failures += $Message; Write-Host "FAIL: $Message" }
  else { Write-Host "pass: $Message" }
}

# Scenario 1: fast success -- must not be TimedOut, must report Success, must return the real value.
$r1 = Invoke-ScriptBlockWithTimeout -TimeoutSeconds 30 -ScriptBlock { 'ok' }
Assert-True ($r1.TimedOut -eq $false) "scenario 1 (fast success): TimedOut should be False, got $($r1.TimedOut)"
Assert-True ($r1.Success  -eq $true)  "scenario 1 (fast success): Success should be True, got $($r1.Success)"
Assert-True ($r1.Value    -eq 'ok')   "scenario 1 (fast success): expected Value 'ok', got '$($r1.Value)'"

# Scenario 2: -ArgumentList must reach the scriptblock -- the production call sites pass TaskName,
# dates, and event-id arrays this way, since a job has no closure over the caller's variables.
$r2 = Invoke-ScriptBlockWithTimeout -TimeoutSeconds 30 -ArgumentList @(3, 4) -ScriptBlock {
  param($A, $B) $A + $B
}
Assert-True ($r2.Success -eq $true) "scenario 2 (arguments): Success should be True, got $($r2.Success)"
Assert-True ($r2.Value   -eq 7)     "scenario 2 (arguments): expected Value 7, got '$($r2.Value)'"

# Scenario 3: a scriptblock that throws must come back as a reported failure, not re-thrown into the
# caller -- mirror-run-classify.ps1 runs under global $ErrorActionPreference = 'Stop' and its own
# header promises it "never throws on missing data"; an unhandled re-throw here would break that.
$r3 = Invoke-ScriptBlockWithTimeout -TimeoutSeconds 30 -ScriptBlock { throw 'boom' }
Assert-True ($r3.TimedOut -eq $false) "scenario 3 (scriptblock throws): TimedOut should be False, got $($r3.TimedOut)"
Assert-True ($r3.Success  -eq $false) "scenario 3 (scriptblock throws): Success should be False, got $($r3.Success)"
Assert-True ($r3.ErrorMessage -match 'boom') "scenario 3 (scriptblock throws): ErrorMessage should mention 'boom', got '$($r3.ErrorMessage)'"

# Scenario 4: a genuine hang -- this is the shape of the 2026-09-18 finding (a Get-WinEvent call that
# simply never returns). Must report TimedOut and, critically, return near the bound rather than
# blocking for the scriptblock's full runtime -- a "timeout" that still waits out the hang would not
# protect the caller.
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$r4 = Invoke-ScriptBlockWithTimeout -TimeoutSeconds 3 -ScriptBlock { Start-Sleep -Seconds 120 }
$sw.Stop()
Assert-True ($r4.TimedOut -eq $true) "scenario 4 (hang): TimedOut should be True, got $($r4.TimedOut)"
Assert-True ($r4.Success  -eq $false) "scenario 4 (hang): Success should be False, got $($r4.Success)"
Assert-True ($sw.Elapsed.TotalSeconds -lt 30) "scenario 4 (hang): must return near the bound, took $([int]$sw.Elapsed.TotalSeconds)s"

# Scenario 5: the reclaimed job must not leave its child process running past the bound -- an orphan
# background-job process would be exactly the kind of silent resource leak this function exists to
# avoid (same concern as native-command-timeout.smoke-test.ps1 scenario 4's grandchild-survival check,
# adapted for Start-Job's own child process rather than a spawned grandchild).
$beforeIds = @(Get-Job | Select-Object -ExpandProperty Id)
$r5 = Invoke-ScriptBlockWithTimeout -TimeoutSeconds 2 -ScriptBlock { Start-Sleep -Seconds 60 }
Start-Sleep -Seconds 1
$afterIds = @(Get-Job | Select-Object -ExpandProperty Id)
$leaked = @($afterIds | Where-Object { $beforeIds -notcontains $_ })
Assert-True ($leaked.Count -eq 0) "scenario 5 (cleanup): timed-out job must be removed, not left registered (found $($leaked.Count) leftover)"

Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host "$($failures.Count) assertion(s) FAILED."
  exit 1
} else {
  Write-Host 'All assertions passed.'
  exit 0
}

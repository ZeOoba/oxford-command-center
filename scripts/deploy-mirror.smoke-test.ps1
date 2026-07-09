<#
  Manual regression smoke test for scripts/lib/deploy-alert.ps1's Send-DeployFailureAlert.
  This repo has no Pester/.Tests.ps1 convention for PowerShell (confirmed empty at the time
  this was written), so this is a plain, run-by-hand assertion script rather than wired into
  `npm test`. Run this before merging future changes to Send-DeployFailureAlert -- a prior
  throwaway version of this exact test caught a real quoting bug (see lib/deploy-alert.ps1's
  -BodyFile comment) that exit-code-only testing had missed.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-mirror.smoke-test.ps1
  Exits 0 if all assertions pass, 1 otherwise.
#>
$ErrorActionPreference = 'Stop'

$callLog = Join-Path $env:TEMP "deploy-alert-smoke-$([guid]::NewGuid()).log"
$repo = Join-Path $env:TEMP "deploy-alert-smoke-repo-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $repo -Force | Out-Null
$AlertSendScript = Join-Path $PSScriptRoot 'lib\fake-mailer.smoke-test.ps1'
$AlertTo = 'test@example.invalid'

. (Join-Path $PSScriptRoot 'lib\deploy-alert.ps1')

$failures = @()
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { $script:failures += $Message; Write-Host "FAIL: $Message" }
  else { Write-Host "pass: $Message" }
}
function Reset-Log { if (Test-Path $callLog) { Remove-Item $callLog } }
function Get-Calls {
  # @(...) forces array semantics -- without it, PowerShell collapses a single Where-Object
  # match to a bare string, and $calls[0] would then index a CHARACTER of that string instead
  # of the call record (caught this exact bug in the first draft of this test). Note this has
  # to be repeated by every CALLER too (as `$calls = @(Get-Calls)`) -- wrapping only inside
  # the function isn't enough, because a 1-element array written to the output stream still
  # collapses back to a scalar at the point where the caller captures it.
  if (-not (Test-Path $callLog)) { return @() }
  return @((Get-Content $callLog -Raw) -split '---CALL---' | Where-Object { $_.Trim() -ne '' })
}

# Scenario 1: exit 0 -- sent OK, exactly 1 call.
Reset-Log
$env:FAKE_SEND_CALL_LOG = $callLog
$env:FAKE_SEND_EXIT_CODE = '0'
Send-DeployFailureAlert -Reason 'TEST scenario 1 (exit 0)'
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 1) "scenario 1 (exit 0): expected 1 call, got $($calls.Count)"

# Scenario 2: exit 1 (usage error) -- no retry, exactly 1 call.
Reset-Log
$env:FAKE_SEND_EXIT_CODE = '1'
Send-DeployFailureAlert -Reason 'TEST scenario 2 (exit 1)'
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 1) "scenario 2 (exit 1, no retry): expected 1 call, got $($calls.Count)"

# Scenario 3: exit 2 (COM failure) -- one retry, exactly 2 calls. (~5s sleep, expected.)
Reset-Log
$env:FAKE_SEND_EXIT_CODE = '2'
Send-DeployFailureAlert -Reason 'TEST scenario 3 (exit 2)'
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 2) "scenario 3 (exit 2, retry once): expected 2 calls, got $($calls.Count)"

# Scenario 4: a reason containing an embedded double-quote, a backtick, and a $ must survive
# byte-for-byte into the sent body. This is the exact class of bug a native -Body argument
# (instead of -BodyFile) hit during review -- regression guard for that fix.
Reset-Log
$env:FAKE_SEND_EXIT_CODE = '0'
$trickyReason = 'wrangler said: "unexpected token" near `$HOME and it cost $5.00'
Send-DeployFailureAlert -Reason $trickyReason
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 1) "scenario 4 (tricky content): expected 1 call, got $($calls.Count)"
if ($calls.Count -ge 1) {
  # .Contains(), not -like: the tricky content itself may contain wildcard-pattern-special
  # characters (a backtick in particular is an ESCAPE char inside a -like pattern, not a
  # literal), which makes -like unsafe for checking arbitrary content -- exact substring
  # match is what's actually being asserted here.
  Assert-True ($calls[0].Contains($trickyReason)) "scenario 4: tricky reason string must survive intact in the sent body"
}

# Scenario 5: -Critical must produce the CRITICAL subject variant.
Reset-Log
$env:FAKE_SEND_EXIT_CODE = '0'
Send-DeployFailureAlert -Reason 'GATE CHECK FAILED: TEST scenario 5' -Critical
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 1 -and $calls[0].Contains('CRITICAL')) "scenario 5: -Critical must produce a CRITICAL subject"

Remove-Item Env:\FAKE_SEND_CALL_LOG -ErrorAction SilentlyContinue
Remove-Item Env:\FAKE_SEND_EXIT_CODE -ErrorAction SilentlyContinue
Reset-Log
Remove-Item -Path $repo -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
if ($failures.Count -gt 0) {
  Write-Host "$($failures.Count) assertion(s) FAILED."
  exit 1
} else {
  Write-Host "All assertions passed."
  exit 0
}

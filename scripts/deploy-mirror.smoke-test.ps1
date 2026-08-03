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
$stateFile = Join-Path $repo 'data\alert-state\offline-suppression.json'

. (Join-Path $PSScriptRoot 'lib\deploy-alert.ps1')
# Get-DeployTimeoutReason -- needed for scenarios 6q/6r below (2026-07-29 code-review follow-up).
. (Join-Path $PSScriptRoot 'lib\native-timeout.ps1')

$failures = @()
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { $script:failures += $Message; Write-Host "FAIL: $Message" }
  else { Write-Host "pass: $Message" }
}
function Reset-Log { if (Test-Path $callLog) { Remove-Item $callLog } }
function Reset-State { if (Test-Path $stateFile) { Remove-Item $stateFile } }
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

# Scenario 6: Test-OfflineSignature classification -- narrow on purpose (only the two
# git fetch/pull throw messages deploy-mirror.ps1 raises); build/gate failures must not match.
Assert-True (Test-OfflineSignature -Reason 'git fetch origin failed (128)') "scenario 6a: git fetch failure classified as offline signature"
Assert-True (Test-OfflineSignature -Reason 'git pull --ff-only failed (1) -- local main has diverged from origin/main') "scenario 6b: git pull failure classified as offline signature"
Assert-True (-not (Test-OfflineSignature -Reason 'build:mirror failed (1)')) "scenario 6c: build failure NOT classified as offline signature"
Assert-True (-not (Test-OfflineSignature -Reason 'GATE CHECK FAILED: TEST')) "scenario 6d: gate check failure NOT classified as offline signature"
# 6q/6r (2026-07-29, code-review follow-up): the deploy-timeout throw must reach Gabriel on the
# FIRST occurrence. If its wording ever drifted into Test-OfflineSignature's match, the timeout
# would be treated as a suppressible offline blip and silently swallowed below the streak threshold
# -- which would restore the exact silent-failure hole the timeout was added to close. This calls
# the REAL Get-DeployTimeoutReason (lib/native-timeout.ps1) rather than a hand-copied literal --
# an earlier draft of this test used a copied string that had already drifted from the production
# message by the time it was reviewed, which would have let a real regression pass silently.
$timeoutReason = Get-DeployTimeoutReason -Seconds 600
Assert-True (-not (Test-OfflineSignature -Reason $timeoutReason)) "scenario 6q: deploy timeout NOT classified as offline signature (must never be suppressed)"
# It is also not a gate failure: a stall's publication state is UNKNOWN, not a confirmed exposure,
# so it must not be escalated to CRITICAL the way a confirmed 2xx gate-check response would be.
Assert-True (-not ($timeoutReason -match '^GATE CHECK FAILED')) "scenario 6r: deploy timeout NOT classified as a gate failure (publication state unknown, not a confirmed confidentiality exposure)"

# Scenario 6e-6k: Test-GitAuthFailureSignature classification -- real git/GitHub credential-
# failure wording (2026-07-10 incident: gh.exe's credential helper going missing/unauthenticated
# produces exit 128, the SAME generic code a real network outage produces). These strings are
# drawn from the actual error text git/GitHub produce for each failure mode.
Assert-True (Test-GitAuthFailureSignature -Reason "fatal: could not read Username for 'https://github.com': terminal prompts disabled") "scenario 6e: 'could not read Username' + 'terminal prompts disabled' classified as auth failure"
Assert-True (Test-GitAuthFailureSignature -Reason "remote: Support for password authentication was removed`nfatal: Authentication failed for 'https://github.com/ZeOoba/oxford-command-center.git/'") "scenario 6f: 'Authentication failed' classified as auth failure"
Assert-True (Test-GitAuthFailureSignature -Reason "Permission denied (publickey).`nfatal: Could not read from remote repository.") "scenario 6g: 'Permission denied' classified as auth failure"
Assert-True (Test-GitAuthFailureSignature -Reason "remote: Repository not found.`nfatal: repository 'https://github.com/ZeOoba/oxford-command-center.git/' not found") "scenario 6h: 'remote: Repository not found' classified as auth failure"
Assert-True (Test-GitAuthFailureSignature -Reason "remote: Invalid username or password.`nfatal: Authentication failed") "scenario 6i: 'Invalid username or password' classified as auth failure"
Assert-True (Test-GitAuthFailureSignature -Reason "fatal: unable to access 'https://github.com/ZeOoba/oxford-command-center.git/': The requested URL returned error: 401") "scenario 6j: 'unable to access ... 401' classified as auth failure"
Assert-True (Test-GitAuthFailureSignature -Reason "fatal: unable to access 'https://github.com/ZeOoba/oxford-command-center.git/': The requested URL returned error: 403") "scenario 6k: 'unable to access ... 403' classified as auth failure"

# Scenario 6l-6o: genuinely network/offline-looking text must NOT be classified as an auth
# failure -- these stay Test-OfflineSignature's territory via deploy-mirror.ps1's unchanged
# fall-through throw for the real-outage case.
Assert-True (-not (Test-GitAuthFailureSignature -Reason "fatal: unable to access 'https://github.com/ZeOoba/oxford-command-center.git/': Could not resolve host: github.com")) "scenario 6l: 'Could not resolve host' NOT classified as auth failure"
Assert-True (-not (Test-GitAuthFailureSignature -Reason "fatal: unable to access 'https://github.com/ZeOoba/oxford-command-center.git/': Connection timed out after 10000 milliseconds")) "scenario 6m: 'Connection timed out' NOT classified as auth failure"
Assert-True (-not (Test-GitAuthFailureSignature -Reason "fatal: unable to access 'https://github.com/ZeOoba/oxford-command-center.git/': Failed to connect to github.com port 443 after 75 ms: Couldn't connect to server")) "scenario 6n: 'Failed to connect' NOT classified as auth failure"
Assert-True (-not (Test-GitAuthFailureSignature -Reason "fatal: unable to access 'https://github.com/ZeOoba/oxford-command-center.git/': Network is unreachable")) "scenario 6o: 'Network is unreachable' NOT classified as auth failure"

# Scenario 6p: the distinctly-prefixed reason deploy-mirror.ps1 throws when an auth failure does
# NOT self-heal must NEVER match Test-OfflineSignature -- this is the core regression guard for
# the whole fix: a non-self-healing credential problem must always alert immediately, never fold
# into the offline-suppression digest meant only for transient network blips.
Assert-True (-not (Test-OfflineSignature -Reason "GIT AUTH FAILURE (128): git fetch origin failed with a credential/auth error, and the Credential Manager fallback retry also failed (128): fatal: could not read Username for 'https://github.com': terminal prompts disabled")) "scenario 6p: GIT AUTH FAILURE reason must NOT match Test-OfflineSignature (must always alert immediately, never suppressed)"

# Scenario 7: suppressible failure, first occurrence in a new streak -- still alerts
# immediately (a one-off blip must look exactly like today's behavior), and records state.
Reset-Log
Reset-State
$env:FAKE_SEND_EXIT_CODE = '0'
Send-DeployFailureAlert -Reason 'git fetch origin failed (128)' -Suppressible -StateFile $stateFile
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 1) "scenario 7 (suppressible, first occurrence): expected 1 call (immediate alert), got $($calls.Count)"
$state = Get-Content $stateFile -Raw | ConvertFrom-Json
Assert-True ($state.streakCount -eq 1) "scenario 7: state streakCount should be 1 after first occurrence"

# Scenario 8: second suppressible failure in the same streak, below escalation threshold --
# must be suppressed (0 calls), not a duplicate FAILED email.
Reset-Log
Send-DeployFailureAlert -Reason 'git fetch origin failed (128)' -Suppressible -StateFile $stateFile
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 0) "scenario 8 (suppressible, 2nd occurrence, below threshold): expected 0 calls (suppressed), got $($calls.Count)"
$state = Get-Content $stateFile -Raw | ConvertFrom-Json
Assert-True ($state.streakCount -eq 2) "scenario 8: streakCount should be 2"

# Scenario 9: third occurrence hits the default EscalationThreshold (3) -- a prolonged outage
# must not go completely silent, so this sends exactly one escalation alert.
Reset-Log
Send-DeployFailureAlert -Reason 'git fetch origin failed (128)' -Suppressible -StateFile $stateFile
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 1 -and $calls[0].Contains('escalated')) "scenario 9 (streak reaches threshold): expected 1 escalation call, got $($calls.Count)"
$state = Get-Content $stateFile -Raw | ConvertFrom-Json
Assert-True ($state.lastEscalatedAtStreak -eq 3) "scenario 9: lastEscalatedAtStreak should now be 3"

# Scenario 10: fourth and fifth occurrences, past the threshold but not yet due for
# RE-escalation (only 1 and 2 further occurrences since the streak-3 escalation) -- must stay
# suppressed, not re-escalate on every single occurrence past the threshold.
Reset-Log
Send-DeployFailureAlert -Reason 'git fetch origin failed (128)' -Suppressible -StateFile $stateFile
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 0) "scenario 10a (streak 4, 1 past last escalation): expected 0 calls, got $($calls.Count)"
Send-DeployFailureAlert -Reason 'git fetch origin failed (128)' -Suppressible -StateFile $stateFile
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 0) "scenario 10b (streak 5, 2 past last escalation): expected 0 calls, got $($calls.Count)"

# Scenario 11: sixth occurrence -- exactly $EscalationThreshold further failures since the last
# escalation (streak 3 -> 6) -- must RE-escalate. This is the fix for a non-self-healing
# failure (e.g. a permanent git divergence, not just a transient network blip) that would
# otherwise go completely silent forever after its one-time escalation alert.
Reset-Log
Send-DeployFailureAlert -Reason 'git fetch origin failed (128)' -Suppressible -StateFile $stateFile
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 1 -and $calls[0].Contains('escalated')) "scenario 11 (streak 6, re-escalation due): expected 1 escalation call, got $($calls.Count)"
$state = Get-Content $stateFile -Raw | ConvertFrom-Json
Assert-True ($state.lastEscalatedAtStreak -eq 6) "scenario 11: lastEscalatedAtStreak should now be 6"

# Scenario 12: recovery digest after this longer, twice-escalated streak -- exactly one digest
# email, and the state file is cleared so the next incident starts a fresh streak.
Reset-Log
Send-DeployRecoveryDigestIfSuppressed -StateFile $stateFile
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 1 -and $calls[0].Contains('recovered')) "scenario 12 (recovery digest after suppressed streak): expected 1 digest call, got $($calls.Count)"
Assert-True (-not (Test-Path $stateFile)) "scenario 12: state file should be cleared after recovery digest"

# Scenario 13: recovery digest called with no suppressed streak on record -- pure no-op.
Reset-Log
Send-DeployRecoveryDigestIfSuppressed -StateFile $stateFile
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 0) "scenario 13 (no suppressed streak on record): expected 0 calls (no-op), got $($calls.Count)"

# Scenario 14: a LONE suppressible failure that self-recovers before ever repeating must not
# gain a second email -- the original immediate alert already covered it. This is the
# no-regression case for the common one-off blip.
Reset-Log
Reset-State
Send-DeployFailureAlert -Reason 'git pull --ff-only failed (1) -- local main has diverged from origin/main' -Suppressible -StateFile $stateFile
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 1) "scenario 14a (lone suppressible failure): expected 1 call (immediate), got $($calls.Count)"
Reset-Log
Send-DeployRecoveryDigestIfSuppressed -StateFile $stateFile
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 0) "scenario 14b (recovery after a single non-repeating failure): expected 0 calls -- no added noise for a one-off blip"
Assert-True (-not (Test-Path $stateFile)) "scenario 14b: state file should be cleared"

# Scenario 15: -Critical must never be suppressed, even mid-streak and even if a caller
# mistakenly passes -Suppressible alongside it -- a possible confidential-exposure alert must
# always fire immediately.
Reset-Log
Reset-State
Send-DeployFailureAlert -Reason 'git fetch origin failed (128)' -Suppressible -StateFile $stateFile
Reset-Log
Send-DeployFailureAlert -Reason 'GATE CHECK FAILED: TEST scenario 15' -Critical -Suppressible -StateFile $stateFile
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 1 -and $calls[0].Contains('CRITICAL')) "scenario 15: -Critical must always alert immediately even mid-streak and even with -Suppressible set"
Reset-State

# Scenario 16: the DEFAULT -StateFile parameter (the one path real hourly runs actually use --
# deploy-mirror.ps1 never passes -StateFile explicitly) must resolve correctly from $repo in
# the dot-sourcing scope, not just the explicit-override path every other scenario exercises.
# $stateFile above was built with the identical expression the default uses, so a successful
# write to that same path confirms the default parameter expression itself works.
Reset-Log
Reset-State
Send-DeployFailureAlert -Reason 'git fetch origin failed (128)' -Suppressible
$calls = @(Get-Calls)
Assert-True ($calls.Count -eq 1) "scenario 16 (default -StateFile path): expected 1 call (immediate), got $($calls.Count)"
Assert-True (Test-Path $stateFile) "scenario 16: default -StateFile expression should have created the state file at `$repo\data\alert-state\offline-suppression.json"
Reset-State

Remove-Item Env:\FAKE_SEND_CALL_LOG -ErrorAction SilentlyContinue
Remove-Item Env:\FAKE_SEND_EXIT_CODE -ErrorAction SilentlyContinue
Reset-Log
Reset-State
Remove-Item -Path $repo -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
if ($failures.Count -gt 0) {
  Write-Host "$($failures.Count) assertion(s) FAILED."
  exit 1
} else {
  Write-Host "All assertions passed."
  exit 0
}

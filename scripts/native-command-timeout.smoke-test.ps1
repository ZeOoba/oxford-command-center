<#
  Manual regression smoke test for scripts/lib/native-timeout.ps1's Invoke-NativeCommandWithTimeout.
  Companion to deploy-mirror.smoke-test.ps1 / git-fetch-capture.smoke-test.ps1 (same "no Pester
  convention here, run-by-hand assertion script" pattern).

  Incident (2026-07-29): the hourly "ORA Command Center - Mirror Deploy" task exited
  3221225786 (0xC000013A, STATUS_CONTROL_C_EXIT). deploy-mirror.ps1 had fetched, merged, baked and
  built successfully (dist/ written at 10:04), then sat ~26 minutes in `npx wrangler pages deploy`
  before the Windows Task Scheduler ExecutionTimeLimit (PT30M) force-terminated the whole process
  tree at 10:30. The next hourly run at 11:00 completed normally (exit 0) with no intervention, so
  the stall was TRANSIENT -- not expired credentials, not a diverged tree (drift was 0, tree clean).

  Why that mattered far more than one missed deploy: a Task Scheduler forced termination does NOT
  unwind PowerShell's try/catch. deploy-mirror.ps1's entire alerting path (catch ->
  Send-DeployFailureAlert -> Outlook COM, with a data/outbox/ fallback) is reached only via `throw`.
  A kill bypasses all of it, so the deploy failed COMPLETELY SILENTLY -- confirmed: no outbox entry
  was written that day. It surfaced only because a separate sampling checker happened to read
  LastTaskResult afterwards. Any unbounded external call in this script can therefore convert a
  transient upstream stall into an unalerted outage.

  Fix under test: bound the external call ourselves, well under the scheduler's PT30M, so a hang
  becomes a normal PowerShell terminating error the existing catch can alert on.

  Scenario 4 is the one that actually reflects the production call site: `npx wrangler ...` is a
  shim that spawns node as a CHILD. Killing only the process we started would leave the real worker
  orphaned -- still holding the upload, still running past the scheduler limit -- so the timeout
  must terminate the whole process TREE.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/native-command-timeout.smoke-test.ps1
  Exits 0 if all assertions pass, 1 otherwise.
#>
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\native-timeout.ps1')

$failures = @()
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { $script:failures += $Message; Write-Host "FAIL: $Message" }
  else { Write-Host "pass: $Message" }
}

$ps = (Get-Command powershell.exe).Source
$harness = Join-Path $env:TEMP "native-timeout-smoke-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $harness -Force | Out-Null

# Each scenario's child runs from a real .ps1 on disk rather than an inline -Command string. An
# inline multi-line command would force the test to hand-quote a script through two parsers
# (PowerShell then cmd.exe), which would end up exercising the harness's own quoting rather than the
# timeout behaviour under test -- and a quoting slip would surface as a confusing false failure.
function New-ChildScript {
  param([string]$Name, [string]$Body)
  $path = Join-Path $harness $Name
  $Body | Out-File -FilePath $path -Encoding ascii
  return $path
}

try {
  # Scenario 1: fast success well under the timeout -- must not throw, must not report TimedOut,
  # and must surface the real exit code.
  $s1 = New-ChildScript -Name 'ok.ps1' -Body 'exit 0'
  $r1 = Invoke-NativeCommandWithTimeout -Executable $ps `
        -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $s1) -TimeoutSeconds 30
  Assert-True ($r1.TimedOut -eq $false) "scenario 1 (fast success): TimedOut should be False, got $($r1.TimedOut)"
  Assert-True ($r1.ExitCode -eq 0)      "scenario 1 (fast success): expected ExitCode 0, got $($r1.ExitCode)"

  # Scenario 2: fast FAILURE under the timeout -- a nonzero exit is a normal result to report, not a
  # timeout. Distinguishing these matters because deploy-mirror.ps1 words its alert differently for
  # "wrangler returned an error" vs "wrangler stopped responding". It also proves the exit code
  # survives the cmd.exe hop this function routes through.
  $s2 = New-ChildScript -Name 'fail.ps1' -Body 'exit 7'
  $r2 = Invoke-NativeCommandWithTimeout -Executable $ps `
        -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $s2) -TimeoutSeconds 30
  Assert-True ($r2.TimedOut -eq $false) "scenario 2 (fast failure): TimedOut should be False, got $($r2.TimedOut)"
  Assert-True ($r2.ExitCode -eq 7)      "scenario 2 (fast failure): expected ExitCode 7, got $($r2.ExitCode)"

  # Scenario 3: a genuine hang -- this is the 2026-07-29 incident shape. Must report TimedOut and,
  # critically, must RETURN PROMPTLY at roughly the timeout rather than blocking for the child's full
  # runtime. A "timeout" that still waits out the hang would not have saved the 10:00 run.
  $s3 = New-ChildScript -Name 'hang.ps1' -Body 'Start-Sleep -Seconds 120'
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $r3 = Invoke-NativeCommandWithTimeout -Executable $ps `
        -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $s3) -TimeoutSeconds 5
  $sw.Stop()
  Assert-True ($r3.TimedOut -eq $true) "scenario 3 (hang): TimedOut should be True, got $($r3.TimedOut)"
  Assert-True ($sw.Elapsed.TotalSeconds -lt 45) "scenario 3 (hang): must return near the timeout, took $([int]$sw.Elapsed.TotalSeconds)s"

  # Scenario 4: PROCESS-TREE kill -- the production-shaped case. The child spawns a grandchild that
  # outlives it, exactly as `npx` spawns node. On timeout BOTH must be dead; killing only the process
  # we started would leave the real worker running past the scheduler's limit -- which is precisely
  # the orphan the PT30M kill would then have to clean up.
  $pidFile = Join-Path $harness 'grandchild-pid.txt'
  $s4 = New-ChildScript -Name 'spawn.ps1' -Body @"
`$c = Start-Process -FilePath '$ps' -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 300' -PassThru
`$c.Id | Out-File -FilePath '$pidFile' -Encoding ascii
Start-Sleep -Seconds 300
"@
  $r4 = Invoke-NativeCommandWithTimeout -Executable $ps `
        -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $s4) -TimeoutSeconds 8
  Assert-True ($r4.TimedOut -eq $true) "scenario 4 (tree kill): TimedOut should be True, got $($r4.TimedOut)"

  Assert-True (Test-Path $pidFile) "scenario 4 (tree kill): grandchild PID file should exist (harness sanity)"
  if (Test-Path $pidFile) {
    $grandchildPid = [int](Get-Content $pidFile -Raw).Trim()
    # Give the tree-kill a moment to be reflected in the process table before asserting.
    Start-Sleep -Seconds 2
    $stillAlive = @(Get-Process -Id $grandchildPid -ErrorAction SilentlyContinue)
    Assert-True ($stillAlive.Count -eq 0) "scenario 4 (tree kill): grandchild PID $grandchildPid must not survive the timeout (found $($stillAlive.Count) alive)"
    if ($stillAlive.Count -gt 0) { Stop-Process -Id $grandchildPid -Force -ErrorAction SilentlyContinue }
  }

  # Scenario 5 (2026-07-29 review follow-up): [System.Diagnostics.Process]::Start uses the process's
  # startup CurrentDirectory, which PowerShell's `Set-Location` does NOT keep in sync -- unlike an
  # inline native call (`& cmd.exe ...`), which PowerShell resolves against the caller's current
  # provider location automatically. The production call site passes deploy-mirror.ps1 the RELATIVE
  # path `dist`; if this function silently resolved it against the wrong directory, a deploy could
  # publish some other folder's dist -- for a run that bakes CONFIDENTIAL data, that is a real
  # wrong-artifact hazard, not just a cosmetic bug. Prove the child actually sees the caller's
  # location: write a marker file, cd into that directory, and have the child report whether it
  # exists via a RELATIVE path only -- it can only find it if its CWD matches.
  $cwdProbeDir = Join-Path $harness 'cwd-probe'
  New-Item -ItemType Directory -Path $cwdProbeDir -Force | Out-Null
  'marker' | Out-File -FilePath (Join-Path $cwdProbeDir 'marker.txt') -Encoding ascii
  $resultFile = Join-Path $harness 'cwd-result.txt'
  $s5 = New-ChildScript -Name 'cwd-check.ps1' -Body @"
`$found = if (Test-Path 'marker.txt') { 'FOUND' } else { 'NOT-FOUND' }
`$found | Out-File -FilePath '$resultFile' -Encoding ascii
"@
  Push-Location $cwdProbeDir
  try {
    $r5 = Invoke-NativeCommandWithTimeout -Executable $ps `
          -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $s5) -TimeoutSeconds 30
  } finally {
    Pop-Location
  }
  Assert-True ($r5.TimedOut -eq $false) "scenario 5 (working directory): TimedOut should be False, got $($r5.TimedOut)"
  Assert-True ($r5.ExitCode -eq 0) "scenario 5 (working directory): expected ExitCode 0, got $($r5.ExitCode)"
  $cwdResult = if (Test-Path $resultFile) { (Get-Content $resultFile -Raw).Trim() } else { 'RESULT-FILE-MISSING' }
  Assert-True ($cwdResult -eq 'FOUND') "scenario 5 (working directory): child must inherit the caller's Set-Location'd directory (relative-path lookup found: $cwdResult)"

  # Scenario 6 (2026-07-29 review follow-up): the entire justification for routing through cmd.exe
  # rather than starting $Executable directly is that Win32 CreateProcess cannot launch a .cmd/.bat
  # shim -- exactly what `npx` is. No prior scenario exercised a real shim, so a regression that broke
  # shim support (e.g. simplifying back to a direct Process.Start) would have gone uncaught. `npm` is
  # npm.cmd on Windows -- a real, always-available shim, no fabricated fixture needed.
  $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
  if (-not $npmCmd) { $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue) }
  if ($npmCmd) {
    $r6 = Invoke-NativeCommandWithTimeout -Executable $npmCmd.Source -Arguments @('--version') -TimeoutSeconds 30
    Assert-True ($r6.TimedOut -eq $false) "scenario 6 (.cmd shim): TimedOut should be False, got $($r6.TimedOut)"
    Assert-True ($r6.ExitCode -eq 0) "scenario 6 (.cmd shim): npm --version should exit 0, got $($r6.ExitCode)"
  } else {
    Assert-True $false "scenario 6 (.cmd shim): npm.cmd not found on PATH -- cannot verify shim support on this machine"
  }
}
finally {
  Remove-Item -Path $harness -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($failures.Count -gt 0) {
  Write-Host "$($failures.Count) assertion(s) FAILED."
  exit 1
} else {
  Write-Host "All assertions passed."
  exit 0
}

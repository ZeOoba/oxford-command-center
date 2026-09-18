<#
  Regression smoke test for scripts/mirror-run-classify.ps1's entrypoint contract.

  WHY THIS EXISTS (bug, 2026-08-04): the classifier resolved its -RepoRoot default inside the
  PARAM BLOCK:

      param([string]$RepoRoot = (Split-Path -Parent $PSScriptRoot))

  Param-block default expressions are evaluated BEFORE $PSScriptRoot is populated in the
  script scope when the script is launched with `powershell -File`. $PSScriptRoot is therefore
  the empty string at that moment, Split-Path rejects it, and the script died on line 26 with:

      Split-Path : Cannot bind argument to parameter 'Path' because it is an empty string.

  `-File` is exactly how the ora-command-center-mirror-drift-check SKILL.md step 4 invokes it,
  so the documented invocation was broken for every run that did not pass -RepoRoot explicitly.
  Under `-Command &` the same expression works, which is why the bug could be missed by hand.

  The trap is specific to the param block: every BODY-level $PSScriptRoot use in this repo
  (deploy-mirror.ps1:55, register-mirror-task.ps1:25, lib/deploy-beacon.ps1:51) is fine under
  -File. The fix moves resolution into the body, matching Get-DeployBeaconPath's idiom.

  This test shells out for real rather than dot-sourcing, because dot-sourcing would evaluate
  the param block in a context where $PSScriptRoot IS set and would therefore pass against the
  very bug it is meant to catch. Invocation mode IS the thing under test.

  This repo has no Pester/.Tests.ps1 convention for PowerShell (same as
  deploy-beacon.smoke-test.ps1), so this is a plain run-by-hand assertion script.

  BOUNDED WAIT (incident, 2026-09-18): the real classifier this test shells out to
  (mirror-run-classify.ps1) makes several live Get-WinEvent/Get-ScheduledTaskInfo calls against
  the real Task Scheduler and System event logs, with no bound of its own -- same defect class as
  the 2026-07-29 `npx wrangler` stall documented in lib/native-timeout.ps1 ("the real defect is
  not the stall; it is that the script had no bound of its own"). Invoke-Classifier previously ran
  the child under Start-Process -Wait with NO timeout, so a stalled log query hung this test
  indefinitely -- observed: 17.8+ minutes wall-clock, 1.9s CPU (idle wait on a blocking call, not a
  deadlock; the process was still responding). It was manually killed rather than diagnosed.
  Invoke-Classifier now waits under a caller-supplied bound and kills the whole process tree on
  overrun, the same tree-kill convention as Invoke-NativeCommandWithTimeout, so a hang here becomes
  a loud, bounded assertion failure instead of an unbounded hang. Scenario 0 below is the
  regression guard: it points Invoke-Classifier at a script that sleeps well past the timeout and
  asserts the call returns promptly with TimedOut = $true, before any of the real invocations run.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/mirror-run-classify.smoke-test.ps1
  Exits 0 if all assertions pass, 1 otherwise.
#>
$ErrorActionPreference = 'Stop'

$failures = @()
function Assert-Equal {
  param([string]$Expected, [string]$Actual, [string]$Message)
  if ($Expected -ne $Actual) {
    $script:failures += $Message
    Write-Host "FAIL: $Message (expected '$Expected', got '$Actual')"
  } else {
    Write-Host "pass: $Message"
  }
}
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { $script:failures += $Message; Write-Host "FAIL: $Message" }
  else { Write-Host "pass: $Message" }
}

$classifier = Join-Path $PSScriptRoot 'mirror-run-classify.ps1'
$expectedRepoRoot = Split-Path -Parent $PSScriptRoot

# Invoke the way the SKILL.md documents: -File, no -RepoRoot. Capture stdout and stderr
# separately so a param-binding failure is visible as itself rather than as unparseable JSON.
#
# Bounded wait (see BOUNDED WAIT note in the header comment): waits at most $TimeoutSeconds, then
# kills the whole process tree and returns TimedOut = $true instead of blocking forever.
#
# 240s, not a tighter figure: measured directly against this machine's real
# Microsoft-Windows-TaskScheduler/Operational log (2026-09-18), a single Get-WinEvent call the
# classifier makes -- with NOTHING wrong, no hang -- took 76.98s to return 3108 events over a
# 7-day window, even though the log file itself is small (wevtutil: 10MB cap, ~19.5k records).
# That is a legitimate-but-slow duration, not a hang, and a tighter bound would turn ordinary runs
# into false FAILs. This IS itself a live latent risk for the production caller
# (ora-command-center-mirror-drift-check invokes mirror-run-classify.ps1 directly, no bound of its
# own) -- flagged separately, out of scope for this test-hygiene fix. 240s stays far below the
# 17.8-minute hang this replaces while giving 3x headroom over the slowest normal run observed.
# Uses [System.Diagnostics.Process]::Start directly rather than Start-Process -PassThru: verified
# by hand (2026-09-18) that Start-Process -PassThru + -RedirectStandardOutput/-Error, WITHOUT
# -Wait, returns a process object whose ExitCode reads back as an empty string even after the
# child has genuinely exited and WaitForExit(ms) returned $true (Refresh() does not fix it
# either) -- a real PowerShell quirk, distinct from the hang this rewrite fixes, that a first
# version of this bound-wait change ran into (1c/2a false-failed with "expected '0', got ''"
# although the classifier itself exited 0). Raw Process + ProcessStartInfo does not have this
# problem and is the same primitive lib/native-timeout.ps1 already uses. Streams are read via
# ReadToEndAsync BEFORE WaitForExit, matching the standard .NET redirect pattern -- reading
# synchronously after WaitForExit can deadlock once either pipe's OS buffer fills.
function Invoke-Classifier {
  param([string[]]$ExtraArgs = @(), [string]$ScriptPath = $classifier, [int]$TimeoutSeconds = 240)
  $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $ExtraArgs
  $quote  = { param($s) '"' + ($s -replace '"', '""') + '"' }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName               = 'powershell.exe'
  $psi.Arguments              = ($psArgs | ForEach-Object { & $quote $_ }) -join ' '
  $psi.UseShellExecute        = $false
  $psi.CreateNoWindow         = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true

  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
  $stderrTask = $proc.StandardError.ReadToEndAsync()
  $timedOut = -not $proc.WaitForExit($TimeoutSeconds * 1000)
  if ($timedOut) {
    # Overran the bound -- reap the whole tree (same convention as
    # lib/native-timeout.ps1's Invoke-NativeCommandWithTimeout: a plain Stop-Process would leave
    # any grandchild powershell.exe the child spawned still running past this test).
    & cmd.exe '/s', '/c', "taskkill /T /F /PID $($proc.Id) >nul 2>&1" | Out-Null
    [void]$proc.WaitForExit(10000)
  }
  [pscustomobject]@{
    ExitCode = if ($timedOut) { $null } else { $proc.ExitCode }
    Stdout   = if ($stdoutTask.IsCompleted) { $stdoutTask.Result } else { '' }
    Stderr   = if ($stderrTask.IsCompleted) { $stderrTask.Result } else { '' }
    TimedOut = $timedOut
  }
}

# ---------------------------------------------------------------------------
# 0 -- the bound itself: a genuine hang must return promptly, not block forever
# ---------------------------------------------------------------------------
$hangHarness = Join-Path ([System.IO.Path]::GetTempPath()) "mirror-run-classify-hang-$([guid]::NewGuid()).ps1"
'Start-Sleep -Seconds 120' | Out-File -FilePath $hangHarness -Encoding ascii
try {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $hangRun = Invoke-Classifier -ScriptPath $hangHarness -TimeoutSeconds 3
  $sw.Stop()
  Assert-True ($hangRun.TimedOut -eq $true) `
    '0a: a hung classifier is reported as TimedOut rather than blocked on forever'
  Assert-True ($sw.Elapsed.TotalSeconds -lt 30) `
    "0b: a hung classifier returns near its bound, not after the child's full runtime (took $([int]$sw.Elapsed.TotalSeconds)s)"
} finally {
  Remove-Item $hangHarness -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 1 -- the regression: -File with no -RepoRoot must resolve, not die
# ---------------------------------------------------------------------------
$run = Invoke-Classifier
Assert-True ($run.TimedOut -eq $false) '1z: -File with no -RepoRoot completes within the bound (does not hang)'

Assert-True ($run.Stderr -notmatch 'Cannot bind argument to parameter') `
  '1a: -File with no -RepoRoot does not fail param binding (the 2026-08-04 regression)'
Assert-True ($run.Stderr -notmatch 'Split-Path') `
  '1b: -File with no -RepoRoot does not throw from Split-Path'
Assert-Equal '0' ([string]$run.ExitCode) `
  '1c: -File with no -RepoRoot exits 0'

$parsed = $null
try { $parsed = $run.Stdout | ConvertFrom-Json } catch { $parsed = $null }
Assert-True ($null -ne $parsed) '1d: -File with no -RepoRoot emits parseable JSON'

if ($null -ne $parsed) {
  Assert-True ([bool]$parsed.repoRoot) '1e: repoRoot is populated, not empty'
  # Resolve both sides: the default path and an explicitly-passed one can differ only by
  # separator/casing, and this assertion is about pointing at the same directory.
  $actualResolved = if ($parsed.repoRoot) { (Resolve-Path $parsed.repoRoot).Path } else { '' }
  Assert-Equal (Resolve-Path $expectedRepoRoot).Path $actualResolved `
    '1f: defaulted repoRoot resolves to the repo root (parent of scripts/)'
}

# ---------------------------------------------------------------------------
# 2 -- the explicit-argument path must keep working (it was the manual workaround)
# ---------------------------------------------------------------------------
$runExplicit = Invoke-Classifier -ExtraArgs @('-RepoRoot', $expectedRepoRoot)
Assert-True ($runExplicit.TimedOut -eq $false) '2z: explicit -RepoRoot completes within the bound (does not hang)'
Assert-Equal '0' ([string]$runExplicit.ExitCode) '2a: explicit -RepoRoot still exits 0'

$parsedExplicit = $null
try { $parsedExplicit = $runExplicit.Stdout | ConvertFrom-Json } catch { $parsedExplicit = $null }
Assert-True ($null -ne $parsedExplicit) '2b: explicit -RepoRoot emits parseable JSON'

if ($null -ne $parsedExplicit -and $null -ne $parsed) {
  # The whole point of the fix: both invocations must describe the same repo.
  Assert-Equal (Resolve-Path $expectedRepoRoot).Path (Resolve-Path $parsedExplicit.repoRoot).Path `
    '2c: explicit -RepoRoot resolves to the same repo root as the default'
  Assert-Equal ([string]$parsed.gitAhead) ([string]$parsedExplicit.gitAhead) `
    '2d: defaulted and explicit invocations agree on gitAhead'
}

# ---------------------------------------------------------------------------
Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host "FAILED: $($failures.Count) assertion(s)"
  $failures | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
Write-Host 'All mirror-run-classify entrypoint assertions passed.'
exit 0

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
function Invoke-Classifier {
  param([string[]]$ExtraArgs = @())
  $stdoutFile = [System.IO.Path]::GetTempFileName()
  $stderrFile = [System.IO.Path]::GetTempFileName()
  try {
    $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $classifier) + $ExtraArgs
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $psArgs `
                       -NoNewWindow -Wait -PassThru `
                       -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
    # Coerce to [string] deliberately: Get-Content -Raw on an EMPTY file returns $null, and
    # `$null -notmatch 'x'` evaluates to an empty Object[] (PowerShell applies collection
    # filtering semantics to $null), not $true -- which blows up Assert-True's [bool] cast in
    # exactly the clean-stderr case this test is supposed to pass on. '' -notmatch 'x' is $true.
    [pscustomobject]@{
      ExitCode = $p.ExitCode
      Stdout   = [string](Get-Content -Raw -Path $stdoutFile -ErrorAction SilentlyContinue)
      Stderr   = [string](Get-Content -Raw -Path $stderrFile -ErrorAction SilentlyContinue)
    }
  } finally {
    Remove-Item $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------------------
# 1 -- the regression: -File with no -RepoRoot must resolve, not die
# ---------------------------------------------------------------------------
$run = Invoke-Classifier

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

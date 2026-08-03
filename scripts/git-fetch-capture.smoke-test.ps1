<#
  Manual regression smoke test for scripts/lib/git-capture.ps1's Invoke-GitFetchCapture.
  Companion to deploy-mirror.smoke-test.ps1 (same "no Pester convention here, run-by-hand
  assertion script" pattern). Builds a real throwaway bare git repo + two working clones in
  $env:TEMP so the fetch scenarios exercised are genuine git behavior, not a mock -- this is the
  exact class of bug (2026-07-26) that a mocked git call would never have caught: the defect
  only appears when a REAL fetch has REAL new ref-update content to report on stderr.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/git-fetch-capture.smoke-test.ps1
  Exits 0 if all assertions pass, 1 otherwise.
#>
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\git-capture.ps1')

$failures = @()
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { $script:failures += $Message; Write-Host "FAIL: $Message" }
  else { Write-Host "pass: $Message" }
}

$harness = Join-Path $env:TEMP "git-fetch-capture-smoke-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $harness -Force | Out-Null
$originPath = Join-Path $harness 'origin.git'
$seedPath   = Join-Path $harness 'seed'
$workPath   = Join-Path $harness 'work'

# Setup steps delegate to the SAME Invoke-NativeCommandCapture the function under test uses
# (not a hand-rolled copy of its quoting/cmd-wrapping logic) -- a prior draft duplicated that
# logic here and it would have silently drifted out of sync with the production version it's
# meant to validate. git clone/push routinely write to stderr on success too, so this same
# wrapping is needed for setup, not just for the scenarios under test.
function Invoke-SetupGit {
  param([Parameter(Mandatory=$true)][string[]]$GitArgs)
  Invoke-NativeCommandCapture -Executable 'git' -Arguments $GitArgs | Out-Null
}

# Uniform wrapper so all three fetch scenarios get the same try/catch shape: an unexpected throw
# reports as a clean `FAIL:` assertion instead of terminating the whole script (which scenario 2
# alone had before -- an inconsistency with no functional reason, since any of the three could in
# principle throw if a regression were reintroduced).
function Invoke-ScenarioNoThrow {
  param([Parameter(Mandatory=$true)][string]$Name, [Parameter(Mandatory=$true)][scriptblock]$Body)
  try {
    $result = & $Body
    Assert-True $true "$Name`: must not throw"
    return $result
  } catch {
    Assert-True $false "$Name`: must not throw (threw: $($_.Exception.Message))"
    return $null
  }
}

try {
  # 2026-07-31: stopped manually quote-wrapping these paths -- cmd-arg-guard.ps1 now rejects any
  # embedded double-quote outright (a wrap was found to silently SPLIT a space-containing value
  # once the callee's own whitespace-quoter wrapped it a second time). The whitespace-quoter in
  # Invoke-NativeCommandCapture already handles a space-containing path correctly on its own.
  Invoke-SetupGit -GitArgs @('init', '--quiet', '--bare', $originPath)
  Invoke-SetupGit -GitArgs @('clone', '--quiet', $originPath, $seedPath)

  Push-Location $seedPath
  Invoke-SetupGit -GitArgs @('checkout', '-q', '-b', 'main')
  'hello' | Out-File -FilePath 'file.txt' -Encoding UTF8
  Invoke-SetupGit -GitArgs @('add', 'file.txt')
  Invoke-SetupGit -GitArgs @('-c', 'user.email=test@test.com', '-c', 'user.name=test', 'commit', '-q', '-m', 'initial')
  Invoke-SetupGit -GitArgs @('push', '-q', 'origin', 'main')
  Pop-Location

  Invoke-SetupGit -GitArgs @('clone', '--quiet', $originPath, $workPath)

  # Scenario 1: no new content to fetch (already up to date) -- must not throw, exit 0.
  Push-Location $workPath
  $result = Invoke-ScenarioNoThrow -Name 'scenario 1 (up to date)' -Body { Invoke-GitFetchCapture -GitArgs @('fetch', 'origin') }
  if ($result) { Assert-True ($result.ExitCode -eq 0) "scenario 1 (up to date): expected ExitCode 0, got $($result.ExitCode)" }
  Pop-Location

  # Scenario 2: a REAL new commit to fetch -- this is the exact case that broke before the fix
  # (git's routine "From <url>" progress header on a successful fetch used to throw under
  # $ErrorActionPreference = 'Stop'). Must not throw, exit 0, and Output must contain the real
  # ref-update line, not a truncated single header line.
  Push-Location $seedPath
  'world' | Out-File -FilePath 'file.txt' -Append -Encoding UTF8
  Invoke-SetupGit -GitArgs @('add', 'file.txt')
  Invoke-SetupGit -GitArgs @('-c', 'user.email=test@test.com', '-c', 'user.name=test', 'commit', '-q', '-m', 'second commit')
  Invoke-SetupGit -GitArgs @('push', '-q', 'origin', 'main')
  Pop-Location

  Push-Location $workPath
  $result = Invoke-ScenarioNoThrow -Name 'scenario 2 (real new content)' -Body { Invoke-GitFetchCapture -GitArgs @('fetch', 'origin') }
  if ($result) {
    Assert-True ($result.ExitCode -eq 0) "scenario 2: expected ExitCode 0, got $($result.ExitCode)"
    Assert-True ($result.Output -match 'main\s*->\s*origin/main') "scenario 2: Output should contain the real ref-update line, got: $($result.Output)"
  }
  Pop-Location

  # Scenario 3: a genuine failure (bad remote) -- must return a nonzero ExitCode with clean,
  # undecorated git error text in Output (no PowerShell ErrorRecord wrapper: no "CategoryInfo",
  # no "FullyQualifiedErrorId", no "At line:N char:M"). Wrapping in Invoke-ScenarioNoThrow too --
  # a bad remote must be reported via ExitCode/Output, never by throwing.
  Push-Location $workPath
  $result = Invoke-ScenarioNoThrow -Name 'scenario 3 (bad remote)' -Body { Invoke-GitFetchCapture -GitArgs @('fetch', 'nonexistent-remote') }
  if ($result) {
    Assert-True ($result.ExitCode -ne 0) "scenario 3 (bad remote): expected nonzero ExitCode, got $($result.ExitCode)"
    Assert-True ($result.Output -match "does not appear to be a git repository") "scenario 3: Output should contain git's real error text, got: $($result.Output)"
    Assert-True (-not ($result.Output -match 'CategoryInfo|FullyQualifiedErrorId')) "scenario 3: Output must not contain PowerShell ErrorRecord decoration"
  }
  Pop-Location
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

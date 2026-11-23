<#
  Smoke test for scripts/lib/mirror-manual-deploy.ps1 (cross-repo audit 2026-11-23, HIGH: the manual
  `npm run deploy:mirror` uploaded with no Access-gate check). Dot-sources the REAL libraries, then
  mocks the network-facing calls (pre-deploy probe, wrangler deploy, post-deploy gate check, lockdown)
  by redefining them. Run by tests/unit/mirror-manual-deploy.test.ts. Prints ALL PASS and exits 0.
  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-mirror-manual.smoke-test.ps1
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\cmd-arg-guard.ps1')
. (Join-Path $PSScriptRoot 'lib\git-capture.ps1')
. (Join-Path $PSScriptRoot 'lib\native-timeout.ps1')
. (Join-Path $PSScriptRoot 'lib\access-gate-probe.ps1')
. (Join-Path $PSScriptRoot 'lib\mirror-deploy.ps1')
. (Join-Path $PSScriptRoot 'lib\mirror-manual-deploy.ps1')

$failures = @()
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { $script:failures += $Message; Write-Host "FAIL: $Message" } else { Write-Host "pass: $Message" }
}
function Get-ThrownMessage { param([scriptblock]$Block) try { & $Block; return '' } catch { return $_.Exception.Message } }

# --- mocks: record the call order; behaviour switched per scenario ---
$script:log = @()
$script:preFails = $false; $script:deployExit = 0; $script:deployTimedOut = $false; $script:postFails = ''
function Assert-MirrorPreDeployAccessGate {
  param($VerifyUrl, $ProjectName, $AccessHost, $FunctionsDirs, $StagedDir, [switch]$IncludeWarehouse, $BudgetSeconds)
  $script:log += 'pre'
  if ($script:preFails) { throw 'GATE CHECK INCONCLUSIVE (PRE-DEPLOY probe): mocked' }
}
function Invoke-MirrorWranglerDeploy {
  param($WranglerRoot, $WorkingDirectory, $DistPath, $ProjectName, $TimeoutSeconds, $OutputFile)
  $script:log += 'deploy'
  $out = if ($script:noAlias) { 'Deployment complete!' } else { 'Deployment complete! https://abc123.ora-command-center.pages.dev' }
  if ($OutputFile) { Set-Content -LiteralPath $OutputFile -Value $out }
  return [pscustomobject]@{ ExitCode = $script:deployExit; TimedOut = $script:deployTimedOut }
}
function Assert-AccessGateOnAllTargets {
  param($Targets, $AccessHost, $Unprobed, $StrictPaths, $SettleSeconds, $BudgetSeconds, $Context)
  $script:log += 'post'
  $script:lastUnprobed = @($Unprobed | Where-Object { $_ })
  if ($script:postFails) {
    $script:LastAccessGateExposures = @([pscustomobject]@{ Code = 200; Strict = $false })
    throw "GATE CHECK FAILED: $script:postFails"
  }
  $script:LastAccessGateExposures = @()
  return @(1, 2, 3)
}
function Invoke-MirrorLockdownContainment {
  param($WranglerRoot, $ProjectName, $TimeoutSeconds)
  $script:log += 'lockdown'
  return [pscustomobject]@{ Deployed = $true; Detail = 'lockdown page deployed (mock)' }
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('mirror-manual-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $tmp 'functions\api') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tmp 'public') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $tmp 'functions\api\ai.ts') -Value 'export const onRequestPost = () => null;'
$build = { $script:log += 'build'; New-Item -ItemType Directory -Path (Join-Path $tmp 'dist') -Force | Out-Null; Set-Content -LiteralPath (Join-Path $tmp 'dist\index.html') -Value '<html></html>' }
function Reset-Scenario {
  $script:log = @(); $script:preFails = $false; $script:deployExit = 0; $script:deployTimedOut = $false; $script:postFails = ''
  $script:noAlias = $false; $script:lastUnprobed = @()
  Remove-Item -LiteralPath (Join-Path $tmp 'dist') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Get-MirrorGateLatchPath -RepoRoot $tmp) -Force -ErrorAction SilentlyContinue
}

try {
  # 0) The WRAPPER's own dot-sources (and nothing else) define every command the real probe chain calls.
  #    Review 2026-11-23: the wrapper omitted lib\git-capture.ps1, so the real pre-probe died on
  #    Invoke-NativeCommandCapture while this mocked test stayed green. Run in a CHILD process so the
  #    libraries this test itself loaded cannot mask a missing one.
  $wrapper = Join-Path $PSScriptRoot 'deploy-mirror-manual.ps1'
  $dotLines = @(Get-Content -LiteralPath $wrapper | Where-Object { $_ -match '^\s*\.\s+\(Join-Path \$PSScriptRoot ' }) -replace '#.*$', ''
  $needed = 'Invoke-NativeCommandCapture', 'Invoke-NativeCommandWithTimeout', 'Invoke-AccessGateProbe', 'Assert-AccessGateOnAllTargets',
            'Get-AccessGateProbeTargets', 'Get-MissingAliasRequirement', 'Assert-MirrorPreDeployAccessGate', 'Invoke-MirrorWranglerDeploy',
            'Invoke-MirrorLockdownContainment', 'Set-MirrorGateLatch', 'Test-MirrorExposureWarrantsContainment', 'Get-MirrorCanonicalRoot', 'Invoke-MirrorManualDeploy'
  $childFile = Join-Path ([System.IO.Path]::GetTempPath()) ('mirror-manual-load-' + [guid]::NewGuid().ToString('N') + '.ps1')
  $rootLiteral = "'" + ($PSScriptRoot -replace "'", "''") + "'"
  $childBody = @('$ErrorActionPreference = ''Stop''')
  $childBody += @($dotLines | ForEach-Object { $_ -replace '\$PSScriptRoot', $rootLiteral })
  $childBody += '$missing = @(' + (($needed | ForEach-Object { "'$_'" }) -join ',') + ') | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }'
  $childBody += 'if ($missing) { Write-Output ("MISSING: " + ($missing -join ",")); exit 1 } else { Write-Output "ALL RESOLVED"; exit 0 }'
  Set-Content -LiteralPath $childFile -Value $childBody -Encoding ASCII
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $childOut = & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $childFile 2>&1; $childExit = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prevEap; Remove-Item -LiteralPath $childFile -Force -ErrorAction SilentlyContinue }
  Assert-True ($dotLines.Count -ge 5) "0: found the wrapper's dot-source lines ($($dotLines.Count))"
  Assert-True (($childExit -eq 0) -and ("$childOut" -match 'ALL RESOLVED')) "0: the wrapper's libraries define every probe-chain command (got: $childOut)"

  # 1) Happy path: pre-probe -> build -> deploy -> post-check, in that order.
  Reset-Scenario
  $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $tmp -Build $build }
  Assert-True ($msg -eq '') "1: happy path does not throw (got '$msg')"
  Assert-True (($script:log -join ',') -eq 'pre,build,deploy,post') "1: order is pre,build,deploy,post (got $($script:log -join ','))"

  # 2) Pre-deploy probe fails: nothing is built or uploaded.
  Reset-Scenario; $script:preFails = $true
  $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $tmp -Build $build }
  Assert-True ($msg -match 'PRE-DEPLOY') '2: a failed pre-deploy probe throws'
  Assert-True (($script:log -join ',') -eq 'pre') "2: no build and no deploy after a failed pre-probe (got $($script:log -join ','))"

  # 3) An open gate latch refuses before even probing.
  Reset-Scenario; Set-MirrorGateLatch -Path (Get-MirrorGateLatchPath -RepoRoot $tmp) -Reason 'prior exposure'
  $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $tmp -Build $build }
  Assert-True ($msg -match 'GATE LATCH OPEN') '3: an open latch refuses'
  Assert-True ($script:log.Count -eq 0) '3: nothing runs while the latch is open'

  # 4) FULL-mode variables set: refuses outright (redacted only).
  Reset-Scenario; $env:MIRROR_INCLUDE_CONFIDENTIAL = '1'
  try { $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $tmp -Build $build } } finally { Remove-Item Env:\MIRROR_INCLUDE_CONFIDENTIAL -ErrorAction SilentlyContinue }
  Assert-True ($msg -match 'REDACTED bake only') '4: MIRROR_INCLUDE_CONFIDENTIAL refuses'
  Assert-True ($script:log.Count -eq 0) '4: nothing runs in FULL mode'

  # 5) Post-deploy exposure: latch opens, lockdown deployed, throws GATE CHECK FAILED.
  Reset-Scenario; $script:postFails = 'apex served 200'
  $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $tmp -Build $build }
  Assert-True ($msg -match '^GATE CHECK FAILED' -and $msg -match 'CONTAINMENT') '5: post-deploy exposure throws with containment detail'
  Assert-True (($script:log -join ',') -eq 'pre,build,deploy,post,lockdown') "5: lockdown ran after the failed check (got $($script:log -join ','))"
  Assert-True (Test-Path -LiteralPath (Get-MirrorGateLatchPath -RepoRoot $tmp)) '5: the gate latch is open'

  # 6) Deploy timeout: still probes, then throws the timeout.
  Reset-Scenario; $script:deployTimedOut = $true
  $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $tmp -Build $build -DeployTimeoutSeconds 5 }
  Assert-True ($msg -match 'timed out') '6: a deploy timeout throws'
  Assert-True (($script:log -join ',') -eq 'pre,build,deploy,post') "6: the gate is probed on the timeout path (got $($script:log -join ','))"

  # 7) Deploy fails: throws, no post-check.
  Reset-Scenario; $script:deployExit = 1
  $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $tmp -Build $build }
  Assert-True ($msg -match 'wrangler deploy failed') '7: a failed wrangler deploy throws'

  # 8) Build produces no dist/index.html: refuses to deploy.
  Reset-Scenario
  $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $tmp -Build { $script:log += 'build' } }
  Assert-True ($msg -match 'no dist/index.html') '8: a missing artifact refuses'
  Assert-True (-not ($script:log -contains 'deploy')) '8: nothing is uploaded without an artifact'

  # 9) Timeout AND an observed exposure: the exposure wins -> latch + lockdown, not a plain timeout.
  Reset-Scenario; $script:deployTimedOut = $true; $script:postFails = 'alias served 200 during a stall'
  $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $tmp -Build $build -DeployTimeoutSeconds 5 }
  Assert-True ($msg -match '^GATE CHECK FAILED' -and $msg -match 'CONTAINMENT') "9: exposure during a timeout is contained (got '$msg')"
  Assert-True ($script:log -contains 'lockdown') '9: lockdown ran on the timeout path'
  Assert-True (Test-Path -LiteralPath (Get-MirrorGateLatchPath -RepoRoot $tmp)) '9: the gate latch is open'

  # 10) wrangler printed no per-deployment alias: the post-check is told it is UNPROBED (-> INCONCLUSIVE).
  Reset-Scenario; $script:noAlias = $true
  Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $tmp -Build $build } | Out-Null
  Assert-True ($script:lastUnprobed.Count -gt 0) '10: a missing alias is passed to the gate check as -Unprobed'

  # 11) MIRROR_ACCESS_PREPROBE alone also refuses (redacted only).
  Reset-Scenario; $env:MIRROR_ACCESS_PREPROBE = 'passed'
  try { $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $tmp -Build $build } } finally { Remove-Item Env:\MIRROR_ACCESS_PREPROBE -ErrorAction SilentlyContinue }
  Assert-True ($msg -match 'REDACTED bake only') '11: MIRROR_ACCESS_PREPROBE refuses'
  Assert-True ($script:log.Count -eq 0) '11: nothing runs'

  # 12) The latch lives in the LATCH root (the canonical checkout), not the build root: a latch opened
  #     by the scheduled task blocks a manual run from a worktree, and an exposure seen by a manual run
  #     from a worktree opens the latch the scheduled task reads (refute wf_8c04876e-bc9).
  $canon = Join-Path $tmp 'canonical'
  New-Item -ItemType Directory -Path $canon -Force | Out-Null
  Reset-Scenario; Set-MirrorGateLatch -Path (Get-MirrorGateLatchPath -RepoRoot $canon) -Reason 'opened by the scheduled task'
  $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $canon -Build $build }
  Assert-True ($msg -match 'GATE LATCH OPEN' -and $script:log.Count -eq 0) '12: a canonical latch blocks a manual run from another root'
  Remove-Item -LiteralPath (Get-MirrorGateLatchPath -RepoRoot $canon) -Force
  Reset-Scenario; $script:postFails = 'apex served 200'
  Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $canon -Build $build } | Out-Null
  Assert-True (Test-Path -LiteralPath (Get-MirrorGateLatchPath -RepoRoot $canon)) '12: an exposure opens the CANONICAL latch'
  Assert-True (-not (Test-Path -LiteralPath (Get-MirrorGateLatchPath -RepoRoot $tmp))) '12: and not a latch in the build root'

  # 13) Get-MirrorCanonicalRoot: a linked worktree resolves to its MAIN checkout; a non-repo throws.
  $mainRepo = Join-Path $tmp 'main-repo'
  $linked = Join-Path $tmp 'linked-wt'
  New-Item -ItemType Directory -Path $mainRepo -Force | Out-Null
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    & git -C $mainRepo init -q 2>&1 | Out-Null
    & git -C $mainRepo -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m seed 2>&1 | Out-Null
    & git -C $mainRepo worktree add -q --detach $linked 2>&1 | Out-Null
  } finally { $ErrorActionPreference = $prevEap }
  $resolved = Get-MirrorCanonicalRoot -RepoRoot $linked
  Assert-True ([System.IO.Path]::GetFullPath($resolved).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($mainRepo).TrimEnd('\')) "13: a worktree resolves to the main checkout (got '$resolved')"
  $resolvedMain = Get-MirrorCanonicalRoot -RepoRoot $mainRepo
  Assert-True ([System.IO.Path]::GetFullPath($resolvedMain).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($mainRepo).TrimEnd('\')) '13: the main checkout resolves to itself'
  $notRepo = Join-Path $tmp 'not-a-repo'
  New-Item -ItemType Directory -Path $notRepo -Force | Out-Null
  $prevCeil = $env:GIT_CEILING_DIRECTORIES; $env:GIT_CEILING_DIRECTORIES = $tmp
  try { $msg = Get-ThrownMessage { Get-MirrorCanonicalRoot -RepoRoot $notRepo } } finally { $env:GIT_CEILING_DIRECTORIES = $prevCeil }
  Assert-True ($msg -match 'cannot resolve the canonical checkout') '13: a non-repo throws (fail closed)'
  Reset-Scenario
  $env:GIT_CEILING_DIRECTORIES = $tmp
  try { $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $notRepo -Build $build } } finally { $env:GIT_CEILING_DIRECTORIES = $prevCeil }
  Assert-True (($msg -match 'cannot resolve the canonical checkout') -and $script:log.Count -eq 0) '13: with no -LatchRoot, an unresolvable canonical root refuses before anything runs'

  # 14) '0' means REDACTED (same as the TypeScript precheck): the run proceeds.
  Reset-Scenario; $env:MIRROR_INCLUDE_CONFIDENTIAL = '0'; $env:MIRROR_ACCESS_PREPROBE = '0'
  try { $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $tmp -Build $build } }
  finally { Remove-Item Env:\MIRROR_INCLUDE_CONFIDENTIAL, Env:\MIRROR_ACCESS_PREPROBE -ErrorAction SilentlyContinue }
  Assert-True ($msg -eq '' -and ($script:log -join ',') -eq 'pre,build,deploy,post') "14: '0' values are REDACTED and do not refuse (got '$msg')"

  # 15) The latch opened DURING the build (by the hourly task) stops the upload.
  Reset-Scenario
  # $script:baseBuild, not $build: inside Invoke-MirrorManualDeploy, $build resolves to its own -Build
  # parameter (PowerShell names are case-insensitive), i.e. this block, and recurses.
  $script:baseBuild = $build
  $buildThenLatch = { & $script:baseBuild; Set-MirrorGateLatch -Path (Get-MirrorGateLatchPath -RepoRoot $tmp) -Reason 'opened mid-run by the scheduled task' }
  $msg = Get-ThrownMessage { Invoke-MirrorManualDeploy -RepoRoot $tmp -LatchRoot $tmp -Build $buildThenLatch }
  Assert-True ($msg -match 'GATE LATCH OPEN') "15: a latch opened mid-run refuses before upload (got '$msg')"
  Assert-True (-not ($script:log -contains 'deploy')) '15: nothing is uploaded'
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count -eq 0) { Write-Host 'ALL PASS'; exit 0 }
Write-Host "$($failures.Count) FAILURE(S)"; exit 1

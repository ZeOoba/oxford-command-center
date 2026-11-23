<#
  Invoke-MirrorManualDeploy -- the body of `npm run deploy:mirror` (scripts/deploy-mirror-manual.ps1).

  WHY (cross-repo audit 2026-11-23, oxford-command-center HIGH #2): the manual path deployed the
  REDACTED bake straight to the production Pages branch with no Access-gate check. The redacted
  bundle still carries the local-only ratified RCT (src/brain/replacement-cost.ts imports
  config/replacement-cost.v3.json), so a manual deploy while the Access policy was broken would
  publish it. Gabriel approved routing the manual path through the same probes (2026-11-23).

  WHAT IT ADDS, and nothing more (the manual path stays a quick deploy of the checked-out tree:
  no git fast-forward, no confidential bake, no alert mail -- a human is watching):
    0. refuses while MIRROR_INCLUDE_CONFIDENTIAL / MIRROR_ACCESS_PREPROBE is set (redacted only);
    1. refuses while the deploy script's gate latch is open (an unresolved exposure);
    2. PRE-deploy Access probe of the live production target (Assert-MirrorPreDeployAccessGate);
    3. build (the injected -Build step: `npm run build:mirror`, which roster-scans dist/);
    4. a BOUNDED wrangler deploy (Invoke-MirrorWranglerDeploy) -- the timeout path still probes;
    5. POST-deploy Access check of every target, per-deployment alias included;
    6. on an observed exposure: opens the latch and replaces production with the lockdown page,
       exactly as deploy-mirror.ps1 does, then throws.

  Requires lib/native-timeout.ps1, lib/access-gate-probe.ps1 and lib/mirror-deploy.ps1 dot-sourced
  first. Throws on any failure; the caller maps that to a non-zero exit.
#>

function Get-MirrorCanonicalRoot {
  <#
    The MAIN checkout of the repo that -RepoRoot belongs to (the parent of git's common dir, which
    every linked worktree shares). The gate latch lives in that checkout's gitignored data/, because
    the hourly scheduled deploy-mirror.ps1 runs there; a manual run from a worktree must read and
    write THAT latch, not its own (refute wf_8c04876e-bc9, two lenses). Throws if git cannot say.
    LIMIT: a separate CLONE (not a linked worktree) has its own common dir and so its own latch; the
    scheduled task runs only from the canonical clone, so run manual deploys from it or its worktrees.
  #>
  param([Parameter(Mandatory=$true)][string]$RepoRoot)
  # PS 5.1 under $ErrorActionPreference='Stop' turns git's stderr into a NativeCommandError; scope it
  # to Continue so a failure reaches the explicit refusal below.
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $out = & git -C $RepoRoot rev-parse --path-format=absolute --git-common-dir 2>$null
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prevEap }
  if ($code -ne 0 -or -not "$out".Trim()) {
    throw "cannot resolve the canonical checkout of $RepoRoot (git rev-parse --git-common-dir failed) -- refusing to deploy without the shared gate latch."
  }
  return (Split-Path -Parent ([System.IO.Path]::GetFullPath("$out".Trim())))
}

function Invoke-MirrorManualDeploy {
  param(
    [Parameter(Mandatory=$true)][string]$RepoRoot,
    [Parameter(Mandatory=$true)][scriptblock]$Build,
    # Root whose data\alert-state holds the gate latch. Defaults to the canonical checkout (see
    # Get-MirrorCanonicalRoot); tests pass a temp root.
    [string]$LatchRoot = '',
    [string]$ProjectName = 'ora-command-center',
    [string]$VerifyUrl = 'https://ora-command-center.pages.dev/',
    [string]$AccessHost = 'cloudflareaccess.com',
    [int]$DeployTimeoutSeconds = 600
  )
  # '0' means REDACTED, matching scan-mirror-dist.ts precheckRedactedOnly and mirror-mode.ts (refute wf_6bae3d4e-aec).
  $fullMode = @($env:MIRROR_INCLUDE_CONFIDENTIAL, $env:MIRROR_ACCESS_PREPROBE) | Where-Object { $_ -and $_ -ne '0' }
  if ($fullMode) {
    throw 'deploy:mirror ships the REDACTED bake only: unset MIRROR_INCLUDE_CONFIDENTIAL and MIRROR_ACCESS_PREPROBE (the FULL bake goes through scripts/deploy-mirror.ps1).'
  }
  if (-not $LatchRoot) { $LatchRoot = Get-MirrorCanonicalRoot -RepoRoot $RepoRoot }
  $latch = Get-MirrorGateLatchPath -RepoRoot $LatchRoot
  Assert-MirrorGateLatchClear -Path $latch

  $functionsDirs = @(Join-Path $RepoRoot 'functions')
  $distPath = Join-Path $RepoRoot 'dist'
  try {
    Write-Host '[deploy:mirror] pre-deploy Access probe of the live production target'
    Assert-MirrorPreDeployAccessGate -VerifyUrl $VerifyUrl -ProjectName $ProjectName -AccessHost $AccessHost -FunctionsDirs $functionsDirs -StagedDir (Join-Path $RepoRoot 'public') | Out-Null

    Write-Host '[deploy:mirror] build (redacted)'
    & $Build
    if (-not (Test-Path -LiteralPath (Join-Path $distPath 'index.html'))) {
      throw "build produced no dist/index.html at $distPath -- refusing to deploy."
    }

    $probePaths = Get-AccessGateProbePaths -DistPath $distPath -FunctionsDirs $functionsDirs
    $routes     = Get-AccessGateFunctionRoutes -FunctionsDirs $functionsDirs
    $deployLog  = Join-Path ([System.IO.Path]::GetTempPath()) ('ora-mirror-manual-' + [guid]::NewGuid().ToString('N') + '.log')
    # Re-check the shared latch right before upload: the hourly task may have opened it (and deployed the
    # lockdown page) while this run was probing and building (refute wf_ecebe6df-109). This narrows the
    # race to the seconds between this check and wrangler; there is no run lock shared with deploy-mirror.ps1.
    Assert-MirrorGateLatchClear -Path $latch
    Write-Host '[deploy:mirror] wrangler pages deploy (bounded)'
    $deploy = Invoke-MirrorWranglerDeploy -WranglerRoot $RepoRoot -WorkingDirectory $RepoRoot -DistPath $distPath -ProjectName $ProjectName -TimeoutSeconds $DeployTimeoutSeconds -OutputFile $deployLog
    $deployOutput = ''
    if (Test-Path -LiteralPath $deployLog) {
      $deployOutput = [string](Get-Content -LiteralPath $deployLog -Raw -ErrorAction SilentlyContinue)
      Remove-Item -LiteralPath $deployLog -Force -ErrorAction SilentlyContinue
    }
    if ($deployOutput) { Write-Host $deployOutput }
    if ($deploy.TimedOut) {
      # Same rule as deploy-mirror.ps1: still probe what is live; an observed exposure wins.
      $t = Get-AccessGateProbeTargets -VerifyUrl $VerifyUrl -ProjectName $ProjectName -DeployOutput $deployOutput -ProbePaths $probePaths
      try {
        Assert-AccessGateOnAllTargets -Targets $t -AccessHost $AccessHost -StrictPaths $routes -Context '(manual deploy:mirror timed out)' | Out-Null
      } catch {
        if ($_.Exception.Message -match '^GATE CHECK FAILED') { throw }
        Write-Host "[gate-check] during deploy timeout: $($_.Exception.Message)"
      }
      throw "wrangler deploy timed out after ${DeployTimeoutSeconds}s"
    }
    if ($deploy.ExitCode -ne 0) { throw "wrangler deploy failed ($($deploy.ExitCode))" }

    Write-Host '[deploy:mirror] post-deploy Access-gate check'
    $targets  = Get-AccessGateProbeTargets -VerifyUrl $VerifyUrl -ProjectName $ProjectName -DeployOutput $deployOutput -ProbePaths $probePaths
    $unprobed = Get-MissingAliasRequirement -DeployOutput $deployOutput -ProjectName $ProjectName
    $results  = Assert-AccessGateOnAllTargets -Targets $targets -AccessHost $AccessHost -Unprobed $unprobed -StrictPaths $routes
    Write-Host "[deploy:mirror] OK - deployed and Access gate verified on all $(@($results).Count) target(s)."
  } catch {
    $reason = $_.Exception.Message
    $exposures = Get-Variable -Name LastAccessGateExposures -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    if (($reason -match '^GATE CHECK FAILED') -and (Test-MirrorExposureWarrantsContainment -Exposures $exposures)) {
      try { Set-MirrorGateLatch -Path $latch -Reason $reason } catch { Write-Host "Set-MirrorGateLatch itself failed: $($_.Exception.Message)" }
      $lockdown = Invoke-MirrorLockdownContainment -WranglerRoot $RepoRoot -ProjectName $ProjectName -TimeoutSeconds ([Math]::Min($DeployTimeoutSeconds, 300))
      throw "$reason -- CONTAINMENT: $($lockdown.Detail). The per-deployment <hash>.$ProjectName.pages.dev alias is NOT replaced by the lockdown page and stays reachable until you delete that deployment in the Cloudflare Pages dashboard. Gate latch open at $latch; every deploy refuses until it is cleared."
    }
    throw
  }
}

<#
  Deploy-side controls for the confidential mirror (deploy-mirror.ps1), extracted so
  scripts/mirror-deploy.smoke-test.ps1 can dot-source and exercise the REAL functions with the
  native call and the probe mocked (same pattern as lib/access-gate-probe.ps1).

  Audit wf_9bf74429-aaf (2026-11-12):

  Finding 1 (HIGH) -- wrangler ran with cwd = the SHARED checkout ($repo), and `wrangler pages
  deploy` takes ./functions from its working directory. So the Pages Functions (ai.ts with its
  confidentiality scan and Access identity check, score.ts with the ruleset and engine) shipped from
  whatever was on disk in a multi-session development tree, next to a FULL confidential bake, while
  the static artifact came from the isolated origin/main build root. Get-MirrorWranglerDeploy now
  pins BOTH the process working directory and wrangler's own --cwd to the build root.

  Finding 4 (MED) -- the Access gate was only checked AFTER upload, and a failure alerted but left
  the FULL bake live. Now:
    - Assert-MirrorPreDeployAccessGate probes the LIVE production target before any FULL bake;
      only a pass lets deploy-mirror.ps1 set MIRROR_ACCESS_PREPROBE=passed, without which
      bake-mirror.ts refuses FULL mode (scripts/lib/mirror-mode.ts);
    - on a GATE CHECK FAILED (pre- or post-deploy) that shows SERVED content
      (Test-MirrorExposureWarrantsContainment) a gate LATCH is written and the production branch is
      replaced with a no-data LOCKDOWN page deployed with NO Functions
      (Invoke-MirrorLockdownContainment);
    - while the latch is open, every run refuses before baking (Assert-MirrorGateLatchClear). A
      human clears it by deleting the file after fixing Access and deleting the exposed deployment.
  The lockdown page, not a redacted re-bake, is the containment: it carries no portfolio data at
  all, needs no workbook/Notion/brief run that could itself fail, and drops the Functions too.
  Deleting the exposed FULL deployment is NOT automated: it is irreversible and its id has to be
  matched from wrangler output that cannot be verified offline, so the alert names the alias for
  manual deletion instead (per-deployment alias pruning is audit finding 29).

  Requires: lib/native-timeout.ps1 (Invoke-NativeCommandWithTimeout) and lib/access-gate-probe.ps1
  dot-sourced first.
#>

function Get-MirrorWranglerDeploy {
  <#
    The wrangler invocation for `pages deploy`: executable, arguments and working directory. The
    working directory is passed to the process AND as wrangler's --cwd, so ./functions resolves in
    -WorkingDirectory whichever one wrangler honours. Falls back to npx only when the build root has
    no local wrangler (same fallback as before).
  #>
  param(
    [Parameter(Mandatory=$true)][string]$WranglerRoot,
    [Parameter(Mandatory=$true)][string]$WorkingDirectory,
    [Parameter(Mandatory=$true)][string]$DistPath,
    [Parameter(Mandatory=$true)][string]$ProjectName
  )
  $common = @('pages', 'deploy', $DistPath, "--project-name=$ProjectName", '--branch=main', "--cwd=$WorkingDirectory")
  $bin = Join-Path $WranglerRoot 'node_modules\.bin\wrangler.cmd'
  if (Test-Path -LiteralPath $bin) {
    return [pscustomobject]@{ Executable = $bin; Arguments = $common; WorkingDirectory = $WorkingDirectory }
  }
  Write-Host "[deploy] local wrangler not found at $bin -- falling back to npx (run 'npm ci' to restore the pinned version)"
  return [pscustomobject]@{ Executable = 'npx'; Arguments = @('wrangler') + $common; WorkingDirectory = $WorkingDirectory }
}

function Invoke-MirrorWranglerDeploy {
  <# Run Get-MirrorWranglerDeploy's command through the bounded native runner. Returns its result. #>
  param(
    [Parameter(Mandatory=$true)][string]$WranglerRoot,
    [Parameter(Mandatory=$true)][string]$WorkingDirectory,
    [Parameter(Mandatory=$true)][string]$DistPath,
    [Parameter(Mandatory=$true)][string]$ProjectName,
    [Parameter(Mandatory=$true)][int]$TimeoutSeconds,
    [string]$OutputFile
  )
  $c = Get-MirrorWranglerDeploy -WranglerRoot $WranglerRoot -WorkingDirectory $WorkingDirectory -DistPath $DistPath -ProjectName $ProjectName
  $params = @{
    Executable       = $c.Executable
    Arguments        = $c.Arguments
    TimeoutSeconds   = $TimeoutSeconds
    WorkingDirectory = $c.WorkingDirectory
  }
  if ($OutputFile) { $params.OutputFile = $OutputFile }
  return Invoke-NativeCommandWithTimeout @params
}

function Assert-MirrorPreDeployAccessGate {
  <#
    Probe the LIVE production target BEFORE any FULL bake: the root, every baked JSON the deploy
    publishes (the floor list, plus warehouse.json with -IncludeWarehouse) and every Function route
    in -FunctionsDirs, on the production URL only (there is no new per-deployment alias yet). Throws
    GATE CHECK FAILED (exposure observed now, on what is live) or GATE CHECK INCONCLUSIVE, with a
    PRE-DEPLOY context, exactly like the post-deploy check. Returns the probe results on a pass.
  #>
  param(
    [Parameter(Mandatory=$true)][string]$VerifyUrl,
    [Parameter(Mandatory=$true)][string]$ProjectName,
    [Parameter(Mandatory=$true)][string]$AccessHost,
    [string[]]$FunctionsDirs = @(),
    # The build root's public/: every top-level *.json already staged there is about to be uploaded
    # again (a gitignored warehouse.json from the last daily run survives `git clean -fd`), so it is
    # probed on the live target too (refute wf_ec2162a9-34f).
    [AllowEmptyString()][string]$StagedDir = '',
    [switch]$IncludeWarehouse,
    [int]$BudgetSeconds = 120
  )
  $paths   = Get-AccessGateProbePaths -DistPath $StagedDir -FunctionsDirs $FunctionsDirs -IncludeWarehouse:$IncludeWarehouse
  $routes  = Get-AccessGateFunctionRoutes -FunctionsDirs $FunctionsDirs
  $targets = Get-AccessGateProbeTargets -VerifyUrl $VerifyUrl -ProjectName $ProjectName -DeployOutput '' -ProbePaths $paths
  return Assert-AccessGateOnAllTargets -Targets $targets -AccessHost $AccessHost -StrictPaths $routes -SettleSeconds 0 -BudgetSeconds $BudgetSeconds -Context '(PRE-DEPLOY probe of the live production target; no FULL bake was produced or uploaded this run)'
}

function Test-MirrorExposureWarrantsContainment {
  <#
    Should a GATE CHECK FAILED latch the mirror and swap in the lockdown page? Only on evidence that
    content was SERVED without Access: a 2xx on any target, or a 4xx from a Function route other
    than 401/403/429 (a Function answering 404/405 means the request reached it). A 5xx, a 429 or a
    401/403 on a Function route can be Cloudflare's own edge answering before Access (an outage, a
    rate limit, a WAF challenge): still a CRITICAL alert, but no automatic lockdown and no latch, so
    an edge blip cannot take the mirror down until a human clears it (refute wf_ec2162a9-34f). The
    next run re-probes before baking anything. -Exposures are the objects
    Assert-AccessGateOnAllTargets records in $script:LastAccessGateExposures.
  #>
  param([object[]]$Exposures = @())
  foreach ($e in @($Exposures | Where-Object { $_ })) {
    $code = [int]$e.Code
    if ($code -ge 200 -and $code -le 299) { return $true }
    if ($e.Strict -and $code -ge 400 -and $code -le 499 -and @(401, 403, 429) -notcontains $code) { return $true }
  }
  return $false
}

function Get-MirrorGateLatchPath {
  param([Parameter(Mandatory=$true)][string]$RepoRoot)
  return Join-Path $RepoRoot 'data\alert-state\mirror-gate-latch.json'
}

function Set-MirrorGateLatch {
  <# Open the latch (idempotent: keeps the FIRST opening's timestamp, records the latest reason). #>
  param([Parameter(Mandatory=$true)][string]$Path, [Parameter(Mandatory=$true)][string]$Reason)
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $openedAt = (Get-Date).ToString('o')
  if (Test-Path -LiteralPath $Path) {
    try {
      $prior = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
      if ($prior.openedAt) { $openedAt = [string]$prior.openedAt }
    } catch { }
  }
  $body = [pscustomobject]@{
    openedAt  = $openedAt
    updatedAt = (Get-Date).ToString('o')
    reason    = $Reason
    clear     = 'Fix Cloudflare Access, delete the exposed deployment(s) in the Pages dashboard, then delete this file. Until then every mirror run refuses before baking.'
  }
  Set-Content -LiteralPath $Path -Value ($body | ConvertTo-Json -Depth 3) -Encoding UTF8
}

function Assert-MirrorGateLatchClear {
  <# Throw GATE LATCH OPEN (suppressible, never CRITICAL: the critical alert already went out when it opened). #>
  param([Parameter(Mandatory=$true)][string]$Path)
  if (Test-Path -LiteralPath $Path) {
    $since = ''
    try { $since = [string](Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json).openedAt } catch { }
    throw "GATE LATCH OPEN: a mirror Access-gate failure (opened $since) has not been cleared, so no FULL bake will be produced or deployed. Fix Access, delete the exposed deployment(s), then delete $Path."
  }
}

function New-MirrorLockdownSite {
  <# A throwaway directory holding dist/index.html with NO portfolio data, and no functions/ dir. #>
  param([string]$ParentDir = [System.IO.Path]::GetTempPath())
  $root = Join-Path $ParentDir ('ora-mirror-lockdown-' + [guid]::NewGuid().ToString('N'))
  $dist = Join-Path $root 'dist'
  New-Item -ItemType Directory -Path $dist -Force | Out-Null
  $html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Unavailable</title></head><body><p>This site is temporarily unavailable.</p></body></html>'
  Set-Content -LiteralPath (Join-Path $dist 'index.html') -Value $html -Encoding UTF8
  return [pscustomobject]@{ Root = $root; Dist = $dist }
}

function Invoke-MirrorLockdownContainment {
  <#
    Replace the production branch with the lockdown page (no data, no Functions: the working
    directory is the throwaway site root, which has no functions/). Never throws: returns
    { Deployed; Detail } so the caller can report the outcome in its alert.
  #>
  param(
    [Parameter(Mandatory=$true)][string]$WranglerRoot,
    [Parameter(Mandatory=$true)][string]$ProjectName,
    [Parameter(Mandatory=$true)][int]$TimeoutSeconds
  )
  $site = $null
  # Same IPv4-first DNS workaround the main deploy uses (deploy-mirror.ps1 step 2): the containment
  # deploy must not be the one wrangler call that stalls on this host's broken IPv6 route.
  $priorNodeOptions = $env:NODE_OPTIONS
  $env:NODE_OPTIONS = '--dns-result-order=ipv4first'
  try {
    $site = New-MirrorLockdownSite
    $r = Invoke-MirrorWranglerDeploy -WranglerRoot $WranglerRoot -WorkingDirectory $site.Root -DistPath $site.Dist -ProjectName $ProjectName -TimeoutSeconds $TimeoutSeconds
    if ($r.TimedOut) { return [pscustomobject]@{ Deployed = $false; Detail = "lockdown deploy timed out after ${TimeoutSeconds}s" } }
    if ($r.ExitCode -ne 0) { return [pscustomobject]@{ Deployed = $false; Detail = "lockdown deploy failed (wrangler exit $($r.ExitCode))" } }
    return [pscustomobject]@{ Deployed = $true; Detail = 'lockdown page deployed to the production branch (no data, no Functions)' }
  } catch {
    return [pscustomobject]@{ Deployed = $false; Detail = "lockdown deploy could not run: $($_.Exception.Message)" }
  } finally {
    if ($null -eq $priorNodeOptions) { Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue } else { $env:NODE_OPTIONS = $priorNodeOptions }
    if ($site -and (Test-Path -LiteralPath $site.Root)) { Remove-Item -LiteralPath $site.Root -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

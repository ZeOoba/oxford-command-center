<#
  Smoke test for scripts/lib/mirror-deploy.ps1 (audit wf_9bf74429-aaf findings 1 and 4) and the
  -WorkingDirectory parameter of lib/native-timeout.ps1's Invoke-NativeCommandWithTimeout. Dot-sources
  the REAL functions; the native deploy call and the curl probe are mocked by redefining
  Invoke-NativeCommandWithTimeout / Invoke-AccessGateProbe AFTER dot-sourcing, except in scenario 1,
  which runs the real native runner to prove the child's working directory mechanically.
  Run by tests/unit/mirror-deploy-egress.test.ts. Exits 0 and prints ALL PASS when every assertion holds.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/mirror-deploy.smoke-test.ps1
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\cmd-arg-guard.ps1')
. (Join-Path $PSScriptRoot 'lib\git-capture.ps1')
. (Join-Path $PSScriptRoot 'lib\native-timeout.ps1')
. (Join-Path $PSScriptRoot 'lib\access-gate-probe.ps1')
. (Join-Path $PSScriptRoot 'lib\mirror-deploy.ps1')

$failures = @()
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { $script:failures += $Message; Write-Host "FAIL: $Message" } else { Write-Host "pass: $Message" }
}
function Get-ThrownMessage { param([scriptblock]$Block) try { & $Block; return '' } catch { return $_.Exception.Message } }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('mirror-deploy-smoke-' + [guid]::NewGuid().ToString('N'))
$buildRoot = Join-Path $tmp 'build root'
$sharedRepo = Join-Path $tmp 'shared'
New-Item -ItemType Directory -Path (Join-Path $buildRoot 'functions\api') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $sharedRepo 'functions\api') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $buildRoot 'functions\api\ai.ts') -Value 'export const onRequestPost = () => null;'
Set-Content -LiteralPath (Join-Path $sharedRepo 'functions\api\dirty-only.ts') -Value 'export const onRequestGet = () => null;'

try {
  # 1) REAL native runner: -WorkingDirectory sets the child's cwd even while PowerShell sits elsewhere.
  Push-Location $sharedRepo
  try {
    $cwdOut = Join-Path $tmp 'cwd.txt'
    $r = Invoke-NativeCommandWithTimeout -Executable 'cmd.exe' -Arguments @('/c', 'cd') -TimeoutSeconds 30 -OutputFile $cwdOut -WorkingDirectory $buildRoot
    $seen = (Get-Content -LiteralPath $cwdOut -Raw).Trim()
    Assert-True ($r.ExitCode -eq 0) '1: native runner exits 0'
    Assert-True ($seen -eq $buildRoot) "1: child cwd is the -WorkingDirectory (got '$seen'), not the caller's location"
    $msg = Get-ThrownMessage { Invoke-NativeCommandWithTimeout -Executable 'cmd.exe' -Arguments @('/c', 'cd') -TimeoutSeconds 5 -WorkingDirectory (Join-Path $tmp 'nope') }
    Assert-True ($msg -match 'WorkingDirectory') '1: a missing -WorkingDirectory throws before starting anything'
  } finally { Pop-Location }

  # 2) Get-MirrorWranglerDeploy pins process cwd AND --cwd to the build root (finding 1).
  New-Item -ItemType Directory -Path (Join-Path $buildRoot 'node_modules\.bin') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $buildRoot 'node_modules\.bin\wrangler.cmd') -Value '@echo off'
  $c = Get-MirrorWranglerDeploy -WranglerRoot $buildRoot -WorkingDirectory $buildRoot -DistPath (Join-Path $buildRoot 'dist') -ProjectName 'proj'
  Assert-True ($c.Executable -eq (Join-Path $buildRoot 'node_modules\.bin\wrangler.cmd')) '2: uses the build root''s local wrangler'
  Assert-True ($c.WorkingDirectory -eq $buildRoot) '2: process working directory is the build root'
  Assert-True (@($c.Arguments) -ccontains "--cwd=$buildRoot") '2: wrangler --cwd is the build root'
  Assert-True (-not (@($c.Arguments) -match [regex]::Escape($sharedRepo))) '2: the shared checkout appears nowhere in the deploy command'

  # 3) Invoke-MirrorWranglerDeploy hands the working directory to the native runner.
  $script:calls = @()
  function Invoke-NativeCommandWithTimeout {
    param([string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds, [string]$OutputFile, [string]$WorkingDirectory)
    $script:calls += [pscustomobject]@{ Executable = $Executable; Arguments = $Arguments; WorkingDirectory = $WorkingDirectory; HadFunctions = (Test-Path -LiteralPath (Join-Path $WorkingDirectory 'functions')); Dist = $Arguments[2]; DistIndex = $(if (Test-Path -LiteralPath (Join-Path $Arguments[2] 'index.html')) { Get-Content -LiteralPath (Join-Path $Arguments[2] 'index.html') -Raw } else { '' }) }
    return [pscustomobject]@{ ExitCode = $script:mockExit; TimedOut = $script:mockTimedOut }
  }
  $script:mockExit = 0; $script:mockTimedOut = $false
  $null = Invoke-MirrorWranglerDeploy -WranglerRoot $buildRoot -WorkingDirectory $buildRoot -DistPath (Join-Path $buildRoot 'dist') -ProjectName 'proj' -TimeoutSeconds 60 -OutputFile (Join-Path $tmp 'log.txt')
  Assert-True ($script:calls.Count -eq 1 -and $script:calls[0].WorkingDirectory -eq $buildRoot) '3: native runner receives -WorkingDirectory = build root'

  # 4) Lockdown containment: no data, no Functions, temp site removed, outcome reported.
  $script:calls = @()
  $lk = Invoke-MirrorLockdownContainment -WranglerRoot $buildRoot -ProjectName 'proj' -TimeoutSeconds 60
  $call = $script:calls[0]
  Assert-True ($lk.Deployed) '4: lockdown reports Deployed on exit 0'
  Assert-True (-not $call.HadFunctions) '4: lockdown deploys from a directory with NO functions/'
  Assert-True ($call.WorkingDirectory -ne $buildRoot) '4: lockdown does not deploy from the build root (whose functions/ would ship)'
  Assert-True ($call.DistIndex -match 'temporarily unavailable' -and $call.DistIndex -notmatch 'snapshot|deal|tenant') '4: lockdown page carries no data'
  Assert-True (-not (Test-Path -LiteralPath $call.WorkingDirectory)) '4: the throwaway lockdown site is removed afterwards'
  $script:mockExit = 1
  $lk = Invoke-MirrorLockdownContainment -WranglerRoot $buildRoot -ProjectName 'proj' -TimeoutSeconds 60
  Assert-True (-not $lk.Deployed -and $lk.Detail -match 'exit 1') '4: a failed lockdown deploy is reported, not thrown'
  $script:mockExit = 0; $script:mockTimedOut = $true
  $lk = Invoke-MirrorLockdownContainment -WranglerRoot $buildRoot -ProjectName 'proj' -TimeoutSeconds 60
  Assert-True (-not $lk.Deployed -and $lk.Detail -match 'timed out') '4: a timed-out lockdown deploy is reported, not thrown'
  $script:mockTimedOut = $false

  # 5) Pre-deploy probe: the live production target only, every route and baked JSON, strict Functions.
  $script:probed = @()
  function Invoke-AccessGateProbe {
    param([string]$VerifyUrl, [string]$AccessHost, [int]$SettleSeconds, [int]$RetryDelaySeconds, [int]$Attempts, [switch]$StrictExposure)
    $script:probed += [pscustomobject]@{ Url = $VerifyUrl; Strict = [bool]$StrictExposure }
    if ($script:exposeUrl -and $VerifyUrl -eq $script:exposeUrl) {
      return [pscustomobject]@{ Verified = $false; Exposed = $true; Code = 200; Location = ''; CurlExitCode = 0 }
    }
    return [pscustomobject]@{ Verified = $true; Exposed = $false; Code = 302; Location = "https://x.$AccessHost/login"; CurlExitCode = 0 }
  }
  $script:exposeUrl = $null
  $null = Assert-MirrorPreDeployAccessGate -VerifyUrl 'https://proj.pages.dev/' -ProjectName 'proj' -AccessHost 'cloudflareaccess.com' -FunctionsDirs @(Join-Path $buildRoot 'functions') -IncludeWarehouse -BudgetSeconds 30
  $urls = @($script:probed | ForEach-Object { $_.Url })
  foreach ($u in @('https://proj.pages.dev/', 'https://proj.pages.dev/snapshot.json', 'https://proj.pages.dev/macro.json', 'https://proj.pages.dev/warehouse.json', 'https://proj.pages.dev/api/ai')) {
    Assert-True ($urls -ccontains $u) "5: pre-deploy probe covers $u"
  }
  Assert-True (-not ($urls -match 'dirty-only')) '5: routes from the shared checkout are not part of the deployed set'
  Assert-True (@($script:probed | Where-Object { $_.Url -like '*/api/ai' -and $_.Strict }).Count -eq 1) '5: Function routes are probed strict'
  $script:probed = @(); $script:exposeUrl = 'https://proj.pages.dev/snapshot.json'
  $msg = Get-ThrownMessage { Assert-MirrorPreDeployAccessGate -VerifyUrl 'https://proj.pages.dev/' -ProjectName 'proj' -AccessHost 'cloudflareaccess.com' -FunctionsDirs @(Join-Path $buildRoot 'functions') -BudgetSeconds 30 }
  Assert-True ($msg -match '^GATE CHECK FAILED' -and $msg -match 'PRE-DEPLOY') "5: an exposure on the live target throws GATE CHECK FAILED with the PRE-DEPLOY context (got '$msg')"
  $script:exposeUrl = $null

  # 5b) Staged JSON in the build root's public/ is probed pre-deploy even without -IncludeWarehouse
  #     (refute wf_ec2162a9-34f: a stale daily warehouse.json is re-uploaded by every hourly run).
  $staged = Join-Path $buildRoot 'public'
  New-Item -ItemType Directory -Path $staged -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $staged 'warehouse.json') -Value '{}'
  $script:probed = @()
  $null = Assert-MirrorPreDeployAccessGate -VerifyUrl 'https://proj.pages.dev/' -ProjectName 'proj' -AccessHost 'cloudflareaccess.com' -FunctionsDirs @(Join-Path $buildRoot 'functions') -StagedDir $staged -BudgetSeconds 30
  Assert-True (@($script:probed | ForEach-Object { $_.Url }) -ccontains 'https://proj.pages.dev/warehouse.json') '5b: a staged warehouse.json is probed pre-deploy without -IncludeWarehouse'

  # 5c) Containment only on served content.
  $mk = { param($code, $strict) [pscustomobject]@{ Url = 'u'; Code = $code; Strict = $strict } }
  Assert-True (Test-MirrorExposureWarrantsContainment -Exposures @((& $mk 200 $false))) '5c: a static 2xx warrants containment'
  Assert-True (Test-MirrorExposureWarrantsContainment -Exposures @((& $mk 405 $true))) '5c: a Function 405 warrants containment'
  Assert-True (Test-MirrorExposureWarrantsContainment -Exposures @((& $mk 404 $true))) '5c: a Function 404 warrants containment'
  foreach ($c in @(500, 502, 503, 429, 401, 403)) {
    Assert-True (-not (Test-MirrorExposureWarrantsContainment -Exposures @((& $mk $c $true)))) "5c: a Function $c (edge-possible) does not lock the mirror down"
  }
  Assert-True (Test-MirrorExposureWarrantsContainment -Exposures @((& $mk 503 $true), (& $mk 204 $false))) '5c: any served target among edge errors warrants containment'
  Assert-True (-not (Test-MirrorExposureWarrantsContainment -Exposures @())) '5c: no exposures -> no containment'
  # The real Assert records its exposures for the caller.
  $script:exposeUrl = 'https://proj.pages.dev/snapshot.json'
  $null = Get-ThrownMessage { Assert-MirrorPreDeployAccessGate -VerifyUrl 'https://proj.pages.dev/' -ProjectName 'proj' -AccessHost 'cloudflareaccess.com' -FunctionsDirs @() -BudgetSeconds 30 }
  $rec = @($script:LastAccessGateExposures)
  Assert-True ($rec.Count -eq 1 -and $rec[0].Code -eq 200 -and (Test-MirrorExposureWarrantsContainment -Exposures $rec)) '5c: Assert-AccessGateOnAllTargets records the exposure it threw on'
  $script:exposeUrl = $null

  # 5d) The lockdown deploy runs with IPv4-first DNS and restores NODE_OPTIONS afterwards.
  $env:NODE_OPTIONS = '--max-old-space-size=123'
  $script:nodeOptsSeen = $null
  function Invoke-NativeCommandWithTimeout {
    param([string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds, [string]$OutputFile, [string]$WorkingDirectory)
    $script:nodeOptsSeen = $env:NODE_OPTIONS
    return [pscustomobject]@{ ExitCode = 0; TimedOut = $false }
  }
  $null = Invoke-MirrorLockdownContainment -WranglerRoot $buildRoot -ProjectName 'proj' -TimeoutSeconds 60
  Assert-True ($script:nodeOptsSeen -eq '--dns-result-order=ipv4first') '5d: lockdown deploy runs with ipv4first DNS'
  Assert-True ($env:NODE_OPTIONS -eq '--max-old-space-size=123') '5d: NODE_OPTIONS restored after the lockdown'
  Remove-Item Env:\NODE_OPTIONS

  # 6) Gate latch.
  $latch = Get-MirrorGateLatchPath -RepoRoot $tmp
  Assert-True ($latch -like '*data\alert-state\mirror-gate-latch.json') '6: latch lives under data\alert-state'
  Assert-True ((Get-ThrownMessage { Assert-MirrorGateLatchClear -Path $latch }) -eq '') '6: no latch -> no throw'
  Set-MirrorGateLatch -Path $latch -Reason 'GATE CHECK FAILED: first'
  $first = (Get-Content -LiteralPath $latch -Raw | ConvertFrom-Json).openedAt
  Start-Sleep -Milliseconds 20
  Set-MirrorGateLatch -Path $latch -Reason 'GATE CHECK FAILED: second'
  $j = Get-Content -LiteralPath $latch -Raw | ConvertFrom-Json
  Assert-True ($j.openedAt -eq $first -and $j.reason -eq 'GATE CHECK FAILED: second') '6: re-opening keeps the first openedAt and records the latest reason'
  $msg = Get-ThrownMessage { Assert-MirrorGateLatchClear -Path $latch }
  Assert-True ($msg -match '^GATE LATCH OPEN' -and $msg -notmatch '^GATE CHECK') '6: an open latch refuses with GATE LATCH OPEN (not a fresh GATE CHECK FAILED)'
  Remove-Item -LiteralPath $latch
  Assert-True ((Get-ThrownMessage { Assert-MirrorGateLatchClear -Path $latch }) -eq '') '6: deleting the latch file clears it'
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) { Write-Host "$($failures.Count) FAILURE(S)"; exit 1 }
Write-Host 'ALL PASS'
exit 0

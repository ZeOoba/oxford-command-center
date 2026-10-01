<#
.SYNOPSIS
  Preflight for the self-hosted CI runner (repo variable CI_RUNNER=self).

.DESCRIPTION
  Read-only. Run on the runner laptop BEFORE relying on CI_RUNNER=self, or any time
  checks sit queued. Checks:
    1. gh is installed and authenticated
    2. exactly the expected runner is registered, ONLINE and IDLE, with the ora-ci label
    3. CI_RUNNER repo variable value
    4. an actions.runner.* Windows service exists and is Running (else the runner is a
       foreground process and dies on logoff/sleep/reboot)
    5. queue depth (queued + in_progress runs)
    6. env vars that break the build (NODE_ENV=production, npm omit/production flags).
       ci.yml clears NODE_ENV for its jobs, so these are WARN, not FAIL.
  Exit 0 = no FAIL. Exit 1 = at least one FAIL. WARNs never fail.

.EXAMPLE
  pwsh -File scripts/ci-runner-preflight.ps1
#>
param(
  [string]$Repo = 'ZeOoba/oxford-command-center',
  [string]$Label = 'ora-ci'
)

$script:fails = 0
function Ok($m)   { Write-Host "[ OK ] $m" }
function Warn($m) { Write-Host "[WARN] $m" }
function Fail($m) { Write-Host "[FAIL] $m"; $script:fails++ }

# 1. gh
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Fail 'gh CLI not found on PATH'
  exit 1
}
gh auth status *> $null
if ($LASTEXITCODE -ne 0) { Fail 'gh is not authenticated (run: gh auth login)'; exit 1 }
Ok 'gh installed and authenticated'

# 2. runner registered / online / idle
$runners = @()
try {
  $runners = @((gh api "repos/$Repo/actions/runners" | ConvertFrom-Json).runners |
    Where-Object { $_.labels.name -contains $Label })
} catch { Fail "could not list runners: $_" }
if ($runners.Count -eq 0) {
  Fail "no runner with label '$Label' is registered"
} else {
  foreach ($r in $runners) {
    $labels = ($r.labels.name -join ',')
    if ($r.status -ne 'online') { Fail "runner $($r.name) is $($r.status) (labels: $labels)" }
    elseif ($r.busy)            { Warn "runner $($r.name) is online but BUSY (labels: $labels)" }
    else                        { Ok   "runner $($r.name) online and idle (labels: $labels)" }
  }
}

# 3. CI_RUNNER variable
$v = gh variable get CI_RUNNER --repo $Repo 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($v)) {
  Warn 'CI_RUNNER is unset: jobs target ubuntu-latest (GitHub-hosted, billed)'
} elseif ($v.Trim() -eq 'self') {
  Ok 'CI_RUNNER=self'
} else {
  Warn "CI_RUNNER='$($v.Trim())' (only 'self' selects the laptop runner)"
}

# 4. service
$svc = @(Get-Service 'actions.runner.*' -ErrorAction SilentlyContinue)
if ($svc.Count -eq 0) {
  Warn 'no actions.runner.* service: runner is a foreground process (stops on logoff/sleep/reboot)'
} else {
  foreach ($s in $svc) {
    if ($s.Status -eq 'Running') { Ok "service $($s.Name) Running ($($s.StartType))" }
    else { Fail "service $($s.Name) is $($s.Status)" }
  }
}

# 5. queue depth
$queued = @(gh run list --repo $Repo --status queued --limit 100 --json databaseId | ConvertFrom-Json).Count
$active = @(gh run list --repo $Repo --status in_progress --limit 100 --json databaseId | ConvertFrom-Json).Count
if ($queued -gt 5) { Warn "$queued runs queued, $active in progress (single runner serialises jobs)" }
else { Ok "$queued runs queued, $active in progress" }

# 6. environment
if ($env:NODE_ENV -eq 'production') {
  Warn 'NODE_ENV=production in this shell: npm ci omits devDependencies and vitest fails to load (ci.yml clears it for jobs)'
} else { Ok "NODE_ENV=[$env:NODE_ENV]" }
foreach ($n in 'NPM_CONFIG_PRODUCTION','NPM_CONFIG_OMIT','npm_config_production','npm_config_omit') {
  $val = [Environment]::GetEnvironmentVariable($n)
  if ($val) { Warn "$n=$val can make npm skip devDependencies" }
}
if ($env:NODE_OPTIONS) { Warn "NODE_OPTIONS=$env:NODE_OPTIONS (inherited by every job)" }

if ($script:fails -gt 0) { Write-Host "`n$($script:fails) FAIL"; exit 1 }
Write-Host "`nPreflight passed"
exit 0

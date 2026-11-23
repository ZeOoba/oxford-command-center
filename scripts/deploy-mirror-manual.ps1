<#
  `npm run deploy:mirror` -- MANUAL redacted deploy of the checked-out tree, with the Access-gate
  probes the scheduled scripts/deploy-mirror.ps1 runs (pre-deploy, bounded wrangler, post-deploy,
  containment on exposure). See lib/mirror-manual-deploy.ps1 for why and what it adds.
  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-mirror-manual.ps1
#>
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib\cmd-arg-guard.ps1')
. (Join-Path $PSScriptRoot 'lib\git-capture.ps1')   # Invoke-NativeCommandCapture, used by the Access probe
. (Join-Path $PSScriptRoot 'lib\native-timeout.ps1')
. (Join-Path $PSScriptRoot 'lib\access-gate-probe.ps1')
. (Join-Path $PSScriptRoot 'lib\mirror-deploy.ps1')
. (Join-Path $PSScriptRoot 'lib\mirror-manual-deploy.ps1')

if ($args.Count -gt 0) {
  # `npm run deploy:mirror -- <flag>` used to reach wrangler; now it would be dropped silently.
  Write-Host "[deploy:mirror] FAILED: deploy:mirror takes no arguments (got: $($args -join ' '))."
  exit 1
}
$priorNodeOptions = $env:NODE_OPTIONS
try {
  Push-Location $repo
  # Same IPv4-first DNS workaround deploy-mirror.ps1 uses for wrangler on this host.
  $env:NODE_OPTIONS = '--dns-result-order=ipv4first'
  Invoke-MirrorManualDeploy -RepoRoot $repo -Build {
    npx tsx scripts/scan-mirror-dist.ts --precheck-redacted-only
    if ($LASTEXITCODE -ne 0) { throw "redacted-only precheck failed ($LASTEXITCODE)" }
    npm run build:mirror
    if ($LASTEXITCODE -ne 0) { throw "build:mirror failed ($LASTEXITCODE)" }
  }
  exit 0
} catch {
  Write-Host "[deploy:mirror] FAILED: $($_.Exception.Message)"
  exit 1
} finally {
  Pop-Location
  if ($null -eq $priorNodeOptions) { Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue } else { $env:NODE_OPTIONS = $priorNodeOptions }
}

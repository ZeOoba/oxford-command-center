<#
.SYNOPSIS
  Bake the confidential-included snapshot, build, deploy to the Access-gated Cloudflare
  mirror, and VERIFY the gate is still enforcing (unauthenticated -> 302).

.DESCRIPTION
  Decision (2026-06-03): the canonical workbook is a local OneDrive file, so the daily
  freshness job runs as a LOCAL Windows scheduled task on the ORA machine (not GitHub
  Actions, which cannot read the workbook). Register it with register-mirror-task.ps1.

  Confidentiality: MIRROR_INCLUDE_CONFIDENTIAL=1 is set ONLY because the deploy target is
  verified behind Cloudflare Access. The post-deploy curl re-proves the gate before the run
  is considered successful; if the apex does NOT 302 to Access, the script FAILS loudly so a
  confidential bake is never left publicly reachable.

  Incident (2026-07-09): this script builds+deploys whatever is currently checked out on
  disk. Since the hourly scheduled task never pulled, merged main PRs (a full retokenization,
  7 commits) sat undeployed for over a day -- the "baked Nm ago" freshness badge only reflects
  the data snapshot, not the code, so the mirror silently served stale UI. Step 1 below now
  fast-forwards to origin/main first and fails loudly (never silently) if that isn't possible.

  Incident follow-up (2026-07-09): "fails loudly" only helps a human already watching Windows
  Task Scheduler history -- there was no alert of any kind. Any throw below now also emails
  ggoldberg@oxfordra.net via the standard Outlook COM path before re-raising, so a failed pull
  or a failed Access-gate check reaches a human even when nobody is watching this machine. If
  the alert email itself can't be sent, the failure is written to data/outbox/ (the same
  gitignored fallback location server/brief/send.ts already uses) so it's never silently lost.

.NOTES
  Requires: node/npm, a Cloudflare auth token for wrangler (CLOUDFLARE_API_TOKEN or
  `wrangler login`). Run `npm run gate` should be green before deploying.
  Gate check uses curl.exe (Windows 11 built-in) -- PS5.1-compatible.
#>
[CmdletBinding()]
param(
  [string]$ProjectName     = 'ora-command-center',
  [string]$VerifyUrl       = 'https://ora-command-center.pages.dev/',
  [string]$AccessHost      = 'cloudflareaccess.com',
  [string]$AlertSendScript = 'C:\Users\Owner\.claude\scheduled-tasks\_shared\send-via-outlook.ps1',
  [string]$AlertTo         = 'ggoldberg@oxfordra.net'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Write-Host "[$stamp] Mirror deploy starting in $repo"

# Send-DeployFailureAlert lives in lib/deploy-alert.ps1 (shared with
# deploy-mirror.smoke-test.ps1) so the smoke test exercises the real function, not a
# hand-copied duplicate that can drift out of sync.
. (Join-Path $PSScriptRoot 'lib\deploy-alert.ps1')

try {
  # 1) Fast-forward to origin/main first -- otherwise this deploys whatever old code happens to
  #    be on disk. Fails loudly (never silently) if the local checkout has diverged or has
  #    uncommitted changes that conflict with incoming commits; a stale-but-successful deploy is
  #    worse than a loud failure here.
  git fetch origin
  if ($LASTEXITCODE -ne 0) { throw "git fetch origin failed ($LASTEXITCODE)" }
  git pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed ($LASTEXITCODE) -- local main has diverged from origin/main or has conflicting uncommitted changes; resolve manually, then re-run this script" }

  # 2) Bake (confidential included -- target is Access-gated) + build.
  $env:MIRROR_INCLUDE_CONFIDENTIAL = '1'
  $env:BRIEF_ENABLED               = '1'
  $env:BRIEF_SEND_SCRIPT           = 'C:\Users\Owner\.claude\scheduled-tasks\_shared\send-via-outlook.ps1'
  try {
    npm run build:mirror
    if ($LASTEXITCODE -ne 0) { throw "build:mirror failed ($LASTEXITCODE)" }

    # 3) Deploy the static bake to the gated Pages project.
    npx wrangler pages deploy dist --project-name=$ProjectName --branch=main
    if ($LASTEXITCODE -ne 0) { throw "wrangler deploy failed ($LASTEXITCODE)" }
  }
  finally {
    Remove-Item Env:\MIRROR_INCLUDE_CONFIDENTIAL -ErrorAction SilentlyContinue
    Remove-Item Env:\BRIEF_ENABLED               -ErrorAction SilentlyContinue
    Remove-Item Env:\BRIEF_SEND_SCRIPT           -ErrorAction SilentlyContinue
  }

  # 4) Verify Access is still enforcing -- unauthenticated must 302 to the Access login host.
  #    Uses curl.exe (Windows 11 built-in) -- PS5.1-compatible; Invoke-WebRequest cannot capture
  #    302 response objects on PS5.1 (SkipHttpErrorCheck is PS7+ only).
  #    Incident (2026-07-09 17:08): a single-shot probe missed transiently and fired the CRITICAL
  #    "confidential bake may be exposed" alert even though the gate was fine. Retry up to 3x
  #    (initial 5s settle, then 15s between attempts) before declaring failure, and split severity
  #    on the last observed $code -- a 2xx apex means the bake really is exposed (CRITICAL); any
  #    other result (0/timeout, 3xx-other, 4xx, 5xx) is an inconclusive probe/edge issue.
  Start-Sleep -Seconds 5
  $gateVerified = $false
  $code     = 0
  $location = ''
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    if ($attempt -gt 1) { Start-Sleep -Seconds 15 }
    $curlOut = & curl.exe -s -I --max-redirs 0 $VerifyUrl 2>&1
    $statusLine   = ($curlOut | Where-Object { $_ -match '^HTTP/' } | Select-Object -First 1) -as [string]
    $locationLine = ($curlOut | Where-Object { $_ -match '^[Ll]ocation:' } | Select-Object -First 1) -as [string]
    $code     = if ($statusLine   -match 'HTTP/\S+\s+(\d+)') { [int]$Matches[1] } else { 0 }
    $location = if ($locationLine -match '^[Ll]ocation:\s*(.+)') { $Matches[1].Trim() } else { '' }
    if ($code -eq 302 -and ($location -match [regex]::Escape($AccessHost))) {
      $gateVerified = $true
      break
    }
    Write-Host "[gate-check] attempt $attempt/3 not yet verified (code=$code, Location='$location')"
  }
  if (-not $gateVerified) {
    if ($code -ge 200 -and $code -le 299) {
      throw "GATE CHECK FAILED: $VerifyUrl returned $code (Location='$location') after 3 attempts. Expected 302 -> *$AccessHost. Confidential bake may be exposed - investigate immediately."
    } else {
      throw "GATE CHECK INCONCLUSIVE: $VerifyUrl returned $code (Location='$location') after 3 attempts. Probe/network issue or edge propagation - gate NOT verified open; verify manually."
    }
  }

  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-Host "[$stamp] OK - deployed and Access gate verified (302 -> $AccessHost). Location: $location"

  # Clears any suppressed offline-signature streak from prior runs and sends one recovery
  # digest if suppression actually happened -- see lib/deploy-alert.ps1.
  try {
    Send-DeployRecoveryDigestIfSuppressed
  } catch {
    Write-Host "Send-DeployRecoveryDigestIfSuppressed itself failed: $($_.Exception.Message)"
  }
}
catch {
  $original = $_
  try {
    $reason = $original.Exception.Message
    $isGateFailure = $reason -match '^GATE CHECK FAILED'
    $isOfflineSignature = Test-OfflineSignature -Reason $reason
    Send-DeployFailureAlert -Reason $reason -Critical:$isGateFailure -Suppressible:$isOfflineSignature
  } catch {
    Write-Host "Send-DeployFailureAlert itself failed: $($_.Exception.Message)"
  }
  throw $original
}

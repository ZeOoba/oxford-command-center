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

.NOTES
  Requires: node/npm, a Cloudflare auth token for wrangler (CLOUDFLARE_API_TOKEN or
  `wrangler login`). Run `npm run gate` should be green before deploying.
#>
[CmdletBinding()]
param(
  [string]$ProjectName = 'ora-command-center',
  [string]$VerifyUrl   = 'https://ora-command-center.pages.dev/',
  [string]$AccessHost  = 'cloudflareaccess.com'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Write-Host "[$stamp] Mirror deploy starting in $repo"

# 1) Bake (confidential included — target is Access-gated) + build.
$env:MIRROR_INCLUDE_CONFIDENTIAL = '1'
try {
  npm run build:mirror
  if ($LASTEXITCODE -ne 0) { throw "build:mirror failed ($LASTEXITCODE)" }

  # 2) Deploy the static bake to the gated Pages project.
  npx wrangler pages deploy dist --project-name=$ProjectName --branch=main
  if ($LASTEXITCODE -ne 0) { throw "wrangler deploy failed ($LASTEXITCODE)" }
}
finally {
  Remove-Item Env:\MIRROR_INCLUDE_CONFIDENTIAL -ErrorAction SilentlyContinue
}

# 3) Verify Access is still enforcing — unauthenticated must 302 to the Access login host.
Start-Sleep -Seconds 5
$resp = Invoke-WebRequest -Uri $VerifyUrl -MaximumRedirection 0 -SkipHttpErrorCheck -ErrorAction SilentlyContinue
$code = [int]$resp.StatusCode
$location = $resp.Headers['Location']
if ($code -ne 302 -or ($location -notmatch [regex]::Escape($AccessHost))) {
  throw "GATE CHECK FAILED: $VerifyUrl returned $code (Location='$location'). Expected 302 -> *$AccessHost. Confidential bake may be exposed — investigate immediately."
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Write-Host "[$stamp] OK — deployed and Access gate verified (302 -> $AccessHost)."

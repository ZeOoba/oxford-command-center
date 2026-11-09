<#
  Access-gate probe for the confidential mirror deploy (deploy-mirror.ps1), extracted into its own
  file so scripts/access-gate-probe.smoke-test.ps1 can dot-source and exercise the REAL functions
  with a mocked curl, the same pattern lib/deploy-alert.ps1 uses.

  mirror-gate-probe-apex-only (audit 2026-11-08): the hourly deploy always publishes the
  confidential bake, but the post-deploy check probed ONLY the apex '/'. Cloudflare Access is
  configured per hostname and path in the dashboard, so a green apex proves nothing about
  /snapshot.json (the confidential payload itself), the Pages Functions under /api/, or the
  per-deployment <hash>.<project>.pages.dev alias wrangler publishes on every run. Every one of
  those is now probed, and the run fails unless EVERY target answers 302 -> the Access host.

  Requires: lib/git-capture.ps1 (Invoke-NativeCommandCapture) dot-sourced first.
#>

# Paths probed on every origin (apex and each deployment alias). '' is the root. The confidential
# payload, the identity Function and the acquisition-score Function are the three non-root surfaces
# the mirror serves; every one must sit behind Access, not just the HTML shell.
$script:AccessGateProbePaths = @('', 'snapshot.json', 'api/whoami', 'api/warehouse/acquisition/score')

function Get-DeploymentAliasUrls {
  <#
    Extract every https://<label>.<project>.pages.dev origin from wrangler's deploy output
    ("Take a peek over at https://<hash>.<project>.pages.dev", and any "alias URL" line). Returns
    distinct origins with a trailing '/'. The apex itself (https://<project>.pages.dev) is not a
    match: it has no <label>. subdomain.
  #>
  param(
    [AllowEmptyString()][string]$DeployOutput,
    [Parameter(Mandatory=$true)][string]$ProjectName
  )
  if (-not $DeployOutput) { return @() }
  $pattern = 'https://([a-z0-9][a-z0-9-]*)\.' + [regex]::Escape($ProjectName) + '\.pages\.dev'
  $found = [regex]::Matches($DeployOutput, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $origins = @()
  foreach ($m in $found) {
    $origin = ('https://' + $m.Groups[1].Value + '.' + $ProjectName + '.pages.dev/').ToLowerInvariant()
    if ($origins -notcontains $origin) { $origins += $origin }
  }
  return $origins
}

function Get-AccessGateProbeTargets {
  <#
    Every URL the gate check must see 302 -> Access on: each probe path on the verify URL, and the
    same paths on every deployment alias. NEVER throws: a missing alias must not stop the apex from
    being probed (an apex exposure would otherwise be reported as a mere INCONCLUSIVE, found by the
    adversarial review of this change). Use Get-MissingAliasRequirement for the missing-alias case
    and pass it to Assert-AccessGateOnAllTargets -Unprobed, which reports it only AFTER the probes.
  #>
  param(
    [Parameter(Mandatory=$true)][string]$VerifyUrl,
    [Parameter(Mandatory=$true)][string]$ProjectName,
    [AllowEmptyString()][string]$DeployOutput
  )
  $base = if ($VerifyUrl.EndsWith('/')) { $VerifyUrl } else { $VerifyUrl + '/' }
  $aliases = @(Get-DeploymentAliasUrls -DeployOutput $DeployOutput -ProjectName $ProjectName)
  $targets = @()
  foreach ($origin in @($base) + $aliases) {
    foreach ($p in $script:AccessGateProbePaths) { $targets += ($origin + $p) }
  }
  return $targets
}

function Get-MissingAliasRequirement {
  <#
    On a deploy wrangler reported as successful it always prints the per-deployment URL, so finding
    none means the alias went unprobed -- the exact gap this file exists to close. Returns a one-item
    description for Assert-AccessGateOnAllTargets -Unprobed (which turns it into INCONCLUSIVE after
    every reachable target has been probed), or an empty array when an alias was found.
  #>
  param(
    [AllowEmptyString()][string]$DeployOutput,
    [Parameter(Mandatory=$true)][string]$ProjectName
  )
  if (@(Get-DeploymentAliasUrls -DeployOutput $DeployOutput -ProjectName $ProjectName).Count -gt 0) { return @() }
  return @("<hash>.$ProjectName.pages.dev deployment alias -> not probed (no deployment URL in wrangler output)")
}

# Invoke-AccessGateProbe -- extracted 2026-07-31 (security review) so the deploy-timeout path
# (step 3) can run the SAME Access-gate re-verification as the normal path (step 4). Moved into this
# lib 2026-11-08 so the smoke test runs the real function.
function Invoke-AccessGateProbe {
  param(
    [Parameter(Mandatory=$true)][string]$VerifyUrl,
    [Parameter(Mandatory=$true)][string]$AccessHost,
    [int]$SettleSeconds = 5,
    [int]$RetryDelaySeconds = 15,
    [int]$Attempts = 3
  )
  # Incident (2026-07-09 17:08): a single-shot probe missed transiently and fired the CRITICAL
  # "confidential bake may be exposed" alert even though the gate was fine. Retry up to 3x
  # (initial 5s settle, then 15s between attempts) before declaring failure, and split severity
  # on the last observed $code -- a 2xx means the bake really is exposed (CRITICAL); any other
  # result (0/timeout, 3xx-other, 4xx, 5xx) is an inconclusive probe/edge issue.
  if ($SettleSeconds -gt 0) { Start-Sleep -Seconds $SettleSeconds }
  $verified = $false
  $code = 0
  $location = ''
  $lastCurlExit = $null
  $anyTwoXx = $false
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    if ($attempt -gt 1 -and $RetryDelaySeconds -gt 0) { Start-Sleep -Seconds $RetryDelaySeconds }
    # Invoke-NativeCommandCapture (not a plain `& curl.exe ... 2>&1`): see lib/git-capture.ps1 for the
    # ErrorRecord-under-Stop hazard. --connect-timeout/--max-time bound each attempt at ~20s.
    $curlResult = Invoke-NativeCommandCapture -Executable 'curl.exe' -Arguments @('-s', '-I', '--connect-timeout', '10', '--max-time', '20', '--max-redirs', '0', $VerifyUrl)
    $lastCurlExit = $curlResult.ExitCode
    $curlOut = $curlResult.Output -split "`n"
    $statusLine   = ($curlOut | Where-Object { $_ -match '^HTTP/' } | Select-Object -First 1) -as [string]
    $locationLine = ($curlOut | Where-Object { $_ -match '^[Ll]ocation:' } | Select-Object -First 1) -as [string]
    $code     = if ($statusLine   -match 'HTTP/\S+\s+(\d+)') { [int]$Matches[1] } else { 0 }
    $location = if ($locationLine -match '^[Ll]ocation:\s*(.+)') { $Matches[1].Trim() } else { '' }
    # A 2xx on ANY attempt is an observed exposure, even if a later attempt 302s (edge flapping):
    # remember it so a transient later 302 cannot launder it into "verified".
    if ($code -ge 200 -and $code -le 299) { $anyTwoXx = $true }
    if ($code -eq 302 -and (Test-AccessLocation -Location $location -AccessHost $AccessHost)) {
      $verified = -not $anyTwoXx
      break
    }
    Write-Host "[gate-check] $VerifyUrl attempt $attempt/$Attempts not yet verified (code=$code, Location='$location')"
  }
  return [pscustomobject]@{
    Url          = $VerifyUrl
    Verified     = $verified
    Code         = $code
    Location     = $location
    CurlExitCode = $lastCurlExit
    Exposed      = $anyTwoXx
  }
}

function Test-AccessLocation {
  <#
    True only when the redirect's HOST is the Access host or a subdomain of it
    (<team>.cloudflareaccess.com). The old check was a substring match anywhere in the Location
    value, so a redirect to https://evil.example/?cloudflareaccess.com would have "verified".
  #>
  param([AllowEmptyString()][string]$Location, [Parameter(Mandatory=$true)][string]$AccessHost)
  if (-not $Location) { return $false }
  $uri = $null
  if (-not [System.Uri]::TryCreate($Location, [System.UriKind]::Absolute, [ref]$uri)) { return $false }
  if ($uri.Scheme -ne 'https') { return $false }
  $h = $uri.Host.ToLowerInvariant()
  $a = $AccessHost.ToLowerInvariant().TrimStart('.')
  return ($h -eq $a -or $h.EndsWith('.' + $a))
}

function Assert-AccessGateOnAllTargets {
  <#
    Probe every target and THROW unless every one is verified (302 -> Access host). Exposure on any
    target (a 2xx) throws "GATE CHECK FAILED" (CRITICAL, never suppressed); anything else unverified
    throws "GATE CHECK INCONCLUSIVE". The settle sleep runs once, not per target. A total budget
    bounds the worst case (every target timing out) well under the task's PT30M limit: targets not
    reached within it count as unverified, so running out of time can only fail the check, never
    pass it. The deadline is checked before each target, so the worst case is settle + budget + one
    target's full retry cycle (~90s): ~275s at the default, against ~95s for the old apex-only probe.
    -Unprobed lists REQUIRED targets that could not be probed at all (the missing deployment alias);
    they are reported as INCONCLUSIVE only after every reachable target was probed, so they can never
    mask a GATE CHECK FAILED. -Context is appended to the message (the deploy-timeout path passes its
    own reason).
  #>
  param(
    [Parameter(Mandatory=$true)][string[]]$Targets,
    [Parameter(Mandatory=$true)][string]$AccessHost,
    [int]$SettleSeconds = 5,
    [int]$RetryDelaySeconds = 15,
    [int]$BudgetSeconds = 180,
    [string[]]$Unprobed = @(),
    [string]$Context = ''
  )
  if ($SettleSeconds -gt 0) { Start-Sleep -Seconds $SettleSeconds }
  $deadline = (Get-Date).AddSeconds($BudgetSeconds)
  $results = @()
  foreach ($t in $Targets) {
    if ((Get-Date) -gt $deadline) {
      $results += [pscustomobject]@{ Url = $t; Verified = $false; Code = 0; Location = ''; CurlExitCode = $null; Exposed = $false; Skipped = $true }
      continue
    }
    $r = Invoke-AccessGateProbe -VerifyUrl $t -AccessHost $AccessHost -SettleSeconds 0 -RetryDelaySeconds $RetryDelaySeconds
    $results += $r
  }
  $suffix = if ($Context) { " $Context" } else { '' }
  $exposed = @($results | Where-Object { $_.Exposed -or ($_.Code -ge 200 -and $_.Code -le 299) })
  if ($exposed.Count -gt 0) {
    $list = ($exposed | ForEach-Object { "$($_.Url) -> 2xx observed (last code $($_.Code))" }) -join '; '
    throw "GATE CHECK FAILED: $($exposed.Count) of $($Targets.Count) probed mirror target(s) answered 2xx without Access ($list). Expected 302 -> *$AccessHost on every target. Confidential bake may be exposed - investigate immediately.$suffix"
  }
  $unverified = @($results | Where-Object { -not $_.Verified })
  $missing = @($Unprobed | Where-Object { $_ })
  if ($unverified.Count -gt 0 -or $missing.Count -gt 0) {
    $items = @($unverified | ForEach-Object {
      if ($_.PSObject.Properties['Skipped'] -and $_.Skipped) { "$($_.Url) -> not probed (budget ${BudgetSeconds}s exhausted)" }
      else { "$($_.Url) -> $($_.Code) (Location='$($_.Location)', curl exit $($_.CurlExitCode))" }
    }) + $missing
    $list = $items -join '; '
    $total = $Targets.Count + $missing.Count
    throw "GATE CHECK INCONCLUSIVE: $($items.Count) of $total mirror target(s) not verified ($list). Probe/network issue, edge propagation or wrangler output change - gate NOT verified; verify manually.$suffix"
  }
  return $results
}

<#
  Access-gate probe for the confidential mirror deploy (deploy-mirror.ps1), extracted into its own
  file so scripts/access-gate-probe.smoke-test.ps1 can dot-source and exercise the REAL functions
  with a mocked curl, the same pattern lib/deploy-alert.ps1 uses.

  mirror-gate-probe-apex-only (audit 2026-11-08): the hourly deploy always publishes the
  confidential bake, but the post-deploy check probed ONLY the apex '/'. Cloudflare Access is
  configured per hostname and path in the dashboard, so a green apex proves nothing about the baked
  JSON payloads, the Pages Functions under /api/, or the per-deployment <hash>.<project>.pages.dev
  alias wrangler publishes on every run. Every one of those is now probed, and the run fails unless
  EVERY target answers 302 -> the Access host.

  The probe PATH list is DERIVED, not hand-kept (refute run wf_44a3341e-b41: a hand-kept list
  missed /warehouse.json, /macro.json and /api/ai): every top-level *.json in the built dist/ (plus
  the files the bake always writes, as a floor), and every functions/**/*.ts file that exports an
  onRequest* handler, mapped to its route. A new baked file or Function is probed automatically;
  tests/unit/access-gate-probe-smoke.test.ts fails if the derivation stops covering either.

  Requires: lib/git-capture.ps1 (Invoke-NativeCommandCapture) dot-sourced first.
#>

# Top-level JSON files bake-mirror.ts always writes into public/ (and so into dist/), probed even if
# the dist/ scan misses them. warehouse.json is added when the deploy bakes it (-IncludeWarehouse).
$script:BakedJsonFloor = @('snapshot.json', 'macro.json')

function Get-BakedJsonProbePaths {
  <#
    Every top-level *.json the deploy publishes: the floor above, warehouse.json when
    -IncludeWarehouse, and every top-level *.json actually present in -DistPath (the built artifact
    wrangler uploads). Union, so an expected file that is absent is still probed (behind Access it
    302s like any other path) and an unexpected file that is present is never skipped.
  #>
  param(
    [AllowEmptyString()][string]$DistPath,
    [switch]$IncludeWarehouse
  )
  $paths = @($script:BakedJsonFloor)
  if ($IncludeWarehouse) { $paths += 'warehouse.json' }
  if ($DistPath -and (Test-Path -LiteralPath $DistPath -PathType Container)) {
    foreach ($f in @(Get-ChildItem -LiteralPath $DistPath -Filter '*.json' -File -ErrorAction Stop)) {
      $paths += $f.Name
    }
  }
  $out = @()
  foreach ($p in $paths) { if ($out -cnotcontains $p) { $out += $p } }
  return $out
}

# Files under functions/ (relative, '/'-separated, exact case) that are NOT routes and are therefore
# not probed. Every other script file is a route, whatever it exports: deciding "is this a handler?"
# by matching export syntax missed `export { onRequestGet }`, `export { h as onRequestPost }`,
# `export var` and .js Functions (refute run wf_c135181a-31a). A file under an underscore segment
# (functions/_shared/, _middleware.ts) is skipped by the derivation, and must ALSO be listed here:
# tests/unit/access-gate-probe-smoke.test.ts fails on any functions/ file that is neither probed nor
# listed, so adding a helper is a visible decision, never a silent gap.
$script:FunctionsNotARoute = @(
  '_shared/access-identity.ts',
  '_shared/access-jwt.ts'
)
# Extensions Pages compiles as Functions.
$script:FunctionScriptExtensions = @('.ts', '.js', '.mjs', '.tsx', '.jsx')

function Get-FunctionsNotARoute { return $script:FunctionsNotARoute }

function Get-FunctionRoutePaths {
  <#
    Every Pages Function route under -FunctionsDir: each script file (.ts/.js/.mjs/.tsx/.jsx, not
    *.d.ts / *.test.* / *.spec.*) that has no underscore-prefixed path segment and is not on
    $script:FunctionsNotARoute, mapped to its URL path the way Pages routes it
    (functions/api/ai.ts -> api/ai; .../index.js -> its directory). No export-syntax matching. A
    dynamic segment ([id] / [[path]]) is probed with the literal 'probe'.
  #>
  param([AllowEmptyString()][string]$FunctionsDir)
  if (-not $FunctionsDir -or -not (Test-Path -LiteralPath $FunctionsDir -PathType Container)) { return @() }
  $root = (Resolve-Path -LiteralPath $FunctionsDir).ProviderPath.TrimEnd('\', '/')
  $routes = @()
  foreach ($f in @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction Stop)) {
    if ($script:FunctionScriptExtensions -notcontains $f.Extension.ToLowerInvariant()) { continue }
    if ($f.Name -match '\.d\.ts$|\.(test|spec)\.[a-z]+$') { continue }
    $rel = $f.FullName.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/'
    if ($script:FunctionsNotARoute -ccontains $rel) { continue }
    if (@($rel -split '/' | Where-Object { $_.StartsWith('_') }).Count -gt 0) { continue }
    $route = $rel -replace '\.[A-Za-z]+$', ''
    $route = $route -replace '(^|/)index$', ''
    $route = $route -replace '\[\[?[^\]]+\]?\]', 'probe'
    if ($routes -cnotcontains $route) { $routes += $route }
  }
  return $routes
}

function Get-AccessGateFunctionRoutes {
  <# The union of Get-FunctionRoutePaths over every -FunctionsDirs entry (the strict-probe set). #>
  param([string[]]$FunctionsDirs = @())
  $out = @()
  foreach ($d in @($FunctionsDirs | Where-Object { $_ })) {
    foreach ($r in @(Get-FunctionRoutePaths -FunctionsDir $d)) { if ($out -cnotcontains $r) { $out += $r } }
  }
  return $out
}

function Get-AccessGateProbePaths {
  <#
    The full path list probed on every origin: '' (the root / HTML shell), every baked top-level
    JSON, and every Function route found in any of -FunctionsDirs (deploy-mirror passes the build
    root's functions/, the tree wrangler deploys from -- audit wf_9bf74429-aaf finding 1).
  #>
  param(
    [AllowEmptyString()][string]$DistPath,
    [string[]]$FunctionsDirs = @(),
    [switch]$IncludeWarehouse
  )
  $paths = @('') + @(Get-BakedJsonProbePaths -DistPath $DistPath -IncludeWarehouse:$IncludeWarehouse)
  $paths += @(Get-AccessGateFunctionRoutes -FunctionsDirs $FunctionsDirs)
  $out = @()
  foreach ($p in $paths) { if ($out -cnotcontains $p) { $out += $p } }
  return $out
}

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
    if ($origins -cnotcontains $origin) { $origins += $origin }
  }
  return $origins
}

function Get-AccessGateProbeTargets {
  <#
    Every URL the gate check must see 302 -> Access on: each of -ProbePaths on the verify URL and on
    every deployment alias, ordered PATH-MAJOR (for each path: apex, then each alias), so the alias's
    root and payloads are requested early instead of after every apex path. NEVER throws: a missing
    alias must not stop the apex from being probed (an apex exposure would otherwise be reported as a
    mere INCONCLUSIVE). Use Get-MissingAliasRequirement for that case and pass it to
    Assert-AccessGateOnAllTargets -Unprobed, which reports it only AFTER the probes.
  #>
  param(
    [Parameter(Mandatory=$true)][string]$VerifyUrl,
    [Parameter(Mandatory=$true)][string]$ProjectName,
    [AllowEmptyString()][string]$DeployOutput,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string[]]$ProbePaths
  )
  $base = if ($VerifyUrl.EndsWith('/')) { $VerifyUrl } else { $VerifyUrl + '/' }
  $origins = @($base) + @(Get-DeploymentAliasUrls -DeployOutput $DeployOutput -ProjectName $ProjectName)
  $paths = @($ProbePaths)
  if ($paths -cnotcontains '') { $paths = @('') + $paths }
  $targets = @()
  foreach ($p in $paths) {
    foreach ($origin in $origins) {
      $u = $origin + $p
      if ($targets -cnotcontains $u) { $targets += $u }
    }
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

function Test-StrictExposureTarget {
  <#
    True for a Pages Function path: any derived Function route in -StrictPaths (whatever its
    prefix -- functions/admin.ts, functions/api/index.ts -> /api), and, as a floor, anything under
    /api/. A Function behind Access answers with the Access 302 before the Function ever runs, so ANY
    HTTP response from one that is not that 302 means the request reached the Function: a POST-only
    Function answers HEAD with 405, a missing route with 404 -- both are exposures, not
    "inconclusive". Only "no HTTP response at all" (code 0: timeout, DNS, refused) stays inconclusive.
  #>
  param(
    [Parameter(Mandatory=$true)][string]$Url,
    [string[]]$StrictPaths = @()
  )
  $uri = $null
  if (-not [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri)) { return $false }
  $path = $uri.AbsolutePath.TrimStart('/')
  if ($path.ToLowerInvariant().StartsWith('api/')) { return $true }
  # '' is the root: functions/index.ts makes it a Function too.
  return (@($StrictPaths | Where-Object { $_ -ne $null }) -ccontains $path)
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
    [int]$Attempts = 3,
    # Function path: any HTTP answer other than the Access 302 is an exposure (Test-StrictExposureTarget).
    [switch]$StrictExposure
  )
  # Incident (2026-07-09 17:08): a single-shot probe missed transiently and fired the CRITICAL
  # "confidential bake may be exposed" alert even though the gate was fine. Retry up to 3x
  # (initial 5s settle, then 15s between attempts) before declaring failure, and split severity
  # on the observed $code -- a 2xx means the bake really is exposed (CRITICAL); on a static path any
  # other result (0/timeout, 3xx-other, 4xx, 5xx) is an inconclusive probe/edge issue.
  if ($SettleSeconds -gt 0) { Start-Sleep -Seconds $SettleSeconds }
  $verified = $false
  $code = 0
  $location = ''
  $lastCurlExit = $null
  $exposed = $false
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
    $isAccess302 = ($code -eq 302 -and (Test-AccessLocation -Location $location -AccessHost $AccessHost))
    # An exposure on ANY attempt is sticky, even if a later attempt 302s (edge flapping): a transient
    # later 302 cannot launder it into "verified".
    if ($code -ge 200 -and $code -le 299) { $exposed = $true }
    if ($StrictExposure -and $code -ne 0 -and -not $isAccess302) { $exposed = $true }
    if ($isAccess302) {
      $verified = -not $exposed
      break
    }
    if ($exposed) { break }
    Write-Host "[gate-check] $VerifyUrl attempt $attempt/$Attempts not yet verified (code=$code, Location='$location')"
  }
  return [pscustomobject]@{
    Url          = $VerifyUrl
    Verified     = $verified
    Code         = $code
    Location     = $location
    CurlExitCode = $lastCurlExit
    Exposed      = $exposed
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
    Probe every target and THROW unless every one is verified (302 -> Access host). An exposure on
    any target (a 2xx; on a Function path, any HTTP answer but the Access 302) throws
    "GATE CHECK FAILED" (CRITICAL, never suppressed); anything else unverified throws
    "GATE CHECK INCONCLUSIVE".

    ROUNDS, not per-target retries: round 1 requests EVERY target once; later rounds (up to
    -Attempts) retry only the targets still unverified and not exposed, with -RetryDelaySeconds
    between rounds. So a stalled target cannot starve the others of their first request (refute run
    wf_44a3341e-b41). Within each round the STRICT targets (Function routes, -StrictPaths and /api/)
    go first, so every Function route gets a request inside the budget even when static targets
    stall (wf_c135181a-31a). The settle sleep runs once. A total budget bounds the worst case: the
    deadline is checked before each request, and a target never requested within it counts as
    unverified, so running out of time can only fail the check, never pass it.

    -Unprobed lists REQUIRED targets that could not be probed at all (the missing deployment alias);
    they are reported as INCONCLUSIVE only after every reachable target was probed, so they can never
    mask a GATE CHECK FAILED. -Context is appended to the message (the deploy-timeout path passes
    its own reason).
  #>
  param(
    [Parameter(Mandatory=$true)][string[]]$Targets,
    [Parameter(Mandatory=$true)][string]$AccessHost,
    [int]$SettleSeconds = 5,
    [int]$RetryDelaySeconds = 15,
    [int]$Attempts = 3,
    [int]$BudgetSeconds = 180,
    [string[]]$Unprobed = @(),
    # Derived Function routes (Get-AccessGateFunctionRoutes): probed strict whatever their prefix.
    [AllowEmptyString()][string[]]$StrictPaths = @(),
    [string]$Context = ''
  )
  if ($SettleSeconds -gt 0) { Start-Sleep -Seconds $SettleSeconds }
  $deadline = (Get-Date).AddSeconds($BudgetSeconds)
  # Case-SENSITIVE map: Pages asset paths are case-sensitive, so /Snapshot.json and /snapshot.json
  # are two targets, not one.
  $state = New-Object System.Collections.Specialized.OrderedDictionary ([System.StringComparer]::Ordinal)
  $strictTargets = @()
  $staticTargets = @()
  foreach ($t in $Targets) {
    if ($state.Contains($t)) { continue }
    $isStrict = Test-StrictExposureTarget -Url $t -StrictPaths $StrictPaths
    $state[$t] = [pscustomobject]@{ Url = $t; Verified = $false; Code = 0; Location = ''; CurlExitCode = $null; Exposed = $false; Requested = $false; Strict = $isStrict }
    if ($isStrict) { $strictTargets += $t } else { $staticTargets += $t }
  }
  # Strict (Function) targets first, each group keeping its path-major order.
  $Targets = @($strictTargets) + @($staticTargets)
  for ($round = 1; $round -le $Attempts; $round++) {
    $pending = @($Targets | Where-Object { -not $state[$_].Verified -and -not $state[$_].Exposed })
    if ($pending.Count -eq 0) { break }
    if ($round -gt 1 -and $RetryDelaySeconds -gt 0) { Start-Sleep -Seconds $RetryDelaySeconds }
    foreach ($t in $pending) {
      if ((Get-Date) -gt $deadline) { break }
      $s = $state[$t]
      $r = Invoke-AccessGateProbe -VerifyUrl $t -AccessHost $AccessHost -SettleSeconds 0 -RetryDelaySeconds 0 -Attempts 1 -StrictExposure:($s.Strict)
      $s.Requested = $true
      $s.Code = $r.Code
      $s.Location = $r.Location
      $s.CurlExitCode = $r.CurlExitCode
      if ($r.Exposed) { $s.Exposed = $true; $s.Verified = $false }
      elseif ($r.Verified -and -not $s.Exposed) { $s.Verified = $true }
    }
  }
  $results = @($state.Values)
  $suffix = if ($Context) { " $Context" } else { '' }
  $exposedList = @($results | Where-Object { $_.Exposed })
  # Exposed targets (Url, Code, Strict) of the most recent check, for a caller that must decide
  # whether an exposure is served content (lib/mirror-deploy.ps1 Test-MirrorExposureWarrantsContainment).
  $script:LastAccessGateExposures = $exposedList
  if ($exposedList.Count -gt 0) {
    $list = ($exposedList | ForEach-Object { "$($_.Url) -> answered without Access (last code $($_.Code), Location='$($_.Location)')" }) -join '; '
    throw "GATE CHECK FAILED: $($exposedList.Count) of $($Targets.Count) probed mirror target(s) answered without Access ($list). Expected 302 -> *$AccessHost on every target. Confidential bake may be exposed - investigate immediately.$suffix"
  }
  $unverified = @($results | Where-Object { -not $_.Verified })
  $missing = @($Unprobed | Where-Object { $_ })
  if ($unverified.Count -gt 0 -or $missing.Count -gt 0) {
    $items = @($unverified | ForEach-Object {
      if (-not $_.Requested) { "$($_.Url) -> not probed (budget ${BudgetSeconds}s exhausted)" }
      else { "$($_.Url) -> $($_.Code) (Location='$($_.Location)', curl exit $($_.CurlExitCode))" }
    }) + $missing
    $list = $items -join '; '
    $total = $Targets.Count + $missing.Count
    throw "GATE CHECK INCONCLUSIVE: $($items.Count) of $total mirror target(s) not verified ($list). Probe/network issue, edge propagation or wrangler output change - gate NOT verified; verify manually.$suffix"
  }
  return $results
}

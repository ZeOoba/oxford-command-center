<#
  Regression smoke test for scripts/lib/access-gate-probe.ps1 (mirror-gate-probe-apex-only,
  audit 2026-11-08; refute run wf_44a3341e-b41 follow-ups). Dot-sources the REAL probe functions
  and replaces curl with a mock keyed by URL, so every scenario runs offline in a few seconds. Also
  covers the probe-path derivation (baked JSON + Function routes) and lib/native-timeout.ps1's
  -OutputFile.

  Run by tests/unit/access-gate-probe-smoke.test.ts on Windows (vitest), or by hand:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/access-gate-probe.smoke-test.ps1
  Exits 0 if all assertions pass, 1 otherwise.
#>
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\git-capture.ps1')
. (Join-Path $PSScriptRoot 'lib\native-timeout.ps1')
. (Join-Path $PSScriptRoot 'lib\access-gate-probe.ps1')

$failures = @()
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { $script:failures += $Message; Write-Host "FAIL: $Message" }
  else { Write-Host "pass: $Message" }
}

$project = 'ora-command-center'
$apex = "https://$project.pages.dev/"
$alias = "https://a1b2c3d4.$project.pages.dev/"
$accessHost = 'cloudflareaccess.com'
$access302 = '302 https://zephyr.cloudflareaccess.com/cdn-cgi/access/login/x'
$wranglerOut = @"
Uploading... (42/42)
Deployment complete! Take a peek over at https://a1b2c3d4.$project.pages.dev
See also https://A1B2C3D4.$project.pages.dev and the production URL https://$project.pages.dev
"@
$paths = @('', 'snapshot.json', 'macro.json', 'api/ai', 'api/whoami', 'api/warehouse/acquisition/score')

# --- curl mock: $script:Responses maps URL -> array of responses (one per request; last repeats).
$script:Responses = @{}
$script:Calls = @()
function Invoke-NativeCommandCapture {
  param([string]$Executable, [string[]]$Arguments)
  $url = $Arguments[-1]
  $script:Calls += $url
  $seq = $script:Responses[$url]
  if (-not $seq) { $seq = @($access302) }
  $n = @($script:Calls | Where-Object { $_ -eq $url }).Count
  $r = $seq[[Math]::Min($n, $seq.Count) - 1]
  $parts = $r -split ' ', 2
  $out = if ($parts[0] -eq '0') { '' } else { "HTTP/2 $($parts[0])`n" }
  if ($parts.Count -gt 1 -and $parts[1]) { $out += "location: $($parts[1])`n" }
  return [pscustomobject]@{ Output = $out; ExitCode = $(if ($parts[0] -eq '0') { 28 } else { 0 }) }
}
function Reset-Mock { $script:Responses = @{}; $script:Calls = @() }
function Get-ThrownMessage {
  param([scriptblock]$Block)
  try { & $Block | Out-Null; return '' } catch { return $_.Exception.Message }
}
$fast = @{ AccessHost = $accessHost; SettleSeconds = 0; RetryDelaySeconds = 0 }

# 1) Alias parsing: hash alias found once (case-folded dedupe); the apex is not an alias.
$aliases = @(Get-DeploymentAliasUrls -DeployOutput $wranglerOut -ProjectName $project)
Assert-True ($aliases.Count -eq 1 -and $aliases[0] -eq $alias) "1: one alias parsed ($($aliases -join ','))"
Assert-True (@(Get-DeploymentAliasUrls -DeployOutput '' -ProjectName $project).Count -eq 0) '1b: empty output -> no aliases'
Assert-True (@(Get-DeploymentAliasUrls -DeployOutput "https://x.other-project.pages.dev" -ProjectName $project).Count -eq 0) '1c: other project alias ignored'

# 2) Targets: every probe path on the apex AND on the alias, PATH-MAJOR.
$targets = @(Get-AccessGateProbeTargets -VerifyUrl $apex -ProjectName $project -DeployOutput $wranglerOut -ProbePaths $paths)
foreach ($o in @($apex, $alias)) {
  foreach ($p in $paths) { Assert-True ($targets -contains ($o + $p)) "2: target $($o + $p) present" }
}
Assert-True ($targets.Count -eq 12) "2b: 12 targets (got $($targets.Count))"
Assert-True ($targets[0] -eq $apex -and $targets[1] -eq $alias -and $targets[3] -eq ($alias + 'snapshot.json')) "2c: path-major order ($($targets[0..3] -join ', '))"
$noSlash = @(Get-AccessGateProbeTargets -VerifyUrl $apex.TrimEnd('/') -ProjectName $project -DeployOutput '' -ProbePaths $paths)
Assert-True ($noSlash -contains ($apex + 'snapshot.json')) '2d: verify URL without trailing slash still joins correctly'
$rootless = @(Get-AccessGateProbeTargets -VerifyUrl $apex -ProjectName $project -DeployOutput '' -ProbePaths @('snapshot.json'))
Assert-True ($rootless -contains $apex) '2e: the root is always probed even if the path list omits it'

# 3) No alias in the output: target building never throws, the requirement is reported after probing.
$apexOnly = @(Get-AccessGateProbeTargets -VerifyUrl $apex -ProjectName $project -DeployOutput 'no url here' -ProbePaths $paths)
Assert-True ($apexOnly.Count -eq 6) "3: no alias -> the 6 apex targets, no throw ($($apexOnly.Count))"
$missingAlias = @(Get-MissingAliasRequirement -DeployOutput 'no url here' -ProjectName $project)
Assert-True ($missingAlias.Count -eq 1) '3b: missing alias produces one unprobed requirement'
Assert-True (@(Get-MissingAliasRequirement -DeployOutput $wranglerOut -ProjectName $project).Count -eq 0) '3c: alias present -> no unprobed requirement'
Reset-Mock
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $apexOnly -Unprobed $missingAlias @fast }
Assert-True ($msg -match '^GATE CHECK INCONCLUSIVE' -and $msg -match 'deployment alias') "3d: no alias + apex gated -> INCONCLUSIVE naming the alias ($msg)"
Assert-True (@($script:Calls).Count -eq 6) "3e: apex targets still probed when the alias is missing ($(@($script:Calls).Count))"
Reset-Mock
$script:Responses[$apex] = @('200')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $apexOnly -Unprobed $missingAlias @fast }
Assert-True ($msg -match '^GATE CHECK FAILED') "3f: no alias + apex 200 -> FAILED, not INCONCLUSIVE ($msg)"

# 4) Every target 302 -> Access: passes, each requested exactly once.
Reset-Mock
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -eq '') "4: all 302 -> passes ($msg)"
Assert-True (@($script:Calls).Count -eq 12) "4b: every target probed once ($(@($script:Calls).Count))"

# 5) The apex is gated but the HASH ALIAS answers 200: GATE CHECK FAILED naming the alias.
Reset-Mock
$script:Responses[$alias] = @('200')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -match '^GATE CHECK FAILED' -and $msg.Contains($alias)) "5: alias 200 -> FAILED ($msg)"

# 6) A baked payload answers 200 while '/' is gated: GATE CHECK FAILED.
foreach ($j in @('snapshot.json', 'macro.json')) {
  Reset-Mock
  $script:Responses[$apex + $j] = @('200')
  $msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
  Assert-True ($msg -match '^GATE CHECK FAILED' -and $msg.Contains($j)) "6: $j 200 -> FAILED ($msg)"
}

# 7) Function paths (/api/...): ANY HTTP answer but the Access 302 is an exposure (a POST-only
#    Function answers HEAD with 405). Only "no response" (code 0) stays inconclusive.
foreach ($c in @('405', '404', '500', '301 https://ora-command-center.pages.dev/elsewhere', '302 https://evil.example/?x=cloudflareaccess.com')) {
  Reset-Mock
  $script:Responses[$alias + 'api/ai'] = @($c)
  $msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
  Assert-True ($msg -match '^GATE CHECK FAILED' -and $msg.Contains('api/ai')) "7: /api/ai '$c' -> FAILED ($msg)"
}
Reset-Mock
$script:Responses[$apex + 'api/warehouse/acquisition/score'] = @('0')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -match '^GATE CHECK INCONCLUSIVE' -and $msg.Contains('acquisition/score')) "7b: /api/ no response (code 0) -> INCONCLUSIVE ($msg)"
Assert-True (Test-StrictExposureTarget -Url ($alias + 'api/whoami')) '7c: /api/ path is strict'
Assert-True (-not (Test-StrictExposureTarget -Url ($apex + 'snapshot.json'))) '7d: static path is not strict'
Assert-True (-not (Test-StrictExposureTarget -Url ($apex + 'apix.json'))) '7e: /apix.json is not an /api/ path'

# 8) Static paths keep the old split: a non-2xx, non-Access answer is INCONCLUSIVE, not FAILED.
Reset-Mock
$script:Responses[$apex + 'macro.json'] = @('404')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -match '^GATE CHECK INCONCLUSIVE' -and $msg.Contains('macro.json')) "8: static 404 -> INCONCLUSIVE ($msg)"
Reset-Mock
$script:Responses[$apex] = @('302 https://evil.example/?next=cloudflareaccess.com')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -match '^GATE CHECK INCONCLUSIVE') "8b: look-alike Location on a static path -> INCONCLUSIVE ($msg)"
Assert-True (-not (Test-AccessLocation -Location 'https://cloudflareaccess.com.evil.example/x' -AccessHost $accessHost)) '8c: suffix look-alike host rejected'
Assert-True (-not (Test-AccessLocation -Location 'http://zephyr.cloudflareaccess.com/x' -AccessHost $accessHost)) '8d: plain-http Access location rejected'
Assert-True (Test-AccessLocation -Location 'https://zephyr.cloudflareaccess.com/cdn-cgi/access/login/x' -AccessHost $accessHost) '8e: team Access host accepted'

# 9) Flapping edge: 200 on the first request, 302 on a retry -- the exposure is NOT laundered.
Reset-Mock
$script:Responses[$alias + 'snapshot.json'] = @('200', $access302)
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -match '^GATE CHECK FAILED') "9: 200-then-302 -> FAILED ($msg)"

# 10) Transient miss then 302 (the 2026-07-09 incident shape) verifies in round 2.
Reset-Mock
$script:Responses[$apex] = @('0', $access302)
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -eq '') "10: transient 0 then 302 -> passes ($msg)"

# 11) ROUNDS: a target that never answers is retried only AFTER every other target got its first
#     request, so a stalled apex cannot starve the alias.
Reset-Mock
$script:Responses[$apex] = @('0')
$script:Responses[$alias + 'snapshot.json'] = @('200')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
$firstApexRetry = [Array]::LastIndexOf([string[]]$script:Calls, $apex)
$aliasSnap = [Array]::IndexOf([string[]]$script:Calls, ($alias + 'snapshot.json'))
Assert-True ($msg -match '^GATE CHECK FAILED' -and $msg.Contains('snapshot.json')) "11: stalled apex + exposed alias -> FAILED ($msg)"
Assert-True ($aliasSnap -ge 0 -and $aliasSnap -lt $firstApexRetry) "11b: alias requested before the apex retry (alias@$aliasSnap, last apex@$firstApexRetry)"
Assert-True (@($script:Calls | Where-Object { $_ -eq $apex }).Count -eq 3) "11c: the stalled apex gets 3 requests total ($(@($script:Calls | Where-Object { $_ -eq $apex }).Count))"

# 12) Exhausted budget: unrequested targets count as unverified (fail closed, never pass).
Reset-Mock
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast -BudgetSeconds -1 }
Assert-True ($msg -match '^GATE CHECK INCONCLUSIVE' -and $msg -match 'budget') "12: budget exhausted -> INCONCLUSIVE ($msg)"

# 13) -Context is appended (the deploy-timeout path passes its reason).
Reset-Mock
$script:Responses[$apex] = @('200')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast -Context 'zephyr-timeout-reason' }
Assert-True ($msg -match '^GATE CHECK FAILED' -and $msg.Contains('zephyr-timeout-reason')) "13: context appended ($msg)"

# 14) Probe-path derivation: baked JSON from dist/ plus the floor, Function routes from functions/.
$tmp = Join-Path $env:TEMP ("agp-derive-" + [guid]::NewGuid().ToString('N'))
$dist = Join-Path $tmp 'dist'
$fn = Join-Path $tmp 'functions'
New-Item -ItemType Directory -Force -Path $dist, (Join-Path $dist 'assets'), (Join-Path $fn 'api\warehouse\acquisition'), (Join-Path $fn '_shared'), (Join-Path $fn 'api\deals\[id]'), (Join-Path $fn 'api\reports') | Out-Null
Set-Content -LiteralPath (Join-Path $dist 'snapshot.json') -Value '{}'
Set-Content -LiteralPath (Join-Path $dist 'zephyr-extra.json') -Value '{}'
Set-Content -LiteralPath (Join-Path $dist 'assets\nested.json') -Value '{}'
Set-Content -LiteralPath (Join-Path $fn 'api\ai.ts') -Value "export function onRequestPost(c) { return c; }"
Set-Content -LiteralPath (Join-Path $fn 'api\warehouse\acquisition\score.ts') -Value "export async function onRequestPost(c) { return c; }"
Set-Content -LiteralPath (Join-Path $fn 'api\deals\[id]\index.ts') -Value "export const onRequest = async () => new Response('');"
Set-Content -LiteralPath (Join-Path $fn 'api\reports\index.ts') -Value "export const onRequestGet = () => null;"
Set-Content -LiteralPath (Join-Path $fn 'api\helpers.ts') -Value "export function notARoute() {}"
Set-Content -LiteralPath (Join-Path $fn '_shared\access.ts') -Value "export function onRequest() {}"
Set-Content -LiteralPath (Join-Path $fn 'api\_middleware.ts') -Value "export const onRequest = [];"
$json = @(Get-BakedJsonProbePaths -DistPath $dist)
Assert-True (($json -contains 'snapshot.json') -and ($json -contains 'macro.json') -and ($json -contains 'zephyr-extra.json')) "14: baked json = floor + dist top-level ($($json -join ','))"
Assert-True (-not ($json -contains 'nested.json') -and -not ($json -contains 'warehouse.json')) '14b: nested json not top-level; warehouse.json only with -IncludeWarehouse'
Assert-True (@(Get-BakedJsonProbePaths -DistPath $dist -IncludeWarehouse) -contains 'warehouse.json') '14c: -IncludeWarehouse adds warehouse.json'
Assert-True (@(Get-BakedJsonProbePaths -DistPath (Join-Path $tmp 'nope')) -contains 'snapshot.json') '14d: missing dist still yields the floor'
$routes = @(Get-FunctionRoutePaths -FunctionsDir $fn) | Sort-Object
$expected = @('api/ai', 'api/deals/probe', 'api/reports', 'api/warehouse/acquisition/score') | Sort-Object
Assert-True (($routes -join '|') -eq ($expected -join '|')) "14e: function routes ($($routes -join ', '))"
$all = @(Get-AccessGateProbePaths -DistPath $dist -FunctionsDirs @($fn, (Join-Path $tmp 'missing-fn')) -IncludeWarehouse)
Assert-True (($all -contains '') -and ($all -contains 'warehouse.json') -and ($all -contains 'api/ai')) "14f: combined probe paths ($($all -join ', '))"
Remove-Item -LiteralPath $tmp -Recurse -Force

# 15) Invoke-NativeCommandWithTimeout -OutputFile captures the child's stdout+stderr to the file.
$outFile = Join-Path $env:TEMP ("agp-smoke-" + [guid]::NewGuid().ToString('N') + '.log')
$r = Invoke-NativeCommandWithTimeout -Executable 'cmd.exe' -Arguments @('/c', 'echo', 'zephyr-wrangler-out') -TimeoutSeconds 30 -OutputFile $outFile
$captured = if (Test-Path -LiteralPath $outFile) { Get-Content -LiteralPath $outFile -Raw } else { '' }
Assert-True ($r.ExitCode -eq 0 -and $captured -match 'zephyr-wrangler-out') "15: -OutputFile captured output ('$($captured.Trim())')"
if (Test-Path -LiteralPath $outFile) { Remove-Item -LiteralPath $outFile -Force }
$msg = Get-ThrownMessage { Invoke-NativeCommandWithTimeout -Executable 'cmd.exe' -Arguments @('/c', 'echo') -TimeoutSeconds 5 -OutputFile 'C:\x" & echo pwned' }
Assert-True ($msg -match 'OutputFile') "15b: unsafe -OutputFile rejected ($msg)"

if ($failures.Count -gt 0) {
  Write-Host "`n$($failures.Count) FAILURE(S)"
  exit 1
}
Write-Host "`nALL PASS"
exit 0

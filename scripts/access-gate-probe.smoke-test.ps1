<#
  Regression smoke test for scripts/lib/access-gate-probe.ps1 (mirror-gate-probe-apex-only,
  audit 2026-11-08). Dot-sources the REAL probe functions and replaces curl with a mock keyed by URL,
  so every scenario runs offline in a few seconds. Also covers lib/native-timeout.ps1's -OutputFile.

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
$wranglerOut = @"
Uploading... (42/42)
Deployment complete! Take a peek over at https://a1b2c3d4.$project.pages.dev
See also https://A1B2C3D4.$project.pages.dev and the production URL https://$project.pages.dev
"@

# --- curl mock: $script:Responses maps URL -> array of responses (one per attempt; last repeats).
$script:Responses = @{}
$script:Calls = @()
function Invoke-NativeCommandCapture {
  param([string]$Executable, [string[]]$Arguments)
  $url = $Arguments[-1]
  $script:Calls += $url
  $seq = $script:Responses[$url]
  if (-not $seq) { $seq = @('302 https://zephyr.cloudflareaccess.com/cdn-cgi/access/login/x') }
  $n = @($script:Calls | Where-Object { $_ -eq $url }).Count
  $r = $seq[[Math]::Min($n, $seq.Count) - 1]
  $parts = $r -split ' ', 2
  $out = "HTTP/2 $($parts[0])`n"
  if ($parts.Count -gt 1 -and $parts[1]) { $out += "location: $($parts[1])`n" }
  return [pscustomobject]@{ Output = $out; ExitCode = 0 }
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

# 2) Targets: every probe path on the apex AND on the alias.
$targets = @(Get-AccessGateProbeTargets -VerifyUrl $apex -ProjectName $project -DeployOutput $wranglerOut)
foreach ($o in @($apex, $alias)) {
  foreach ($p in @('', 'snapshot.json', 'api/whoami', 'api/warehouse/acquisition/score')) {
    Assert-True ($targets -contains ($o + $p)) "2: target $($o + $p) present"
  }
}
Assert-True ($targets.Count -eq 8) "2b: 8 targets (got $($targets.Count))"
$noSlash = @(Get-AccessGateProbeTargets -VerifyUrl $apex.TrimEnd('/') -ProjectName $project -DeployOutput '')
Assert-True ($noSlash -contains ($apex + 'snapshot.json')) '2c: verify URL without trailing slash still joins correctly'

# 3) No alias in the output: target building never throws, the requirement is reported after probing.
$apexOnly = @(Get-AccessGateProbeTargets -VerifyUrl $apex -ProjectName $project -DeployOutput 'no url here')
Assert-True ($apexOnly.Count -eq 4) "3: no alias -> the 4 apex targets, no throw ($($apexOnly.Count))"
$missingAlias = @(Get-MissingAliasRequirement -DeployOutput 'no url here' -ProjectName $project)
Assert-True ($missingAlias.Count -eq 1) '3b: missing alias produces one unprobed requirement'
Assert-True (@(Get-MissingAliasRequirement -DeployOutput $wranglerOut -ProjectName $project).Count -eq 0) '3c: alias present -> no unprobed requirement'
Reset-Mock
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $apexOnly -Unprobed $missingAlias @fast }
Assert-True ($msg -match '^GATE CHECK INCONCLUSIVE' -and $msg -match 'deployment alias') "3d: no alias + apex gated -> INCONCLUSIVE naming the alias ($msg)"
Assert-True (@($script:Calls).Count -eq 4) "3e: apex targets still probed when the alias is missing ($(@($script:Calls).Count))"
# Adversarial-review finding C7: a missing alias must NOT mask an apex exposure.
Reset-Mock
$script:Responses[$apex] = @('200')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $apexOnly -Unprobed $missingAlias @fast }
Assert-True ($msg -match '^GATE CHECK FAILED') "3f: no alias + apex 200 -> FAILED, not INCONCLUSIVE ($msg)"

# 4) Every target 302 -> Access: passes.
Reset-Mock
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -eq '') "4: all 302 -> passes ($msg)"
Assert-True (@($script:Calls).Count -eq 8) "4b: every target probed once ($(@($script:Calls).Count))"

# 5) The apex is gated but the HASH ALIAS answers 200: GATE CHECK FAILED naming the alias.
Reset-Mock
$script:Responses[$alias] = @('200')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -match '^GATE CHECK FAILED' -and $msg.Contains($alias)) "5: alias 200 -> FAILED ($msg)"

# 6) /snapshot.json answers 200 while '/' is gated: GATE CHECK FAILED.
Reset-Mock
$script:Responses[$apex + 'snapshot.json'] = @('200')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -match '^GATE CHECK FAILED' -and $msg.Contains('snapshot.json')) "6: snapshot.json 200 -> FAILED ($msg)"

# 7) The score Function answers 405 (reached the Function, not Access): INCONCLUSIVE, run fails.
Reset-Mock
$script:Responses[$apex + 'api/warehouse/acquisition/score'] = @('405')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -match '^GATE CHECK INCONCLUSIVE' -and $msg.Contains('acquisition/score')) "7: score 405 -> INCONCLUSIVE ($msg)"

# 8) A 302 whose Location merely CONTAINS the Access host is not Access.
Reset-Mock
$script:Responses[$apex] = @('302 https://evil.example/?next=cloudflareaccess.com')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -match '^GATE CHECK INCONCLUSIVE') "8: look-alike Location -> INCONCLUSIVE ($msg)"
Assert-True (-not (Test-AccessLocation -Location 'https://cloudflareaccess.com.evil.example/x' -AccessHost $accessHost)) '8b: suffix look-alike host rejected'
Assert-True (-not (Test-AccessLocation -Location 'http://zephyr.cloudflareaccess.com/x' -AccessHost $accessHost)) '8c: plain-http Access location rejected'
Assert-True (Test-AccessLocation -Location 'https://zephyr.cloudflareaccess.com/cdn-cgi/access/login/x' -AccessHost $accessHost) '8d: team Access host accepted'

# 9) Flapping edge: 200 on attempt 1, 302 on attempt 2 -- the observed exposure is NOT laundered.
Reset-Mock
$script:Responses[$alias + 'snapshot.json'] = @('200', '302 https://zephyr.cloudflareaccess.com/cdn-cgi/access/login/x')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -match '^GATE CHECK FAILED') "9: 200-then-302 -> FAILED ($msg)"

# 10) Transient miss then 302 (the 2026-07-09 incident shape) still verifies.
Reset-Mock
$script:Responses[$apex] = @('0', '302 https://zephyr.cloudflareaccess.com/cdn-cgi/access/login/x')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast }
Assert-True ($msg -eq '') "10: transient 0 then 302 -> passes ($msg)"

# 11) Exhausted budget: unreached targets count as unverified (fail closed, never pass).
Reset-Mock
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast -BudgetSeconds -1 }
Assert-True ($msg -match '^GATE CHECK INCONCLUSIVE' -and $msg -match 'budget') "11: budget exhausted -> INCONCLUSIVE ($msg)"

# 12) -Context is appended (the deploy-timeout path passes its reason).
Reset-Mock
$script:Responses[$apex] = @('200')
$msg = Get-ThrownMessage { Assert-AccessGateOnAllTargets -Targets $targets @fast -Context 'zephyr-timeout-reason' }
Assert-True ($msg -match '^GATE CHECK FAILED' -and $msg.Contains('zephyr-timeout-reason')) "12: context appended ($msg)"

# 13) Invoke-NativeCommandWithTimeout -OutputFile captures the child's stdout+stderr to the file.
$outFile = Join-Path $env:TEMP ("agp-smoke-" + [guid]::NewGuid().ToString('N') + '.log')
$r = Invoke-NativeCommandWithTimeout -Executable 'cmd.exe' -Arguments @('/c', 'echo', 'zephyr-wrangler-out') -TimeoutSeconds 30 -OutputFile $outFile
$captured = if (Test-Path -LiteralPath $outFile) { Get-Content -LiteralPath $outFile -Raw } else { '' }
Assert-True ($r.ExitCode -eq 0 -and $captured -match 'zephyr-wrangler-out') "13: -OutputFile captured output ('$($captured.Trim())')"
if (Test-Path -LiteralPath $outFile) { Remove-Item -LiteralPath $outFile -Force }
$msg = Get-ThrownMessage { Invoke-NativeCommandWithTimeout -Executable 'cmd.exe' -Arguments @('/c', 'echo') -TimeoutSeconds 5 -OutputFile 'C:\x" & echo pwned' }
Assert-True ($msg -match 'OutputFile') "13b: unsafe -OutputFile rejected ($msg)"

if ($failures.Count -gt 0) {
  Write-Host "`n$($failures.Count) FAILURE(S)"
  exit 1
}
Write-Host "`nALL PASS"
exit 0

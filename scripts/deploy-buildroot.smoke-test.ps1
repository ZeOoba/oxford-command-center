<#
  Regression smoke test for scripts/lib/deploy-buildroot.ps1.

  This repo has no Pester convention for PowerShell (see deploy-mirror.smoke-test.ps1), so this is
  a plain run-by-hand assertion script, matching that precedent.

  WHY THESE ASSERTIONS. The build root is refreshed with `git reset --hard` + `git clean -fd`.
  Pointed at the wrong directory that is a working-tree destroyer -- it would delete exactly the
  kind of uncommitted, unpushed, multi-session WIP that this whole change exists to stop building.
  Assert-BuildRootIsolated is the only thing standing between "isolated build" and "wipes Gabriel's
  repo", so its refusal cases are tested far harder than its accept case.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-buildroot.smoke-test.ps1
  Exits 0 if all assertions pass, 1 otherwise.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\deploy-buildroot.ps1')

$failures = @()
function Assert-True($cond, $label) {
  if ($cond) { Write-Host "  PASS  $label" } else { $script:failures += $label; Write-Host "  FAIL  $label" }
}
function Assert-Throws([scriptblock]$sb, $label) {
  try { & $sb; $script:failures += $label; Write-Host "  FAIL  $label (did not throw)" }
  catch { Write-Host "  PASS  $label" }
}

Write-Host "=== Assert-BuildRootIsolated: refusal cases (the destructive-operation gate) ==="

$repo = 'C:\Users\Owner\oxford-command-center'

Assert-Throws { Assert-BuildRootIsolated -RepoRoot $repo -BuildRoot $repo } `
  'refuses a build root IDENTICAL to the canonical repo'

# Windows paths are case-insensitive: a differing-case string is the SAME directory on disk, and a
# naive -ne comparison would happily reset --hard the canonical checkout.
Assert-Throws { Assert-BuildRootIsolated -RepoRoot $repo -BuildRoot 'c:\users\owner\OXFORD-command-center' } `
  'refuses the same path in different case'

# Trailing separators are another way to spell the same directory.
Assert-Throws { Assert-BuildRootIsolated -RepoRoot $repo -BuildRoot "$repo\" } `
  'refuses the same path with a trailing separator'

Assert-Throws { Assert-BuildRootIsolated -RepoRoot $repo -BuildRoot (Join-Path $repo 'build') } `
  'refuses a build root NESTED inside the canonical repo'

# Cleaning a parent would take the canonical repo with it.
Assert-Throws { Assert-BuildRootIsolated -RepoRoot $repo -BuildRoot 'C:\Users\Owner' } `
  'refuses a build root that CONTAINS the canonical repo'

Assert-Throws { Assert-BuildRootIsolated -RepoRoot $repo -BuildRoot '' } `
  'refuses an empty build root'

# A sibling whose name merely starts with the repo path must NOT be mistaken for a nested path by a
# plain StartsWith check -- but it is also genuinely NOT nested, so it must be ACCEPTED.
Assert-True (Assert-BuildRootIsolated -RepoRoot $repo -BuildRoot "$repo-deploy") `
  'accepts a sibling whose name shares the repo prefix (StartsWith is not enough)'

Assert-True (Assert-BuildRootIsolated -RepoRoot $repo -BuildRoot 'C:\Users\Owner\oxford-cc-deploy') `
  'accepts a genuine sibling directory'

Write-Host ""
Write-Host "=== Import-DotEnvIntoEnvironment: parsing + precedence ==="

$envFile = Join-Path $env:TEMP "buildroot-smoke-$([guid]::NewGuid()).env"
@(
  '# a comment',
  '',
  'SMOKE_PLAIN=hello',
  'SMOKE_QUOTED="quoted value"',
  "SMOKE_SINGLE='single value'",
  'SMOKE_EQUALS=key=with=equals',
  '  SMOKE_SPACED  =  spaced  ',
  'not a valid line',
  'SMOKE_EXISTING=from-file'
) | Set-Content -Path $envFile -Encoding UTF8

# Precedence must match server/load-env.ts: a real, non-empty env var WINS over the file, so the
# deploy can override without editing .env. An empty one must be filled.
$env:SMOKE_EXISTING = 'from-environment'
$env:SMOKE_EMPTY = ''
Remove-Item Env:\SMOKE_PLAIN -ErrorAction SilentlyContinue

$count = Import-DotEnvIntoEnvironment -Path $envFile

Assert-True ($env:SMOKE_PLAIN -eq 'hello')                  'parses a plain KEY=VALUE'
Assert-True ($env:SMOKE_QUOTED -eq 'quoted value')          'strips double quotes'
Assert-True ($env:SMOKE_SINGLE -eq 'single value')          'strips single quotes'
Assert-True ($env:SMOKE_EQUALS -eq 'key=with=equals')       'keeps = characters in the value'
Assert-True ($env:SMOKE_SPACED -eq 'spaced')                'trims surrounding whitespace'
Assert-True ($env:SMOKE_EXISTING -eq 'from-environment')    'does NOT override an existing non-empty var'
# EXACT, not >=: the file holds 6 valid assignments and SMOKE_EXISTING must be skipped by
# precedence, so 5 is the only correct answer. A >= assertion would pass even if precedence broke.
Assert-True ($count -eq 5)                                  'imports exactly the 5 fillable vars (skips the precedence-protected one)'

Assert-True ((Import-DotEnvIntoEnvironment -Path (Join-Path $env:TEMP 'definitely-absent.env')) -eq 0) `
  'returns 0 for an absent .env rather than throwing'

Remove-Item $envFile -ErrorAction SilentlyContinue
foreach ($v in 'SMOKE_PLAIN','SMOKE_QUOTED','SMOKE_SINGLE','SMOKE_EQUALS','SMOKE_SPACED','SMOKE_EXISTING','SMOKE_EMPTY') {
  Remove-Item "Env:\$v" -ErrorAction SilentlyContinue
}

Write-Host "=== Copy-RealDataIntoBuildRoot: real data in, synthetic never (ruling 2026-11-10) ==="

function New-SmokeTree([string]$name) {
  $d = Join-Path ([System.IO.Path]::GetTempPath()) ("deploy-realdata-$name-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  $d
}
function Write-SmokeFile([string]$root, [string]$rel, [string]$text) {
  $p = Join-Path $root ($rel -replace '/', '\')
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
  Set-Content -LiteralPath $p -Value $text -NoNewline -Encoding ASCII
}
$canon = New-SmokeTree 'canon'
$build = New-SmokeTree 'build'
$manifestJson = '{"files":["data/snapshots/portfolio.json"],"dirs":["data/calibration/"]}'
Write-SmokeFile $build 'scripts/fixtures/real-data-manifest.json' $manifestJson
Write-SmokeFile $canon 'fixtures/synthetic/data/snapshots/portfolio.json' '{"synthetic":true}'
Write-SmokeFile $canon 'data/snapshots/portfolio.json' '{"real":true}'
Write-SmokeFile $canon 'data/calibration/observations.json' '[1]'

Assert-True ((Copy-RealDataIntoBuildRoot -RepoRoot $canon -BuildRoot $build) -eq 2) 'copies every manifest file and every file under a manifest dir'
Assert-True ((Get-Content -LiteralPath (Join-Path $build 'data\snapshots\portfolio.json') -Raw) -eq '{"real":true}') 'the build root gets the REAL bytes'

Remove-Item -LiteralPath (Join-Path $canon 'data\snapshots\portfolio.json')
Assert-Throws { Copy-RealDataIntoBuildRoot -RepoRoot $canon -BuildRoot $build } 'fails closed when a manifest file is missing from the canonical checkout'
Write-SmokeFile $canon 'data/snapshots/portfolio.json' '{"synthetic":true}'
Assert-Throws { Copy-RealDataIntoBuildRoot -RepoRoot $canon -BuildRoot $build } 'fails closed when a canonical file is byte-identical to its synthetic stand-in'
Write-SmokeFile $canon 'data/snapshots/portfolio.json' '{"real":2}'
Write-SmokeFile $canon 'data/.synthetic-seeded.json' '{"seeded":["data/snapshots/portfolio.json"]}'
Assert-Throws { Copy-RealDataIntoBuildRoot -RepoRoot $canon -BuildRoot $build } 'fails closed when a canonical file is listed in data/.synthetic-seeded.json'
Remove-Item -LiteralPath (Join-Path $canon 'data\.synthetic-seeded.json')
Write-SmokeFile $build 'data/calibration/stale-synthetic.json' '[]'
Assert-Throws { Copy-RealDataIntoBuildRoot -RepoRoot $canon -BuildRoot $build } 'fails closed on a build-root file under a manifest dir the canonical checkout lacks'
Remove-Item -LiteralPath (Join-Path $build 'data\calibration\stale-synthetic.json')
Write-SmokeFile $build 'data/.synthetic-seeded.json' '{"seeded":[]}'
Assert-Throws { Copy-RealDataIntoBuildRoot -RepoRoot $canon -BuildRoot $build } 'fails closed when the build root itself was seeded'
Remove-Item -LiteralPath $canon, $build -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "=== Install-DeployBuildRootDeps: the deps stamp survives the sync's git clean -fd ==="
# 2026-11-13: the stamp lived at <buildRoot>\.deploy-deps-stamp -- untracked and NOT ignored -- so
# Sync-DeployBuildRoot's own `git clean -fd` deleted it every run, every hourly run did a full
# `npm ci`, and overnight runs hit the task's 30-minute ExecutionTimeLimit before reaching wrangler.
# This runs the same clean against a real git tree with node_modules/ ignored, then asserts the
# skip path still fires. npm is never invoked: a matching stamp returns $false before it.
$deps = New-SmokeTree 'deps'
Push-Location $deps
# git writes advisories (CRLF) to stderr, which Windows PowerShell turns into a terminating error under 'Stop'.
$savedEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & git init -q . 2>$null
  Write-SmokeFile $deps '.gitignore' "node_modules/`n"
  Write-SmokeFile $deps 'package-lock.json' '{"lockfileVersion":3}'
  & git add .gitignore package-lock.json 2>$null
  & git -c user.email=smoke@example.invalid -c user.name=smoke commit -q -m init 2>$null
  New-Item -ItemType Directory -Force -Path (Join-Path $deps 'node_modules') | Out-Null
  $stampPath = Get-DeployDepsStampPath -BuildRoot $deps
  $lockHash = (Get-FileHash -LiteralPath (Join-Path $deps 'package-lock.json') -Algorithm SHA256).Hash
  $key = Get-DeployDepsKey -BuildRoot $deps -NodeRuntime '137-x64'
  Assert-True ($key -eq "$lockHash|node-137-x64") 'the deps key is <lockfile SHA256>|node-<ABI>-<arch>'
  Set-Content -LiteralPath $stampPath -Value $key -Encoding ASCII
  & git -C $deps clean -fd 2>$null | Out-Null
  Assert-True (Test-Path -LiteralPath $stampPath) 'the deps stamp survives git clean -fd (the exact clean Sync-DeployBuildRoot runs)'
  Assert-True ((Install-DeployBuildRootDeps -BuildRoot $deps -NodeRuntime '137-x64') -eq $false) 'a matching stamp after the clean skips npm ci'

  # Refute wf_27705618-22a: a Node major upgrade must force npm ci (native modules are per-ABI).
  Assert-True (-not (Test-DeployDepsCurrent -BuildRoot $deps -NodeRuntime '141-x64')) 'a different Node ABI is not current (npm ci re-runs)'
  Assert-True (-not (Test-DeployDepsCurrent -BuildRoot $deps -NodeRuntime '137-arm64')) 'a different arch is not current'
  Assert-True (-not (Test-DeployDepsCurrent -BuildRoot $deps -NodeRuntime '')) 'an unrunnable node is never current'
  Set-Content -LiteralPath $stampPath -Value $lockHash -Encoding ASCII
  Assert-True (-not (Test-DeployDepsCurrent -BuildRoot $deps -NodeRuntime '137-x64')) 'an old lockfile-only stamp is not current (one npm ci after upgrade to this key)'
  Set-Content -LiteralPath $stampPath -Value $key -Encoding ASCII
  Write-SmokeFile $deps 'package-lock.json' '{"lockfileVersion":3,"changed":true}'
  Assert-True (-not (Test-DeployDepsCurrent -BuildRoot $deps -NodeRuntime '137-x64')) 'a lockfile change is not current'
  Write-SmokeFile $deps 'package-lock.json' '{"lockfileVersion":3}'
  Remove-Item -LiteralPath (Join-Path $deps 'node_modules') -Recurse -Force
  Assert-True (-not (Test-DeployDepsCurrent -BuildRoot $deps -NodeRuntime '137-x64')) 'no node_modules is not current'

  # Refute wf_9e1d05e9-ca9: a 0-byte stamp (a run killed mid-write) is not current, and does not throw.
  New-Item -ItemType Directory -Force -Path (Join-Path $deps 'node_modules') | Out-Null
  Set-Content -LiteralPath $stampPath -Value '' -NoNewline -Encoding ASCII
  $ErrorActionPreference = 'Stop'
  $threw = $false
  try { $emptyCurrent = Test-DeployDepsCurrent -BuildRoot $deps -NodeRuntime '137-x64' } catch { $threw = $true }
  Assert-True ((-not $threw) -and (-not $emptyCurrent)) 'an empty stamp is not current and does not throw (under Stop)'
  # The real node read runs under 'Stop', as deploy-mirror.ps1 does.
  $threw = $false
  try { $rt = Get-DeployNodeRuntime } catch { $threw = $true }
  Assert-True ((-not $threw) -and ($rt -match '^\d+-\w+$')) 'Get-DeployNodeRuntime reads the node on PATH as <ABI>-<arch> (under Stop)'
  $ErrorActionPreference = 'Continue'
} finally {
  $ErrorActionPreference = $savedEap
  Pop-Location
  Remove-Item -LiteralPath $deps -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "=== Sync-DeployBuildRoot: returns ONLY the short HEAD sha ==="
# 2026-11-13: git's stdout ("HEAD is now at <sha> <subject>" from reset --hard, "Removing <file>"
# from clean -fd, worktree add's "Preparing worktree") leaked into the function's return value, so
# the step log read "deps-check (build root @ HEAD is now at 9994e288 fix(mirror): ... 9994e288)".
# Real git, both paths: first call creates the worktree, second resets and cleans it.
$syncRepo = New-SmokeTree 'sync-repo'
$syncBuild = Join-Path ([System.IO.Path]::GetTempPath()) ('deploy-sync-build-' + [guid]::NewGuid().ToString('N'))
$savedEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & git -C $syncRepo init -q 2>$null
  Write-SmokeFile $syncRepo 'tracked.txt' 'v1'
  & git -C $syncRepo add tracked.txt 2>$null
  & git -C $syncRepo -c user.email=smoke@example.invalid -c user.name=smoke commit -q -m 'smoke subject line' 2>$null
  $expected = (& git -C $syncRepo rev-parse --short HEAD 2>$null)
  $ErrorActionPreference = 'Stop'

  $created = @(Sync-DeployBuildRoot -RepoRoot $syncRepo -BuildRoot $syncBuild -Ref 'HEAD')
  Assert-True ($created.Count -eq 1 -and $created[0] -eq $expected) "create path returns exactly the sha (got: $($created -join ' | '))"

  Write-SmokeFile $syncBuild 'untracked-junk.txt' 'x'
  Write-SmokeFile $syncBuild 'tracked.txt' 'drift'
  $reset = @(Sync-DeployBuildRoot -RepoRoot $syncRepo -BuildRoot $syncBuild -Ref 'HEAD')
  Assert-True ($reset.Count -eq 1 -and $reset[0] -eq $expected) "reset+clean path returns exactly the sha (got: $($reset -join ' | '))"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $syncBuild 'untracked-junk.txt'))) 'the clean still removed the untracked file'
  Assert-True ((Get-Content -LiteralPath (Join-Path $syncBuild 'tracked.txt') -Raw) -eq 'v1') 'the reset still restored the tracked file'
  # git now runs inside a pipeline (| ForEach-Object): its exit code must still reach the check.
  # Message-matched (refute wf_3b03928e-67a): the throw must come from the explicit $LASTEXITCODE check.
  $msg = ''
  try { Sync-DeployBuildRoot -RepoRoot $syncRepo -BuildRoot $syncBuild -Ref 'no-such-ref-smoke' | Out-Null } catch { $msg = $_.Exception.Message }
  Assert-True ($msg -like 'git reset --hard no-such-ref-smoke failed in build root (*)') "a failing git reset throws from the exit-code check (got: $msg)"
  $freshBuild = Join-Path ([System.IO.Path]::GetTempPath()) ('deploy-sync-build2-' + [guid]::NewGuid().ToString('N'))
  $msg = ''
  try { Sync-DeployBuildRoot -RepoRoot $syncRepo -BuildRoot $freshBuild -Ref 'no-such-ref-smoke' | Out-Null } catch { $msg = $_.Exception.Message }
  Assert-True ($msg -like 'git worktree add failed (*)') "a failing worktree add throws from the exit-code check (got: $msg)"
  Remove-Item -LiteralPath $freshBuild -Recurse -Force -ErrorAction SilentlyContinue
} finally {
  $ErrorActionPreference = $savedEap
  & git -C $syncRepo worktree remove --force $syncBuild 2>$null | Out-Null
  Remove-Item -LiteralPath $syncBuild, $syncRepo -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($failures.Count) {
  Write-Host "FAILED ($($failures.Count)):"
  $failures | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
Write-Host "All deploy-buildroot assertions passed."
exit 0

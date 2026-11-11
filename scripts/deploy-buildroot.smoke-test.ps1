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

Write-Host ""
if ($failures.Count) {
  Write-Host "FAILED ($($failures.Count)):"
  $failures | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
Write-Host "All deploy-buildroot assertions passed."
exit 0

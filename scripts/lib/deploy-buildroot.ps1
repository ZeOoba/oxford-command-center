<#
  Isolated build root for the mirror deploy.

  INCIDENT THIS EXISTS FOR (2026-08-16). The hourly deploy fast-forwarded git and then built
  WHATEVER WAS CHECKED OUT ON DISK. Another session left an uncommitted test file in the shared
  checkout at 14:13; it failed `tsc --noEmit` with TS7016, `build:mirror` exited 2, and every
  subsequent hourly run failed the same way. The mirror silently kept serving the 13:00 bake.

  This is the same CLASS as the 2026-07-09 incident, whose fix added the git fast-forward. That
  addressed stale code coming FROM ORIGIN but did nothing about uncommitted LOCAL work -- the
  shared checkout is a multi-session development surface, so "what is on disk" is never a safe
  build input for a production deploy.

  THE FIX: build from a dedicated worktree pinned to origin/main. The canonical checkout is then
  only a source of git objects and machine state, never of build content.

  WHAT DELIBERATELY STAYS IN THE CANONICAL REPO: the beacon (data/_state/), the alert-state digest
  (data/alert-state/) and the outbox (data/outbox/). mirror-run-classify.ps1 and the health monitor
  read those from the repo root; relocating them would silently blind both.
#>

Set-StrictMode -Version Latest

function Get-DeployBuildRoot {
  <#
    .SYNOPSIS Default isolated build root: a SIBLING of the canonical repo.
    .DESCRIPTION
      Sibling, never nested. A build root inside the repo would be swept by the repo's own
      tooling and would make `git clean` semantics ambiguous between the two trees.
  #>
  param([Parameter(Mandatory)][string]$RepoRoot)
  if ($env:MIRROR_BUILD_ROOT) { return $env:MIRROR_BUILD_ROOT }
  $parent = Split-Path -Parent $RepoRoot
  $leaf = Split-Path -Leaf $RepoRoot
  Join-Path $parent "$leaf-deploy-build"
}

function ConvertTo-ComparablePath {
  <# Normalize for comparison: absolute-ish, no trailing separator, lower-cased (Windows paths are
     case-insensitive, so a case difference is the SAME directory, not a different one). #>
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
  $p = $Path.Trim()
  # Do NOT use Resolve-Path: the build root legitimately may not exist yet on a first run.
  try { $p = [System.IO.Path]::GetFullPath($p) } catch { return '' }
  $p = $p.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $p.ToLowerInvariant()
}

function Assert-BuildRootIsolated {
  <#
    .SYNOPSIS Refuse to proceed unless the build root is genuinely separate from the canonical repo.
    .DESCRIPTION
      THE SAFETY GATE. Sync-DeployBuildRoot runs `git reset --hard` and `git clean -fd` inside the
      build root. Pointed at the canonical checkout, that destroys exactly the uncommitted
      multi-session WIP this change exists to stop building -- unrecoverably, since it is unpushed.
      Every refusal here is cheap; the failure it prevents is not.
    .OUTPUTS $true when isolated. Throws otherwise.
  #>
  param(
    [Parameter(Mandatory)][string]$RepoRoot,
    [AllowEmptyString()][string]$BuildRoot
  )
  $r = ConvertTo-ComparablePath $RepoRoot
  $b = ConvertTo-ComparablePath $BuildRoot
  if (-not $b) { throw "Build root is empty or unresolvable -- refusing to run destructive git operations." }
  if (-not $r) { throw "Repo root is empty or unresolvable -- refusing to run destructive git operations." }
  if ($b -eq $r) { throw "Build root resolves to the CANONICAL repo ($RepoRoot) -- refusing (reset --hard would destroy uncommitted work)." }

  # Separator-anchored containment. A bare StartsWith would wrongly flag the legitimate sibling
  # `<repo>-deploy-build` as nested, because its string genuinely starts with the repo path.
  $sep = [System.IO.Path]::DirectorySeparatorChar
  if ($b.StartsWith("$r$sep")) { throw "Build root ($BuildRoot) is INSIDE the canonical repo -- refusing." }
  if ($r.StartsWith("$b$sep")) { throw "Build root ($BuildRoot) CONTAINS the canonical repo -- refusing (cleaning it would take the repo with it)." }
  $true
}

# Keys honoured ONLY from the real process environment, never imported from .env (audit
# wf_9bf74429-aaf finding 31). Mirrors server/load-env.ts PROCESS_ENV_ONLY_KEYS;
# tests/unit/mirror-mode.test.ts pins the two lists together. deploy-mirror.ps1 sets both itself,
# and only after its pre-deploy Access probe passed.
$script:ProcessEnvOnlyKeys = @('MIRROR_INCLUDE_CONFIDENTIAL', 'MIRROR_ACCESS_PREPROBE')

function Import-DotEnvIntoEnvironment {
  <#
    .SYNOPSIS Load the canonical repo's .env into THIS process's environment.
    .DESCRIPTION
      The build root is a clean checkout, so it has no .env (gitignored) -- and the bake needs
      those credentials. Rather than copying a secrets file into a second on-disk location, the
      values are injected into the environment the child npm process inherits.

      Precedence deliberately MIRRORS server/load-env.ts: an existing NON-EMPTY environment
      variable wins; missing-or-empty ones are filled. Diverging here would mean the deploy and the
      dev server resolve the same key differently, which is the kind of difference that only
      surfaces in production.
    .OUTPUTS Count of variables imported.
  #>
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  $n = 0
  foreach ($line in (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
    $m = [regex]::Match($line, '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$')
    if (-not $m.Success) { continue }
    $key = $m.Groups[1].Value
    if ($script:ProcessEnvOnlyKeys -contains $key) { continue }
    $value = $m.Groups[2].Value -replace '^([''"])(.*)\1$', '$2'
    $existing = [System.Environment]::GetEnvironmentVariable($key)
    if ([string]::IsNullOrEmpty($existing)) {
      Set-Item -Path "Env:\$key" -Value $value
      $n++
    }
  }
  $n
}

function Sync-DeployBuildRoot {
  <#
    .SYNOPSIS Create or refresh the isolated build root at the given ref.
    .DESCRIPTION
      First run creates a git worktree. Later runs hard-reset it to the ref and clean it, so the
      build root can never accumulate drift of its own and become a second stale surface.

      Callers MUST have passed Assert-BuildRootIsolated first; this asserts again rather than
      trusting the caller, because everything below this line is destructive.
  #>
  param(
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][string]$BuildRoot,
    [string]$Ref = 'origin/main'
  )
  Assert-BuildRootIsolated -RepoRoot $RepoRoot -BuildRoot $BuildRoot | Out-Null

  if (-not (Test-Path -LiteralPath (Join-Path $BuildRoot '.git'))) {
    Write-Host "  Creating isolated build worktree at $BuildRoot"
    if (Test-Path -LiteralPath $BuildRoot) {
      throw "Build root $BuildRoot exists but is not a git worktree -- refusing to overwrite an unknown directory."
    }
    # Every git command's stdout goes to the HOST, never the pipeline: this function returns the
    # short sha, and git's "Preparing worktree" / "HEAD is now at <sha> <subject>" / "Removing <file>"
    # lines used to come back with it (2026-11-13 step log: "build root @ HEAD is now at ...").
    & git -C $RepoRoot worktree add --detach $BuildRoot $Ref | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "git worktree add failed ($LASTEXITCODE)" }
  } else {
    & git -C $BuildRoot reset --hard $Ref | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "git reset --hard $Ref failed in build root ($LASTEXITCODE)" }
    # -fd, NOT -fdx: node_modules is gitignored and rebuilding it hourly would add minutes to every
    # run for no benefit. Tracked-file drift is what must not survive.
    & git -C $BuildRoot clean -fd | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "git clean failed in build root ($LASTEXITCODE)" }
  }

  $head = (& git -C $BuildRoot rev-parse --short HEAD 2>$null)
  Write-Host "  Build root synced to $Ref (HEAD $head)"
  $head
}

function Get-DeployDepsStampPath {
  <#
    .SYNOPSIS Where Install-DeployBuildRootDeps records the deps key (lockfile SHA256 + Node ABI/arch) it last installed for.
    .DESCRIPTION
      Inside node_modules/, which .gitignore covers, so Sync-DeployBuildRoot's `git clean -fd` (no -x)
      keeps it. It used to sit at <buildRoot>\.deploy-deps-stamp -- untracked and NOT ignored -- so that
      clean deleted it every run and every hourly deploy did a full `npm ci`; overnight runs then hit
      the task's 30-minute ExecutionTimeLimit before reaching wrangler (2026-11-13). `npm ci` wipes
      node_modules, and the stamp is written only after it succeeds, so a failed install leaves none.
  #>
  param([Parameter(Mandatory)][string]$BuildRoot)
  Join-Path (Join-Path $BuildRoot 'node_modules') '.deploy-deps-stamp'
}

function Get-DeployNodeRuntime {
  <# The running node's native-module ABI and arch ('137-x64'), or '' when node cannot be run. #>
  try {
    $out = (& node -p "process.versions.modules + '-' + process.arch" 2>$null)
    if ($LASTEXITCODE -eq 0 -and $out) { return ([string]$out).Trim() }
  } catch { }
  ''
}

function Get-DeployDepsKey {
  <#
    .SYNOPSIS What node_modules was installed FOR: '<lockfile SHA256>|node-<ABI>-<arch>'.
    .DESCRIPTION
      The lockfile alone is not enough (refute wf_27705618-22a): native modules (better-sqlite3) are
      compiled for one Node ABI. Before the stamp survived `git clean -fd`, every run re-ran `npm ci`
      and so rebuilt them; with the skip working, a Node major upgrade on the deploy host would keep
      the old binary, and every warehouse read in the bake (governors, the brief's insurance alerts)
      would fail open with nothing visible. Keying on the ABI and arch forces `npm ci` after such an
      upgrade. Returns $null when node cannot be run, so the deps are never treated as current.
  #>
  param(
    [Parameter(Mandatory)][string]$BuildRoot,
    # Test seam: the runtime string to key on instead of asking the node on PATH.
    [string]$NodeRuntime
  )
  $lock = Join-Path $BuildRoot 'package-lock.json'
  if (-not (Test-Path -LiteralPath $lock)) { return $null }
  $runtime = if ($PSBoundParameters.ContainsKey('NodeRuntime')) { $NodeRuntime } else { Get-DeployNodeRuntime }
  if (-not $runtime) { return $null }
  '{0}|node-{1}' -f (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash, $runtime
}

function Test-DeployDepsCurrent {
  <# True only when node_modules exists and its stamp equals Get-DeployDepsKey exactly. #>
  param(
    [Parameter(Mandatory)][string]$BuildRoot,
    [string]$NodeRuntime
  )
  $key = if ($PSBoundParameters.ContainsKey('NodeRuntime')) { Get-DeployDepsKey -BuildRoot $BuildRoot -NodeRuntime $NodeRuntime } else { Get-DeployDepsKey -BuildRoot $BuildRoot }
  if (-not $key) { return $false }
  $stamp = Get-DeployDepsStampPath -BuildRoot $BuildRoot
  if (-not (Test-Path -LiteralPath (Join-Path $BuildRoot 'node_modules'))) { return $false }
  if (-not (Test-Path -LiteralPath $stamp)) { return $false }
  # An empty or unreadable stamp (a run killed mid-write) is NOT current: npm ci re-runs and rewrites it.
  # Throwing here instead would fail every run, since the stamp now survives `git clean -fd` (refute wf_9e1d05e9-ca9).
  $prior = Get-Content -LiteralPath $stamp -Raw -ErrorAction SilentlyContinue
  if ([string]::IsNullOrWhiteSpace($prior)) { return $false }
  $prior.Trim() -ceq $key
}

function Install-DeployBuildRootDeps {
  <#
    .SYNOPSIS Ensure the build root has node_modules matching its lockfile and the running Node runtime.
    .DESCRIPTION
      `git worktree add` creates tracked files only -- no node_modules -- so a first run would fail
      with "vite is not recognized" rather than anything that names the real problem.

      Sync-DeployBuildRoot cleans with -fd (not -fdx), so node_modules SURVIVES between runs and
      this is normally a no-op. `npm ci` is re-run only when the lockfile or the Node runtime changes,
      tracked via a stamp file (Get-DeployDepsStampPath, Get-DeployDepsKey). Deciding on a content key
      rather than a timestamp means an unrelated touch does not trigger a multi-minute install inside
      the hourly budget.
  #>
  param(
    [Parameter(Mandatory)][string]$BuildRoot,
    # Test seam, passed through to Get-DeployDepsKey.
    [string]$NodeRuntime
  )

  $lock = Join-Path $BuildRoot 'package-lock.json'
  $stamp = Get-DeployDepsStampPath -BuildRoot $BuildRoot
  if (-not (Test-Path -LiteralPath $lock)) { throw "No package-lock.json in build root $BuildRoot -- refusing to npm ci." }

  $current = if ($PSBoundParameters.ContainsKey('NodeRuntime')) { Test-DeployDepsCurrent -BuildRoot $BuildRoot -NodeRuntime $NodeRuntime } else { Test-DeployDepsCurrent -BuildRoot $BuildRoot }
  if ($current) {
    Write-Host "  Build-root deps current (lockfile and Node runtime unchanged)"
    return $false
  }

  Write-Host "  Installing build-root deps (npm ci) -- lockfile or Node runtime changed, or node_modules absent"
  Push-Location $BuildRoot
  try {
    # stdout to the HOST, not the pipeline: this function returns a bool (installed or not), and npm's
    # output used to come back with it as an array (refute wf_3b03928e-67a, same leak as Sync-DeployBuildRoot).
    npm ci | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed in build root ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
  $key = if ($PSBoundParameters.ContainsKey('NodeRuntime')) { Get-DeployDepsKey -BuildRoot $BuildRoot -NodeRuntime $NodeRuntime } else { Get-DeployDepsKey -BuildRoot $BuildRoot }
  # No key (node not runnable) means no stamp: the next run installs again rather than trusting it.
  if ($key) { Set-Content -LiteralPath $stamp -Value $key -Encoding ASCII }
  $true
}

function Copy-RealDataIntoBuildRoot {
  <#
    .SYNOPSIS Supply every real-data manifest path to the build root from the canonical checkout.
    .DESCRIPTION
      Real firm data is never tracked (ruling 2026-11-10): every path in
      scripts/fixtures/real-data-manifest.json is gitignored and local-only, so the clean build root
      has none of it -- like .env and WAREHOUSE_DB, it must come from the canonical checkout. A
      production mirror must NEVER ship the committed synthetic stand-ins, so this fails closed,
      before any bake, when:
        - a manifest file (or a manifest directory) is missing from the canonical checkout,
        - a canonical file is listed in data/.synthetic-seeded.json or is byte-identical to its
          fixtures/synthetic/ stand-in,
        - the build root holds a seed marker, or a file under a manifest directory that the
          canonical checkout does not have (a stale synthetic left by an earlier seeding).
      The caller sets ORA_NO_SYNTHETIC_SEED=1 for the build root so `npm ci` never seeds it.
  #>
  param(
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][string]$BuildRoot
  )
  $manifestPath = Join-Path $BuildRoot 'scripts\fixtures\real-data-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw "No real-data manifest in build root ($manifestPath) -- refusing to bake." }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

  $seeded = @()
  $marker = Join-Path $RepoRoot 'data\.synthetic-seeded.json'
  if (Test-Path -LiteralPath $marker) {
    try { $seeded = @((Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).seeded) } catch { throw "Unreadable $marker -- refusing to bake." }
  }
  if (Test-Path -LiteralPath (Join-Path $BuildRoot 'data\.synthetic-seeded.json')) {
    throw "The build root holds data\.synthetic-seeded.json (it was seeded with synthetic stand-ins) -- refusing to bake."
  }

  $rels = New-Object System.Collections.Generic.List[string]
  # `optional` is absent from older manifests; StrictMode forbids reading a missing property.
  $optional = @(if ($manifest.PSObject.Properties['optional']) { @($manifest.optional) })
  foreach ($f in @($manifest.files)) { $rels.Add([string]$f) }
  foreach ($d in @($manifest.dirs)) {
    $src = Join-Path $RepoRoot ($d -replace '/', '\')
    if (-not (Test-Path -LiteralPath $src)) { throw "Real-data directory missing from the canonical checkout: $d -- refusing to bake." }
    foreach ($file in Get-ChildItem -LiteralPath $src -Recurse -File) {
      $rels.Add(($d.TrimEnd('/') + '/' + $file.FullName.Substring($src.TrimEnd('\').Length + 1).Replace('\', '/')))
    }
    $dst = Join-Path $BuildRoot ($d -replace '/', '\')
    if (Test-Path -LiteralPath $dst) {
      foreach ($file in Get-ChildItem -LiteralPath $dst -Recurse -File) {
        $rel = $file.FullName.Substring($dst.TrimEnd('\').Length + 1)
        if (-not (Test-Path -LiteralPath (Join-Path $src $rel))) { throw "Build root has $d$rel that the canonical checkout does not (stale stand-in?) -- refusing to bake." }
      }
    }
  }

  foreach ($rel in $rels) {
    # Optional manifest files (value locks, local operator tables) are never bake inputs.
    if ($optional -contains $rel) { continue }
    $src = Join-Path $RepoRoot ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $src)) { throw "Real-data file missing from the canonical checkout: $rel -- refusing to bake (restore it; see docs/ops/2026-11-11-real-data-untrack-pull-runbook.md)." }
    if ($seeded -contains $rel) { throw "Canonical $rel is listed in data\.synthetic-seeded.json (synthetic stand-in) -- refusing to bake." }
    $fixture = Join-Path $RepoRoot ('fixtures\synthetic\' + ($rel -replace '/', '\'))
    if ((Test-Path -LiteralPath $fixture) -and ((Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash)) {
      throw "Canonical $rel is byte-identical to its synthetic stand-in -- refusing to bake."
    }
    $dst = Join-Path $BuildRoot ($rel -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
  }
  Write-Host "  Supplied $($rels.Count) real-data file(s) from the canonical checkout"
  $rels.Count
}

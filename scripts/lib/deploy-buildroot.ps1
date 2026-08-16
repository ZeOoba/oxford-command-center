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
    & git -C $RepoRoot worktree add --detach $BuildRoot $Ref
    if ($LASTEXITCODE -ne 0) { throw "git worktree add failed ($LASTEXITCODE)" }
  } else {
    & git -C $BuildRoot reset --hard $Ref
    if ($LASTEXITCODE -ne 0) { throw "git reset --hard $Ref failed in build root ($LASTEXITCODE)" }
    # -fd, NOT -fdx: node_modules is gitignored and rebuilding it hourly would add minutes to every
    # run for no benefit. Tracked-file drift is what must not survive.
    & git -C $BuildRoot clean -fd
    if ($LASTEXITCODE -ne 0) { throw "git clean failed in build root ($LASTEXITCODE)" }
  }

  $head = (& git -C $BuildRoot rev-parse --short HEAD 2>$null)
  Write-Host "  Build root synced to $Ref (HEAD $head)"
  $head
}

function Install-DeployBuildRootDeps {
  <#
    .SYNOPSIS Ensure the build root has node_modules matching its lockfile.
    .DESCRIPTION
      `git worktree add` creates tracked files only -- no node_modules -- so a first run would fail
      with "vite is not recognized" rather than anything that names the real problem.

      Sync-DeployBuildRoot cleans with -fd (not -fdx), so node_modules SURVIVES between runs and
      this is normally a no-op. `npm ci` is re-run only when the lockfile actually changes, tracked
      via a stamp file. Deciding on the lockfile hash rather than a timestamp means an unrelated
      touch does not trigger a multi-minute install inside the hourly budget.
  #>
  param([Parameter(Mandatory)][string]$BuildRoot)

  $lock = Join-Path $BuildRoot 'package-lock.json'
  $modules = Join-Path $BuildRoot 'node_modules'
  $stamp = Join-Path $BuildRoot '.deploy-deps-stamp'

  if (-not (Test-Path -LiteralPath $lock)) { throw "No package-lock.json in build root $BuildRoot -- refusing to npm ci." }
  $lockHash = (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash
  $priorHash = if (Test-Path -LiteralPath $stamp) { (Get-Content -LiteralPath $stamp -Raw).Trim() } else { '' }

  if ((Test-Path -LiteralPath $modules) -and $priorHash -eq $lockHash) {
    Write-Host "  Build-root deps current (lockfile unchanged)"
    return $false
  }

  Write-Host "  Installing build-root deps (npm ci) -- lockfile changed or node_modules absent"
  Push-Location $BuildRoot
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed in build root ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
  Set-Content -LiteralPath $stamp -Value $lockHash -Encoding ASCII
  $true
}

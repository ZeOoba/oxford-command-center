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
  [string]$AlertTo         = 'ggoldberg@oxfordra.net',
  # Upper bound for the wrangler deploy (step 3). Must stay comfortably BELOW the registered task's
  # ExecutionTimeLimit (PT30M) -- the whole point is that this script gets to fail on its own terms,
  # and still has time to send the alert, before Task Scheduler force-kills the tree and silences it.
  # 10 minutes is ~10x a normal deploy, so it only trips on a genuine stall. See the 2026-07-29 note
  # on step 3 below. Range floor (60s) keeps this meaningfully above a normal deploy; ceiling (1200s
  # = 20min) leaves headroom under PT30M for the fetch/build that precede it and the gate-check/alert
  # that follow -- added 2026-07-31 (security review) alongside the library-level ValidateRange in
  # Invoke-NativeCommandWithTimeout, after finding an out-of-range value could previously leave a
  # process running, unwaited and unkilled.
  [ValidateRange(60, 1200)]
  [int]$DeployTimeoutSeconds = 600,
  # Also bake the Fat Mirror payload (public/warehouse.json) in step 2 -- the COMPUTED PFI +
  # Calibration-read route payloads that make those two server-only modules work on the mirror,
  # and (Eric Live Phase 2) the cold-standby payload the edge proxy serves when the workstation
  # is asleep.
  #
  # OFF by default and deliberately NOT on the hourly task: the warehouse bake is RAM/IO-heavy
  # and contends with the live Brain Server's WAL lock, so it runs on its own DAILY schedule
  # (cadence decoupling -- spec section 2.2). The hourly snapshot bake must stay light.
  [switch]$IncludeWarehouse
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
# Invoke-GitFetchCapture lives in lib/git-capture.ps1 (shared with
# git-fetch-capture.smoke-test.ps1) -- see that file for why a plain
# `(& git fetch origin 2>&1 | Out-String)` is unsafe under $ErrorActionPreference = 'Stop'.
. (Join-Path $PSScriptRoot 'lib\git-capture.ps1')
# Invoke-NativeCommandWithTimeout lives in lib/native-timeout.ps1 (shared with
# native-command-timeout.smoke-test.ps1) -- see that file for why an unbounded external call here
# turns a transient upstream stall into a completely unalerted outage.
. (Join-Path $PSScriptRoot 'lib\native-timeout.ps1')
# Get-DeployBuildRoot / Assert-BuildRootIsolated / Sync-DeployBuildRoot / Import-DotEnvIntoEnvironment
# live in lib/deploy-buildroot.ps1 (shared with deploy-buildroot.smoke-test.ps1). See that file for
# the 2026-08-16 incident that motivated building outside the shared checkout.
. (Join-Path $PSScriptRoot 'lib\deploy-buildroot.ps1')
# Write-DeployBeacon* lives in lib/deploy-beacon.ps1 (shared with
# deploy-beacon.smoke-test.ps1). See that file for the full rationale; in short, the
# try/catch below can only report failures that THROW, and 0xC000013A (process killed --
# reboot, Modern Standby transition) never throws, so three such failures in the week of
# 2026-08-01 alerted nobody. The beacon is the out-of-process record that the run started
# and, separately, that it finished.
#
# Complements the deploy-timeout work (PR #248): that bounds a wrangler STALL so the script
# can fail on its own terms and still alert; this covers the case where the process is killed
# outright and never gets to alert at all. Neither subsumes the other.
. (Join-Path $PSScriptRoot 'lib\deploy-beacon.ps1')

# Invoke-AccessGateProbe -- extracted 2026-07-31 (security review) so the deploy-timeout path
# (step 3) can run the SAME Access-gate re-verification as the normal path (step 4), instead of
# skipping it entirely. Before this, a deploy that timed out never got its gate re-checked at all --
# meaning a PERSISTENT stall (the same transient-looking signature recurring hourly) left the one
# control that detects an Access-policy regression unrun for as long as the stall continued, even on
# runs where the mirror genuinely did publish before wrangler hung. Extracting to a shared function
# means both call sites can't silently drift the way the pre-extraction duplicated cmd-guard did.
function Invoke-AccessGateProbe {
  param(
    [Parameter(Mandatory=$true)][string]$VerifyUrl,
    [Parameter(Mandatory=$true)][string]$AccessHost
  )
  # Incident (2026-07-09 17:08): a single-shot probe missed transiently and fired the CRITICAL
  # "confidential bake may be exposed" alert even though the gate was fine. Retry up to 3x
  # (initial 5s settle, then 15s between attempts) before declaring failure, and split severity
  # on the last observed $code -- a 2xx apex means the bake really is exposed (CRITICAL); any
  # other result (0/timeout, 3xx-other, 4xx, 5xx) is an inconclusive probe/edge issue.
  Start-Sleep -Seconds 5
  $verified = $false
  $code = 0
  $location = ''
  $lastCurlExit = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    if ($attempt -gt 1) { Start-Sleep -Seconds 15 }
    # Invoke-NativeCommandCapture (not a plain `& curl.exe ... 2>&1`) -- same ErrorRecord-under-
    # Stop hazard the git fetch case has: curl's `-s` flag normally suppresses curl's own stderr
    # text, but if it or a future flag change ever leaks anything to stderr, a bare `2>&1` would
    # throw and silently replace this gate-check's own "GATE CHECK FAILED"/"GATE CHECK INCONCLUSIVE"
    # wording -- the highest-stakes throw in this script, since it's what detects a confidential
    # bake being publicly exposed.
    # --connect-timeout/--max-time (added 2026-07-29, code-review follow-up): without these curl can
    # hang indefinitely if the edge accepts the TCP connection and then stalls -- the same
    # unbounded-external-call shape as the wrangler deploy hang this whole fix addresses, on the
    # single highest-stakes step in the script. Bounded to ~20s per attempt x3 attempts, still
    # trivial against the scheduler's PT30M limit.
    $curlResult = Invoke-NativeCommandCapture -Executable 'curl.exe' -Arguments @('-s', '-I', '--connect-timeout', '10', '--max-time', '20', '--max-redirs', '0', $VerifyUrl)
    $lastCurlExit = $curlResult.ExitCode
    $curlOut = $curlResult.Output -split "`n"
    $statusLine   = ($curlOut | Where-Object { $_ -match '^HTTP/' } | Select-Object -First 1) -as [string]
    $locationLine = ($curlOut | Where-Object { $_ -match '^[Ll]ocation:' } | Select-Object -First 1) -as [string]
    $code     = if ($statusLine   -match 'HTTP/\S+\s+(\d+)') { [int]$Matches[1] } else { 0 }
    $location = if ($locationLine -match '^[Ll]ocation:\s*(.+)') { $Matches[1].Trim() } else { '' }
    if ($code -eq 302 -and ($location -match [regex]::Escape($AccessHost))) {
      $verified = $true
      break
    }
    Write-Host "[gate-check] attempt $attempt/3 not yet verified (code=$code, Location='$location')"
  }
  return [pscustomobject]@{
    Verified     = $verified
    Code         = $code
    Location     = $location
    CurlExitCode = $lastCurlExit
  }
}

$beaconPath = Get-DeployBeaconPath -RepoRoot $repo
# Stamped BEFORE the try block so that a kill at any point inside it -- including during the
# very first git call -- still leaves a 'running' beacon behind for the health check to find.
# HEAD is captured here as the pre-fast-forward sha purely for diagnostics; it is not used
# for any control flow.
$beaconHeadSha = (& git rev-parse --short HEAD 2>$null)
Write-DeployBeaconStart -BeaconPath $beaconPath -HeadSha $beaconHeadSha


try {
  # 1) Fast-forward to origin/main first -- otherwise this deploys whatever old code happens to
  #    be on disk. Fails loudly (never silently) if the local checkout has diverged or has
  #    uncommitted changes that conflict with incoming commits; a stale-but-successful deploy is
  #    worse than a loud failure here.
  #
  #    Auth-vs-offline (2026-07-10 follow-up): git exit code 128 is generic and shared by BOTH a
  #    genuine network-down condition AND a git credential/auth failure (gh.exe's credential
  #    helper going missing/unauthenticated -- see reference_github_credential_path.md). Capture
  #    actual stderr/stdout (not just the exit code) so Test-GitAuthFailureSignature can tell the
  #    two apart. An auth-looking failure gets ONE self-heal retry that bypasses gh.exe in favor
  #    of the Credential Manager fallback; if that also fails, this throws a distinctly-prefixed
  #    "GIT AUTH FAILURE (128): ..." reason that Test-OfflineSignature will NOT match, so it
  #    always alerts immediately instead of silently folding into the offline-suppression digest
  #    meant only for transient network blips. A genuinely network-looking failure (or any
  #    failure that isn't an auth signature) falls through to the original throw shape unchanged,
  #    so Test-OfflineSignature still matches and today's suppression/escalation behavior is
  #    unaffected for real outages.
  # Invoke-GitFetchCapture (not a plain `& git fetch origin 2>&1 | Out-String`) -- see
  # lib/git-capture.ps1 for why: PowerShell 5.1 converts native stderr into ErrorRecord objects
  # even when merged via 2>&1, and under $ErrorActionPreference = 'Stop' (set above) that throws
  # immediately on ANY stderr output -- including git fetch's routine "From <url>" progress
  # header on a completely successful fetch with new commits. That discarded this script's own
  # throw wording entirely and alerted with just the raw stderr line as "Reason" (2026-07-26).
  $fetchResult = Invoke-GitFetchCapture -GitArgs @('fetch', 'origin')
  $fetchOutput = $fetchResult.Output
  $fetchExit = $fetchResult.ExitCode
  if ($fetchExit -ne 0) {
    if (Test-GitAuthFailureSignature -Reason $fetchOutput) {
      Write-Host "[git-auth] git fetch origin failed ($fetchExit) with an auth-looking error -- attempting self-heal via Credential Manager fallback"
      $retryResult = Invoke-GitFetchCapture -GitArgs @('-c', 'credential.https://github.com.helper=', '-c', 'credential.https://github.com.helper=manager', 'fetch', 'origin')
      $retryOutput = $retryResult.Output
      $retryExit = $retryResult.ExitCode
      if ($retryExit -eq 0) {
        Write-Host "[git-auth] self-heal succeeded via Credential Manager fallback"
      } else {
        throw "GIT AUTH FAILURE (128): git fetch origin failed with a credential/auth error, and the Credential Manager fallback retry also failed ($retryExit): $($retryOutput.Trim()). One-off unblock -- run manually: git -c credential.https://github.com.helper= -c credential.https://github.com.helper=manager fetch origin -- If gh.exe itself needs a real fix (not just this one-off bypass): reinstall via 'winget install GitHub.cli', then re-seed %APPDATA%\GitHub CLI\hosts.yml with a valid oauth_token (gh auth login --with-token rejects the GCM-stored token here -- missing org scope it doesn't actually need for this repo). See reference_github_credential_path.md for the full recipe."
      }
    } else {
      throw "git fetch origin failed ($fetchExit): $($fetchOutput.Trim())"
    }
  }
  # Note: still worded "git pull --ff-only failed" (not "git merge") below intentionally, even
  # though the actual command is now `git merge --ff-only origin/main` -- this preserves
  # Test-OfflineSignature's existing `^git (fetch|pull)\b` match and suppression behavior for
  # this failure mode unchanged. Switched from `git pull --ff-only` to an explicit merge because
  # origin/main was already fetched above (with auth self-heal already handled there); a plain
  # `git pull` implicitly re-fetches over the network, which would re-expose this same
  # credential-failure risk a second time for no benefit. `git merge --ff-only` is purely local
  # (no network, no credentials) once the fetch above has succeeded.
  # 1b) Sync the ISOLATED BUILD ROOT to origin/main and build THERE, not in this checkout.
  #
  # Incident (2026-08-16): the canonical checkout is a multi-session development surface. Another
  # session left an uncommitted `tests/unit/install-git-hooks.test.ts` here at 14:13; it failed
  # `tsc --noEmit` (TS7016), `build:mirror` exited 2, and EVERY subsequent hourly run failed
  # identically while the mirror kept serving the 13:00 bake. "Whatever is on disk" is not a safe
  # build input for a production deploy.
  #
  # The 2026-07-09 fast-forward fixed the sibling half of this (stale code from origin) but could
  # not fix this half -- and is now REMOVED deliberately. Fast-forwarding the shared checkout is
  # both unnecessary (we no longer build from it) and undesirable: it made an unattended job
  # mutate a tree that humans and other sessions are actively working in, and it re-coupled the
  # deploy's success to that tree's cleanliness. The fetch above still runs, because the build
  # root resolves origin/main from THIS repo's object store.
  $buildRoot = Get-DeployBuildRoot -RepoRoot $repo
  Assert-BuildRootIsolated -RepoRoot $repo -BuildRoot $buildRoot | Out-Null
  $buildHeadSha = Sync-DeployBuildRoot -RepoRoot $repo -BuildRoot $buildRoot -Ref 'origin/main'
  Install-DeployBuildRootDeps -BuildRoot $buildRoot | Out-Null
  Write-Host "  Building from $buildRoot (origin/main @ $buildHeadSha), NOT from the shared checkout"

  # 2) Bake (confidential included -- target is Access-gated) + build.
  $env:MIRROR_INCLUDE_CONFIDENTIAL = '1'
  $env:BRIEF_ENABLED               = '1'
  # Fat Mirror / cold-standby payload. Set explicitly to '0' rather than left unset when the switch
  # is absent: this process inherits the caller's environment, and a BAKE_WAREHOUSE=1 lingering in an
  # operator's shell would otherwise silently turn every hourly run into the heavy bake -- the exact
  # WAL contention the daily cadence exists to avoid. bake-mirror.ts's shouldBakeWarehouse() is
  # strict ('0' is OFF, not a truthy string), so this pins the hourly path OFF by construction.
  $env:BAKE_WAREHOUSE              = if ($IncludeWarehouse) { '1' } else { '0' }
  $env:BRIEF_SEND_SCRIPT           = 'C:\Users\Owner\.claude\scheduled-tasks\_shared\send-via-outlook.ps1'
  # Incident (2026-08-05 -> 2026-08-09, ~13 consecutive failed runs): this machine is dual-stack
  # but has NO working IPv6 route, while its only DNS server (10.254.1.1, no secondary) still
  # returns AAAA records. Node's default dual-stack resolution therefore pays a ~5s penalty per
  # fresh hostname (measured: api.cloudflare.com 5.11s default vs 0.013s with -4), and under load
  # it fails outright -- the same fault produced "Could not resolve host: github.com" on the git
  # fetch in step 1. That delay compounds across wrangler's Cloudflare API calls until they trip
  # its internal connection timeout ("The request to Cloudflare's API timed out", errorType
  # ConnectionTimeout). Forcing IPv4-first resolution made an otherwise-identical deploy succeed
  # on the first attempt. This is a WORKAROUND for a host network fault, not a fix for it -- if
  # IPv6 is ever routed correctly (or the resolver stops returning AAAA), this line becomes a
  # no-op rather than a hazard, so it is safe to leave in place.
  $env:NODE_OPTIONS = '--dns-result-order=ipv4first'

  # The build root is a CLEAN checkout, so the gitignored inputs the bake needs are not in it.
  # Supply them from the canonical repo rather than duplicating them on disk:
  #   .env  -- injected into this process's environment (inherited by the npm child). Precedence
  #            matches server/load-env.ts, and load-env.ts anchors to its OWN file location, so the
  #            build root's absent .env is a harmless no-op once these are real env vars.
  #   WAREHOUSE_DB -- an ABSOLUTE path back to the canonical data dir. Without this it would
  #            default to <cwd>/data/warehouse/finance.sqlite, i.e. a nonexistent file in the fresh
  #            build root, and the Fat Mirror bake would silently have no warehouse to read.
  $importedEnvCount = Import-DotEnvIntoEnvironment -Path (Join-Path $repo '.env')
  Write-Host "  Imported $importedEnvCount var(s) from the canonical .env"
  if (-not $env:WAREHOUSE_DB) { $env:WAREHOUSE_DB = Join-Path $repo 'data\warehouse\finance.sqlite' }

  try {
    # Build in the ISOLATED root. Note npm --prefix does NOT chdir the spawned script (confirmed
    # 2026-07-09, see server/load-env.ts) -- Push-Location makes the build root the real cwd so
    # every cwd-relative path inside the bake resolves there, not into the canonical checkout.
    Push-Location $buildRoot
    try {
      npm run build:mirror
      if ($LASTEXITCODE -ne 0) { throw "build:mirror failed ($LASTEXITCODE)" }
    } finally {
      Pop-Location
    }

    # 3) Deploy the static bake to the gated Pages project.
    #    Incident (2026-07-29): this call ran unbounded and hung ~26 minutes, so the Windows Task
    #    Scheduler ExecutionTimeLimit (PT30M) force-terminated the process tree -- exit 3221225786
    #    (0xC000013A). A forced kill does NOT unwind try/catch, so the catch block below never ran
    #    and NO alert was sent (no email, and no data/outbox/ fallback entry either); the failure was
    #    found only because a separate sampling checker read LastTaskResult afterwards. The 11:00 run
    #    then succeeded unattended, confirming a transient stall rather than bad credentials.
    #    Bounding the call here means a stall becomes an ordinary throw that the catch CAN alert on,
    #    with time to spare before the scheduler's own limit. Tree-kill matters: the launcher spawns
    #    node as a child, and killing only the launcher would orphan the real uploader.
    #
    #    Why the LOCAL wrangler binary and not `npx wrangler` (2026-08-09): wrangler was not a
    #    dependency of this repo, so `npx` re-resolved it from the npm registry on every hourly run.
    #    Combined with the DNS fault described in step 2, that fetch is what actually consumed the
    #    600s budget -- the proof is that ~/.wrangler/logs/ contains NO log for any of the ~13 failed
    #    runs between 2026-08-05 and 2026-08-09, and wrangler writes a log even for `--version`, so
    #    wrangler never started at all. npx also has no timeout of its own, so it hangs indefinitely.
    #    wrangler is now pinned in devDependencies; resolve its local bin and fall back to npx only
    #    if node_modules is missing, so a fresh checkout degrades to the old behavior rather than
    #    hard-failing.
    #    The artifact now lives in the ISOLATED build root, so this path must be ABSOLUTE. It was
    #    the relative 'dist', which resolved against $repo -- after the 2026-08-16 build-isolation
    #    change that would publish the canonical checkout's stale dist (13:00 in the incident)
    #    while reporting a successful deploy: the worst possible outcome, a silent wrong-artifact
    #    publish to an external surface.
    $distPath = Join-Path $buildRoot 'dist'
    if (-not (Test-Path -LiteralPath (Join-Path $distPath 'index.html'))) {
      throw "Build root produced no dist/index.html at $distPath -- refusing to deploy (a missing artifact must never fall back to another tree's dist)."
    }
    $wranglerBin  = Join-Path $buildRoot 'node_modules\.bin\wrangler.cmd'
    if (Test-Path -LiteralPath $wranglerBin) {
      $deployExe  = $wranglerBin
      $deployArgs = @('pages', 'deploy', $distPath, "--project-name=$ProjectName", '--branch=main')
    } else {
      Write-Host "[deploy] local wrangler not found at $wranglerBin -- falling back to npx (run 'npm ci' to restore the pinned version)"
      $deployExe  = 'npx'
      $deployArgs = @('wrangler', 'pages', 'deploy', $distPath, "--project-name=$ProjectName", '--branch=main')
    }
    $deploy = Invoke-NativeCommandWithTimeout `
      -Executable $deployExe `
      -Arguments $deployArgs `
      -TimeoutSeconds $DeployTimeoutSeconds
    if ($deploy.TimedOut) {
      $timeoutReason = Get-DeployTimeoutReason -Seconds $DeployTimeoutSeconds
      # 2026-07-31 (security review): run the Access-gate probe on the timeout path too, instead of
      # skipping it entirely as before. ~95s worst case (5s settle + 3x20s + 2x15s) is trivial
      # against the scheduler's PT30M budget, and this is the one control that can still catch a
      # genuine exposure even though the deploy itself never confirmed success.
      $gate = Invoke-AccessGateProbe -VerifyUrl $VerifyUrl -AccessHost $AccessHost
      if ($gate.Code -ge 200 -and $gate.Code -le 299) {
        throw "GATE CHECK FAILED: $VerifyUrl returned $($gate.Code) (Location='$($gate.Location)') -- detected while investigating a deploy timeout. Expected 302 -> *$AccessHost. Confidential bake may be exposed - investigate immediately. $timeoutReason"
      }
      throw $timeoutReason
    }
    if ($deploy.ExitCode -ne 0) { throw "wrangler deploy failed ($($deploy.ExitCode))" }
  }
  finally {
    Remove-Item Env:\MIRROR_INCLUDE_CONFIDENTIAL -ErrorAction SilentlyContinue
    Remove-Item Env:\BRIEF_ENABLED               -ErrorAction SilentlyContinue
    Remove-Item Env:\BRIEF_SEND_SCRIPT           -ErrorAction SilentlyContinue
    Remove-Item Env:\NODE_OPTIONS                -ErrorAction SilentlyContinue
  }

  # 4) Verify Access is still enforcing -- unauthenticated must 302 to the Access login host.
  #    Uses curl.exe (Windows 11 built-in) -- PS5.1-compatible; Invoke-WebRequest cannot capture
  #    302 response objects on PS5.1 (SkipHttpErrorCheck is PS7+ only).
  #    Invoke-AccessGateProbe (defined above) is shared with the deploy-timeout path in step 3 --
  #    see that definition for the retry/severity-split rationale.
  $gate = Invoke-AccessGateProbe -VerifyUrl $VerifyUrl -AccessHost $AccessHost
  if (-not $gate.Verified) {
    if ($gate.Code -ge 200 -and $gate.Code -le 299) {
      throw "GATE CHECK FAILED: $VerifyUrl returned $($gate.Code) (Location='$($gate.Location)') after 3 attempts. Expected 302 -> *$AccessHost. Confidential bake may be exposed - investigate immediately."
    } else {
      throw "GATE CHECK INCONCLUSIVE: $VerifyUrl returned $($gate.Code) (Location='$($gate.Location)') after 3 attempts (last curl exit $($gate.CurlExitCode)). Probe/network issue or edge propagation - gate NOT verified open; verify manually."
    }
  }
  $location = $gate.Location

  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-Host "[$stamp] OK - deployed and Access gate verified (302 -> $AccessHost). Location: $location"

  # Clears any suppressed offline-signature streak from prior runs and sends one recovery
  # digest if suppression actually happened -- see lib/deploy-alert.ps1.
  try {
    Send-DeployRecoveryDigestIfSuppressed
  } catch {
    Write-Host "Send-DeployRecoveryDigestIfSuppressed itself failed: $($_.Exception.Message)"
  }

  # Reached the normal exit path. Beacon writes are wrapped so a beacon problem can never
  # turn an otherwise-successful deploy into a failed one -- this is observability, and it
  # must not become a new way for the deploy to break.
  try {
    Write-DeployBeaconEnd -BeaconPath $beaconPath -Outcome 'success'
  } catch {
    Write-Host "Write-DeployBeaconEnd (success) itself failed: $($_.Exception.Message)"
  }
}
catch {
  $original = $_
  # ORDER MATTERS: stamp the beacon BEFORE attempting the alert send, not after.
  #
  # Send-DeployFailureAlert drives Outlook COM and retries once on failure, so it can occupy
  # several seconds. If the machine reboots or suspends during that window, the beacon would
  # still read 'running' and mirror-run-classify.ps1 would find a correlating power event and
  # classify a genuine failure as BENIGN_INTERRUPTED -- silently, and worst of all for a
  # GATE CHECK FAILED (confidential bake possibly exposed), which is the highest-stakes throw
  # in this script. Recording outcome='failed' first makes that misclassification impossible:
  # the classifier keys on status='completed', so the run can no longer be excused as a kill.
  # Found by the adversarial review of this change, not in production.
  try {
    Write-DeployBeaconEnd -BeaconPath $beaconPath -Outcome 'failed' -Reason $original.Exception.Message
  } catch {
    Write-Host "Write-DeployBeaconEnd (failed) itself failed: $($_.Exception.Message)"
  }
  try {
    $reason = $original.Exception.Message
    $isGateFailure = $reason -match '^GATE CHECK FAILED'
    # Suppressibility widened 2026-08-11 from "offline git fetch/pull signature only" to every
    # class except a confirmed gate failure -- see Test-SuppressibleReason for the 44-email
    # incident that motivated it. Test-OfflineSignature still exists and is still meaningful,
    # but it now selects alert WORDING, not whether repeats are suppressed at all.
    $isSuppressible = Test-SuppressibleReason -Reason $reason
    Send-DeployFailureAlert -Reason $reason -Critical:$isGateFailure -Suppressible:$isSuppressible
  } catch {
    Write-Host "Send-DeployFailureAlert itself failed: $($_.Exception.Message)"
  }
  throw $original
}

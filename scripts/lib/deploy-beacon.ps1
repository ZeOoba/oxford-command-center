<#
  Run-completion beacon for deploy-mirror.ps1, plus the classifier that reads it.

  WHY (incident, 2026-08-03): deploy-mirror.ps1 reports failures from a try/catch, which only
  fires when the script THROWS. Three runs in seven days instead returned 3221225786
  (0xC000013A = STATUS_CONTROL_C_EXIT) -- the process was KILLED, so the catch never ran,
  Send-DeployFailureAlert was never called, and data/outbox/ (its own can't-send fallback)
  recorded nothing. The pipeline had no way to report the one failure mode it cannot catch.

  You cannot catch 0xC000013A from inside the process, so this does the inverse: the script
  announces that it STARTED, and separately announces that it FINISHED. A run that was killed
  leaves a beacon stuck at status='running' -- absence of the finish record IS the signal.

  Why not just use run duration as the signal: the three real kills lasted 4 seconds, 96
  seconds, and several hours. There is no duration threshold that separates them from healthy
  runs (which take 5-19 minutes). Duration was evaluated and rejected; only the beacon works.

  Classification, not just detection: most of these kills are benign machine lifecycle (a
  reboot or a Modern Standby transition mid-run), and the next hourly fire self-heals them.
  Alerting on all of them would train the reader to ignore the alert. Get-MirrorRunVerdict
  therefore correlates the kill against System-log power/session events and only alarms when
  nothing explains it -- which is exactly the 2026-08-01 13:01:37 case.
#>

# Correlation half-window, in seconds, around the run's END. Deliberately tight.
#
# DO NOT WIDEN THIS CASUALLY. The machine this runs on enters Modern Standby roughly 20x/day;
# at a few minutes' width, every kill finds some nearby power event, everything classifies
# BENIGN_INTERRUPTED, and the check goes permanently silent. 90s comfortably covers both real
# benign incidents (event was 10s and 8s from the kill) while still excluding the real
# unexplained one (nearest event 263s away). Scenarios 2g and 3c in
# deploy-beacon.smoke-test.ps1 are the regression guards for exactly this.
$script:BeaconCorrelationWindowSeconds = 90

# A beacon written more than this long before the run Windows just reported is treated as
# belonging to an EARLIER run, i.e. this run produced no beacon at all.
$script:BeaconFreshnessToleranceSeconds = 120

# At or above this many unpushed commits, being ahead of origin stops being a hygiene note
# and becomes an alarm. Set to 3 by Gabriel 2026-08-03. WHY a threshold rather than "any
# ahead > 0 pages": ora-lease-snapshot-refresh auto-commits data/snapshots/portfolio.json up
# to 3x/weekday and is instructed never to push, so ahead=1..2 is the EXPECTED steady state.
# Paging on it would over-fire daily and train the reader to ignore the alert -- the identical
# failure mode the blanket "rc != 0 is an ALARM" rule was rolled back for in v1.2. Do not
# lower this to 1 without also changing that no-push rule; the two settings are coupled.
$script:MirrorAheadEscalationThreshold = 3

function Get-DeployBeaconPath {
  <# Default beacon location. data/_state/ is gitignored -- this is machine state, not repo content. #>
  param([string]$RepoRoot)
  if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot | Split-Path -Parent }
  Join-Path $RepoRoot 'data\_state\mirror-deploy-beacon.json'
}

function Write-DeployBeaconStart {
  <#
    Announce that a run has begun. Called as early as possible in deploy-mirror.ps1 so that a
    kill at ANY later point still leaves a 'running' beacon behind.
  #>
  param(
    [Parameter(Mandatory)][string]$BeaconPath,
    [datetime]$StartedAt = (Get-Date),
    [string]$HeadSha = ''
  )
  $dir = Split-Path -Parent $BeaconPath
  # A fresh clone has no data/_state/ (gitignored), so the first deploy on a new machine
  # would otherwise die inside the beacon call instead of doing its actual job.
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  $beacon = [ordered]@{
    schemaVersion = 1
    status        = 'running'
    outcome       = $null
    reason        = $null
    startedAt     = $StartedAt.ToString('o')
    finishedAt    = $null
    headSha       = $HeadSha
    pid           = $PID
    hostname      = $env:COMPUTERNAME
  }
  $beacon | ConvertTo-Json | Set-Content -Path $BeaconPath -Encoding UTF8
}

function Write-DeployBeaconEnd {
  <#
    Announce that a run reached its exit path. Called for BOTH outcomes -- 'success' and
    'failed' -- because "the script threw and self-alerted" and "the script was killed and
    could not alert" are different situations that must not collapse into one signal.
  #>
  param(
    [Parameter(Mandatory)][string]$BeaconPath,
    [Parameter(Mandatory)][ValidateSet('success', 'failed')][string]$Outcome,
    [datetime]$FinishedAt = (Get-Date),
    [string]$Reason = ''
  )
  # Preserve startedAt/headSha/pid from the start beacon rather than re-stamping them; the
  # gap between the two is the only record of how long the run actually took.
  $existing = Get-DeployBeacon -BeaconPath $BeaconPath
  $startedAt = if ($existing -and $existing.startedAt) { $existing.startedAt } else { $FinishedAt }
  $headSha   = if ($existing) { $existing.headSha } else { '' }

  $dir = Split-Path -Parent $BeaconPath
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  $beacon = [ordered]@{
    schemaVersion = 1
    status        = 'completed'
    outcome       = $Outcome
    reason        = $Reason
    startedAt     = ([datetime]$startedAt).ToString('o')
    finishedAt    = $FinishedAt.ToString('o')
    headSha       = $headSha
    pid           = $PID
    hostname      = $env:COMPUTERNAME
  }
  $beacon | ConvertTo-Json | Set-Content -Path $BeaconPath -Encoding UTF8
}

function Get-DeployBeacon {
  <#
    Read the beacon. Returns $null for missing OR unparseable content -- a half-written
    beacon is precisely what a kill mid-write produces, so a corrupt file is a live case,
    not a hypothetical, and it must not throw inside a health check.
  #>
  param([Parameter(Mandatory)][string]$BeaconPath)
  if (-not (Test-Path $BeaconPath)) { return $null }
  try {
    $raw = Get-Content $BeaconPath -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    $obj = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $null
  }
  # Re-hydrate the round-trip 'o' strings into real datetimes so callers can compare them.
  $startedAt  = if ($obj.startedAt)  { [datetime]::Parse($obj.startedAt,  $null, [System.Globalization.DateTimeStyles]::RoundtripKind) } else { $null }
  $finishedAt = if ($obj.finishedAt) { [datetime]::Parse($obj.finishedAt, $null, [System.Globalization.DateTimeStyles]::RoundtripKind) } else { $null }
  [pscustomobject]@{
    schemaVersion = $obj.schemaVersion
    status        = $obj.status
    outcome       = $obj.outcome
    reason        = $obj.reason
    startedAt     = $startedAt
    finishedAt    = $finishedAt
    headSha       = $obj.headSha
    pid           = $obj.pid
    hostname      = $obj.hostname
  }
}

function Format-BeaconReasonSuffix {
  <#
    Render a beacon's recorded reason as a sentence suffix, or as nothing at all when it is
    empty.

    WHY (2026-08-04): the verdict text interpolated $Beacon.reason unconditionally, but
    Write-DeployBeaconEnd defaults -Reason to '', so a beacon can legitimately carry an empty
    one. The result was a ": ." stranded mid-sentence -- observed live in the 11:00 run's
    verdict. An absent reason must read as absent, not as punctuation.
  #>
  param([string]$Reason)
  if ([string]::IsNullOrWhiteSpace($Reason)) { return '' }
  ": $Reason"
}

function Get-MirrorRunVerdict {
  <#
    Classify the last mirror-deploy run. All inputs are injected so this is testable without a
    real event log or a real scheduled task.

    Verdicts:
      HEALTHY                       -- rc=0 and this run wrote a fresh success beacon.
      ALARM_SILENT_INCOMPLETE       -- rc=0 but the script never reached its exit path. Windows
                                       says success; the script disagrees.
      ALARM_SCRIPT_FAILED           -- the script threw and reached its catch. It already
                                       self-alerted; this confirms rather than discovers.
      BENIGN_KILLED_AFTER_COMPLETION-- rc!=0, but THIS run's beacon already recorded
                                       outcome=success: the deploy published and only teardown
                                       was killed. The mirror is not stale. Silent.
      BENIGN_INTERRUPTED            -- killed mid-run, with a power/session event that explains it.
      ALARM_UNEXPLAINED_KILL        -- killed mid-run with nothing to explain it.
      INDETERMINATE                 -- no readable beacon. Never fabricate HEALTHY from this.

    A note on beacon FRESHNESS, because it is the whole subject of the 2026-08-04 fix: the
    beacon is a single file that each run overwrites, so "a completed beacon exists" and "THIS
    run completed" are different claims. Both rc branches must therefore test freshness before
    reading anything else out of the beacon. Only the rc=0 branch used to.
  #>
  param(
    $Beacon,
    [Parameter(Mandatory)][long]$LastTaskResult,
    [datetime]$RunStartedAt,
    [datetime]$RunEndedAt,
    [object[]]$EnvironmentalEvents = @()
  )

  if ($null -eq $Beacon) {
    return [pscustomobject]@{
      verdict = 'INDETERMINATE'
      reason  = 'No readable beacon file. Either this run predates the beacon change, or the beacon was lost/corrupted. Cannot confirm the run completed.'
      correlatingEvent = $null
    }
  }

  # Is the beacon actually from THIS run? A stale beacon left by an earlier successful run
  # would otherwise make a beacon-less run look perfectly healthy.
  $beaconIsFresh = $true
  if ($Beacon.startedAt -and $RunStartedAt) {
    $skew = [math]::Abs(($Beacon.startedAt - $RunStartedAt).TotalSeconds)
    $beaconIsFresh = ($skew -le $script:BeaconFreshnessToleranceSeconds)
  }

  $killed = ($Beacon.status -ne 'completed')

  if ($LastTaskResult -eq 0) {
    if ($killed -or -not $beaconIsFresh) {
      $why = if (-not $beaconIsFresh) {
        "Windows reported success (rc=0), but the beacon is from an earlier run (beacon startedAt $($Beacon.startedAt), this run started $RunStartedAt) -- this run wrote no beacon."
      } else {
        "Windows reported success (rc=0), but the beacon is still 'running' -- the script never reached its exit path."
      }
      return [pscustomobject]@{ verdict = 'ALARM_SILENT_INCOMPLETE'; reason = $why; correlatingEvent = $null }
    }
    if ($Beacon.outcome -eq 'failed') {
      return [pscustomobject]@{
        verdict = 'ALARM_SCRIPT_FAILED'
        reason  = "Windows reported rc=0 but the script recorded outcome='failed'$(Format-BeaconReasonSuffix $Beacon.reason)."
        correlatingEvent = $null
      }
    }
    return [pscustomobject]@{ verdict = 'HEALTHY'; reason = 'Run completed and recorded outcome=success.'; correlatingEvent = $null }
  }

  # rc != 0 from here down.
  #
  # FRESHNESS IS NOT OPTIONAL ON THIS SIDE EITHER (2026-08-04). This branch used to test only
  # $killed -- i.e. only the beacon's status -- so a 'completed' beacon left by ANY earlier run
  # made $killed false and short-circuited straight to ALARM_SCRIPT_FAILED, never reaching the
  # correlation logic below. The rc=0 branch above has always applied the freshness test
  # (scenario 2c); this one did not, and the asymmetry was the bug.
  #
  # What it cost, live: the 11:00:01 run on 2026-08-04 was killed at 11:00:29, 28 seconds in --
  # before Write-DeployBeaconStart could run -- so it left no beacon. The classifier read the
  # 10:00 run's completed/success beacon and announced "Script threw and reached its exit path
  # (outcome=success)", which is incoherent (killed is not threw, success is not a failure), and
  # directed the reader to a Send-DeployFailureAlert email that could not exist. Step 5 of the
  # drift-check SKILL reads a missing self-alert as a broken send path and "the bigger finding",
  # so the bad text invented a second incident to chase -- while masking the real one: that run
  # was the THIRD unexplained kill in four days (08-01 13:01, 08-03 20:05, 08-04 11:00), and it
  # went into the log as a script failure instead.
  $hasBeaconForThisRun = (-not $killed) -and $beaconIsFresh

  if ($hasBeaconForThisRun -and $Beacon.outcome -eq 'success') {
    # Killed AFTER this run recorded success. Write-DeployBeaconEnd -Outcome 'success' sits past
    # the wrangler deploy, which throws on a non-zero exit, so a fresh success beacon is positive
    # proof the mirror actually published -- not merely that dist/ looks fresh, which the
    # 2026-08-03 incident established is no evidence of anything. The work is done; only teardown
    # died, and the next hourly fire has nothing to repair.
    #
    # This is deliberately NOT folded into BENIGN_INTERRUPTED, and it does not widen that
    # bucket: it is gated on this run's own success record, not on whether some power event
    # happened to land within 90s. Modern Standby churn cannot route runs into it, which is
    # exactly the property the correlation window lacks and why widening that window is the
    # failure direction that silences the check. Scenario 2o pins the gate.
    return [pscustomobject]@{
      verdict = 'BENIGN_KILLED_AFTER_COMPLETION'
      reason  = "Run recorded outcome=success at $($Beacon.finishedAt), then the process was killed (rc=$LastTaskResult) during teardown. The deploy had already published, so the mirror is NOT stale and no action is needed. The script did not fail and did not throw -- no Send-DeployFailureAlert was sent, and none should be looked for."
      correlatingEvent = $null
    }
  }

  if ($hasBeaconForThisRun) {
    return [pscustomobject]@{
      verdict = 'ALARM_SCRIPT_FAILED'
      reason  = "Script threw and reached its exit path (outcome=$($Beacon.outcome))$(Format-BeaconReasonSuffix $Beacon.reason). Send-DeployFailureAlert should have already fired."
      correlatingEvent = $null
    }
  }

  # No usable record of THIS run: either the beacon is still 'running', or it belongs to an
  # earlier run. Both mean the same thing here -- nothing tells us how far this run got -- so
  # both take the correlation path below rather than being reported as a script failure.
  # Gated on freshness ALONE, not on status: two kills in a row leave a stale 'running' beacon
  # from the previous run, which is just as misleading to a reader as a stale 'completed' one.
  $staleNote = ''
  if (-not $beaconIsFresh) {
    $staleNote = " The beacon on disk is from an earlier run (beacon startedAt $($Beacon.startedAt), this run started $RunStartedAt), so this run left no completion record of its own and the beacon says nothing about it."
  }

  # Killed mid-run. Look for something that explains it, anchored to the run's END -- not its
  # start, because a run can be killed hours after launching (the 2026-08-01 10:06 case).
  # Pick the NEAREST in-window event, not the first one the log happened to return.
  # Get-WinEvent yields newest-first, so a first-match-wins loop attributes a kill to the
  # boot that FOLLOWED the shutdown rather than to the shutdown itself -- both are inside the
  # window and both are "true", but only the closest names the actual cause.
  $match = $null
  if ($RunEndedAt -and $EnvironmentalEvents) {
    $bestDelta = [double]::MaxValue
    foreach ($e in $EnvironmentalEvents) {
      if ($null -eq $e) { continue }
      $delta = [math]::Abs(($e.TimeCreated - $RunEndedAt).TotalSeconds)
      if ($delta -le $script:BeaconCorrelationWindowSeconds -and $delta -lt $bestDelta) {
        $bestDelta = $delta
        $match = $e
      }
    }
  }

  if ($match) {
    return [pscustomobject]@{
      verdict = 'BENIGN_INTERRUPTED'
      reason  = "Run was killed (rc=$LastTaskResult) by machine lifecycle: '$($match.Label)' (event $($match.Id)) at $($match.TimeCreated), $([math]::Round([math]::Abs(($match.TimeCreated - $RunEndedAt).TotalSeconds)))s from the run's end. The next hourly fire re-bakes; no action needed.$staleNote"
      correlatingEvent = $match
    }
  }

  return [pscustomobject]@{
    verdict = 'ALARM_UNEXPLAINED_KILL'
    reason  = "Run was killed (rc=$LastTaskResult) mid-flight with NO power/session event within ${script:BeaconCorrelationWindowSeconds}s of the run's end ($RunEndedAt). Something other than normal machine lifecycle terminated the deploy.$staleNote"
    correlatingEvent = $null
  }
}

function Test-MirrorRepoAhead {
  <#
    Flag local main being AHEAD of origin/main.

    WHY (2026-08-03): the drift check measured only `git rev-list --count HEAD..origin/main`
    (behind) and reported "drift 0 = clean" while local main carried commit 3692385 for five
    days -- present on no remote branch, so the mirror was serving code nobody could review on
    GitHub, and a hard reset of local main would have destroyed it. Behind and ahead are
    different hazards and the check needs both.
  #>
  param([Parameter(Mandatory)][int]$AheadCount)
  $threshold = $script:MirrorAheadEscalationThreshold
  if ($AheadCount -le 0) {
    return [pscustomobject]@{
      isAhead   = $false
      severity  = 'OK'
      threshold = $threshold
      reason    = 'Local main is not ahead of origin/main.'
    }
  }

  # Two tiers, NOT one. FLAG = record it in the Notion row and stay silent; ESCALATE = alarm
  # email. See $script:MirrorAheadEscalationThreshold for why the routine 1-2 case must not page.
  $base = "Local main is $AheadCount commit(s) AHEAD of origin/main. The mirror is deploying code that is not on the remote -- unreviewable on GitHub, and lost if local main is ever reset. Push or open a PR."
  if ($AheadCount -ge $threshold) {
    return [pscustomobject]@{
      isAhead   = $true
      severity  = 'ESCALATE'
      threshold = $threshold
      reason    = "$base This is at or past the escalation threshold of $threshold unpushed commit(s), so it is no longer routine drift -- alarm rather than a silent Notion row."
    }
  }
  [pscustomobject]@{
    isAhead   = $true
    severity  = 'FLAG'
    threshold = $threshold
    reason    = "$base Below the escalation threshold of $threshold, so this is recorded as a hygiene note without an alarm email."
  }
}

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

# LastTaskResult while an instance is STILL EXECUTING. 0x00041301 = SCHED_S_TASK_RUNNING.
# It is an informational status, not a completion code, and it is neither success nor a kill.
#
# WHY (2026-08-09): the classifier had only two branches -- rc=0, and everything else treated
# as killed -- so a healthy run eight minutes into its bake was reported as "Run was killed
# (rc=267009) by machine lifecycle". Windows independently said State=Running and the beacon
# held a live pid; nothing was killed. Match ONLY this code: its sibling 0x00041306
# (SCHED_S_TASK_TERMINATED, 267014) is a genuine kill and must keep taking the kill path.
$script:MirrorRunInProgressResultCode = 267009

# How long a run may stay in flight before being in flight is itself the problem.
#
# This does NOT contradict the header's rejection of run duration. Duration was rejected as a
# KILL detector, where it cannot work: killed runs lasted 4s, 96s, and several hours, so no
# threshold separates them from healthy 5-19 minute runs. This branch has no such ambiguity --
# Windows is affirmatively reporting the process alive -- and elapsed time is the only signal
# that distinguishes "working" from "hung". Without it, RUN_IN_PROGRESS would be a permanent
# silence: a wedged deploy would sit at rc=267009 forever and never page.
#
# 90 minutes is above one full hourly cycle and ~4.7x the healthy ceiling, and it fires before
# the SKILL's existing "LastRunTime older than ~3 hours" backstop, so the two agree in
# direction rather than contradicting each other.
$script:MirrorRunStuckThresholdMinutes = 90

# Once a commit has sat ahead of origin/main longer than this many hours, being ahead stops
# being a hygiene note and becomes an alarm. Set to 24 by Gabriel 2026-08-12, REPLACING the
# previous count threshold of 3 (`$script:MirrorAheadEscalationThreshold`, 2026-08-03..08-11).
#
# WHY AGE AND NOT COUNT. The count threshold existed solely to suppress EXPECTED noise:
# ora-lease-snapshot-refresh auto-committed portfolio.json and was instructed never to push,
# so ahead=1..2 was the steady state and paging on it would have over-fired daily. Both
# snapshot tasks now auto-push (ora-lease-snapshot-refresh v1.5 2026-08-09,
# ora-cc-snapshot-refresh v1.2 2026-08-11), so that noise source is gone and the count rule's
# entire justification went with it.
#
# Lowering the count to 1 was considered and REJECTED: humans leave commits ahead mid-session
# too -- Gabriel's own 2026-08-05 batch sat 7 commits ahead for ~4 hours before being pushed --
# so a count-1 rule would page through normal work. That is the same over-firing that got the
# blanket "rc != 0 is an ALARM" rule rolled back in v1.2, just relocated from automation noise
# to human noise.
#
# Age separates them cleanly because the real hazard was never "how many" but "how long":
# 3692385 sat unpushed for FIVE DAYS while the mirror deployed it, and that is the incident
# Test-MirrorRepoAhead was written for. Commits minutes old are an active session; anything
# stranded overnight is not. 24h is above any plausible working session and below the
# multi-day strand that motivated the check.
$script:MirrorAheadStaleHours = 24

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

function Select-RunCompletionEvent {
  <#
    Pick the TaskScheduler completion (201) event belonging to THIS run, out of the events the
    caller collected -- i.e. the newest one that does not predate the run's own start.

    WHY (2026-08-09): mirror-run-classify.ps1 took the newest 201 event in a 7-day window with
    `Select-Object -First 1` and never asked whose run it described. While a run is in flight,
    no 201 exists for it yet, so the newest one belongs to the PREVIOUS run -- which is how the
    09:00:01 run was handed an end time of 08:51:07, nine minutes BEFORE its own start.

    Returns $null rather than borrowing a neighbouring run's end time. A null end time is an
    honest "not established yet"; a foreign one silently relocates the correlation window (see
    Get-MirrorRunVerdict) and gets copied into the Notion row as if it were this run's.

    Comparison is >= the run start with no tolerance: a run's own completion event cannot
    precede its start, and LastRunTime is second-truncated, so any rounding error is toward
    accepting this run's event rather than a foreign one.
  #>
  param(
    [object[]]$Events = @(),
    [datetime]$RunStartedAt
  )
  if (-not $Events) { return $null }
  $best = $null
  foreach ($e in $Events) {
    if ($null -eq $e -or $null -eq $e.TimeCreated) { continue }
    if ($e.TimeCreated -lt $RunStartedAt) { continue }
    if ($null -eq $best -or $e.TimeCreated -gt $best.TimeCreated) { $best = $e }
  }
  $best
}

function Get-MirrorRunVerdict {
  <#
    Classify the last mirror-deploy run. All inputs are injected so this is testable without a
    real event log or a real scheduled task.

    Verdicts:
      RUN_IN_PROGRESS               -- the run is still executing. Not a result at all yet.
      ALARM_RUN_STUCK               -- still executing, but far past any plausible runtime.
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
    [object[]]$EnvironmentalEvents = @(),
    [datetime]$Now = (Get-Date)
  )

  # IN FLIGHT -- tested FIRST, ahead of even the null-beacon guard.
  #
  # Order matters. A run checked in its opening seconds has not reached Write-DeployBeaconStart
  # yet, so it has no beacon; if the INDETERMINATE guard ran first it would return a verdict the
  # SKILL reads as an alarm, on a perfectly healthy deploy. rc is the authority on liveness here
  # and the beacon has nothing to say yet.
  if ($LastTaskResult -eq $script:MirrorRunInProgressResultCode) {
    $elapsedMinutes = $null
    if ($RunStartedAt -gt [datetime]::MinValue) {
      $elapsedMinutes = [math]::Round(($Now - $RunStartedAt).TotalMinutes)
    }
    if ($null -ne $elapsedMinutes -and $elapsedMinutes -ge $script:MirrorRunStuckThresholdMinutes) {
      return [pscustomobject]@{
        verdict = 'ALARM_RUN_STUCK'
        reason  = "The run that started $RunStartedAt is STILL executing $elapsedMinutes minutes later (rc=$LastTaskResult, SCHED_S_TASK_RUNNING), past the ${script:MirrorRunStuckThresholdMinutes}-minute threshold. Healthy runs take 5-19 minutes and the task fires hourly, so this run is wedged rather than working. The mirror is not advancing."
        correlatingEvent = $null
      }
    }
    $elapsedNote = if ($null -ne $elapsedMinutes) { " (started $RunStartedAt, $elapsedMinutes minutes ago)" } else { '' }
    return [pscustomobject]@{
      verdict = 'RUN_IN_PROGRESS'
      reason  = "The run is still executing$elapsedNote. rc=$LastTaskResult is SCHED_S_TASK_RUNNING -- an in-flight status, not a completion code, and not a kill. Nothing can be concluded about this run's outcome until it finishes; the next check will classify it."
      correlatingEvent = $null
    }
  }

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

  # Does the end time even belong to THIS run? (2026-08-09.) Same defect family as the v1.4
  # beacon-freshness fix, one field over -- and the reason it needs its own guard is that the
  # beacon test cannot catch it: on 08-09 the beacon was fresh (1s skew) while runEndedAt came
  # from a run nine minutes earlier.
  #
  # An end time that precedes its own run's start is from a previous run, and correlation is
  # anchored to the end time -- so accepting it drags the entire 90s window onto an unrelated
  # point in history, where any passing Modern Standby event will excuse the kill. That is
  # exactly the silencing failure the window constant warns about, achieved without widening
  # the window, which is why the 2g/3c guards could not see it. Refuse to correlate instead:
  # an unexplained kill is the safe direction, a falsely-excused one is not.
  $endTimeNote = ''
  $endTimeIsThisRun = $true
  if ($RunEndedAt -gt [datetime]::MinValue -and $RunStartedAt -gt [datetime]::MinValue -and $RunEndedAt -lt $RunStartedAt) {
    $endTimeIsThisRun = $false
    $endTimeNote = " This run's END time could not be established: the newest completion event on record ($RunEndedAt) predates this run's start ($RunStartedAt), so it belongs to an earlier run and was NOT used to correlate power events."
  }

  # Killed mid-run. Look for something that explains it, anchored to the run's END -- not its
  # start, because a run can be killed hours after launching (the 2026-08-01 10:06 case).
  # Pick the NEAREST in-window event, not the first one the log happened to return.
  # Get-WinEvent yields newest-first, so a first-match-wins loop attributes a kill to the
  # boot that FOLLOWED the shutdown rather than to the shutdown itself -- both are inside the
  # window and both are "true", but only the closest names the actual cause.
  $match = $null
  if ($RunEndedAt -and $EnvironmentalEvents -and $endTimeIsThisRun) {
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
      reason  = "Run was killed (rc=$LastTaskResult) by machine lifecycle: '$($match.Label)' (event $($match.Id)) at $($match.TimeCreated), $([math]::Round([math]::Abs(($match.TimeCreated - $RunEndedAt).TotalSeconds)))s from the run's end. The next hourly fire re-bakes; no action needed.$staleNote$endTimeNote"
      correlatingEvent = $match
    }
  }

  return [pscustomobject]@{
    verdict = 'ALARM_UNEXPLAINED_KILL'
    reason  = "Run was killed (rc=$LastTaskResult) mid-flight with NO usable power/session event within ${script:BeaconCorrelationWindowSeconds}s of the run's end$(if ($endTimeIsThisRun) { " ($RunEndedAt)" }). Something other than normal machine lifecycle terminated the deploy.$staleNote$endTimeNote"
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

    PREMISE CORRECTED (2026-08-16, PR #279). That original hazard had two halves: unpushed
    commits were (1) what the mirror actually deployed, and (2) unreviewable on GitHub and
    destroyed by a reset. #279 moved the deploy onto an isolated build root pinned to
    origin/main, which eliminates half (1) BY CONSTRUCTION -- the mirror can no longer serve a
    local commit no matter how far ahead this checkout drifts.

    Observed live at 16:22 that day: with local main 2 ahead, this check told an operator "The
    mirror is deploying code that is not on the remote" about a deploy that had just built and
    shipped origin/main from the build root. A monitoring check that asserts something false
    about the system it monitors is worse than no check -- it spends the reader's trust and
    misdirects the next incident.

    Half (2) is untouched and still worth paging on, so the check STAYS and its severity
    behaviour is deliberately unchanged: the age tiering below was always measuring work-loss
    risk (how long a commit sits stranded), never mirror content. Only the claim is corrected.
  #>
  param(
    [Parameter(Mandatory)][int]$AheadCount,
    # Committer date of the OLDEST commit ahead of origin/main -- the one stranded longest.
    # [datetime]::MinValue means "unknown", matching this file's absent-timestamp idiom.
    [datetime]$OldestAheadCommitAt = [datetime]::MinValue,
    [datetime]$Now = (Get-Date)
  )
  $thresholdHours = $script:MirrorAheadStaleHours

  if ($AheadCount -le 0) {
    return [pscustomobject]@{
      isAhead             = $false
      severity            = 'OK'
      thresholdHours      = $thresholdHours
      ageHours            = $null
      oldestAheadCommitAt = $null
      reason              = 'Local main is not ahead of origin/main.'
    }
  }

  # Two tiers, NOT one. FLAG = record it in the Notion row and stay silent; ESCALATE = alarm
  # email. See $script:MirrorAheadStaleHours for why COUNT must not decide this.
  # Wording is load-bearing: it must state the hazard that SURVIVES #279 (work loss /
  # unreviewable) without reasserting the one that does not (mirror content). The parenthetical
  # is there so an operator reading this mid-incident does not go hunting for a mirror problem
  # that cannot exist -- the misdirection this correction is fixing.
  $base = "Local main is $AheadCount commit(s) AHEAD of origin/main -- unreviewable on GitHub, and lost if local main is ever reset. (Since PR #279 the mirror builds origin/main in an isolated build root, so this does NOT affect what the mirror serves -- it is a work-loss hazard, not a mirror-content one.) Push or open a PR."

  # Can't-verify is not healthy. Without a commit date the staleness gate cannot run, and
  # defaulting it to FLAG would report a clean-looking hygiene note that actually means
  # "couldn't look" -- the inferred-null failure this project treats as a defect in its own
  # right. Escalate instead; a genuinely fresh commit costs one email to correct.
  if ($OldestAheadCommitAt -le [datetime]::MinValue) {
    return [pscustomobject]@{
      isAhead             = $true
      severity            = 'ESCALATE'
      thresholdHours      = $thresholdHours
      ageHours            = $null
      oldestAheadCommitAt = $null
      reason              = "$base The oldest ahead-commit's date could not be read, so the ${thresholdHours}-hour staleness gate could not be evaluated -- escalating rather than assuming the commit is recent, because an unverifiable age is not a clean one."
    }
  }

  # Floor, not Round: the reason strings below claim the commit "has been stranded N hours",
  # and only Floor makes that an at-least statement. Round made the effective threshold 23.5h
  # and would report "stranded 24 hours" for a commit 23h31m old.
  $ageHours = [math]::Floor(($Now - $OldestAheadCommitAt).TotalHours)
  $stamp    = $OldestAheadCommitAt.ToString('o')

  # A commit dated in the FUTURE is not merely unverifiable, it is provably wrong -- so it
  # cannot be treated as cleaner than the absent date handled above, which escalates.
  #
  # WHY THIS IS NOT A FLAG (adversarial review, 2026-08-12): a negative age can never satisfy
  # the -ge test below, so a future-dated commit would be exempt from escalation FOREVER. The
  # realistic producer is a system clock stepped BACKWARD (NTP/RTC correction after running
  # fast): every commit made under the fast clock then reads future-dated, and the gate goes
  # silent for skew + 24h -- a month of skew is a month of silence, at any commit count. That
  # is the permanent-silence failure mode this whole check exists to avoid.
  #
  # -1 rather than 0 is deliberate tolerance: sub-hour jitter between the committer's clock
  # and this process is normal and must not page. Anything beyond that is clock breakage.
  if ($ageHours -lt -1) {
    return [pscustomobject]@{
      isAhead             = $true
      severity            = 'ESCALATE'
      thresholdHours      = $thresholdHours
      ageHours            = $ageHours
      oldestAheadCommitAt = $stamp
      reason              = "$base The oldest ahead-commit is dated $stamp, which is $([math]::Abs($ageHours)) hours in the FUTURE -- the ${thresholdHours}-hour staleness gate cannot be evaluated against an impossible date. This usually means the system clock was stepped backward; until it is reconciled, staleness here cannot be measured at all, so this escalates rather than reporting a clean hygiene note."
    }
  }

  if ($ageHours -ge $thresholdHours) {
    return [pscustomobject]@{
      isAhead             = $true
      severity            = 'ESCALATE'
      thresholdHours      = $thresholdHours
      ageHours            = $ageHours
      oldestAheadCommitAt = $stamp
      reason              = "$base The oldest of those commits ($stamp) has been stranded $ageHours hours, at or past the ${thresholdHours}-hour staleness threshold -- this is no longer an active session's work in flight, so it alarms rather than sitting in a silent Notion row."
    }
  }
  [pscustomobject]@{
    isAhead             = $true
    severity            = 'FLAG'
    thresholdHours      = $thresholdHours
    ageHours            = $ageHours
    oldestAheadCommitAt = $stamp
    reason              = "$base The oldest of those commits ($stamp) is $ageHours hour(s) old, below the ${thresholdHours}-hour staleness threshold, so this reads as an active session's work in flight -- recorded as a hygiene note without an alarm email."
  }
}

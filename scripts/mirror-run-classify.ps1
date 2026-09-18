<#
.SYNOPSIS
  Classify the last "ORA Command Center - Mirror Deploy" run. Read-only. Emits JSON.

.DESCRIPTION
  Called by the ora-command-center-mirror-drift-check scheduled task. Exists so the
  classification is TESTED CODE (scripts/lib/deploy-beacon.ps1, covered by
  scripts/deploy-beacon.smoke-test.ps1) rather than prose in a SKILL.md that a model
  re-derives from scratch on every run and can drift on.

  Gathers the four inputs the classifier needs -- the beacon, the native task's
  LastRunTime/LastTaskResult, the run's actual END time from the Task Scheduler operational
  log, and nearby System-log power/session events -- then prints one JSON object.

  STRICTLY READ-ONLY: no pull, no merge, no reset, no writes to the repo. `git fetch` is
  NOT run here either; the caller does that first.

.NOTES
  PS 5.1-compatible. Never throws on missing data -- an unreadable input becomes a null
  field and, where it matters, an INDETERMINATE verdict. "Can't verify" must never render
  as "confirmed healthy".

  BOUNDED QUERIES (2026-09-18): the caller (ora-command-center-mirror-drift-check SKILL.md step 4)
  invokes this script directly with no timeout of its own -- unlike "ORA Command Center - Mirror
  Deploy" (deploy-mirror.ps1), which sits under the native task's PT30M ExecutionTimeLimit, this
  script's caller is a Claude scheduled-task step with no equivalent enforced bound. Its five live
  system-state calls (Get-ScheduledTaskInfo, four Get-WinEvent queries) are therefore the ONLY
  thing standing between a stalled call and an unbounded hang of that step. Evidence: a single
  Get-WinEvent against the TaskScheduler/Operational log measured 76.98s under completely normal
  conditions (3108 events, 7-day window), and two independent end-to-end runs of this classifier
  measured 187s and 215s the same day -- Get-WinEvent -FilterHashtable is intrinsically slow
  against this log/provider combination even when nothing is wrong, and the log wraps frequently
  (no retention, 10MB cap) while this machine enters Modern Standby ~20x/day, both plausible
  contributors to worse variance. Each call below is wrapped in
  Invoke-ScriptBlockWithTimeout (lib/job-timeout.ps1) -- the in-process analogue of
  lib/native-timeout.ps1's Invoke-NativeCommandWithTimeout, since these are cmdlet calls on this
  process's own thread, not external processes a taskkill /T could reap. A timeout is reported
  through the same $result.errors / null-field path as any other read failure, preserving "never
  throws on missing data": a stall becomes an INDETERMINATE-leaning gap in the output, never a
  hang. Regression guard: job-timeout.smoke-test.ps1 (the shared primitive) and scenario 3 in
  mirror-run-classify.smoke-test.ps1 (this script's own end-to-end bound).
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'ORA Command Center - Mirror Deploy',
  [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\deploy-beacon.ps1')
. (Join-Path $PSScriptRoot 'lib\job-timeout.ps1')

# Per-call bounds for the live system-state queries below (see BOUNDED QUERIES note above for the
# measured evidence). $TaskSchedulerLogTimeoutSeconds is wider than the others because it alone
# scans the full 7-day TaskScheduler/Operational window (the 76.98s single-call measurement); the
# System-log queries below it filter a narrow +/-5 minute (or bounded suspension) window and have
# not been observed anywhere near as slow, but get real headroom rather than a guess. If every
# single one of these timed out, the script would still terminate in
# ~(60 + 180 + 90*3) = 510s (~8.5min) -- bounded, not fast, but never unbounded.
$ScheduledTaskInfoTimeoutSeconds = 60
$TaskSchedulerLogTimeoutSeconds  = 180
$EventLogWindowTimeoutSeconds    = 90

# Resolve the repo root HERE, in the body -- never as a param-block default. Param defaults are
# evaluated before $PSScriptRoot is populated under `powershell -File`, so the previous
# `[string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)` died on every -File launch with
# "Cannot bind argument to parameter 'Path' because it is an empty string" -- and -File is
# exactly how the drift-check SKILL.md invokes this. Body-level $PSScriptRoot is populated in
# every invocation mode, which is why the dot-source above and deploy-mirror.ps1:55 were always
# fine. Same idiom as Get-DeployBeaconPath. Regression guard: mirror-run-classify.smoke-test.ps1.
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }

# System-log events that legitimately explain a mid-run kill. IDs are Windows-defined.
$EnvEventLabels = @{
  1074 = 'shutdown/restart initiated (User32)'
  1075 = 'shutdown initiated by remote'
  109  = 'kernel power shutdown transition'
  13   = 'operating system shutting down'
  12   = 'operating system started (boot)'
  41   = 'kernel power -- unclean shutdown'
  6008 = 'unexpected shutdown'
  6006 = 'event log service stopped (shutdown)'
  42   = 'entering sleep (S3)'
  107  = 'resuming from sleep (S3)'
  506  = 'entering Modern Standby'
  507  = 'exiting Modern Standby'
}

$result = [ordered]@{
  checkedAt        = (Get-Date).ToString('o')
  taskName         = $TaskName
  repoRoot         = $RepoRoot
  lastRunTime      = $null
  lastTaskResult   = $null
  nextRunTime      = $null
  runEndedAt       = $null
  beaconPresent    = $false
  beaconStatus     = $null
  beaconOutcome    = $null
  gitBehind        = $null
  gitAhead         = $null
  aheadFlag        = $null
  verdict          = 'INDETERMINATE'
  reason           = $null
  correlatingEvent = $null
  suspendedMinutes = 0
  errors           = @()
}

# --- 1) Native task info -----------------------------------------------------------------
$info = $null
try {
  $infoResult = Invoke-ScriptBlockWithTimeout -TimeoutSeconds $ScheduledTaskInfoTimeoutSeconds `
    -ArgumentList @($TaskName) -ScriptBlock {
      param($TaskName)
      Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
    }
  if ($infoResult.TimedOut) {
    $result.errors += "Get-ScheduledTaskInfo timed out after ${ScheduledTaskInfoTimeoutSeconds}s"
  } elseif (-not $infoResult.Success) {
    $result.errors += "Get-ScheduledTaskInfo failed: $($infoResult.ErrorMessage)"
  } else {
    $info = $infoResult.Value
    $result.lastRunTime    = $info.LastRunTime.ToString('o')
    $result.lastTaskResult = [long]$info.LastTaskResult
    $result.nextRunTime    = if ($info.NextRunTime) { $info.NextRunTime.ToString('o') } else { $null }
  }
} catch {
  $result.errors += "Get-ScheduledTaskInfo failed: $($_.Exception.Message)"
}

# --- 2) The run's actual END time --------------------------------------------------------
# LastRunTime is when the task STARTED. The correlation window is anchored to the end,
# because a run can be killed hours after launching (the 2026-08-01 10:06 incident).
#
# The event must belong to THIS run, which `Select-Object -First 1` never checked. While a run
# is in flight it has no 201 event yet, so the newest one is the PREVIOUS run's: on 2026-08-09
# the 09:00:01 run was handed 08:51:07, an end time before its own start, and the classifier
# correlated a Modern Standby event from that earlier moment. Select-RunCompletionEvent returns
# $null instead of borrowing, because the drift-check SKILL copies this field straight into the
# Notion row -- a foreign end time there reads as this run's.
$runEndedAt = $null
try {
  $completionsResult = Invoke-ScriptBlockWithTimeout -TimeoutSeconds $TaskSchedulerLogTimeoutSeconds `
    -ArgumentList @($TaskName) -ScriptBlock {
      param($TaskName)
      @(Get-WinEvent -FilterHashtable @{
        LogName   = 'Microsoft-Windows-TaskScheduler/Operational'
        Id        = 201
        StartTime = (Get-Date).AddDays(-7)
      } -ErrorAction Stop | Where-Object { $_.Message -like "*$TaskName*" })
    }

  if ($completionsResult.TimedOut) {
    $result.errors += "Task Scheduler completion-event lookup timed out after ${TaskSchedulerLogTimeoutSeconds}s"
  } elseif (-not $completionsResult.Success) {
    $result.errors += "Task Scheduler completion-event lookup failed: $($completionsResult.ErrorMessage)"
  } else {
    $completions = @($completionsResult.Value)
    $completion = if ($info -and $info.LastRunTime) {
      Select-RunCompletionEvent -Events $completions -RunStartedAt $info.LastRunTime
    } else {
      # No LastRunTime to test ownership against; fall back to the newest, as before.
      $completions | Select-Object -First 1
    }
    if ($completion) {
      $runEndedAt = $completion.TimeCreated
      $result.runEndedAt = $runEndedAt.ToString('o')
    }
  }
} catch {
  $result.errors += "Task Scheduler completion-event lookup failed: $($_.Exception.Message)"
}

# --- 3) Nearby System-log power/session events -------------------------------------------
$envEvents = @()
if ($runEndedAt) {
  try {
    $powerResult = Invoke-ScriptBlockWithTimeout -TimeoutSeconds $EventLogWindowTimeoutSeconds `
      -ArgumentList @($runEndedAt, @($EnvEventLabels.Keys)) -ScriptBlock {
        param($RunEndedAt, $Ids)
        Get-WinEvent -FilterHashtable @{
          LogName   = 'System'
          Id        = $Ids
          StartTime = $RunEndedAt.AddMinutes(-5)
          EndTime   = $RunEndedAt.AddMinutes(5)
        } -ErrorAction Stop
      }
    if ($powerResult.TimedOut) {
      $result.errors += "System event lookup timed out after ${EventLogWindowTimeoutSeconds}s"
    } elseif (-not $powerResult.Success) {
      # A genuinely empty window throws "No events were found" on PS 5.1 -- that is a normal
      # result (it is exactly what the 2026-08-01 13:01 unexplained kill looked like), NOT an
      # error, so it must not be recorded as one or the verdict would read as unreliable.
      if ($powerResult.ErrorMessage -notmatch 'No events were found') {
        $result.errors += "System event lookup failed: $($powerResult.ErrorMessage)"
      }
    } else {
      foreach ($e in @($powerResult.Value)) {
        $envEvents += [pscustomobject]@{
          TimeCreated = $e.TimeCreated
          Id          = $e.Id
          Label       = $EnvEventLabels[[int]$e.Id]
        }
      }
    }
  } catch {
    $result.errors += "System event lookup failed: $($_.Exception.Message)"
  }

  # SESSION-class events (2026-09-05). Queried SEPARATELY from the power ids above and scoped
  # by PROVIDER, because IsolatedUserMode id 1 is generic across providers; folding it into the
  # id-only query would match unrelated events and excuse kills that nothing explains (verified:
  # a Kernel-* wildcard query on ids 1/5 returned 11 non-session events).
  #
  # The re-check below is NOT belt-and-braces, it is load-bearing, for two independent reasons:
  #   1. -FilterHashtable ANDs LogName/ProviderName/Id, so it returns the CROSS-PRODUCT and can
  #      hand back e.g. a Winlogon event carrying id 1.
  #   2. ProviderName in -FilterHashtable is WILDCARD-matched, not exact (verified live:
  #      '*IsolatedUserMode*' resolves). Today's allowlist strings contain no metacharacters, so
  #      nothing is smuggled -- but the exactness guarantee comes from
  #      Get-MirrorSessionEventLabel, never from this hashtable.
  # That function (lib/deploy-beacon.ps1) is the authoritative pairing and is covered by smoke
  # scenarios 9a-9j; the hashtable here is only a coarse pre-filter.
  #
  # A non-existent provider name here throws a message that does NOT match 'No events were
  # found', so it lands in $result.errors and this whole block yields nothing -- failing toward
  # ALARM, which is the safe direction.
  try {
    $sessionResult = Invoke-ScriptBlockWithTimeout -TimeoutSeconds $EventLogWindowTimeoutSeconds `
      -ArgumentList @($runEndedAt, @(Get-MirrorSessionEventProviders), @(Get-MirrorSessionEventIds)) `
      -ScriptBlock {
        param($RunEndedAt, $Providers, $Ids)
        Get-WinEvent -FilterHashtable @{
          LogName      = 'System'
          ProviderName = $Providers
          Id           = $Ids
          StartTime    = $RunEndedAt.AddMinutes(-5)
          EndTime      = $RunEndedAt.AddMinutes(5)
        } -ErrorAction Stop
      }
    if ($sessionResult.TimedOut) {
      $result.errors += "Session event lookup timed out after ${EventLogWindowTimeoutSeconds}s"
    } elseif (-not $sessionResult.Success) {
      if ($sessionResult.ErrorMessage -notmatch 'No events were found') {
        $result.errors += "Session event lookup failed: $($sessionResult.ErrorMessage)"
      }
    } else {
      foreach ($e in @($sessionResult.Value)) {
        $label = Get-MirrorSessionEventLabel -ProviderName $e.ProviderName -Id ([int]$e.Id)
        if (-not $label) { continue }
        $envEvents += [pscustomobject]@{
          TimeCreated = $e.TimeCreated
          Id          = $e.Id
          Label       = $label
        }
      }
    }
  } catch {
    $result.errors += "Session event lookup failed: $($_.Exception.Message)"
  }
}

# --- 4) Beacon ---------------------------------------------------------------------------
$beacon = $null
try {
  $beacon = Get-DeployBeacon -BeaconPath (Get-DeployBeaconPath -RepoRoot $RepoRoot)
  if ($beacon) {
    $result.beaconPresent = $true
    $result.beaconStatus  = $beacon.status
    $result.beaconOutcome = $beacon.outcome
  }
} catch {
  $result.errors += "Beacon read failed: $($_.Exception.Message)"
}

# --- 5) Git behind AND ahead -------------------------------------------------------------
# Ahead matters as much as behind: on 2026-08-03 local main sat 1 commit ahead, on no remote
# branch, for five days while the check reported "drift 0 = clean". Read-only; assumes the
# caller already ran `git fetch origin`.
try {
  Push-Location $RepoRoot
  $behind = (& git rev-list --count HEAD..origin/main 2>$null)
  $ahead  = (& git rev-list --count origin/main..HEAD 2>$null)
  if ($behind -match '^\d+$') { $result.gitBehind = [int]$behind }
  if ($ahead  -match '^\d+$') {
    $result.gitAhead = [int]$ahead
    # Escalation is driven by how LONG a commit has been stranded, not how many there are
    # (see $script:MirrorAheadStaleHours). --reverse puts the oldest ahead-commit first, and
    # %cI is the COMMITTER date -- when it actually landed on local main. Author date would
    # be wrong here: a cherry-picked commit can carry an author date from weeks earlier and
    # would read as stranded the moment it lands. (This does NOT hold for MERGE commits: the
    # oldest commit reachable via a just-merged feature branch keeps its original committer
    # date, so a stale branch merged locally reads as stranded from its own creation. That
    # over-pages rather than going silent, and this repo merges on the remote, so it is
    # accepted rather than special-cased.)
    $oldestAheadAt = [datetime]::MinValue
    if ([int]$ahead -gt 0) {
      # The git call belongs INSIDE this try, not just the parse (adversarial review,
      # 2026-08-12). $ErrorActionPreference='Stop' is set at the top of this script, and
      # under PS 5.1 a native command writing ANYTHING to stderr -- including a warning
      # while succeeding -- throws (same hazard documented at deploy-mirror.ps1:169). With
      # the call outside, that throw escaped to the outer catch, left aheadFlag $null while
      # gitAhead was already set, and mislabelled it "git rev-list failed" -- an inferred
      # null in the one field this change exists to make trustworthy.
      try {
        $oldestRaw = (& git log origin/main..HEAD --reverse --format=%cI 2>$null | Select-Object -First 1)
        if ($oldestRaw) {
          $oldestAheadAt = [datetime]::Parse($oldestRaw, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
        }
      } catch {
        # Leave it at MinValue -- Test-MirrorRepoAhead escalates on an unreadable date
        # rather than assuming the commit is fresh.
        $result.errors += "could not read oldest ahead-commit date: $($_.Exception.Message)"
      }
    }
    $result.aheadFlag = Test-MirrorRepoAhead -AheadCount ([int]$ahead) -OldestAheadCommitAt $oldestAheadAt
  }
} catch {
  $result.errors += "git rev-list failed: $($_.Exception.Message)"
} finally {
  Pop-Location -ErrorAction SilentlyContinue
}

# --- 5b) Time the machine spent SUSPENDED inside this run's window -------------------------
#
# WHY (2026-08-25): ALARM_RUN_STUCK compares elapsed time against a 90-minute threshold, and it
# was measuring raw wall-clock. This machine enters Modern Standby ~20x/day, so any run that
# spans a sleep accrues wall-clock it never spent executing. The 13:13 run did ~8m16s of real
# work either side of a 2h07m sleep; a check at 15:00 would have computed 107 minutes and paged
# about a deploy that was merely asleep.
#
# Only the IN-FLIGHT window matters (RunStartedAt -> now), which is the only window the stuck
# test looks at. Pairs 506 (entering) with 507 (exiting); an unclosed 506 means the machine is
# still suspended, so the interval runs to now.
#
# Failure here is non-fatal by design: a missing figure means 0, which restores the previous
# wall-clock behaviour rather than silently excusing a genuinely wedged run.
if ($info -and $info.LastRunTime) {
  try {
    $windowStart = $info.LastRunTime
    $now         = Get-Date
    if ($windowStart -lt $now) {
      # This window's width is RunStartedAt -> now, i.e. it GROWS with how long the run has been
      # in flight -- unbounded in principle for a wedged run, which is exactly the case this
      # figure exists to detect. $EventLogWindowTimeoutSeconds bounds the QUERY regardless of how
      # wide that window gets; a timed-out query still yields suspendedMinutes = 0 (the same
      # "missing figure means 0" fallback the comment above already documents for any other
      # read failure), not a hang.
      $sleepResult = Invoke-ScriptBlockWithTimeout -TimeoutSeconds $EventLogWindowTimeoutSeconds `
        -ArgumentList @($windowStart, $now) -ScriptBlock {
          param($WindowStart, $Now)
          @(Get-WinEvent -FilterHashtable @{
            LogName   = 'System'
            Id        = @(506, 507)
            StartTime = $WindowStart
            EndTime   = $Now
          } -ErrorAction SilentlyContinue | Sort-Object TimeCreated)
        }

      if ($sleepResult.TimedOut) {
        $result.errors += "Modern Standby suspension lookup timed out after ${EventLogWindowTimeoutSeconds}s"
      } elseif (-not $sleepResult.Success) {
        $result.errors += "Modern Standby suspension lookup failed: $($sleepResult.ErrorMessage)"
      } else {
        $sleepEvents = @($sleepResult.Value)

        $suspended = [timespan]::Zero
        $sleepFrom = $null
        foreach ($e in $sleepEvents) {
          if ($e.Id -eq 506) {
            # Keep the FIRST 506 of a run of them; a repeated 506 without an intervening 507 is
            # the same suspension being re-announced, not a second one.
            if ($null -eq $sleepFrom) { $sleepFrom = $e.TimeCreated }
          } elseif ($e.Id -eq 507 -and $null -ne $sleepFrom) {
            $suspended += ($e.TimeCreated - $sleepFrom)
            $sleepFrom = $null
          }
        }
        # Still suspended at check time -- the interval has not closed yet.
        if ($null -ne $sleepFrom) { $suspended += ($now - $sleepFrom) }

        $result.suspendedMinutes = [math]::Round($suspended.TotalMinutes, 1)
      }
    }
  } catch {
    $result.errors += "Modern Standby suspension lookup failed: $($_.Exception.Message)"
  }
}

# --- 6) Classify -------------------------------------------------------------------------
if ($null -ne $result.lastTaskResult) {
  # Splatted, and the two datetimes are omitted when unknown rather than passed as $null.
  # PowerShell cannot bind $null to a [datetime] parameter -- it throws "Cannot convert null to
  # type System.DateTime" -- so the previous `-RunEndedAt $runEndedAt` killed this script
  # outright whenever no completion event was found. That was latent before (it needed an empty
  # 7-day event window); with the ownership test above, an in-flight run reaches it every time.
  $verdictArgs = @{
    Beacon              = $beacon
    LastTaskResult      = [long]$result.lastTaskResult
    EnvironmentalEvents = $envEvents
  }
  if ($info -and $info.LastRunTime) { $verdictArgs['RunStartedAt'] = $info.LastRunTime }
  if ($runEndedAt)                  { $verdictArgs['RunEndedAt']   = $runEndedAt }
  if ($result.suspendedMinutes -gt 0) { $verdictArgs['SuspendedMinutes'] = [double]$result.suspendedMinutes }
  $verdict = Get-MirrorRunVerdict @verdictArgs
  $result.verdict = $verdict.verdict
  $result.reason  = $verdict.reason
  $result.correlatingEvent = $verdict.correlatingEvent
} else {
  $result.reason = 'Could not read the native task info, so the run could not be classified. Treat as ALARM per the check doctrine: "can''t verify" is not "confirmed healthy".'
}

$result | ConvertTo-Json -Depth 5

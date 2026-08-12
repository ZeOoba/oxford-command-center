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
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'ORA Command Center - Mirror Deploy',
  [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\deploy-beacon.ps1')

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
  errors           = @()
}

# --- 1) Native task info -----------------------------------------------------------------
$info = $null
try {
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
  $result.lastRunTime    = $info.LastRunTime.ToString('o')
  $result.lastTaskResult = [long]$info.LastTaskResult
  $result.nextRunTime    = if ($info.NextRunTime) { $info.NextRunTime.ToString('o') } else { $null }
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
  $completions = @(Get-WinEvent -FilterHashtable @{
    LogName   = 'Microsoft-Windows-TaskScheduler/Operational'
    Id        = 201
    StartTime = (Get-Date).AddDays(-7)
  } -ErrorAction Stop | Where-Object { $_.Message -like "*$TaskName*" })

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
} catch {
  $result.errors += "Task Scheduler completion-event lookup failed: $($_.Exception.Message)"
}

# --- 3) Nearby System-log power/session events -------------------------------------------
$envEvents = @()
if ($runEndedAt) {
  try {
    $raw = Get-WinEvent -FilterHashtable @{
      LogName   = 'System'
      Id        = @($EnvEventLabels.Keys)
      StartTime = $runEndedAt.AddMinutes(-5)
      EndTime   = $runEndedAt.AddMinutes(5)
    } -ErrorAction Stop
    foreach ($e in $raw) {
      $envEvents += [pscustomobject]@{
        TimeCreated = $e.TimeCreated
        Id          = $e.Id
        Label       = $EnvEventLabels[[int]$e.Id]
      }
    }
  } catch {
    # A genuinely empty window throws "No events were found" on PS 5.1 -- that is a normal
    # result (it is exactly what the 2026-08-01 13:01 unexplained kill looked like), NOT an
    # error, so it must not be recorded as one or the verdict would read as unreliable.
    if ($_.Exception.Message -notmatch 'No events were found') {
      $result.errors += "System event lookup failed: $($_.Exception.Message)"
    }
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
  $verdict = Get-MirrorRunVerdict @verdictArgs
  $result.verdict = $verdict.verdict
  $result.reason  = $verdict.reason
  $result.correlatingEvent = $verdict.correlatingEvent
} else {
  $result.reason = 'Could not read the native task info, so the run could not be classified. Treat as ALARM per the check doctrine: "can''t verify" is not "confirmed healthy".'
}

$result | ConvertTo-Json -Depth 5

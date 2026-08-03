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
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\deploy-beacon.ps1')

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
$runEndedAt = $null
try {
  $completion = Get-WinEvent -FilterHashtable @{
    LogName   = 'Microsoft-Windows-TaskScheduler/Operational'
    Id        = 201
    StartTime = (Get-Date).AddDays(-7)
  } -ErrorAction Stop | Where-Object { $_.Message -like "*$TaskName*" } | Select-Object -First 1
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
    $result.aheadFlag = Test-MirrorRepoAhead -AheadCount ([int]$ahead)
  }
} catch {
  $result.errors += "git rev-list failed: $($_.Exception.Message)"
} finally {
  Pop-Location -ErrorAction SilentlyContinue
}

# --- 6) Classify -------------------------------------------------------------------------
if ($null -ne $result.lastTaskResult) {
  $verdict = Get-MirrorRunVerdict -Beacon $beacon `
                                  -LastTaskResult ([long]$result.lastTaskResult) `
                                  -RunStartedAt $info.LastRunTime `
                                  -RunEndedAt $runEndedAt `
                                  -EnvironmentalEvents $envEvents
  $result.verdict = $verdict.verdict
  $result.reason  = $verdict.reason
  $result.correlatingEvent = $verdict.correlatingEvent
} else {
  $result.reason = 'Could not read the native task info, so the run could not be classified. Treat as ALARM per the check doctrine: "can''t verify" is not "confirmed healthy".'
}

$result | ConvertTo-Json -Depth 5

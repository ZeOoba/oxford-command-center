<#
  Regression smoke test for scripts/lib/deploy-beacon.ps1.

  WHY THIS EXISTS (incident, 2026-08-03): the hourly "ORA Command Center - Mirror Deploy"
  task returned 3221225786 (0xC000013A = STATUS_CONTROL_C_EXIT) three times in seven days.
  deploy-mirror.ps1 alerts from a try/catch, which assumes the script THROWS -- but
  0xC000013A means the process was KILLED, so the catch never ran and data/outbox/ recorded
  nothing. The failure was invisible to the pipeline's own alerting; only an external
  sampling check that reads LastTaskResult noticed.

  Root cause of the three kills (established from the System event log):
    * 2026-08-01 10:06:18 -- killed across a Modern Standby transition (507 "exiting Modern
      Standby Reason: Input Keyboard" at 10:06:08, ten seconds prior).
    * 2026-08-03 11:28:13 -- killed by a system restart (User32 1074 winlogon-initiated
      restart at 11:28:21, eight seconds later).
    * 2026-08-01 13:01:37 -- NO correlating power/session event anywhere near it. Genuinely
      unexplained; this is the one that must still alarm.
    * 2026-08-04 11:00:01 -- also unexplained, and originally MISCLASSIFIED as
      ALARM_SCRIPT_FAILED because the run was killed before it could write a beacon and the
      classifier read the PREVIOUS hour's beacon as this run's. See Part 2b and fixture 3d.

  So the requirement is not "detect kills" (they are mostly benign machine lifecycle) but
  "tell a benign environmental interruption apart from an unexplained one, and never go
  silent on the latter". Scenarios 3a-3d below replay all four real incidents as regression
  fixtures.

  This repo has no Pester/.Tests.ps1 convention for PowerShell (same as
  deploy-mirror.smoke-test.ps1), so this is a plain run-by-hand assertion script rather than
  something wired into `npm test`.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-beacon.smoke-test.ps1
  Exits 0 if all assertions pass, 1 otherwise.
#>
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\deploy-beacon.ps1')

$failures = @()
function Assert-Equal {
  param([string]$Expected, [string]$Actual, [string]$Message)
  if ($Expected -ne $Actual) {
    $script:failures += $Message
    Write-Host "FAIL: $Message (expected '$Expected', got '$Actual')"
  } else {
    Write-Host "pass: $Message"
  }
}
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { $script:failures += $Message; Write-Host "FAIL: $Message" }
  else { Write-Host "pass: $Message" }
}

$scratch = Join-Path $env:TEMP "deploy-beacon-smoke-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
$beaconPath = Join-Path $scratch 'mirror-deploy-beacon.json'

# ---------------------------------------------------------------------------
# Part 1 -- beacon write/read round-trip
# ---------------------------------------------------------------------------

# 1a: Write-DeployBeaconStart creates a 'running' beacon with no finishedAt.
$t0 = [datetime]'2026-08-03 14:00:00'
Write-DeployBeaconStart -BeaconPath $beaconPath -StartedAt $t0 -HeadSha 'abc1234'
$b = Get-DeployBeacon -BeaconPath $beaconPath
Assert-Equal 'running' $b.status                   '1a: start beacon status is running'
Assert-Equal 'abc1234' $b.headSha                  '1a: start beacon records headSha'
Assert-True  ($null -eq $b.finishedAt)             '1a: start beacon has no finishedAt'
Assert-True  ($b.startedAt -eq $t0)                '1a: start beacon startedAt round-trips as a datetime'

# 1b: the beacon must survive being written into a directory that does not exist yet --
# data/_state/ is gitignored, so a fresh clone has no such folder and the FIRST deploy on a
# new machine would otherwise die inside the beacon call rather than doing its actual job.
$nestedBeacon = Join-Path $scratch 'does\not\exist\yet\beacon.json'
Write-DeployBeaconStart -BeaconPath $nestedBeacon -StartedAt $t0 -HeadSha 'abc1234'
Assert-True (Test-Path $nestedBeacon)              '1b: start beacon creates missing parent directories'

# 1c: Write-DeployBeaconEnd flips it to completed and stamps the outcome.
$t1 = [datetime]'2026-08-03 14:06:30'
Write-DeployBeaconEnd -BeaconPath $beaconPath -FinishedAt $t1 -Outcome 'success'
$b = Get-DeployBeacon -BeaconPath $beaconPath
Assert-Equal 'completed' $b.status                 '1c: end beacon status is completed'
Assert-Equal 'success'   $b.outcome                '1c: end beacon records outcome'
Assert-True  ($b.finishedAt -eq $t1)               '1c: end beacon finishedAt round-trips'
Assert-True  ($b.startedAt -eq $t0)                '1c: end beacon PRESERVES the original startedAt'

# 1d: a failed outcome is recorded distinctly (the script threw and self-alerted).
Write-DeployBeaconEnd -BeaconPath $beaconPath -FinishedAt $t1 -Outcome 'failed' -Reason 'GATE CHECK INCONCLUSIVE'
$b = Get-DeployBeacon -BeaconPath $beaconPath
Assert-Equal 'failed' $b.outcome                   '1d: failed outcome recorded'
Assert-Equal 'GATE CHECK INCONCLUSIVE' $b.reason   '1d: failure reason recorded'

# 1e: a missing beacon reads as $null, not an exception.
Assert-True ($null -eq (Get-DeployBeacon -BeaconPath (Join-Path $scratch 'nope.json'))) '1e: missing beacon returns null'

# 1f: a CORRUPT beacon reads as $null rather than throwing. A half-written beacon is exactly
# what a kill mid-write produces, so this is a live case, not a hypothetical.
Set-Content -Path (Join-Path $scratch 'corrupt.json') -Value '{"status":"run' -Encoding UTF8
Assert-True ($null -eq (Get-DeployBeacon -BeaconPath (Join-Path $scratch 'corrupt.json'))) '1f: corrupt beacon returns null'

# ---------------------------------------------------------------------------
# Part 2 -- Get-MirrorRunVerdict classification
#
# All inputs are injected so this runs with no real event log and no real scheduled task.
# ---------------------------------------------------------------------------

function New-Beacon {
  param($Status, $Outcome, $StartedAt, $FinishedAt, $Reason = $null)
  [pscustomobject]@{ status = $Status; outcome = $Outcome; startedAt = $StartedAt; finishedAt = $FinishedAt; reason = $Reason }
}

$start = [datetime]'2026-08-03 14:00:00'
$end   = [datetime]'2026-08-03 14:06:30'

# 2a: clean success.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'completed' 'success' $start $end) `
                          -LastTaskResult 0 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'HEALTHY' $v.verdict '2a: rc=0 + completed/success -> HEALTHY'

# 2b: THE SILENT CASE. Windows reported success but the script never reached its exit path.
# Nothing in the pipeline would surface this today -- it is the whole reason the beacon has a
# distinct 'running' state instead of just being written once at the end.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'running' $null $start $null) `
                          -LastTaskResult 0 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'ALARM_SILENT_INCOMPLETE' $v.verdict '2b: rc=0 but beacon still running -> ALARM_SILENT_INCOMPLETE'

# 2c: STALE BEACON. rc=0 and status=completed, but the beacon is from an EARLIER run than the
# one Windows just reported -- so this run produced no beacon at all. Without the freshness
# comparison, 2c would masquerade as 2a and pass silently.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'completed' 'success' ([datetime]'2026-08-03 09:00:00') ([datetime]'2026-08-03 09:05:00')) `
                          -LastTaskResult 0 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'ALARM_SILENT_INCOMPLETE' $v.verdict '2c: rc=0 but beacon predates this run -> ALARM_SILENT_INCOMPLETE'

# 2d: the script threw and self-alerted via Send-DeployFailureAlert. Real failure, real alert.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'completed' 'failed' $start $end) `
                          -LastTaskResult 1 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'ALARM_SCRIPT_FAILED' $v.verdict '2d: rc!=0 + completed/failed -> ALARM_SCRIPT_FAILED'

# 2e: killed, WITH a correlating environmental event inside the window -> benign.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'running' $null $start $null) `
                          -LastTaskResult 3221225786 -RunStartedAt $start -RunEndedAt $end `
                          -EnvironmentalEvents @([pscustomobject]@{ TimeCreated = $end.AddSeconds(8); Id = 1074; Label = 'restart initiated' })
Assert-Equal 'BENIGN_INTERRUPTED' $v.verdict '2e: killed + correlating event -> BENIGN_INTERRUPTED'

# 2f: killed, NO correlating event -> must alarm.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'running' $null $start $null) `
                          -LastTaskResult 3221225786 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'ALARM_UNEXPLAINED_KILL' $v.verdict '2f: killed + no correlating event -> ALARM_UNEXPLAINED_KILL'

# 2g: an environmental event FAR outside the window must not excuse the kill. This is the
# guard against the correlation window quietly widening until everything looks benign --
# this laptop enters Modern Standby ~20x/day, so a loose window would excuse literally every
# kill and the check would never alarm again.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'running' $null $start $null) `
                          -LastTaskResult 3221225786 -RunStartedAt $start -RunEndedAt $end `
                          -EnvironmentalEvents @([pscustomobject]@{ TimeCreated = $end.AddMinutes(30); Id = 507; Label = 'standby exit' })
Assert-Equal 'ALARM_UNEXPLAINED_KILL' $v.verdict '2g: killed + only a far-away event -> still ALARM_UNEXPLAINED_KILL'

# 2i: when several events fall inside the window, the reported cause must be the NEAREST one,
# not merely the first the event log happened to return. Get-WinEvent yields newest-first, so
# without an explicit nearest-wins selection a shutdown at +8s gets attributed to the
# subsequent boot at +51s -- both are "true", but only the closest names the actual cause, and
# a health report that names the wrong one sends the reader down the wrong path.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'running' $null $start $null) `
                          -LastTaskResult 3221225786 -RunStartedAt $start -RunEndedAt $end `
                          -EnvironmentalEvents @(
                            [pscustomobject]@{ TimeCreated = $end.AddSeconds(51); Id = 12;   Label = 'operating system started (boot)' },
                            [pscustomobject]@{ TimeCreated = $end.AddSeconds(8);  Id = 1074; Label = 'shutdown/restart initiated (User32)' }
                          )
Assert-Equal 'BENIGN_INTERRUPTED' $v.verdict            '2i: multiple in-window events -> BENIGN_INTERRUPTED'
Assert-Equal '1074' ([string]$v.correlatingEvent.Id)    '2i: nearest event (+8s restart) wins over the later boot (+51s)'

# 2h: no beacon at all -> INDETERMINATE, never a fabricated HEALTHY. ("Can't verify" is not
# "confirmed healthy" -- the drift-check SKILL makes this same distinction.)
$v = Get-MirrorRunVerdict -Beacon $null -LastTaskResult 0 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'INDETERMINATE' $v.verdict '2h: no beacon -> INDETERMINATE'

# ---------------------------------------------------------------------------
# Part 2b -- rc!=0 when the beacon did NOT come from this run (2026-08-04 defect)
#
# The rc=0 path has always tested beacon FRESHNESS (scenario 2c). The rc!=0 path tested only
# status, so a 'completed' beacon left behind by ANY earlier run made $killed false and
# short-circuited every kill straight to ALARM_SCRIPT_FAILED, never reaching the correlation
# logic at all.
#
# Live consequence, 2026-08-04 11:00:01: a run killed 28 seconds in -- before
# Write-DeployBeaconStart at deploy-mirror.ps1:146 ever executed -- was reported as "Script
# threw and reached its exit path (outcome=success)". That is self-contradictory on its face
# (killed is not threw; outcome=success is not a failure), and it told the reader a
# Send-DeployFailureAlert email should have arrived. None could: the script never threw. Step 5
# of the drift-check SKILL says a missing self-alert means the send path is itself broken and
# is "the bigger finding" -- so the bad verdict text manufactured a phantom second incident to
# go chase. Worse, it hid a real one (see 3d).
#
# The principle: a stale beacon carries exactly as much information about THIS run as no beacon
# at all -- none. It must route to the same correlation logic a 'running' beacon does.
# ---------------------------------------------------------------------------

$staleStart = [datetime]'2026-08-03 13:00:00'
$staleEnd   = [datetime]'2026-08-03 13:05:00'

# 2j: routing to correlation must not silently become "always alarm". An ordinary reboot
# mid-run is benign whether or not the run got far enough to leave a beacon of its own.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'completed' 'success' $staleStart $staleEnd) `
                          -LastTaskResult 3221225786 -RunStartedAt $start -RunEndedAt $end `
                          -EnvironmentalEvents @([pscustomobject]@{ TimeCreated = $end.AddSeconds(8); Id = 1074; Label = 'restart initiated' })
Assert-Equal 'BENIGN_INTERRUPTED' $v.verdict '2j: kill + STALE beacon + correlating event -> BENIGN_INTERRUPTED'

# 2k: THE 08-04 SHAPE. Stale completed/success beacon, killed, nothing explains it.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'completed' 'success' $staleStart $staleEnd) `
                          -LastTaskResult 3221225786 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'ALARM_UNEXPLAINED_KILL' $v.verdict '2k: kill + STALE beacon + no event -> ALARM_UNEXPLAINED_KILL'
Assert-True ($v.reason -notlike '*Send-DeployFailureAlert*') '2k: reason does not send the reader hunting a self-alert email'
Assert-True ($v.reason -notlike '*threw*')                   '2k: reason does not claim the script threw'
Assert-True ($v.reason -like '*earlier run*')                '2k: reason says why the beacon on disk was disregarded'

# 2l: a stale FAILED beacon must not be pinned on this run either. Otherwise a throw from an
# hour ago gets reported as this run's failure, with the same phantom-alert-email advice, and
# the actual kill goes unclassified.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'completed' 'failed' $staleStart $staleEnd -Reason 'GATE CHECK FAILED') `
                          -LastTaskResult 3221225786 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'ALARM_UNEXPLAINED_KILL' $v.verdict '2l: kill + STALE failed beacon -> ALARM_UNEXPLAINED_KILL, not ALARM_SCRIPT_FAILED'

# 2m: killed during TEARDOWN, after this run recorded success. Write-DeployBeaconEnd -Outcome
# 'success' sits past the wrangler deploy, which throws on a non-zero exit, so a FRESH success
# beacon is positive proof the mirror actually published. The work is done; only teardown died.
# This is the case the 08-04 report hypothesised -- it was not what happened that morning, but
# it is independently reachable (killed between deploy-mirror.ps1:274 and process exit) and the
# old code produced the same wrong text for it.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'completed' 'success' $start $end) `
                          -LastTaskResult 3221225786 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'BENIGN_KILLED_AFTER_COMPLETION' $v.verdict '2m: kill + FRESH success beacon -> BENIGN_KILLED_AFTER_COMPLETION'

# 2n: and it must not claim a self-alert email exists (defect 1 of the 08-04 report).
Assert-True ($v.reason -notlike '*Send-DeployFailureAlert should*') '2n: does not claim a failure alert should have fired'
Assert-True ($v.reason -notlike '*threw*')                          '2n: does not claim the script threw'
Assert-True ($v.reason -like '*NOT stale*')                         '2n: states plainly that the mirror is not stale'

# 2o: this verdict is gated on the beacon ALONE, never on a nearby power event. That is exactly
# what keeps it from becoming the creeping-silence failure a wider correlation window would be:
# no amount of Modern Standby churn can route a run into it, because the gate is this run's own
# success record. It must therefore classify identically with a far-away event present (2m had
# none) -- if this ever starts depending on $EnvironmentalEvents, the gate has moved.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'completed' 'success' $start $end) `
                          -LastTaskResult 3221225786 -RunStartedAt $start -RunEndedAt $end `
                          -EnvironmentalEvents @([pscustomobject]@{ TimeCreated = $end.AddMinutes(30); Id = 507; Label = 'standby exit' })
Assert-Equal 'BENIGN_KILLED_AFTER_COMPLETION' $v.verdict '2o: verdict comes from the beacon, not from event correlation'

# 2p: a FRESH failed beacon still means the script threw and self-alerted. 2d must not regress
# -- the new silent verdict is scoped to outcome=success and nothing else.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'completed' 'failed' $start $end -Reason 'wrangler deploy failed (1)') `
                          -LastTaskResult 3221225786 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'ALARM_SCRIPT_FAILED' $v.verdict '2p: kill rc + FRESH failed beacon -> still ALARM_SCRIPT_FAILED'
Assert-True ($v.reason -like '*wrangler deploy failed (1)*') '2p: the recorded failure reason is quoted'

# 2q: DANGLING PUNCTUATION (defect 2 of the 08-04 report). Write-DeployBeaconEnd defaults
# -Reason to '', so a beacon can legitimately carry an empty reason; interpolating it
# unconditionally produced a ": ." stranded mid-sentence. Empty must render as absent, not as
# punctuation.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'completed' 'failed' $start $end -Reason '') `
                          -LastTaskResult 3221225786 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'ALARM_SCRIPT_FAILED' $v.verdict '2q: empty reason still classifies as ALARM_SCRIPT_FAILED'
Assert-True ($v.reason -notlike '*: .*') '2q: empty beacon reason leaves no dangling ": ."'

# 2r: the rc=0 branch interpolates the reason the same way and needs the same guard. Its
# sentence has no trailing period, so an empty reason strands a hanging "...outcome='failed': "
# instead of a ": ." -- a different shape of the same defect, which is why this asserts on the
# trailing colon rather than reusing 2q's pattern.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'completed' 'failed' $start $end -Reason '') `
                          -LastTaskResult 0 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'ALARM_SCRIPT_FAILED' $v.verdict '2r: rc=0 + failed beacon still ALARM_SCRIPT_FAILED'
Assert-True ($v.reason -notlike '*: .*')                  '2r: rc=0 branch leaves no dangling ": ."'
Assert-True (-not $v.reason.TrimEnd().EndsWith(':'))      '2r: rc=0 branch leaves no hanging trailing colon'

# 2t: TWO KILLS IN A ROW. The previous run was killed and left a stale 'running' beacon; this
# run was killed too. The verdict was already right (a 'running' beacon takes the correlation
# path regardless), but the reason must still tell the reader the beacon on disk is not this
# run's -- otherwise they read a 'running' beacon as evidence about a run it has nothing to do
# with. Freshness, not status, is what makes a beacon worth quoting.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'running' $null $staleStart $null) `
                          -LastTaskResult 3221225786 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'ALARM_UNEXPLAINED_KILL' $v.verdict '2t: kill + stale RUNNING beacon -> ALARM_UNEXPLAINED_KILL'
Assert-True ($v.reason -like '*earlier run*') '2t: reason still flags the beacon as belonging to an earlier run'

# 2u: the converse -- a FRESH running beacon is this run's own, so it must NOT be disclaimed.
# If this ever starts printing the stale note, the gate has inverted and every ordinary
# mid-run kill would tell the reader to distrust a beacon that is in fact correct.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'running' $null $start $null) `
                          -LastTaskResult 3221225786 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-Equal 'ALARM_UNEXPLAINED_KILL' $v.verdict '2u: kill + FRESH running beacon -> ALARM_UNEXPLAINED_KILL'
Assert-True ($v.reason -notlike '*earlier run*') '2u: a fresh beacon is NOT disclaimed as stale'

# 2s: and the same branch must still quote a reason when there IS one.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'completed' 'failed' $start $end -Reason 'GATE CHECK INCONCLUSIVE') `
                          -LastTaskResult 0 -RunStartedAt $start -RunEndedAt $end -EnvironmentalEvents @()
Assert-True ($v.reason -like '*GATE CHECK INCONCLUSIVE*') '2s: rc=0 branch still quotes a non-empty reason'

# ---------------------------------------------------------------------------
# Part 3 -- regression fixtures: the four REAL 2026-08 incidents
# ---------------------------------------------------------------------------

# 3a: 2026-08-01 10:06:18 -- Modern Standby exit at 10:06:08, ten seconds before the kill.
# Note the long run (launched ~03:00, killed at 10:06) -- the correlation window is anchored
# to the run's END, not its start, precisely so a multi-hour run still classifies correctly.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'running' $null ([datetime]'2026-08-01 03:00:47') $null) `
                          -LastTaskResult 3221225786 `
                          -RunStartedAt ([datetime]'2026-08-01 03:00:47') `
                          -RunEndedAt   ([datetime]'2026-08-01 10:06:18') `
                          -EnvironmentalEvents @([pscustomobject]@{ TimeCreated = [datetime]'2026-08-01 10:06:08'; Id = 507; Label = 'exiting Modern Standby' })
Assert-Equal 'BENIGN_INTERRUPTED' $v.verdict '3a: real 08-01 10:06 standby kill -> BENIGN_INTERRUPTED'

# 3b: 2026-08-03 11:28:13 -- system restart initiated at 11:28:21, eight seconds after.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'running' $null ([datetime]'2026-08-03 11:28:09') $null) `
                          -LastTaskResult 3221225786 `
                          -RunStartedAt ([datetime]'2026-08-03 11:28:09') `
                          -RunEndedAt   ([datetime]'2026-08-03 11:28:13') `
                          -EnvironmentalEvents @([pscustomobject]@{ TimeCreated = [datetime]'2026-08-03 11:28:21'; Id = 1074; Label = 'restart initiated' })
Assert-Equal 'BENIGN_INTERRUPTED' $v.verdict '3b: real 08-03 11:28 restart kill -> BENIGN_INTERRUPTED'

# 3c: 2026-08-01 13:01:37 -- the unexplained one. The System log has ZERO events between
# 12:58 and 13:05; the nearest power event is a source change at 13:06:00, 263s away and well
# outside the window. This MUST alarm -- if a future window change makes 3c go benign, the
# check has been blinded to the only genuinely unexplained kill in the incident set.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'running' $null ([datetime]'2026-08-01 13:00:01') $null) `
                          -LastTaskResult 3221225786 `
                          -RunStartedAt ([datetime]'2026-08-01 13:00:01') `
                          -RunEndedAt   ([datetime]'2026-08-01 13:01:37') `
                          -EnvironmentalEvents @([pscustomobject]@{ TimeCreated = [datetime]'2026-08-01 13:06:00'; Id = 105; Label = 'power source change' })
Assert-Equal 'ALARM_UNEXPLAINED_KILL' $v.verdict '3c: real 08-01 13:01 unexplained kill -> ALARM_UNEXPLAINED_KILL'

# 3d: 2026-08-04 11:00:01 -- the incident that exposed the Part 2b defect, replayed from the
# live evidence rather than from the report's hypothesis about it.
#
# What actually happened: the hourly run started 11:00:01 and was killed at 11:00:29, 28
# seconds in -- before Write-DeployBeaconStart at deploy-mirror.ps1:146 ever executed -- so it
# wrote NO beacon of its own. The beacon sitting on disk belonged to the 10:00 run
# (startedAt 10:00:02, finishedAt 10:04:54, completed/success); that finishedAt matches the
# 10:00 run's Task Scheduler 201 completion event exactly, which is how the ownership was
# pinned. The nearest System power/session event was 09:51:33 -- 4,136s away, far outside the
# 90s window. The empty in-window result was re-run against an 08:00-13:00 window to prove it
# was a real null and not a failed query, per the verified-null-vs-inferred-null rule.
#
# So this is the THIRD unexplained kill (08-01 13:01, 08-03 20:05, 08-04 11:00), and the old
# code hid it behind ALARM_SCRIPT_FAILED -- an alarm, but for the wrong failure, pointing at a
# non-existent email. A wrong alarm is not a safe failure mode: it consumed the reader's
# attention on a phantom send-path outage while the real signal went unrecorded.
$v = Get-MirrorRunVerdict -Beacon (New-Beacon 'completed' 'success' ([datetime]'2026-08-04 10:00:02') ([datetime]'2026-08-04 10:04:54')) `
                          -LastTaskResult 3221225786 `
                          -RunStartedAt ([datetime]'2026-08-04 11:00:01') `
                          -RunEndedAt   ([datetime]'2026-08-04 11:00:29') `
                          -EnvironmentalEvents @([pscustomobject]@{ TimeCreated = [datetime]'2026-08-04 09:51:33'; Id = 6008; Label = 'unexpected shutdown' })
Assert-Equal 'ALARM_UNEXPLAINED_KILL' $v.verdict '3d: real 08-04 11:00 stale-beacon kill -> ALARM_UNEXPLAINED_KILL'
Assert-True ($v.reason -notlike '*Send-DeployFailureAlert*') '3d: reason promises no self-alert email that never fired'

# ---------------------------------------------------------------------------
# Part 4 -- Test-MirrorRepoAhead (the 2026-08-03 blind spot)
#
# The drift check measured only HEAD..origin/main (behind) and reported "drift 0 = clean"
# while local main sat 1 commit AHEAD, on no remote branch, for five days -- so the mirror
# was deploying a commit nobody could review on GitHub.
# ---------------------------------------------------------------------------

Assert-True  (Test-MirrorRepoAhead -AheadCount 1).isAhead   '4a: 1 commit ahead is flagged'
Assert-True  (-not (Test-MirrorRepoAhead -AheadCount 0).isAhead) '4b: 0 commits ahead is not flagged'
Assert-Equal 'FLAG' (Test-MirrorRepoAhead -AheadCount 2).severity '4c: below threshold is a FLAG (Notion row only)'

# Severity TIERING (2026-08-03, Gabriel ruling "option 3"). Ahead-of-origin is a hygiene
# problem, not a broken pipeline, so it must not page on the routine case: the lease-snapshot
# task auto-commits up to 3x/weekday and is instructed never to push, so ahead=1..2 is the
# EXPECTED steady state and emailing on it would train the reader to ignore the alert (the
# same over-firing failure the v1.2 rc!=0 rule was rolled back for). The threshold converts
# the old vague SKILL.md prose -- "persists across runs or exceeds a handful of commits" --
# into tested code, per this file's own doctrine that classification never lives in prose
# re-derived on each run.
Assert-Equal 'FLAG'     (Test-MirrorRepoAhead -AheadCount 1).severity  '4d: 1 ahead stays a FLAG, no email'
Assert-Equal 'ESCALATE' (Test-MirrorRepoAhead -AheadCount 3).severity  '4e: AT the threshold escalates'
Assert-Equal 'ESCALATE' (Test-MirrorRepoAhead -AheadCount 25).severity '4f: far above threshold escalates'
Assert-Equal 'OK'       (Test-MirrorRepoAhead -AheadCount 0).severity  '4g: not ahead is OK, never FLAG/ESCALATE'

# The threshold is exposed so the consumer reports it instead of hardcoding "3" in prose --
# the hardcoded-baseline-list rot this task already hit twice.
Assert-Equal 3 (Test-MirrorRepoAhead -AheadCount 5).threshold '4h: threshold is exposed on the result'
Assert-True ((Test-MirrorRepoAhead -AheadCount 5).reason -like '*3*') '4i: escalation reason names the threshold'
Assert-True ((Test-MirrorRepoAhead -AheadCount 5).isAhead) '4j: escalation still reports isAhead'

# Boundary guard: off-by-one here silently changes when the check pages. Pin both sides.
Assert-Equal 'FLAG'     (Test-MirrorRepoAhead -AheadCount 2).severity '4k: threshold-1 does NOT escalate'
Assert-Equal 'ESCALATE' (Test-MirrorRepoAhead -AheadCount 4).severity '4l: threshold+1 escalates'

# Negative counts are a caller bug (git rev-list can't return < 0); must not read as ahead.
Assert-True (-not (Test-MirrorRepoAhead -AheadCount -1).isAhead) '4m: negative count is not ahead'

# ---------------------------------------------------------------------------

Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host "FAILED: $($failures.Count) assertion(s)"
  exit 1
}
Write-Host 'ALL ASSERTIONS PASSED'
exit 0

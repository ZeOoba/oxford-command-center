<#
.SYNOPSIS
  Off-fleet alerting layer for "ORA Command Center - Mirror Deploy" (OI-197 fix (a),
  2026-08-21). Runs the SAME tested classifier (mirror-run-classify.ps1) as the
  CC/MCP fleet task ora-command-center-mirror-drift-check, but from a native Windows
  Scheduled Task -- so classification survives a full fleet pause, which the fleet
  task cannot (it went dark with everything else during the 2026-08-17 pause,
  per open-items-tracker.md#OI-197).

.DESCRIPTION
  Deliberately narrower than the fleet task's own doctrine
  (~/.claude/scheduled-tasks/ora-command-center-mirror-drift-check/SKILL.md): this
  script alarms ONLY on signals the classifier's own JSON already resolves
  mechanically -- it does not attempt the fleet task's richer working-tree
  FLAG/BENIGN judgment calls (those need an LLM reading git diff output, which this
  plain script cannot do). The fleet task remains the primary, full-fidelity check
  when the fleet is up; this is the redundant layer that survives when it is not.

  Alarms when ANY of:
    - classifier verdict is one of the ALARM_* values
    - aheadFlag.severity == 'ESCALATE'
    - LastRunTime is stale (>3h) during business hours (07:00-20:00 ET)

  On alarm: sends ONE Outlook COM alert via the same send-via-outlook.ps1 path
  deploy-mirror.ps1 already uses successfully standalone (proven working outside
  any Claude/fleet context, 2026-08-20 incident). Retry-once on send failure, then
  falls back to data/outbox/ -- never loses an alarm silently.

  Writes data/_state/mirror-classify-offfleet-status.json on every run (alarm or
  not) so a human or a future automated check can see the last off-fleet result
  without waiting for an email.

  Deliberately does NOT write to Notion. A GitHub Actions third-layer watchdog
  (matching ora-cowork-watchdog's cowork-heartbeat-check.py pattern) was designed
  alongside this but NOT built in the same pass -- it needs a Notion integration
  token provisioned for a native (non-Claude-session) script, which is its own
  decision and was deliberately not rushed the same day CRON_SECRET was rotated.
  See open-items-tracker.md#OI-197 for the follow-up.

.NOTES
  PS 5.1-compatible, matching mirror-run-classify.ps1. Read-only against the repo
  (does not fetch, pull, merge, or push) -- the classifier itself does not fetch
  either; this script fetches once, read-only, before calling it, matching the
  fleet task's own step 1.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$AlertSendScript = 'C:\Users\Owner\.claude\scheduled-tasks\_shared\send-via-outlook.ps1',
  [string]$AlertTo = 'ggoldberg@oxfordra.net',
  [int]$StaleHoursDuringBusinessHours = 3
)

$ErrorActionPreference = 'Stop'
# Resolve HERE, in the body -- never as a param-block default. Param defaults are evaluated
# before $PSScriptRoot is populated under `powershell -File`, which is exactly how a scheduled
# task invokes this. Same bug, same fix, as mirror-run-classify.ps1 (see its own header note).
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'
$statusPath = Join-Path $RepoRoot 'data\_state\mirror-classify-offfleet-status.json'

function Write-Status($obj) {
  $dir = Split-Path -Parent $statusPath
  New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue | Out-Null
  $obj | ConvertTo-Json -Depth 6 | Out-File -FilePath $statusPath -Encoding UTF8
}

function Send-Alert([string]$Subject, [string]$Body) {
  $tmpBodyPath = Join-Path $env:TEMP "ora-mirror-classify-offfleet-$([guid]::NewGuid()).txt"
  try {
    $Body | Out-File -FilePath $tmpBodyPath -Encoding UTF8
    $sendArgs = @('-NoProfile', '-File', $AlertSendScript, '-To', $AlertTo, '-Subject', $Subject, '-BodyFile', $tmpBodyPath, '-BodyFormat', 'text')
    & powershell @sendArgs
    $sendExit = $LASTEXITCODE
    if ($sendExit -eq 0) { return $true }
    if ($sendExit -eq 2 -or $sendExit -eq 4) {
      Start-Sleep -Seconds 5
      & powershell @sendArgs
      $sendExit = $LASTEXITCODE
      if ($sendExit -eq 0) { return $true }
    }
  }
  finally {
    Remove-Item -Path $tmpBodyPath -ErrorAction SilentlyContinue
  }
  $outboxDir = Join-Path $RepoRoot 'data\outbox'
  New-Item -ItemType Directory -Path $outboxDir -Force -ErrorAction SilentlyContinue | Out-Null
  $obStamp = (Get-Date).ToString('yyyy-MM-ddTHH-mm-ss')
  $outboxPath = Join-Path $outboxDir "$obStamp-mirror-classify-offfleet-alert.txt"
  "$Body`n`n(alert send itself failed, exit=$sendExit)" | Out-File -FilePath $outboxPath -Encoding UTF8
  Write-Host "[$ts] Alert send failed (exit=$sendExit) -- wrote fallback to $outboxPath"
  return $false
}

try {
  Push-Location $RepoRoot
  git fetch origin --quiet 2>&1 | Out-Null
  Pop-Location
} catch {
  Write-Host "[$ts] git fetch failed (non-fatal, classifier proceeds on local state): $($_.Exception.Message)"
}

$classifyScript = Join-Path $PSScriptRoot 'mirror-run-classify.ps1'
try {
  $json = & powershell -NoProfile -ExecutionPolicy Bypass -File $classifyScript -RepoRoot $RepoRoot
  $result = $json | ConvertFrom-Json
} catch {
  # Classifier itself failed to run -- can't-verify is not healthy (matches the fleet task's
  # own rule for this case).
  $reason = "mirror-run-classify.ps1 failed to run or produced unparseable output: $($_.Exception.Message)"
  Write-Status @{ checkedAt = $ts; alarmed = $true; reason = $reason; classifierAvailable = $false }
  Send-Alert -Subject '[ORA Command Center] Mirror Deploy Classifier (off-fleet) - ALARM' -Body @"
$reason

This is the off-fleet redundant classifier (mirror-classify-offfleet.ps1), running
independently of the CC/MCP fleet. If you are also seeing this from the fleet task,
the underlying problem is real. If this is the ONLY alert you got, the fleet task
may itself be down (e.g. during a fleet pause) -- check ora-command-center-mirror-drift-check.
"@ | Out-Null
  exit 1
}

$alarmReasons = New-Object System.Collections.Generic.List[string]

$alarmVerdicts = @('ALARM_RUN_STUCK', 'ALARM_UNEXPLAINED_KILL', 'ALARM_SILENT_INCOMPLETE', 'ALARM_SCRIPT_FAILED')
if ($result.verdict -in $alarmVerdicts) {
  $alarmReasons.Add("classifier verdict = $($result.verdict): $($result.reason)")
}
if ($result.aheadFlag -and $result.aheadFlag.severity -eq 'ESCALATE') {
  $alarmReasons.Add("ahead-of-origin ESCALATE: $($result.aheadFlag.reason)")
}

$hourEt = [int](Get-Date -Format 'HH')
$isBusinessHours = ($hourEt -ge 7 -and $hourEt -lt 20)
if ($isBusinessHours -and $result.lastRunTime) {
  try {
    $lastRun = [datetime]$result.lastRunTime
    $ageHours = ((Get-Date) - $lastRun).TotalHours
    if ($ageHours -gt $StaleHoursDuringBusinessHours) {
      $alarmReasons.Add("LastRunTime is $([math]::Round($ageHours,1))h old during business hours (threshold $StaleHoursDuringBusinessHours h)")
    }
  } catch {
    # Unreadable LastRunTime is itself worth flagging, but not fatal to the rest of the check.
    $alarmReasons.Add("LastRunTime unreadable: '$($result.lastRunTime)'")
  }
}

$alarmed = $alarmReasons.Count -gt 0

Write-Status @{
  checkedAt           = $ts
  alarmed             = $alarmed
  reasons             = $alarmReasons
  classifierVerdict   = $result.verdict
  aheadFlagSeverity   = if ($result.aheadFlag) { $result.aheadFlag.severity } else { $null }
  lastRunTime         = $result.lastRunTime
  classifierAvailable = $true
}

if ($alarmed) {
  $body = @(
    "Off-fleet mirror-deploy classifier ALARM at $ts.",
    '',
    ($alarmReasons -join "`n"),
    '',
    "Classifier verdict: $($result.verdict)",
    "Repo: $RepoRoot",
    '',
    "This is the redundant off-fleet layer (mirror-classify-offfleet.ps1) -- it exists",
    "specifically to keep alerting during a CC/MCP fleet pause, when",
    "ora-command-center-mirror-drift-check cannot run. See open-items-tracker.md#OI-197."
  ) -join "`n"
  Send-Alert -Subject '[ORA Command Center] Mirror Deploy Classifier (off-fleet) - ALARM' -Body $body | Out-Null
  Write-Host "[$ts] ALARM: $($alarmReasons -join '; ')"
  exit 1
} else {
  Write-Host "[$ts] OK -- verdict=$($result.verdict), no alarm."
  exit 0
}

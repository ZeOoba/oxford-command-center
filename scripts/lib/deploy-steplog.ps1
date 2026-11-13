<#
  Per-run step log for scripts/deploy-mirror.ps1.

  WHY. On 2026-11-13 Task Scheduler killed four overnight runs at the task's 30-minute
  ExecutionTimeLimit. The beacon (lib/deploy-beacon.ps1) only said "running", and Write-Host output
  from a hidden scheduled task goes nowhere, so the step that ran long could not be named. Each
  step now appends one timestamped line BEFORE it starts; after a kill, the run's last line names
  the step it died in.

  FORMAT. One line per event:  <ISO-8601 local time> <run id> <step>
  The file is capped at each run start: once it holds $MaxLines lines or more (default 2000, about
  a week and a half of hourly runs at ~15 lines each), Start-DeployStepLog trims it to the newest
  $MaxLines - 1 before writing the run's start line. The run then adds its own ~15 lines, so between
  runs the file may sit up to ~15 lines over the cap. The scheduled task runs one instance at a time
  (MultipleInstances IgnoreNew); two overlapping manual runs could lose a line to the trim.

  NEVER THROWS. Logging must not be able to fail a deploy: every function here swallows its own
  errors (a locked or unwritable file just loses that line).
#>

function Get-DeployStepLogPath {
  param([Parameter(Mandatory)][string]$RepoRoot)
  Join-Path $RepoRoot 'data\_state\mirror-deploy-steps.log'
}

function Start-DeployStepLog {
  <# Trims the log to its newest $MaxLines lines, then writes the run's 'start' line. Returns the run id. #>
  param(
    [Parameter(Mandatory)][string]$Path,
    [int]$MaxLines = 2000,
    [string]$Detail = ''
  )
  $runId = [guid]::NewGuid().ToString('N').Substring(0, 8)
  try {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if (Test-Path -LiteralPath $Path) {
      $lines = @(Get-Content -LiteralPath $Path -ErrorAction Stop)
      if ($lines.Count -ge $MaxLines) {
        # Keep room for this run's lines: trim to MaxLines - 1 so the start line lands within the cap.
        $keep = [Math]::Max(0, $MaxLines - 1)
        $tail = if ($keep -gt 0) { $lines[($lines.Count - $keep)..($lines.Count - 1)] } else { @() }
        Set-Content -LiteralPath $Path -Value $tail -Encoding UTF8
      }
    }
  } catch { }
  Write-DeployStep -Path $Path -RunId $runId -Step ("start" + $(if ($Detail) { " $Detail" } else { '' }))
  $runId
}

function Write-DeployStep {
  <# Appends one '<timestamp> <run id> <step>' line. Never throws. #>
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$RunId,
    [Parameter(Mandatory)][string]$Step
  )
  try {
    $line = '{0} {1} {2}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz'), $RunId, ($Step -replace '[\r\n]+', ' ')
    Add-Content -LiteralPath $Path -Value $line -Encoding UTF8
  } catch { }
}

<#
  Invoke-ScriptBlockWithTimeout -- run an in-process PowerShell scriptblock under a
  caller-owned time bound, terminating it if it overruns. Extracted into lib/ so
  scripts/job-timeout.smoke-test.ps1 exercises the REAL function rather than a hand-copied
  duplicate (same convention as lib/native-timeout.ps1's Invoke-NativeCommandWithTimeout).

  WHY THIS EXISTS (2026-09-18): Invoke-NativeCommandWithTimeout bounds an EXTERNAL process
  (started via [Process]::Start, killed via taskkill /T). It cannot bound an in-process cmdlet
  call like Get-WinEvent or Get-ScheduledTaskInfo -- there is no child process tree to kill,
  because the call runs on this process's own thread. mirror-run-classify.ps1 makes four live
  Get-WinEvent calls with no bound of their own; a single one of them measured 76.98s under
  completely normal conditions (3108 events over a 7-day window against the
  TaskScheduler/Operational log), and two independent end-to-end runs of the real classifier
  measured 187s and 215s on the same machine, same day -- so Get-WinEvent -FilterHashtable is
  intrinsically slow against this log/provider combination even when nothing is wrong. The
  classifier's own header comment promises it "never throws on missing data"; a stalled
  Get-WinEvent call inside it currently has no such promise -- it can hang the calling process
  indefinitely.

  Same underlying idea as Invoke-NativeCommandWithTimeout ("bounding the call ourselves, well
  under the caller's own budget, converts a hang into an ordinary terminating error the existing
  catch can alert on") but applied via Start-Job/Wait-Job -Timeout, the PS 5.1-compatible
  primitive for bounding in-process work: Start-Job runs the scriptblock in a genuinely separate
  child process, so Stop-Job/Remove-Job -Force can reclaim it the same way taskkill reclaims an
  external process tree -- this process's own thread is never blocked past the bound.

  Callers pass all inputs via -ArgumentList: a job's scriptblock has no closure over the caller's
  variables or dot-sourced functions, only what is explicitly handed to it via -ArgumentList (and
  whatever modules auto-load in the child, e.g. ScheduledTasks / Microsoft.PowerShell.Diagnostics).

  The scriptblock's own errors (e.g. Get-WinEvent's "No events were found" on a genuinely empty
  window, which callers here treat as a normal result, not a failure) are returned as
  -Success:$false / -ErrorMessage rather than re-thrown, so a caller under global
  $ErrorActionPreference = 'Stop' can inspect and classify them exactly as it did the original
  inline try/catch -- this function changes WHERE the call runs, not how its errors are reported.
#>

function Invoke-ScriptBlockWithTimeout {
  param(
    [Parameter(Mandatory=$true)][scriptblock]$ScriptBlock,
    [object[]]$ArgumentList = @(),
    # Same range as Invoke-NativeCommandWithTimeout's -TimeoutSeconds, for the same reason
    # (ValidateRange rejects a bad value before any job is even started, rather than reaching
    # Wait-Job with an out-of-range argument mid-call).
    [Parameter(Mandatory=$true)][ValidateRange(1, 86400)][int]$TimeoutSeconds
  )

  $job = Start-Job -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList
  try {
    Wait-Job -Job $job -Timeout $TimeoutSeconds | Out-Null

    if ($job.State -eq 'Running') {
      # Overran the bound. Stop-Job first (graceful, lets the child unwind its own pipeline);
      # Remove-Job -Force in the finally block below reclaims it unconditionally even if Stop-Job
      # itself does not fully quiesce it -- mirrors the "wait, then reap" shape of
      # Invoke-NativeCommandWithTimeout's WaitForExit + taskkill /T.
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      return [pscustomobject]@{
        TimedOut     = $true
        Success      = $false
        Value        = $null
        ErrorMessage = "timed out after ${TimeoutSeconds}s"
      }
    }

    if ($job.State -eq 'Failed') {
      $reason = $job.ChildJobs[0].JobStateInfo.Reason
      $message = if ($reason) { $reason.Message } else { 'job failed with no reason recorded' }
      return [pscustomobject]@{
        TimedOut     = $false
        Success      = $false
        Value        = $null
        ErrorMessage = $message
      }
    }

    # -ErrorAction SilentlyContinue + -ErrorVariable rather than -ErrorAction Stop: a scriptblock
    # that wrote to the error stream without throwing (e.g. via Write-Error) would otherwise
    # re-throw here under the CALLER's global $ErrorActionPreference = 'Stop', reintroducing the
    # exact "native stderr becomes a terminating ErrorRecord" hazard lib/git-capture.ps1's header
    # documents at length -- this function exists to make the failure a reported value, not a throw.
    $jobErrors = $null
    $value = Receive-Job -Job $job -ErrorAction SilentlyContinue -ErrorVariable jobErrors
    if ($jobErrors -and $jobErrors.Count -gt 0) {
      return [pscustomobject]@{
        TimedOut     = $false
        Success      = $false
        Value        = $null
        ErrorMessage = $jobErrors[0].Exception.Message
      }
    }

    return [pscustomobject]@{
      TimedOut     = $false
      Success      = $true
      Value        = $value
      ErrorMessage = $null
    }
  } finally {
    # -Force: reclaims the job (and its child process) even if it is still Running -- the state we
    # are in whenever Stop-Job above did not fully quiesce it before this block runs.
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
}

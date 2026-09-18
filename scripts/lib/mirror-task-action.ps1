<#
  Get-MirrorTaskArguments -- builds the powershell.exe argument string for the
  "ORA Command Center - Mirror Deploy" scheduled task action. Extracted to its own lib
  (shared with register-mirror-task.smoke-test.ps1) so the fix below can be asserted
  without actually registering a live Windows scheduled task.

  Incident (2026-09-16 -> 09-18): register-mirror-task.ps1 built the action with NO window
  style at all, so every hourly/06:45 fire opened a normal, focus-stealing PowerShell console
  on the interactive desktop (this task's Principal is InteractiveToken, not a headless/S4U
  logon -- required so Outlook COM and Credential Manager keep working inside deploy-mirror.ps1).
  Live-sampled on 2026-09-18: the 16:00 run's console took foreground focus at 16:00:03,
  focus moved to the taskbar/thumbnail flyout at 16:00:54-57 (where the window-close control
  sits), and the process was terminated (rc=3221225786 / 0xC000013A) at 16:01:00 -- ~5s later,
  matching Windows' console-close grace period. All 17 unexplained-kill events across five ORA
  tasks in the prior 48h clustered inside attended hours (10:30-17:00), none overnight, which
  fits a human closing a visible window rather than any automated killer (RAM toolkit, the
  stuck-session watchdog, and Task Scheduler's own ExecutionTimeLimit/MultipleInstances were
  all checked and ruled out -- none matches the timing or the window-focus evidence).

  Fix: -WindowStyle Hidden, the SAME flag register-brain-server-task.ps1 / start-brain-server.ps1
  already use for their own interactive-session background tasks. Empirically verified
  (3/3 trials) that a process launched this way never takes foreground focus, unlike the
  current no-flag launch. NOT conhost --headless: that suppresses the window too, but also
  collapses Task Scheduler's LastTaskResult to 0 regardless of the child's real exit code,
  which would silently break every alarm rule in mirror-run-classify.ps1 that branches on
  $LastTaskResult -ne 0. -WindowStyle Hidden preserves the real exit code, so no other file
  needs to change.
#>

function Get-MirrorTaskArguments {
  param(
    [Parameter(Mandatory)][string]$ScriptPath
  )
  return "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""
}

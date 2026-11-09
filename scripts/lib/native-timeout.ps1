<#
  Invoke-NativeCommandWithTimeout -- run an external command under a caller-owned time bound,
  terminating the whole process TREE if it overruns. Extracted into lib/ so
  scripts/native-command-timeout.smoke-test.ps1 exercises the REAL function rather than a
  hand-copied duplicate (same convention as lib/git-capture.ps1 and lib/deploy-alert.ps1).

  Incident (2026-07-29): the hourly "ORA Command Center - Mirror Deploy" task exited 3221225786
  (0xC000013A, STATUS_CONTROL_C_EXIT). deploy-mirror.ps1 fetched, merged, baked and built fine
  (dist/ written 10:04), then sat ~26 minutes inside `npx wrangler pages deploy` until the Windows
  Task Scheduler ExecutionTimeLimit (PT30M) force-killed the tree at 10:30. The 11:00 run then
  succeeded unattended (exit 0), so the stall was TRANSIENT -- not credentials, not a diverged tree.

  The real defect is not the stall; it is that the script had no bound of its own. A Task Scheduler
  forced termination does NOT unwind PowerShell try/catch, and deploy-mirror.ps1 reaches its entire
  alerting path (catch -> Send-DeployFailureAlert -> Outlook COM, data/outbox/ fallback) only via
  `throw`. So the kill bypassed every alert and the deploy failed SILENTLY -- confirmed by the
  absence of any outbox entry that day. It was noticed only because a separate sampling checker read
  LastTaskResult afterwards. Bounding the call ourselves, well under PT30M, converts a hang into an
  ordinary terminating error the existing catch can alert on.

  Why route through cmd.exe rather than starting the executable directly:
    1. `npx` is `npx.cmd`, a batch shim. Win32 CreateProcess cannot execute .cmd/.bat directly, so
       [Process]::Start with UseShellExecute=$false would fail on the production call site.
    2. It gives the timeout a single tree root. `npx` spawns node as a child; `taskkill /T` from the
       cmd root reaps the whole tree, whereas killing only the process we started would orphan the
       real worker -- still uploading, still running past the scheduler's limit.
  PS5.1 note: ProcessStartInfo.ArgumentList does not exist on .NET Framework, so the command line is
  assembled and quoted by hand below.

  Streams are deliberately NOT redirected: stdout/stderr inherit the parent console so npm/wrangler
  output keeps flowing to Task Scheduler's captured output exactly as before. This function reports
  timing and exit status only -- use Invoke-NativeCommandCapture (lib/git-capture.ps1) when the
  caller needs the text back instead.
#>

# Assert-CmdSafeArgument (lib/cmd-arg-guard.ps1) -- shared with lib/git-capture.ps1's
# Invoke-NativeCommandCapture, extracted 2026-07-29 after a regression from maintaining this guard
# as two separate copies. See that file for the rule.
. (Join-Path $PSScriptRoot 'cmd-arg-guard.ps1')

function Invoke-NativeCommandWithTimeout {
  param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string[]]$Arguments,
    # Upper bound is generic library-level headroom, not this caller's specific PT30M budget --
    # deploy-mirror.ps1 further constrains its own -DeployTimeoutSeconds param below this. Added
    # 2026-07-31 (security review): an out-of-Int32-range value (e.g. 2147484) previously reached
    # [Process]::Start successfully, then WaitForExit(seconds*1000) THREW a .NET type-conversion
    # error with the child left running, never waited on, never killed -- a guaranteed orphan and a
    # confusing alert. ValidateRange rejects it before the process is ever started.
    [Parameter(Mandatory=$true)][ValidateRange(1, 86400)][int]$TimeoutSeconds,
    # Optional (added 2026-11-08, mirror-gate-probe-apex-only): redirect the command's combined
    # stdout+stderr into this file INSTEAD of the console, so the caller can read it back (and
    # echo it, so Task Scheduler's captured output keeps it) (deploy-mirror.ps1 parses the
    # per-deployment <hash>.pages.dev URL from wrangler's output to probe it). The redirect is
    # written by cmd.exe at the OS level -- no PowerShell pipe, so none of the ErrorRecord-under-Stop
    # or pipe-buffer deadlock hazards apply. Omitted = the original inherit-the-console behaviour.
    [string]$OutputFile
  )
  if ($OutputFile) {
    try {
      Assert-CmdSafeArgument -Argument $OutputFile
    } catch {
      throw "Invoke-NativeCommandWithTimeout: OutputFile: $($_.Exception.Message)"
    }
  }

  # Guard extracted to Assert-CmdSafeArgument above -- see lib/cmd-arg-guard.ps1 for the rule and
  # why it now lives in one place instead of two.
  #
  # $Executable is validated too (added 2026-07-31, security review): every existing call site
  # passes a hardcoded literal ('npx'), so this is not exploitable today, but the guard only
  # validated $Arguments -- a future caller passing a caller-influenced executable string would
  # have bypassed it entirely, on the exact command line this function exists to make safe.
  try {
    Assert-CmdSafeArgument -Argument $Executable
  } catch {
    throw "Invoke-NativeCommandWithTimeout: Executable: $($_.Exception.Message)"
  }
  foreach ($arg in $Arguments) {
    try {
      Assert-CmdSafeArgument -Argument $arg
    } catch {
      throw "Invoke-NativeCommandWithTimeout: $($_.Exception.Message)"
    }
  }

  # Quote any token containing whitespace -- a plain join would split a path like
  # "C:\Program Files\..." into separate positional arguments once cmd.exe parses it.
  $quote     = { param($s) if ($s -match '\s') { '"' + $s + '"' } else { $s } }
  $argString = (($Arguments | ForEach-Object { & $quote $_ })) -join ' '
  $command   = (& $quote $Executable) + $(if ($argString) { " $argString" } else { '' })
  if ($OutputFile) { $command += ' > "' + $OutputFile + '" 2>&1' }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'
  # `/s` makes cmd's quote handling deterministic: it strips exactly the first and last quote of the
  # /c string and treats the remainder verbatim, instead of applying its ambiguous multi-quote rule.
  $psi.Arguments       = '/s /c "' + $command + '"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow  = $true
  # [Process]::Start uses the OS process's startup CurrentDirectory, which PowerShell's Set-Location
  # does NOT keep in sync -- unlike an inline native call (`& cmd.exe ...`), which PowerShell resolves
  # against the caller's current provider location for you. Without this, a relative path argument
  # (the production call passes the deploy dir as plain `dist`) resolves against wherever this
  # process originally started, not wherever the caller has since cd'd to. Found via review
  # (2026-07-29): reproduced by scenario 5 in the smoke test.
  $psi.WorkingDirectory = (Get-Location).ProviderPath

  $proc = [System.Diagnostics.Process]::Start($psi)

  if ($proc.WaitForExit($TimeoutSeconds * 1000)) {
    return [pscustomobject]@{
      ExitCode = $proc.ExitCode
      TimedOut = $false
    }
  }

  # Overran the bound -- reap the whole tree. taskkill is invoked through cmd.exe with its output
  # swallowed at the OS pipe level rather than via `& taskkill ... 2>&1`: under the caller's global
  # $ErrorActionPreference = 'Stop', native stderr becomes an ErrorRecord that would terminate the
  # pipeline here and replace the caller's own timeout wording (the hazard documented at length in
  # lib/git-capture.ps1). A nonzero taskkill result is expected and benign when the process exits on
  # its own in the race window between the wait expiring and the kill landing.
  & cmd.exe '/s', '/c', "taskkill /T /F /PID $($proc.Id) >nul 2>&1" | Out-Null

  # Give the tree a moment to actually go away so callers observing the process table (and the
  # smoke test's grandchild assertion) see a settled state rather than a racing one.
  [void]$proc.WaitForExit(10000)

  return [pscustomobject]@{
    ExitCode = $null
    TimedOut = $true
  }
}

# Get-DeployTimeoutReason -- the exact throw-message text for a timed-out deploy, shared between
# deploy-mirror.ps1 (the real caller) and its smoke test. Extracted 2026-07-29 (code-review
# follow-up) after finding the test had a hand-copied, already-drifted duplicate of this string --
# proving a regression in the real message could pass the test undetected. Now there is exactly one
# copy; the test asserts against calling this function, not a literal.
#
# Wording: earlier drafts said "the mirror was NOT updated this run", which overclaims -- a stall
# inside `wrangler pages deploy` could occur AFTER the upload/publish step, so whether the mirror
# actually updated is genuinely unknown from here, not "no". Since 2026-07-31 the timeout path runs
# the Access-gate probe too (an observed 2xx throws GATE CHECK FAILED instead of this message), but
# an inconclusive probe still ends here, so publication state stays unverified. The message says so plainly and gives the exact manual check, rather than asserting a
# specific (and possibly wrong) outcome.
function Get-DeployTimeoutReason {
  param([Parameter(Mandatory=$true)][int]$Seconds)
  return "wrangler deploy TIMED OUT after ${Seconds}s and was terminated (process tree killed). " +
         "Publication state UNKNOWN -- the deploy may or may not have published before the stall. " +
         "The Access-gate probe ran on this path and saw no 2xx exposure, but it may not have " +
         "verified every target, and a stalled wrangler may never have printed the deployment alias " +
         "(see the [gate-check] lines in this run's log). This is the 2026-07-29 stall signature; a " +
         "single occurrence has previously been transient, with the next hourly run recovering " +
         "unattended -- but verify manually rather than assume that again: " +
         "curl -s -I --max-redirs 0 https://ora-command-center.pages.dev/ and .../snapshot.json " +
         "should each return 302 to a *.cloudflareaccess.com Location. Investigate further if this " +
         "repeats or if that check does not come back clean."
}

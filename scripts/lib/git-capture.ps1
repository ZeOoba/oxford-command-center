<#
  Invoke-NativeCommandCapture / Invoke-GitFetchCapture -- extracted so
  scripts/git-fetch-capture.smoke-test.ps1 can exercise the REAL capture logic against a real
  throwaway git repo, not a hand-copied duplicate.

  Bug (2026-07-26): deploy-mirror.ps1 used to capture git fetch output with
  `(& git fetch origin 2>&1 | Out-String)`. In Windows PowerShell 5.1, merging streams with
  `2>&1` does NOT stop native stderr lines from being converted into ErrorRecord objects --
  under `$ErrorActionPreference = 'Stop'` (set globally by deploy-mirror.ps1), the FIRST such
  record terminates the pipeline immediately. This fires on every fetch that has ANY stderr
  output, which for `git fetch` includes the ordinary "From <url>" progress header printed on
  a completely SUCCESSFUL fetch with new commits to report -- not just real failures. The
  resulting exception's Message is just that raw first stderr line, discarding the script's own
  intended "git fetch origin failed (N): ..." wording entirely. This produced an unhelpful
  "Reason: From https://github.com/ZeOoba/oxford-command-center" alert on 2026-07-26 for what
  was actually a routine successful pull of 2 new commits -- confirmed via reproduction in an
  isolated bare-repo harness (real `git fetch` with genuine new ref-update content, same
  PowerShell 5.1 binary Task Scheduler uses).

  Tried and rejected: temporarily setting $ErrorActionPreference = 'Continue' around the call
  stops the throw, but ErrorRecord objects still flow through 2>&1 and Out-String renders them
  with PowerShell's full diagnostic wrapper (CategoryInfo, FullyQualifiedErrorId, "At line:N
  char:M", etc.) interleaved with the real git text -- unusable as alert copy. Piping through
  `ForEach-Object { $_.ToString() }` to strip that wrapper is inconsistent: most ErrorRecords
  stringify to their message text, but at least one observed case stringified to the bare
  exception type name instead, silently corrupting the captured text.

  Fix: route through cmd.exe. cmd's own `2>&1` merges the streams at the OS pipe level before
  PowerShell ever sees them, so the captured output is always plain strings -- never ErrorRecord
  objects -- regardless of $ErrorActionPreference. $LASTEXITCODE still faithfully reflects the
  real exit code through a single `cmd /c "<command>"` invocation (verified empirically for both
  a successful fetch with new content and a genuine failure).

  Generalized (2026-07-26, same-day review follow-up): the identical bug shape existed one call
  site away in deploy-mirror.ps1's post-deploy Access-gate check (`curl.exe ... 2>&1`, also under
  the script's global $ErrorActionPreference = 'Stop') -- lower probability of firing since
  curl's `-s` flag suppresses curl's own error/progress text, but higher consequence if it ever
  does, since that's the check guarding against a confidential bake being publicly exposed.
  Invoke-GitFetchCapture is now a thin wrapper over a generic Invoke-NativeCommandCapture so both
  call sites share one hardened implementation instead of two copies drifting apart.
#>

# Assert-CmdSafeArgument (lib/cmd-arg-guard.ps1) -- shared with lib/native-timeout.ps1's
# Invoke-NativeCommandWithTimeout, extracted 2026-07-29 after a regression from maintaining this
# guard as two separate copies. See that file for the rule.
. (Join-Path $PSScriptRoot 'cmd-arg-guard.ps1')

function Invoke-NativeCommandCapture {
  param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string[]]$Arguments
  )
  # Guard extracted to Assert-CmdSafeArgument (lib/cmd-arg-guard.ps1) -- see that file for the exact
  # rule and the 2026-07-29 regression that made a shared, single-copy guard the correct fix rather
  # than two independently-maintained copies.
  #
  # $Executable is validated too (added 2026-07-31, security review): every existing call site
  # passes a hardcoded literal ('git', 'curl.exe'), so this is not exploitable today, but the guard
  # only validated $Arguments -- a future caller passing a caller-influenced executable string would
  # have bypassed it entirely, on the exact command line this function exists to make safe. Proven
  # via a real PoC against this function ('echo hi & mkdir ...' as $Executable executed the mkdir).
  try {
    Assert-CmdSafeArgument -Argument $Executable
  } catch {
    throw "Invoke-NativeCommandCapture: Executable: $($_.Exception.Message)"
  }
  foreach ($arg in $Arguments) {
    try {
      Assert-CmdSafeArgument -Argument $arg
    } catch {
      throw "Invoke-NativeCommandCapture: $($_.Exception.Message)"
    }
  }
  # Quote any arg containing whitespace -- a plain `-join ' '` would silently split a multi-word
  # value (e.g. a commit message) into separate positional args once handed to cmd.exe.
  $argString = (($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })) -join ' '
  $output = cmd /c "$Executable $argString 2>&1"
  $exitCode = $LASTEXITCODE
  [pscustomobject]@{
    Output   = ($output -join "`n")
    ExitCode = $exitCode
  }
}

function Invoke-GitFetchCapture {
  param(
    [Parameter(Mandatory=$true)][string[]]$GitArgs
  )
  Invoke-NativeCommandCapture -Executable 'git' -Arguments $GitArgs
}

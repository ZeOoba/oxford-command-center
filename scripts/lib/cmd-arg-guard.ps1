<#
  Assert-CmdSafeArgument -- shared cmd.exe argument-safety guard for lib/git-capture.ps1's
  Invoke-NativeCommandCapture and lib/native-timeout.ps1's Invoke-NativeCommandWithTimeout, both of
  which build a single cmd.exe command-line string from caller-supplied arguments.

  Extracted 2026-07-29 after a real regression: two independently-maintained copies of this guard
  drifted apart. When `%`/`"` were added to close a metacharacter gap found in code review, the
  naive fix (`-match '[&|<>^%"]'`) blanket-rejected `"` and broke an existing, legitimate call site
  -- git-fetch-capture.smoke-test.ps1 wraps temp-dir paths in a literal quote pair before passing
  them to Invoke-NativeCommandCapture (e.g. `"`"$originPath`""` -> `"C:\...\origin.git"`), which is
  the standard, safe way to quote a single value on a cmd.exe command line and had been working
  all along. That failure mode -- one copy of a security-relevant check silently drifting from the
  other -- is exactly why this now lives in one place instead of two.

  Rule (tightened 2026-07-31, security review of the deploy-timeout fix):
    - & | < > ^ are always rejected -- no current call site needs them, and none has a safe literal
      form on an unescaped cmd.exe command line.
    - % is always rejected -- cmd.exe expands it as an environment-variable reference. Verified
      empirically: an argument containing '%USERNAME%' silently became the literal 'Owner' with no
      error, which for the actual call sites here (git args, curl flags, a Cloudflare project name)
      would be a silent argument-substitution bug, not a loud failure.
    - CR and LF are always rejected. Verified empirically: a value containing an embedded newline
      (e.g. "first`nsecond") reached the child as ONLY the first line -- everything after the
      newline, including a trailing flag or the caller's own `2>&1` redirection, was silently
      dropped with ExitCode 0. No injection results (cmd /c only executes the first line), but it
      is exactly the failure mode this guard exists to prevent: silent truncation reported as
      success, not a loud rejection.
    - " is now ALWAYS rejected, full stop -- not just unbalanced/interior quotes. The prior "exactly
      one matched pair wrapping the entire argument" allowance (originally added to keep
      git-fetch-capture.smoke-test.ps1's manual `"$path"` wrapping working) was found to silently
      SPLIT any wrapped value containing a space: the whitespace-quoter in the calling function
      already wraps space-containing values, so a value pre-wrapped by the caller gets wrapped
      AGAIN ("""a b"""), and cmd's quote-toggling splits it into two argv elements. Confirmed
      empirically. The allowance bought nothing (the one caller relying on it worked only because
      %TEMP% on this machine happens to contain no space) and was the only remaining way to get
      silent argument splitting past this guard. Callers needing a literal value should pass it
      unwrapped and let the whitespace-quoter in Invoke-NativeCommandCapture /
      Invoke-NativeCommandWithTimeout handle quoting -- see git-fetch-capture.smoke-test.ps1, which
      was updated in the same pass to stop manually wrapping its temp-dir paths.
#>

function Assert-CmdSafeArgument {
  param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Argument)

  if ($Argument -match "[&|<>^%`r`n]") {
    throw "argument contains a cmd.exe metacharacter or newline this function does not escape: '$Argument'"
  }

  if ($Argument.Contains('"')) {
    throw "argument contains a double-quote this function does not escape -- pass the raw value and let the caller's whitespace-quoter handle it: '$Argument'"
  }
}

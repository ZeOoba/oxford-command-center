<#
  Manual regression smoke test for scripts/lib/cmd-arg-guard.ps1's Assert-CmdSafeArgument. Same
  "no Pester convention here, run-by-hand assertion script" pattern as its sibling smoke tests.

  Incident (2026-07-29, code-review follow-up): the metacharacter guard duplicated across
  lib/git-capture.ps1 and lib/native-timeout.ps1 was missing `%` (cmd.exe environment-variable
  expansion -- verified '%USERNAME%' silently became 'Owner') and `"`. The first attempt to close
  that gap blanket-rejected any `"`, which broke an existing, legitimate call site:
  git-fetch-capture.smoke-test.ps1 wraps temp-dir paths in a literal quote pair before passing them
  to Invoke-NativeCommandCapture (the standard way to quote a single value on a cmd.exe command
  line). That regression is why the guard now lives in ONE function tested here, instead of two
  hand-copied ones -- this file exists so the rule's edge cases (which quote patterns are actually
  safe) are proven once, not re-derived per caller.

  Reversed (2026-07-31, security review): the whole-value-quote-wrap ALLOWANCE added above was
  itself found unsafe -- Invoke-NativeCommandCapture/Invoke-NativeCommandWithTimeout's own
  whitespace-quoter re-wraps any space-containing value a SECOND time, and cmd's quote-toggling
  splits the double-wrapped result into two argv elements. Confirmed empirically. `"` is now
  rejected unconditionally, and git-fetch-capture.smoke-test.ps1 was updated in the same pass to
  stop manually wrapping its paths (the whitespace-quoter already handles them correctly alone).
  CR/LF are also now rejected -- an embedded newline was found to silently truncate the argument
  list rather than reject loudly, the exact failure mode this guard exists to prevent.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cmd-arg-guard.smoke-test.ps1
  Exits 0 if all assertions pass, 1 otherwise.
#>
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\cmd-arg-guard.ps1')

$failures = @()
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { $script:failures += $Message; Write-Host "FAIL: $Message" }
  else { Write-Host "pass: $Message" }
}

function Assert-Allowed {
  param([string]$Argument, [string]$Name)
  try {
    Assert-CmdSafeArgument -Argument $Argument
    Assert-True $true "$Name`: should be allowed"
  } catch {
    Assert-True $false "$Name`: should be allowed, but was rejected: $($_.Exception.Message)"
  }
}

function Assert-Rejected {
  param([string]$Argument, [string]$Name)
  try {
    Assert-CmdSafeArgument -Argument $Argument
    Assert-True $false "$Name`: should be rejected, but was allowed"
  } catch {
    Assert-True $true "$Name`: should be rejected (rejected: $($_.Exception.Message))"
  }
}

# Ordinary values -- the shape of every real call site today (git subcommands/flags, curl flags, a
# fixed apex URL, `wrangler pages deploy dist --project-name=... --branch=main`).
Assert-Allowed 'fetch'                            'plain word'
Assert-Allowed '--project-name=ora-command-center' 'flag=value, no special chars'
Assert-Allowed ''                                  'empty string'
Assert-Allowed 'C:\Users\Owner\oxford-command-center' 'plain windows path, no spaces'

# 2026-07-31: the whole-value quote-wrap that USED to be the blessed, allowed pattern (previously
# git-fetch-capture.smoke-test.ps1's own convention) is now REJECTED -- proven to silently split a
# space-containing value once double-wrapped by the callee's whitespace-quoter. Every `"`-containing
# argument is rejected unconditionally now, whole-value wrap or not.
Assert-Rejected '"C:\Users\Owner\AppData\Local\Temp\git-fetch-capture-smoke-abc\origin.git"' 'whole-value quote-wrapped path (now rejected -- was the pre-2026-07-31 regression-allowance case)'
Assert-Rejected '""' 'minimal whole-value wrap of an empty value (now rejected)'

# Metacharacters -- always rejected, no legitimate call site needs them.
foreach ($ch in @('&', '|', '<', '>', '^')) {
  Assert-Rejected "foo${ch}bar" "metacharacter '$ch'"
}

# % -- rejected because cmd.exe expands it as an env-var reference, not because it's a shell
# metacharacter in the same family as & | < >.
Assert-Rejected '--project-name=%USERNAME%' 'percent env-var expansion'
Assert-Rejected 'foo%bar'                   'bare percent'

# CR/LF -- rejected because an embedded newline silently truncates the command line rather than
# rejecting loudly (confirmed empirically: everything after the newline, including a trailing flag
# or the caller's own `2>&1` redirection, was silently dropped with the child reporting ExitCode 0).
Assert-Rejected "foo`nbar" 'embedded LF'
Assert-Rejected "foo`rbar" 'embedded CR'
Assert-Rejected "foo`r`nbar --trailing-flag" 'embedded CRLF ahead of a trailing flag'

# Quote misuse -- every double-quote is now rejected, not just unbalanced/interior ones.
Assert-Rejected 'foo"bar'           'single unbalanced quote'
Assert-Rejected '"foo'              'unbalanced quote at start only'
Assert-Rejected 'foo"'              'unbalanced quote at end only'
Assert-Rejected 'foo"bar"baz'       'interior quote pair, not wrapping the whole value'
Assert-Rejected '"foo"bar"'         'three quotes -- not a clean pair'
Assert-Rejected '"foo""bar"'        'two pairs -- not a single whole-value wrap'
Assert-Rejected '"foo bar" extra"'  'quoted prefix plus trailing unmatched quote'

Write-Host ""
if ($failures.Count -gt 0) {
  Write-Host "$($failures.Count) assertion(s) FAILED."
  exit 1
} else {
  Write-Host "All assertions passed."
  exit 0
}

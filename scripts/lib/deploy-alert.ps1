<#
  Send-DeployFailureAlert -- extracted from deploy-mirror.ps1 into its own file so
  scripts/deploy-mirror.smoke-test.ps1 can dot-source and exercise the REAL function
  instead of a hand-copied duplicate (a prior throwaway test harness that copy-pasted
  this function caught a real bug during review, then was deleted before commit,
  leaving no regression net -- this file plus the smoke test replace that).

  Callers must dot-source this file with $repo, $AlertSendScript, and $AlertTo already
  defined in scope (deploy-mirror.ps1 sets these from its own params before dot-sourcing;
  the smoke test sets its own test values).

  Sends a failure alert via the standard Outlook COM path, following the outer-retry
  convention documented in ~/.claude/CLAUDE.md: exit 2 (COM failure) or 4 (timeout) get one
  retry, then flag; exit 1 (usage error) or 3 (stuck Outlook wizard) flag immediately, no
  retry. If the alert itself can't be sent, the failure is written to data/outbox/ (the same
  gitignored fallback location server/brief/send.ts falls back to) so it's never silently lost.
#>
function Send-DeployFailureAlert {
  param(
    [Parameter(Mandatory=$true)][string]$Reason,
    [switch]$Critical
  )
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'
  $subject = if ($Critical) { '[ORA Command Center] CRITICAL - Access gate check failed' } else { '[ORA Command Center] Mirror deploy FAILED' }

  $bodyLines = @(
    $subject,
    '',
    "Time:   $ts",
    "Repo:   $repo",
    "Reason: $Reason",
    '',
    "Next step: check git status / git log HEAD..origin/main --oneline on $repo.",
    "If diverged or dirty, resolve manually -- never auto-force-pull or discard local changes",
    "without Gabriel's OK. See reference_command_center_mirror_deploy_gap.md for the last",
    "incident's resolution steps."
  )
  if ($Critical) {
    $bodyLines += ''
    $bodyLines += 'This was the post-deploy Access-gate check -- a confidential bake may currently be publicly reachable. Investigate immediately.'
  }
  $body = $bodyLines -join "`n"

  # -BodyFile, not -Body: splatting a string containing an embedded double-quote as a native
  # -Body argument corrupts or breaks the child powershell.exe invocation (confirmed by repro
  # during review). server/brief/send.ts hits the same class of hazard and avoids it the same
  # way -- write to a temp file, pass -BodyFile.
  $tmpBodyPath = Join-Path $env:TEMP "ora-deploy-alert-$([guid]::NewGuid()).txt"
  try {
    $body | Out-File -FilePath $tmpBodyPath -Encoding UTF8
    $sendArgs = @('-NoProfile', '-File', $AlertSendScript, '-To', $AlertTo, '-Subject', $subject, '-BodyFile', $tmpBodyPath, '-BodyFormat', 'text')
    & powershell @sendArgs
    $sendExit = $LASTEXITCODE

    if ($sendExit -eq 0) { return }

    if ($sendExit -eq 2 -or $sendExit -eq 4) {
      Start-Sleep -Seconds 5
      & powershell @sendArgs
      $sendExit = $LASTEXITCODE
      if ($sendExit -eq 0) { return }
    }
  }
  finally {
    Remove-Item -Path $tmpBodyPath -ErrorAction SilentlyContinue
  }

  # Alert itself failed (usage error, stuck wizard, or retry exhausted) -- never lose the
  # failure silently.
  $outboxDir = Join-Path $repo 'data\outbox'
  New-Item -ItemType Directory -Path $outboxDir -Force | Out-Null
  $obStamp = (Get-Date).ToString('yyyy-MM-ddTHH-mm-ss')
  $outboxPath = Join-Path $outboxDir "$obStamp-deploy-alert.txt"
  "$body`n`n(alert send itself failed, exit=$sendExit)" | Out-File -FilePath $outboxPath -Encoding UTF8
  Write-Host "[$ts] Alert send failed (exit=$sendExit) -- wrote fallback to $outboxPath"
}

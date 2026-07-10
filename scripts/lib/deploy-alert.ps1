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

  Incident (2026-07-10): the machine was offline ~10:15-11:00 ET. Two hourly runs both hit
  "git fetch origin failed (128)" and both queued/sent identical FAILED emails once Outlook
  reconnected, plus automation-health-monitor's own separate ALARM addendum -- three alerts
  for one transient outage. Test-OfflineSignature + the suppression state file below collapse
  repeat occurrences of that specific signature into at most one immediate alert (the first)
  plus one recovery digest, with a re-escalation alert every $EscalationThreshold further
  consecutive occurrences (not just once) so a genuinely long, non-self-healing outage keeps
  getting noticed instead of going silent for its entire remaining duration. GATE CHECK FAILED
  (-Critical) is never suppressible -- a possible confidential-exposure alert must always fire
  immediately, incident or not. Send-RawRetriedAlert always runs before
  Save-OfflineSuppressionState in every branch that sends -- a state-persistence hiccup must
  never be able to eat the alert it was tracking (caught in review, 2026-07-10).
#>

function Test-OfflineSignature {
  param([string]$Reason)
  # Matches only the two throw messages deploy-mirror.ps1 raises for a failed fast-forward
  # (git fetch / git pull) -- the actual "machine was offline or network unreachable"
  # signature. Deliberately narrow: build/deploy/gate-check failures must never be classified
  # as offline and must never be suppressed.
  return $Reason -match '^git (fetch|pull)\b'
}

function Get-OfflineSuppressionState {
  param([Parameter(Mandatory=$true)][string]$StateFile)
  if (-not (Test-Path $StateFile)) { return $null }
  try { return Get-Content -Path $StateFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Save-OfflineSuppressionState {
  param([Parameter(Mandatory=$true)][string]$StateFile, [Parameter(Mandatory=$true)]$State)
  # Never let a persistence hiccup (AV lock, permission blip, disk full) become a terminating
  # exception -- callers always send/attempt-send FIRST and save second specifically so this
  # can fail without eating an alert; if the save itself fails, the worst case is the next
  # occurrence looks like a fresh streak (fails open to "alert again"), never silence.
  try {
    $dir = Split-Path -Parent $StateFile
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $State | ConvertTo-Json | Out-File -FilePath $StateFile -Encoding UTF8
  } catch {
    Write-Host "Save-OfflineSuppressionState failed (non-fatal, state tracking only): $($_.Exception.Message)"
  }
}

function Clear-OfflineSuppressionState {
  param([Parameter(Mandatory=$true)][string]$StateFile)
  Remove-Item -Path $StateFile -ErrorAction SilentlyContinue
}

# Shared mailer: retry + outbox-fallback logic, extracted so both the normal failure path and
# the suppression/escalation/recovery paths below send through the exact same tested routine.
function Send-RawRetriedAlert {
  param(
    [Parameter(Mandatory=$true)][string]$Subject,
    [Parameter(Mandatory=$true)][string]$Body
  )
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'

  # -BodyFile, not -Body: splatting a string containing an embedded double-quote as a native
  # -Body argument corrupts or breaks the child powershell.exe invocation (confirmed by repro
  # during review). server/brief/send.ts hits the same class of hazard and avoids it the same
  # way -- write to a temp file, pass -BodyFile.
  $tmpBodyPath = Join-Path $env:TEMP "ora-deploy-alert-$([guid]::NewGuid()).txt"
  try {
    $Body | Out-File -FilePath $tmpBodyPath -Encoding UTF8
    $sendArgs = @('-NoProfile', '-File', $AlertSendScript, '-To', $AlertTo, '-Subject', $Subject, '-BodyFile', $tmpBodyPath, '-BodyFormat', 'text')
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
  "$Body`n`n(alert send itself failed, exit=$sendExit)" | Out-File -FilePath $outboxPath -Encoding UTF8
  Write-Host "[$ts] Alert send failed (exit=$sendExit) -- wrote fallback to $outboxPath"
}

function Send-DeployFailureAlert {
  param(
    [Parameter(Mandatory=$true)][string]$Reason,
    [switch]$Critical,
    # Set by callers only for the narrow offline-fetch/pull signature -- everything else
    # (build failures, wrangler deploy failures, gate-check failures) always alerts immediately.
    [switch]$Suppressible,
    [string]$StateFile = (Join-Path $repo 'data\alert-state\offline-suppression.json'),
    [int]$EscalationThreshold = 3
  )
  if ($Critical) { $Suppressible = $false }  # GATE CHECK FAILED must never be suppressed.

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

  if (-not $Suppressible) {
    Send-RawRetriedAlert -Subject $subject -Body $body
    return
  }

  # Suppressible (offline-signature) path: the first occurrence of a new streak still alerts
  # immediately (matches prior behavior for a one-off blip); repeats within the same streak are
  # logged but not emailed, until either the streak clears (Send-DeployRecoveryDigestIfSuppressed
  # sends one digest) or it persists past $EscalationThreshold (a re-escalation alert every
  # $EscalationThreshold further occurrences, not just once -- a divergence that never
  # self-heals must keep getting noticed, not go silent for its entire remaining duration).
  #
  # Ordering matters in both branches below: Send-RawRetriedAlert always runs BEFORE
  # Save-OfflineSuppressionState. A prior draft saved state first -- if that save threw
  # (Save-OfflineSuppressionState is now non-throwing itself, but don't rely on only one of
  # the two safeguards), the alert send, and therefore its outbox fallback, was never reached
  # at all. Send first so the one thing this function exists to do always happens.
  $state = Get-OfflineSuppressionState -StateFile $StateFile
  if ($null -eq $state) {
    $state = [pscustomobject]@{
      firstFailureTime      = $ts
      lastFailureTime       = $ts
      streakCount           = 1
      lastEscalatedAtStreak = 0
      reason                = $Reason
    }
    Send-RawRetriedAlert -Subject $subject -Body $body
    Save-OfflineSuppressionState -StateFile $StateFile -State $state
    return
  }

  $state.streakCount++
  $state.lastFailureTime = $ts
  $state.reason = $Reason

  if (($state.streakCount - $state.lastEscalatedAtStreak) -ge $EscalationThreshold) {
    $state.lastEscalatedAtStreak = $state.streakCount
    $escSubject = '[ORA Command Center] Mirror deploy still failing (offline signature, escalated)'
    $escBody = @(
      $escSubject,
      '',
      "First failure:         $($state.firstFailureTime)",
      "Still failing as of:   $ts",
      "Consecutive failures:  $($state.streakCount)",
      "Reason:                $Reason",
      '',
      "This has now persisted past $EscalationThreshold consecutive hourly runs -- no longer treating it as a transient blip. Investigate machine/network connectivity. You will get another alert like this every $EscalationThreshold further consecutive failures until it recovers -- this does not go silent."
    ) -join "`n"
    Send-RawRetriedAlert -Subject $escSubject -Body $escBody
    Save-OfflineSuppressionState -StateFile $StateFile -State $state
    return
  }

  Save-OfflineSuppressionState -StateFile $StateFile -State $state
  Write-Host "[$ts] Offline-signature failure (streak=$($state.streakCount)) -- suppressed, collapsing into one digest on recovery."
}

# Call after a successful deploy. If a suppressed offline-signature streak is on record, sends
# ONE recovery digest covering the whole incident and clears the state; if the streak was a lone
# failure that already got its own immediate alert (no suppression actually happened), clears
# silently rather than adding a second email for a one-off blip.
function Send-DeployRecoveryDigestIfSuppressed {
  param(
    [string]$StateFile = (Join-Path $repo 'data\alert-state\offline-suppression.json')
  )
  $state = Get-OfflineSuppressionState -StateFile $StateFile
  if ($null -eq $state) { return }

  if ($state.streakCount -le 1 -and $state.lastEscalatedAtStreak -eq 0) {
    Clear-OfflineSuppressionState -StateFile $StateFile
    return
  }

  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'
  $subject = '[ORA Command Center] Mirror deploy recovered (offline signature cleared)'
  $body = @(
    $subject,
    '',
    "Recovered:                                  $ts",
    "First failure:                              $($state.firstFailureTime)",
    "Last failure:                               $($state.lastFailureTime)",
    "Consecutive failures folded into this digest: $($state.streakCount)",
    "Last escalation sent at streak count:        $($state.lastEscalatedAtStreak) (0 = none)",
    "Last reason:                                $($state.reason)",
    '',
    "No action needed -- the most recent run succeeded. This digest replaces what would otherwise have been $($state.streakCount - 1) separate duplicate `"Mirror deploy FAILED`" emails for the same offline incident."
  ) -join "`n"
  Send-RawRetriedAlert -Subject $subject -Body $body
  Clear-OfflineSuppressionState -StateFile $StateFile
}

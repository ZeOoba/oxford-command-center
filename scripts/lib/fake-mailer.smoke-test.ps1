<#
  Stub mailer standing in for send-via-outlook.ps1, used only by
  scripts/deploy-mirror.smoke-test.ps1. Exit code comes from $env:FAKE_SEND_EXIT_CODE;
  each call (including the resolved -BodyFile content) is appended to
  $env:FAKE_SEND_CALL_LOG, separated by a "---CALL---" marker line, if that env var is set.
#>
param(
  [string]$To,
  [string]$Subject,
  [string]$Body,
  [string]$BodyFile,
  [string]$BodyFormat,
  [string]$Cc
)
$code = 0
if ($env:FAKE_SEND_EXIT_CODE) { $code = [int]$env:FAKE_SEND_EXIT_CODE }
$resolvedBody = if ($BodyFile) { Get-Content -Path $BodyFile -Raw -Encoding UTF8 } else { $Body }
if ($env:FAKE_SEND_CALL_LOG) {
  Add-Content -Path $env:FAKE_SEND_CALL_LOG -Value "---CALL---"
  Add-Content -Path $env:FAKE_SEND_CALL_LOG -Value "to=$To subject=$Subject exit=$code bodyformat=$BodyFormat"
  Add-Content -Path $env:FAKE_SEND_CALL_LOG -Value "body=$resolvedBody"
}
exit $code

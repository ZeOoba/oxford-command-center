<#
.SYNOPSIS
  Convert the binary .xls (OLE2 / BIFF8) AppFolio exports under the Property Financials folder to .xlsx
  so parse-sources.ts (exceljs) can read them. Plan T9b, part 1 — see README "Binary .xls exports".

.DESCRIPTION
  Requires desktop Excel (COM automation). Every source file is opened READ-ONLY and nothing is written
  into the source folder: the file is first copied to -Staging, its Mark-of-the-Web is removed there
  (Office blocks downloaded legacy .xls behind "Office has detected a problem with this file"), and the
  .xlsx lands in -OutDir as "<folder leaf>__<basename>.xlsx" — the name lib/sources.ts looks up.
  Macros are disabled (AutomationSecurity = ForceDisable) and Office File Validation is skipped, which
  is what let the last 21 of 186 exports through on 2026-10-05. Existing outputs are skipped.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/property-financials/convert-xls.ps1 `
    -SourceDir "C:\Users\Owner\OneDrive - Oxford Capital Partners\Business\Property Financials\Property Management P&Ls" `
    -OutDir "$env:LOCALAPPDATA\ora\pf-converted" -Staging "$env:TEMP\pf-staging"
  $env:PF_CONVERTED_DIR = "$env:LOCALAPPDATA\ora\pf-converted"
#>
param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Staging = (Join-Path $env:TEMP 'pf-xls-staging')
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path $Staging | Out-Null

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$excel.AskToUpdateLinks = $false
$excel.AutomationSecurity = 3   # msoAutomationSecurityForceDisable — never run macros
$excel.FileValidation = 1       # msoFileValidationSkip — legacy BIFF the validator rejects still opens
$ok = 0; $skipped = 0; $failed = 0
try {
  Get-ChildItem -LiteralPath $SourceDir -Recurse -File | Where-Object { $_.Extension -ieq '.xls' } | ForEach-Object {
    $src = $_.FullName
    $leaf = Split-Path (Split-Path $src -Parent) -Leaf
    $dst = Join-Path $OutDir ("{0}__{1}.xlsx" -f $leaf, $_.BaseName)
    if (Test-Path -LiteralPath $dst) { $skipped++; Write-Output ("SKIP " + $dst); return }
    $staged = Join-Path $Staging ("{0}__{1}.xls" -f $leaf, $_.BaseName)
    Copy-Item -LiteralPath $src -Destination $staged -Force
    Unblock-File -LiteralPath $staged -ErrorAction SilentlyContinue
    try {
      $wb = $excel.Workbooks.Open($staged, 0, $true)   # UpdateLinks = 0, ReadOnly = $true
      $wb.SaveAs($dst, 51)                             # 51 = xlOpenXMLWorkbook
      $wb.Close($false)
      $ok++
      Write-Output ("OK   " + $dst)
    } catch {
      $failed++
      Write-Output ("FAIL " + $src + " :: " + $_.Exception.Message)
    }
  }
} finally {
  $excel.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}
Write-Output ("DONE converted=$ok skipped=$skipped failed=$failed -> $OutDir")
if ($failed -gt 0) { exit 4 }

param()
# reindex-loop.ps1 — loops tsx index-docs.ts until rc=0 (all chunks embedded)
# rc=3 -> more chunks, loop | rc=0 -> done | rc=1/2 -> abort
Set-Location "C:\Users\Owner\oxford-command-center"
$run = 0
$rc = 3
while ($rc -eq 3) {
    $run++
    Write-Host "--- Reindex run #${run} $(Get-Date -Format 'HH:mm:ss') ---"
    & npx tsx scripts/index-docs.ts
    $rc = $LASTEXITCODE
    Write-Host "--- Run #${run} exit rc=${rc} ---"
    if (($rc -eq 1) -or ($rc -eq 2)) {
        Write-Host "ABORT: reindex guard blocked or error (rc=${rc})"
        exit $rc
    }
}
Write-Host "DONE: Reindex complete after ${run} run(s)"

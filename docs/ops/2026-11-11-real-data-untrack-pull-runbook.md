# Runbook: pulling the real-data untrack change without losing the real files

Ruling 2026-11-10: real firm data is never tracked. The change that lands this (branch
`chore/decouple-real-data-2026-11-10`) runs `git rm --cached` on every path in
`scripts/fixtures/real-data-manifest.json`. **Git deletes a file from a working tree when a pull,
merge, rebase or checkout moves that tree to a commit where the file is no longer tracked.** Pulling
naively into the live checkout therefore deletes the live app's real data.

After the change, a checkout that is missing real files refuses to run on synthetic stand-ins:
`npm install` / `npm test` fail loudly (`scripts/ensure-local-data.ts`), the Brain Server prints a
banner and raises error-severity data-quality flags, and `bake-mirror`, the lease drift check and the
production mirror deploy refuse outright. None of that brings the files back. Follow this runbook.

## 1. Before pulling: copy the manifest files aside (every checkout that has real data)

Run from the checkout root (`C:/Users/Owner/oxford-command-center` for the live one) **before**
`git pull`, using the manifest of the commit you are about to pull (so newly listed paths are
included):

```powershell
$aside = "$env:USERPROFILE\real-data-aside-$(Get-Date -Format yyyyMMdd-HHmmss)"
git fetch origin
git show origin/main:scripts/fixtures/real-data-manifest.json | Set-Content -Encoding utf8 "$aside.manifest.json"
$m = Get-Content "$aside.manifest.json" -Raw | ConvertFrom-Json
$paths = @($m.files) + @(foreach ($d in $m.dirs) { Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue | Resolve-Path -Relative })
foreach ($p in $paths) {
  $p = $p -replace '^\.\\', ''
  if (Test-Path $p) {
    $dst = Join-Path $aside $p
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item $p $dst
  }
}
Get-ChildItem $aside -Recurse -File | Get-FileHash -Algorithm SHA256 |
  ForEach-Object { "$($_.Hash)  $($_.Path.Substring($aside.Length + 1))" } | Set-Content "$aside.sha256"
```

Keep `$aside` outside every git checkout (it is real data). Do not delete it until step 4 passes.

## 2. Pull with seeding switched off

```powershell
$env:ORA_NO_SYNTHETIC_SEED = '1'   # nothing may back-fill a half-restored tree
git pull --ff-only
```

The pull deletes the manifest files from the working tree. That is expected.

## 3. Restore the real files

```powershell
Get-ChildItem $aside -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($aside.Length + 1)
  New-Item -ItemType Directory -Force -Path (Split-Path $rel) | Out-Null
  Copy-Item $_.FullName $rel -Force
}
Remove-Item Env:\ORA_NO_SYNTHETIC_SEED
```

The two operator tables under `config/local/` did not exist before this change (the AR seed
mappings were an inline table in `scripts/seed-ar-mappings.ts`, the doc-search golden was
`scripts/doc-search-golden.json`), so the aside copy has nothing for them. Rebuild both from the
pre-pull commit (`ORIG_HEAD` right after the pull; any commit before the change works). It never
overwrites an existing file and refuses to write a partial table:

```powershell
npx tsx scripts/extract-local-tables.ts ORIG_HEAD
```

## 4. Verify by hash, then that nothing is synthetic

```powershell
Get-Content "$aside.sha256" | ForEach-Object {
  $hash, $rel = $_ -split '  ', 2
  if ((Get-FileHash $rel -Algorithm SHA256).Hash -ne $hash) { "MISMATCH $rel" }
}
npx tsx -e "import('./server/real-data-status.ts').then(m => { const s = m.realDataStatus(process.cwd()); console.log(s.filter(x => x.state !== 'real').map(x => x.state + ' ' + x.rel).join('\n') || 'all real'); })"
```

Expect no `MISMATCH` lines. The status check lists every manifest path that is not real. Only the
manifest's four `optional` files may be listed (`absent`): the two `config/local/` tables until the
rebuild in step 3 has run, and the two value locks on first upgrade. Ratify the locks on purpose,
after looking at the figures:

```powershell
npm run golden:ratify      # writes data/property-financials/golden.local.json and data/cost-seg/golden.local.json
npm run gate
```

`git status` must show none of the manifest paths (they are gitignored). If any is shown as
modified or untracked, stop: something re-tracked it (the pre-push scan and `npm run governance`
both fail closed on that).

## 5. Other worktrees and scratch checkouts

- **Worktrees that need real data** (scheduled-task worktrees, the production mirror build root):
  copy the manifest files in from the live checkout before running anything, with
  `ORA_NO_SYNTHETIC_SEED=1` set. The mirror deploy (`scripts/deploy-mirror.ps1`) does this itself via
  `Copy-RealDataIntoBuildRoot` and refuses to bake if any file is missing or synthetic. The lease and
  CC snapshot-refresh tasks must be updated (outside this repo, via `register-scheduled-task`) to copy
  the live real files in and to write the live snapshot in place instead of committing it: the
  snapshot is gitignored and is never committed again.
- **Worktrees that should run on synthetic data** (feature work, CI-like runs): start with no real
  files at all and set `ORA_ALLOW_SYNTHETIC_SEED=1` for `npm install` (CI sets `CI=true`, which allows
  it). The Brain Server, reconcile and the drift check will say loudly that the data is synthetic.
- **Never** copy a single real file into an otherwise synthetic worktree or the reverse:
  `ensure-local-data` refuses to seed a checkout that holds any real manifest file.

## 6. Afterwards

Keep the aside copy until the history purge (done separately) has completed and the live checkout
has been verified again. Then move it into the purge archive; do not leave real data in a temp
folder.

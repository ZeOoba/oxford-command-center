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

Why the order below matters (tested on a scratch clone): `git pull` silently deletes a manifest file that
is unmodified against the old commit, and ABORTS when one is locally modified. So the live files are moved
out of the tree at pull time, not copied: nothing can overwrite them, the pull goes through, and they go
back byte-for-byte. Every check compares against hashes taken from the LIVE files at that moment, never
against an older copy.

## 0. Stop every writer of a manifest path

Nothing may write a manifest file between step 1 and step 4, or that write is lost or clobbered. Stop the
Brain Server (it persists `data/snapshots/portfolio.json` and the AR mapping cache) and pause the scheduled
tasks that write manifest paths: the AR import (`ar-import-headless`: snapshot, `data/ar/review-queue.json`,
`data/ar-mapping-cache.json`), the snapshot refresh, the lease drift check, and calibration
propose/promote (`data/calibration/`). Resume them only after step 4 passes.

## 1. At pull time: hash the live files, then move them out of the tree

Run from the checkout root (`C:/Users/Owner/oxford-command-center` for the live one), using the manifest
of the commit you are about to pull (so newly listed paths are included):

```powershell
$aside = "$env:USERPROFILE\real-data-aside-$(Get-Date -Format yyyyMMdd-HHmmss)"
git fetch origin
git show origin/main:scripts/fixtures/real-data-manifest.json | Set-Content -Encoding utf8 "$aside.manifest.json"
$m = Get-Content "$aside.manifest.json" -Raw | ConvertFrom-Json
$paths = @($m.files) + @(foreach ($d in $m.dirs) { Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue | Resolve-Path -Relative })
$before = foreach ($p in $paths) {
  $p = $p -replace '^\.\', ''
  if (Test-Path $p) {
    $h = (Get-FileHash $p -Algorithm SHA256).Hash      # hash of the LIVE file, writers stopped
    $dst = Join-Path $aside $p
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Move-Item $p $dst                                   # out of the tree: the pull cannot touch it
    "$h  $p"
  }
}
$before | Set-Content "$aside.sha256"
```

Also take an independent backup copy of `$aside` (it is the only copy of the real files until step 3).
Keep both outside every git checkout (they are real data).

## 2. Pull with seeding switched off

```powershell
$env:ORA_NO_SYNTHETIC_SEED = '1'   # nothing may back-fill a half-restored tree
git pull --ff-only
```

## 3. Move the files back, never over anything

```powershell
$clash = Get-Content "$aside.sha256" | ForEach-Object { ($_ -split '  ', 2)[1] } | Where-Object { Test-Path $_ }
if ($clash) { "STOP: recreated since step 1 (compare by hand, overwrite nothing): $clash"; return }
Get-Content "$aside.sha256" | ForEach-Object {
  $rel = ($_ -split '  ', 2)[1]
  New-Item -ItemType Directory -Force -Path (Split-Path $rel) | Out-Null
  Move-Item (Join-Path $aside $rel) $rel
}
Remove-Item Env:\ORA_NO_SYNTHETIC_SEED
```

A path that exists again after the pull was recreated by something (a writer that was not stopped, or
seeding). Never overwrite it: compare it with the aside file by hand and keep the right one.

The four operator tables under `config/local/` did not exist as files before this change (the AR seed
mappings were an inline table in `scripts/seed-ar-mappings.ts`, the doc-search golden was
`scripts/doc-search-golden.json`, the lease-term roster was `LEASE_TERM_SEEDS` in
`server/warehouse/lease-terms.ts`, the PCA overlay tables were exports of
`src/modules/property-condition/pca-overlay.ts`), so step 1 had nothing to move for them. Rebuild all
four from the pre-pull commit (`ORIG_HEAD` right after the pull; any commit before the change works). It
never overwrites an existing file and refuses to write a partial table:

```powershell
npx tsx scripts/extract-local-tables.ts ORIG_HEAD
```

## 4. Verify against the step-1 hashes, then that nothing is synthetic

```powershell
Get-Content "$aside.sha256" | ForEach-Object {
  $hash, $rel = $_ -split '  ', 2
  if (-not (Test-Path $rel)) { "MISSING $rel" }
  elseif ((Get-FileHash $rel -Algorithm SHA256).Hash -ne $hash) { "MISMATCH $rel" }
}
if (Test-Path data\.synthetic-seeded.json) { "STOP: this checkout was seeded with synthetic stand-ins" }
npx tsx -e "import('./server/real-data-status.ts').then(m => { const s = m.realDataStatus(process.cwd()); console.log(s.filter(x => x.state !== 'real').map(x => x.state + ' ' + x.rel).join('\n') || 'all real'); })"
```

The hashes in `$aside.sha256` were taken from the live files themselves at pull time, so `MISSING` /
`MISMATCH` mean a file did not come back intact. Expect neither. The status check lists every manifest
path that is not real. Only the manifest's `optional` files may be listed (`absent`): the two value locks
on first upgrade. Ratify the locks on purpose, after looking at the figures:

```powershell
npm run golden:ratify      # writes data/property-financials/golden.local.json and data/cost-seg/golden.local.json
npm run gate
```

Then resume the writers stopped in step 0.

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
  `ensure-local-data` refuses to seed a checkout that holds any real manifest file. A seeded worktree
  stays synthetic even if real bytes are copied over its files: every path listed in
  `data/.synthetic-seeded.json` reads as synthetic whatever it holds, so readers keep warning and the
  manifest writers (`ar-import-headless`, calibration propose/promote, `extract-workbook`,
  `seed-ar-mappings`, `warehouse:backfill`, `bake-mirror`, the drift check) keep refusing. To turn a
  seeded worktree into a real one, put ALL real files in and then move the marker out of the tree on
  purpose.

## 6. Afterwards

Keep the aside copy until the history purge (done separately) has completed and the live checkout
has been verified again. Then move it into the purge archive; do not leave real data in a temp
folder.

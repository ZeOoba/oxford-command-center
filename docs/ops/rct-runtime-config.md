# RCT runtime config: the ratified Replacement-Cost Table is local-only

The Replacement-Cost Table (RCT) is the Basis-floor denominator: per-market LOW / POINT / HIGH all-in $/SF, the
cheapest-market fallback, the construction-type multiplier schedule and the adder schedule. It is governor-level
(Hard Invariant 4) and this repo is public, so since 2026-11-13 the table is **not tracked**. Gabriel chose runtime
config over making the repo private (2026-11-12 audit; repos stay public, ruling 2026-11-09). The same change was
made in the Website repo (ZeOoba/Website#204).

The values in git history (every commit before this change) stay there; no history rewrite was approved.

## Where the table lives

| What | Where | Tracked |
|---|---|---|
| Ratified table | `config/replacement-cost.v3.json` (same path as before) | **No**: gitignored and listed in `scripts/fixtures/real-data-manifest.json` |
| Synthetic stand-in (invented figures, `_synthetic: true`) | `fixtures/synthetic/config/replacement-cost.v3.json` | Yes |
| Pin (keyed HMAC-SHA256 of the parsed table) | `RATIFIED_RCT_HMAC` in `server/warehouse/rct-pin.ts` | Yes (reveals nothing without the key) |
| Pin key | `RCT_PIN_KEY` in the canonical checkout's `.env` (min. 32 chars) | **No** |

Because the table is a real-data manifest path, it gets the same treatment as the other real data
(`docs/ops/2026-11-11-real-data-untrack-pull-runbook.md`): `ensure-local-data` seeds the synthetic stand-in only on
an all-synthetic checkout (CI, fresh clones, scratch worktrees), the mirror build root copies the real file in from the
canonical checkout and refuses a missing or synthetic one, the pre-push scan blocks the PATH from being pushed (it has no fingerprints for the
figures, so a figure pasted into another file is caught only by `tests/unit/rct-public-leak.test.ts` on a checkout that
holds the real table), and the governance check fails if it is tracked.

## Who reads it, and how each one fails closed

| Reader | How it gets the table | Fails closed when |
|---|---|---|
| Brain Server (`server/warehouse/api.ts` acqConfig, `capital-allocation.ts` BUY gate) | `loadRatifiedRct()` reads the file | the file is missing, not JSON, the synthetic stand-in, unratified/unsigned, outside the plausibility bounds, not the pinned table, or `RCT_PIN_KEY` is missing or short. The scoring routes return 503 and the BUY gate emits no BUY. |
| Mirror build (`npm run build:mirror`) | `bake`, then `npm run check:rct-pin` verifies the very file about to be bundled, then `build` | same conditions as above. The build stops before anything is bundled, so nothing is deployed. `bake`, which reads no RCT and sends the Daily Brief, runs first, so a missing key stops the mirror deploy but not the brief. `deploy-mirror.ps1` imports the canonical `.env` before the build, so `RCT_PIN_KEY` reaches it. The hourly task builds `origin/main` with no human step, so the key must already be in `.env` when this change merges (Setup step 1). |
| Deal drawer (`src/brain/replacement-cost.ts`, Vite bundle) | bundled at build time | a production-mode build of the synthetic stand-in prices nothing (no verdict). The refusal follows Vite's mode (`import.meta.env.PROD`), so a build run with `NODE_ENV=development` keeps the stand-in. That is why the deployed bundle relies on `build:mirror`'s pin check, which refuses the stand-in whatever the mode. **Gap:** the local dev UI (`npm run dev`) bundles whatever the local file holds without a pin check. After a hand edit, the drawer can show a verdict while the engine refuses it (503, no BUY). The engine is authoritative. |
| Edge scoring Function (`functions/api/warehouse/acquisition/score.ts`) | bundled at build time | the synthetic stand-in or an implausible table returns 503 |
| Tests | always the synthetic stand-in (`vitest.config.ts` alias, `tests/setup.ts`, `tests/support/rct.ts`) | n/a. Tests never read the real table, except `tests/unit/rct-public-leak.test.ts`, which compares and never prints. |

The pin is keyed on purpose. A plain hash published in a public repo would confirm the values already in git history
and let anyone brute-force a future re-ratification by starting from them.

## Setup (once, on the Brain Server machine)

1. **Before this change merges**, add the pin key to the canonical checkout's `.env` as `RCT_PIN_KEY=<the key>`. The
   key that produced the committed pin was generated when this change was made and handed over out of band (never in
   git, PR text or chat). The hourly mirror deploy builds `origin/main` on its own, so if the key is missing at merge,
   every run after that fails closed at `check:rct-pin` (alert `build:mirror failed (1)`) until the key is added. The
   Daily Brief still sends, because `bake` runs before the check. Scoring on the Brain Server also fails closed (503,
   no BUY) until steps 2-4 are done.
2. Pull the change with the real-data runbook (`docs/ops/2026-11-11-real-data-untrack-pull-runbook.md`). The manifest
   now lists `config/replacement-cost.v3.json`, so the runbook moves it aside before the pull and back after. **A plain
   `git pull` deletes the file**, because it is no longer tracked. If that happened, restore it from the
   pinned v3.2 table: `365d6f27` (#569) is the commit that ratified it, and every later `main` commit before this change
   carries the same blob.
   `git restore --source=365d6f27 --worktree -- config/replacement-cost.v3.json`
   It writes the working file only and does not re-track it. Avoid a `>` redirect in Windows PowerShell, which writes
   UTF-16 and leaves a file the loader refuses. Then run `npm run check:rct-pin` to confirm the restored file is the
   pinned table.
3. Check: `npm run check:rct-pin` prints `OK ... is the pinned ratified table`.
4. Restart the Brain Server.

**Do not switch the live checkout to a branch cut before this change.** Any such branch still tracks
`config/replacement-cost.v3.json`. Checking it out overwrites the local table with that branch's copy, and switching
back to `main` deletes it. Git gives no warning, because the path is gitignored on `main`. Use a separate worktree
for old branches. If it happens, restore the table as in step 2 and re-run `npm run check:rct-pin`.

If a checkout was ever seeded with the synthetic stand-in (`data/.synthetic-seeded.json` lists
`config/replacement-cost.v3.json`), it keeps treating that path as synthetic even after you copy the real table in, and
the mirror build root refuses it. Remove that entry from the marker, as for any other real-data path (real-data runbook).

## Re-ratifying the table (Gabriel's approval, Invariant 4)

1. Edit the local `config/replacement-cost.v3.json` and bump `rctVersion`.
2. In a PR: bump `RCT_VERSION` in `src/contracts/acquisition.ts`, and set `RATIFIED_RCT_HMAC` to the output of
   `npm run check:rct-pin -- --print`. Do not put any figure in the PR, the commit or a tracked file.
3. The PR changes financial source, so it needs the `refute-financial-change` Workflow trailer (`check:refute`).
4. After merge: restart the Brain Server and run `rescoreStaleCandidates` (the version bump marks cached scores stale).

Rotating the key means a new `RCT_PIN_KEY` in `.env` and a recomputed `RATIFIED_RCT_HMAC` in a PR, the same way.

## Leak guard

`tests/unit/rct-public-leak.test.ts` always checks that the table path is untracked, gitignored and in the manifest,
that the stand-in is marked synthetic and refused by the production loader, and that the pin is a 64-hex HMAC. With
the local table present it also scans every tracked file (not the gitignored `dist/`, which bundles the real table by design) for a $/SF figure from the table, the multiplier
schedule and the adder schedule. It verifies the local table against the pin when `RCT_PIN_KEY` is available, and
checks that the key is in no tracked file. In CI the table is absent, so the value scan skips.

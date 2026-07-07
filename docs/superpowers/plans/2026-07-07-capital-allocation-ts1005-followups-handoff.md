# Handoff — Follow-ups Discovered Fixing PR #176 TS1005 — 2026-07-07

**Origin:** Gabriel asked for a targeted fix — `server/warehouse/capital-allocation.ts` had a
missing `}` closing `buildBuyVerdict`, failing `tsc` in PR #176's CI gate. Fix landed, merged
`2026-07-07T15:29:50Z` (commit `9b604e9` on `fix/c3-buy-verdicts`). This doc is **not** that
fix — it's the incidental findings from that session, handed off because they're real but
out of scope for a "minimal diff" CI fix.

**Read this first — the core lesson of the session that produced this doc:** the line numbers
in the original bug report (`capital-allocation.ts:956`) were already stale by the time the
fix was written — a same-day merge had added 178 lines and moved the real defect to line 163.
By the time *this doc* is read, the repo will have moved again (see PR velocity below). **Every
line number, file state, and "current" claim below must be re-verified against `git log` /
`git status` / a fresh `Grep` before acting on it — do not trust this doc's line numbers
blindly.** That's what "failure proof" means here: not that the facts can't go stale, but that
every item below tells you how to re-check before you act.

**PR velocity context (2026-07-07, for calibration):** PRs #172–#178 merged today alone, several
touching `server/warehouse/capital-allocation.ts` directly (#175 C-4, #176 C-3, #178 capexIrr
gate). This file specifically is under heavy concurrent development — treat any line-number
citation for it as provisional until you `Grep` it fresh.

---

## Item A — Prettier formatting drift in `capital-allocation.ts` (cosmetic, low urgency)

**Finding:** `npx prettier --check server/warehouse/capital-allocation.ts` fails. A full
`prettier` (no `--write`) diff showed ~714 differing lines out of 956 at the time of the PR
#176 fix (file has since grown to 1094 lines post-#178 — re-run to get a current count).
Representative deviations: quoted enum-like object keys (`'excellent': 'low'` →
`excellent: 'low'`), numeric literal trimming (`0.80` → `0.8`).

**Why it wasn't fixed inline:** the PR #176 task was scoped to a minimal single-brace CI fix.
Running `prettier --write` on the whole file would have produced a 700+-line diff unrelated to
the syntax bug, which is exactly the kind of scope creep CLAUDE.md's Engineering OS explicitly
guards against ("smallest surgical change").

**Why it matters at all:** this drift isn't enforced anywhere — confirmed neither `npm run gate`
nor `npm run gate:ci` (`package.json`) invoke `prettier --check` or `npm run format`. So it's
silent, compounding drift, not a blocking defect. Two independent decisions here, don't
conflate them:
1. Reformat `capital-allocation.ts` (and likely siblings — this may be repo-wide, not
   file-specific; sample 2-3 other `server/warehouse/*.ts` files with `prettier --check` before
   assuming scope).
2. Whether to add a `prettier --check` step to `gate:ci` going forward — a process/policy call
   for Gabriel, not something to decide unilaterally. Flag it, don't auto-add it.

**Before acting:** re-run `npx prettier --check server/warehouse/capital-allocation.ts` (state
may have changed) and sample the rest of `server/warehouse/` and `src/` to size the real blast
radius before committing to "reformat everything."

**Suggested approach if greenlit:** isolated worktree, single commit `chore(format): apply
prettier to server/warehouse/**` (or repo-wide), no logic changes, verify `tsc`+`lint`+`test`
still green before/after (diff should be whitespace/quote-style only — `git diff -w` should be
near-empty).

---

## Item B — Contaminated shared main checkout (`C:\Users\Owner\oxford-command-center`) — higher priority, needs a human decision

**Finding (re-verified immediately before writing this doc, 2026-07-07):** the **main
checkout** (not a worktree) is sitting on branch `chore/post-w2-merge`, whose upstream is
`[gone]` (deleted on remote — i.e. that branch's PR already merged and the remote ref was
cleaned up), with:
- 8 **modified, uncommitted** tracked files: `architecture/status.json`,
  `scripts/reconcile.ts`, `server/brief/render.ts`, `server/warehouse/scores.ts`,
  `src/analytics/conditions.ts`, `src/analytics/types.ts`,
  `tests/unit/brief-render.test.ts`, `tests/unit/warehouse-scores-basis.test.ts`
- 12 **untracked** paths, including `docs/superpowers/plans/2026-06-21-phase-2-completion-handoff.md`
  and `.../2026-06-20-phase-4-steps-5-7-8-9-execution-plan.md` — dated **over two weeks before
  today**, suggesting this is abandoned/forgotten work rather than something mid-flight.

**Why this matters:** CLAUDE.md's shared-checkout single-writer rule exists precisely for this —
"NEVER `checkout`/`reset`/`rebase`/`stash`/`branch -f` a tree whose `git status` shows
uncommitted work you didn't create." I obeyed that rule this session (worked entirely in the
`c3-buy-verdicts` worktree instead), which is why PR #176 shipped clean — but the underlying
mess is still sitting there blocking anyone who tries to use the main checkout directly next.

**This is not mine to resolve** — I don't know whose work this is or whether it's safe to
discard. It needs a human call (Gabriel) or an investigating session with authority to make one:
1. `git log -1 --format=%cd chore/post-w2-merge` / check the untracked docs' content for
   authorship clues (session IDs, dates) to figure out whose in-flight work this is.
2. Given the branch's own PR already merged (upstream `[gone]`) and the untracked docs are
   2+ weeks stale, the working hypothesis is this is dead/superseded — but **do not delete
   without confirming**, per CLAUDE.md invariant 6 (never delete — move to `/archive/`) and the
   general "investigate before overwriting" doctrine.
3. Safe first move for a new session: `git stash push -u -m "quarantine-2026-0X-XX-main-checkout-audit"`
   on the main checkout (stash, don't discard) after confirming no *other* live session has that
   checkout open, then the main checkout can be returned to a clean `main` for the next writer.

---

## Item C — Stale worktree sprawl under `.claude/worktrees/` — mechanical, low risk

**Finding:** `git worktree list` (re-run 2026-07-07, post PR #176/#178 merge) still shows 20+
worktrees. Cross-referencing against `gh pr list --state merged --limit 30` confirms these
worktrees' branches are **already merged** as of today:

| Worktree dir | Branch | Merged PR |
|---|---|---|
| `insight-rank` | `claude/insight-rank-main` | #152 (2026-06-23) |
| `insight-scope-gate` | `claude/insight-scope-gate` | #151 (2026-06-23) |
| `insight-stats` | `claude/insight-stats` | #149 (2026-06-23) |
| `insight-cf1` | `claude/insight-cf1` | #156 (2026-06-23) |
| `item3-acq-live-pipeline` | `claude/item3-acq-live-pipeline` | #153 (2026-06-23) |
| `item4-acq-input-persist` | `claude/item4-acq-input-persist` | #154 (2026-06-23) |
| `m6-leasing-risk-ic-memo` | `claude/m6-leasing-risk-ic-memo` | #155 (2026-06-23) |
| `m11-usememo-cols` | `claude/m11-usememo-cols` | #158 (2026-06-23) |
| `m12-tenant-slug` | `claude/m12-tenant-slug` | #157 (2026-06-23) |

Two other worktrees (`c2-refi-savings-gate`, `c3-buy-verdicts`, `fix-improve-capex-proxy`)
**self-pruned automatically** during this same session within ~2 hours of their PRs merging
(#173, #176, #178) — confirming *something* already auto-prunes merged worktrees, just not
fast enough to keep the list clean, or the ones above (2 weeks old) are past whatever window
that automation checks. Worth finding that automation (likely in
`scripts/` or a scheduled task) and understanding why it missed the 2-week-old batch — that's
more valuable than manually pruning once.

**Not yet checked** (sample further before pruning): `h4-easement-impl`, `insight-contract`,
`item1-anomaly-bridge`, `item8-capex-irr`, `wave1-analytics`, `wave1-hygiene`,
`wave1-m1-integration`, `wave1-ux-acq`, `wave1-ux-capital`, `wave2-h2-leasing-basis`,
`agent-a4db3bf5d0d691ecc` (**locked** — do not touch without finding out why it's locked first).

**Before acting:** re-run `git worktree list` + `gh pr list --state merged --limit 60
--json number,headRefName` fresh (more merges will have landed) and only remove worktrees whose
branch is confirmed merged AND not locked. `git worktree remove <path>` is safe/reversible
(the branch and its commits stay in the repo either way) but confirm no session has that
worktree open first.

---

## Item D — Pre-existing JV/fractional-ownership basis-mismatch flag (context, not newly discovered — carry forward)

**Location (re-verified at time of writing, will drift — `Grep` for "Known follow-up" to
relocate):** `server/warehouse/capital-allocation.ts:42-47`, a comment already in the file
before this session touched it:

> `entryValue` (`oxfordValue`) is scaled by the workbook's `oxfordOwnPct`; `currentNoi`
> (`oxfordNoi`) is scaled by `property_master.ownership_pct` (`metrics.ts`). These are two
> independently maintained ownership fractions for the same property — if they ever diverge for
> a JV/fractional-ownership asset, the IRR's going-in yield would be computed on mismatched
> bases.

This was flagged by a prior adversarial-refute pass (dated 2026-07-07, "low severity,
unconfirmed on live data") and left unresolved — not something I found new, but it's directly
adjacent to the file this session touched and it's a real capital-allocation-math risk per
CLAUDE.md's financial-decision-code standard, so it belongs in this handoff rather than getting
lost. **Action needed:** verify `property_master`'s seeded `ownership_pct` against the live
workbook's `oxfordOwnPct` for every JV/fractional asset in the portfolio — if they match for
all current properties this is a non-issue in practice (just fragile); if any diverge, the
IRR math in `buildBuyVerdict`'s sibling functions needs a single source of truth for ownership
fraction.

---

## Priority read (my judgment, not a decision — Gabriel arbitrates)

1. **Item B** (contaminated main checkout) — blocks safe future use of the shared checkout;
   needs a human look, not code.
2. **Item D** (ownership-fraction mismatch) — real financial-math risk, but "unconfirmed on live
   data" per its own flag; a data-verification task, not urgent unless a JV asset is about to be
   scored.
3. **Item C** (worktree sprawl) — pure hygiene, zero risk, do whenever convenient.
4. **Item A** (prettier drift) — cosmetic; bundle with Item C's next "housekeeping session" or
   skip indefinitely, Gabriel's call.

## Where this doc lives

Written from an isolated worktree (`.claude/worktrees/handoff-2026-07-07-capital-allocation-followups`,
branch `docs/handoff-2026-07-07-capital-allocation-followups`, based on latest `origin/main`
post-#178) — **not** the contaminated main checkout (Item B), per the same single-writer
discipline this doc asks you to follow. Pushed to origin so a fresh session/clone can find it
without needing this worktree to still exist. Not opened as a PR — docs-only, no urgency; open
one if/when you act on any item above, or merge directly.

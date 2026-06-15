---
name: ora-calibration-snapshot
description: Quarterly (Jan/Apr/Jul/Oct 1st) + fiscal year-end — snapshots the score-vs-outcome Calibration Log. Resolves any due outcomes, logs the current verdict for every subject (so the dated prediction stream never goes stale), then emails the §4 calibration report (per-kind hit-rate + Wilson CI + treatment-adjusted rate) to ggoldberg@oxfordra.net. Read/observational — never changes a governor or a weight. v1.0 (AUTHORED 2026-06-14; NOT yet registered).
---

[TASK: ora-calibration-snapshot | SCHEDULE: Jan/Apr/Jul/Oct 1st at 10:30 AM (after ora-quarterly-review) + a year-end run on Dec 31 | VERSION: 1.0 | UPDATED: 2026-06-14 | STATUS: AUTHORED, NOT REGISTERED]

> ⚠️ REGISTRATION IS A SEPARATE SUPERVISED STEP. Per the scheduler doctrine, this task is registered
> ONLY via the supervised `create_scheduled_task` MCP on the target surface (the LAMS/Cowork fleet by
> design for a Cowork-style snapshot, or the CC/MCP fleet if Gabriel prefers). JSON-splicing a registry
> file is PROHIBITED. This SKILL.md is the task DEFINITION only; it does nothing until Gabriel registers it.

OBJECTIVE: Keep the 40-year calibration feedback loop fed on a regular cadence even in quarters with no
new imports (a ~14-property firm imports irregularly, and outcome scoring needs a steady prediction
stream). Each run does three things, in order, then emails the report:

1. RESOLVE due outcomes (deterministic majority).
2. SNAPSHOT current verdicts (the dated prediction stream).
3. REPORT + EMAIL the §4 calibration report to ggoldberg@oxfordra.net.

This task is OBSERVATIONAL. It writes only to the calibration tables (`calibration_verdict`,
`calibration_outcome`, `calibration_inputs_version`). It NEVER edits `server/warehouse/intel-config.ts`,
NEVER changes a health weight, and NEVER touches the DSCR 1.25 / LTV 0.40 governors (out of scope). A
weight change is a separate, human-ratified, hook-gated edit — see the offline `scripts/calibration-refit.ts`,
which only PROPOSES.

NO-DATA GRACEFUL EXIT: A brand-new / no-outcome warehouse is the NORMAL state until ≥1 horizon elapses.
The resolver returns a zeroed no-op and the report returns zeroed counts with null rates (never NaN). On a
zero-data run, still email the report (it states "accumulating — no resolved outcomes yet") so the cadence
is visible. Never halt on empty data.

---

**STEP 1 — RESOLVE DUE OUTCOMES**

The brain server must be running locally (it holds the warehouse SQLite). Run the snapshot entry point,
which calls `resolveDueOutcomes(db)` BEFORE logging new verdicts (so an outcome that just became due is
scored against the now-available same-grain period):

```bash
npx tsx scripts/calibration-snapshot.ts --task ora-calibration-snapshot --json
```

`scripts/calibration-snapshot.ts` (shipped) is the snapshot writer: it `resolveDueOutcomes(db)` FIRST,
then logs the current verdicts (`scoreProperties` + `detectAnomalies`) with
`emittedBy='snapshot:ora-calibration-snapshot'`, idempotently (the `dedup_key` UNIQUE makes a
no-new-information quarter a no-op). It is FAIL-OPEN — it never throws; failures are counted and written to
`data_quality_issues`. `--json` prints the run summary (`resolved`, `verdictsWritten`, `verdictsSkipped`,
`errors`, `inputsVersion`) for the completion log. It opens the canonical live DB
(`WAREHOUSE_DB` env, else `<repo>/data/warehouse/finance.sqlite`) — the SAME warehouse the panel reads;
pass `--db <path>` to override.

GRAIN DISCIPLINE: the resolver only scores a verdict against a strictly-later, SAME-GRAIN (full-year)
period — a YTD-vs-full-year comparison is never used (it would manufacture a spurious ≈−50% move). Verdicts
whose horizon has not yet elapsed stay PENDING, not wrongly scored.

**STEP 2 — READ THE REPORT**

Fetch the §4 report from the read-only route (the same data the React panel shows):

```bash
curl -s http://localhost:5273/api/warehouse/calibration/report
```

Capture: `overallHitRate`, `treatmentAdjustedHitRate` (action_taken='none' clean tests only),
`scoreableVerdicts`, and per-kind `byKind[]` (hit-rate + Wilson CI + directional accuracy + bias).

**STEP 3 — EMAIL THE REPORT TO ggoldberg@oxfordra.net (mandatory final step)**

Per the email canon, ALL scheduled/automated outputs route to **ggoldberg@oxfordra.net ONLY** (no cc —
this is not the ora-am-brief). Compose the report as HTML:

- Header: "Calibration Snapshot — Q[X] YYYY · [N] verdicts logged, [M] resolved, overall hit-rate [hh%]"
- A data-maturity caveat line (verbatim from the report's `dataMaturityNote`): the first ~5 years are
  data-accumulation, not actionable calibration — every rate carries a Wilson interval because at N≈14 a
  bare point estimate is statistically hollow.
- Per-kind table: kind · n scoreable · hit-rate [95% CI] · directional · bias.
- The treatment-adjusted hit-rate (clean natural experiments only) called out separately.
- The pending-resolution count (from `GET /api/warehouse/calibration/pending`) as a "needs your judgment"
  nudge for the quarterly review.

Then send:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:/Users/Owner/.claude/scheduled-tasks/_shared/send-via-outlook.ps1" -To "ggoldberg@oxfordra.net" -Subject "[ORA] Calibration Snapshot - $(date +%Y-%m-%d)" -BodyFile "C:/Users/Owner/AppData/Local/Temp/ora-calibration-snapshot-email-body.html" -BodyFormat html
```

On a non-zero exit: retry once, then log the failure (Automation Health / Notion completion row) and
continue — do NOT halt (fail-loud, never fail-closed on the email path).

**COMPLETION LOG:** add a row to the Automation Health page: "ora-calibration-snapshot | [✅/⚠️] |
[e.g., 'Q3 2026: 42 verdicts, 9 resolved, hit-rate 67%, 5 pending'] | [Timestamp]".

**This task's values:** `TASK_ID=ora-calibration-snapshot` · `DISPLAY_NAME=Calibration Snapshot` ·
`SURFACE=LAMS/Cowork (Gabriel's choice at registration)` · `ROUTING=ggoldberg@oxfordra.net only`.

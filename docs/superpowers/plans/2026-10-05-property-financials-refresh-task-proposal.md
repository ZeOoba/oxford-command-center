# Property Financials — monthly refresh scheduled task (PROPOSAL, not registered)

Status: **PROPOSED 2026-10-05 — nothing registered.** Registration, if approved, goes through the
`register-scheduled-task` skill (supervised `create_scheduled_task` on the target surface) and nothing else:
no registry JSON is spliced, no generic `schedule` skill. This document is the ratification input.

## Purpose

Rebuild the Property Financials module's data (`data/property-financials/{monthly-long.csv,dataset.json}`)
once a month from the property-management statement exports, through the tested T9a/T9b pipeline
(`scripts/property-financials/README.md`), and hand Gabriel a reviewed diff to promote. The task never
promotes on its own: `data/property-financials/` is written only by a human commit.

## Proposed registration

| Field | Proposal | Why |
|---|---|---|
| Name | `ora-property-financials-refresh` | fleet naming (`ora-*`), one job |
| Surface | Code (CC/MCP fleet) — needs the repo checkout, `npx tsx`, desktop Excel for the `.xls` conversion step | the pipeline is a repo CLI chain; Cowork has no checkout or Excel COM |
| Schedule | `0 7 5 * *` (07:00 local, 5th of each month) | PM exports for the prior month land in the first days of the month; the 5th leaves room for late postings and still precedes the monthly close review |
| Timeout | 30 min | a full run (246 files) takes ~3 s to parse, ~2 min to convert via Excel when new `.xls` land, under a minute for tests |
| Routing | **output to `ggoldberg@oxfordra.net` only** (Outlook COM via `_shared/send-via-outlook.ps1`); no cc, never ze@ | routing canon — the only cc exception is the AM Daily Brief |
| Writes | `scripts/property-financials/_out/` (gitignored), a local converted-`.xlsx` cache, an outbound summary mail | OneDrive `Business/` is READ-ONLY; `data/property-financials/` is never touched |
| Dead-man link | registers in the dual-fleet dead-man chain checked by `automation-health-monitor` (weekday 11:00): a missed 5th-of-month run is reported there; the task also writes its last-run beacon alongside `_out/parse-report.json` (`refresh-run.json`: started, finished, exit code, counts) for `fleet-status.py` | no silent non-run |

## Steps (each stops the run and reports on failure)

1. **Acquire exports** — list `Business/Property Financials/Property Management P&Ls/**` and the top-level
   `P&L <year>[ YTD] -- <entity>.*` files; compare against the previous run's `parse-report.json` file list.
   New files = the month's work. Nothing is downloaded or written into OneDrive; AppFolio / Yardi / QuickBooks
   portal pulls stay a human step (the `pm-portal-pnl-export` skill) until a read-only export agent is ratified.
2. **Convert** — `convert-xls.ps1` for every `.xls` with no converted twin (Excel COM, read-only opens, staging
   copy unblocked, macros disabled). Skipped files are listed; a conversion failure is a run failure.
3. **Normalize** — `parse-sources.ts --converted <cache> --out _out/` (exit 4 = unreadable/unsupported files →
   report and STOP), then `normalize-raw.ts --in _out/raw-records.json` (exit 2 = unmapped accounts → the report
   names each account; the fix is a new `account-mapping.vN.json`, never a default).
4. **Build** — `build-dataset.ts --csv _out/monthly-long.csv --generated <run date>` (exit 3 = contract failure →
   STOP; note a rolled calendar year is a contract change for the architect).
5. **Diff** — the CLIs' built-in diff summaries against the committed files (`monthly-long.csv` line diff;
   `dataset.json` leaf diff) plus the cross-check block (annual statements vs monthly sums) and the live-SF
   provenance (`GET /dataset liveSf`: live vs static, as-of, stale).
6. **Human promotion** — the summary mail carries: coverage per entity (periods, files), the diff summaries,
   unreadable / unsupported / excluded files, unmapped accounts, cross-check deltas, and the exact promotion
   commands (`copy _out/monthly-long.csv data/property-financials/`, `copy _out/dataset.json …`, then
   `npx vitest run tests/unit/property-financials-*.test.ts` and `npm run gate`). Gabriel reviews and commits;
   `src/analytics` / `scripts` changes need the refute attestation as usual.

## Failure modes and the response

| Failure | Detection | Response |
|---|---|---|
| OneDrive folder absent / not synced | step 1 `existsSync` false | report "source folder unavailable", no partial outputs |
| New `.xls` cannot be converted (Office validation, locked file) | step 2 FAIL lines | report the files; the run continues to parse what it can and exits 4 — the mail says the raw records are INCOMPLETE |
| New account label (vendor renamed a GL line) | step 3 exit 2 with the unmapped report | mail the report; propose the rule; no default classification ever |
| Statement whose totals do not tie (truncated export, hidden rows) | `StatementParseError` naming file › sheet › row › month | run fails; the mail quotes the error |
| Two files for one entity-period that disagree (re-export after a correction) | `collectSourceRecords` duplicate error naming both files | run fails; human removes/archives the superseded file (never deletes — `/archive/`) |
| Northwood exports appear (financials received) | listed under EXCLUDED by `excludedEntities` | the mail flags that Northwood is still excluded; adding it is data (registry + mapping patterns), reviewed |
| Known-difference drift (the 9620 2025-09 ruling) | the gated test's `KNOWN_DIFFERENCES` | until ruled, the diff summary will always show the 9620 2025-09 rows; the mail says so |
| Spine A snapshot stale (> 7 days) | `liveSf.stale` | reported as information; figures already fall back to the static dataset by the client rule |
| Excel COM hangs | step 2 timeout (per-file 60 s, whole step 10 min) | kill Excel, report, continue with what converted |
| Run did not start | dead-man chain / health monitor | reported by `automation-health-monitor`; no mail = no run |

## Not in scope

* Registering anything (this is a proposal); promoting data; writing into OneDrive; adding a reader dependency
  (open decision in the README); pulling exports from the PM portals.

## Ratification needed

1. Approve name / cron / surface / routing above (or amend).
2. Rule on the binary-`.xls` reader (Excel conversion step vs LibreOffice vs approved dependency) — the task's step 2 depends on it.
3. Rule on the 9620 State 350 2025-09 known difference (promote the corrected figures or keep the reference's).
4. Then: `register-scheduled-task` on the Code surface, supervised `create_scheduled_task`, and the dead-man link.

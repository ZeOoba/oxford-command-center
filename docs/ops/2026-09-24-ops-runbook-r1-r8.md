# Ops Runbook R1–R8 — tracked checklist

Status: OPEN until **System Health › Data Feeds shows "0 need attention" (green)** and every row below is checked.
Owner of this checklist: Gabriel (with supervised Claude sessions for the command rows).
Source: 2026-09-23 review Ops Runbook (docs/superpowers/plans/2026-09-23-command-center-review-fixes.md), ratified follow-up 2026-09-24.

Guardrails: business-OneDrive files are edited by Gabriel only (Invariant 5). Recurring jobs are registered ONLY through the
`register-scheduled-task` skill (supervised `create_scheduled_task`, never registry JSON). Nothing here is a code change.

| # | Item | Owner | Exact command / action | Expected Data Feeds status when done | Done |
|---|---|---|---|---|---|
| R1 | Cash history rows missing after **2026-07-10** (08-10, 09-10). Also the cause of the gate's current `reconcile` failure: *Cash history latest = current total* (history total above the current total, as of 2026-09-27) | Gabriel | Add the 2026-08-10 and 2026-09-10 rows to *Cash Data* in the Master Workbook; save (the watcher re-parses). | **Cash history (monthly rows)** fresh (≤ 40d); Health › Data Quality has no `cash.history.date` flag; `npm run reconcile` passes | [ ] |
| R2 | AR aging import stale (newest import 2026-08-21; **44** leases with stale AR as of 2026-09-27 — the feed crossed its 35-day budget on 2026-09-26) | Supervised session → Gabriel runs the QB export | 1) Export AR aging from QuickBooks Desktop into `AR_INBOX`. 2) `npx tsx scripts/ar-import-headless.ts` 3) Fleet check on why the Monday 08:20 import stopped: `automation-health-monitor` → `fleet-advisory-remediation`. | **AR aging (QuickBooks)** fresh (≤ 35d) with **no** "N leases with stale AR" note | [ ] |
| R3 | Daily brief last ran **2026-07-09** | Supervised session | Confirm whether the snapshot-refresh / brief task (runs `scripts/bake-mirror.ts` → brief) was paused or retired; re-register via `register-scheduled-task` if retired. | **Daily brief** fresh (< 36h); Health › Daily Brief card "OK" | [ ] |
| R4 | Lease Market never computed | Supervised session | `npm run lease-market:ingest` (CoStar exports in the intake folder) then `npm run lease-market:compute`; register weekly via `register-scheduled-task`. | **Lease market compute** fresh (≤ 14d); Lease Market module shows KPIs, not the empty state | [ ] |
| R5 | Document index built **2026-06-06** | Supervised session | `npm run index:docs -- --replan` once, then repeat `npm run index:docs` (or `scripts/reindex-loop.ps1`) until it reports 0 remaining; register monthly. Requires `DOCUMENTS_EXCLUDE` + `DOCUMENTS_INCLUDE_DIRS` in `.env` (the reindex safety guard refuses otherwise). | **Document index (Ask)** fresh (≤ 30d) | [ ] |
| R6 | Insurance: 8 policy lines show expired (1100 Rarig, ETC POA, 1851 S Club, 9050 Red Branch, 3034 Westerville); TIV null on all 30 | Gabriel supplies dec pages; supervised session imports | Confirm renewals were bound; `npx tsx scripts/import-insurance-data.ts --dec-pages <policies.json>` (terms + TIV) and `--policies <policies.json>` (premium history); verify with the `insurance-declaration-checker` agent. | Not a Data Feeds row — Obligations › Insurance shows a **Rate vs Benchmark** value and no Expired lines in the Policy Tracker | [ ] |
| R7 | Workbook rows: **Example Consulting** $0 rent "Active"; **Tenant 038 LLC** / **Tenant 059 LLC** ended 2024-09-01 (retire) | Gabriel | Fix Example Consulting's rent/status and retire the Tenant 038 and Tenant 059 rows in the Master Workbook (no code change — ratified 2026-09-24). | **Workbook snapshot** fresh (≤ 2d) after re-parse; Health › Data Quality has no `lease.<id>.leaseEnd` flag for those tenants | [ ] |
| R8 | Leasing velocity has no data (`lease_events` = 0 rows) | New spec session | Spec an importer that derives vacate/commence events from historical rent rolls or the Notion Tenant DB history (brainstorming → `/plan`), then add the velocity trend chart. Output: `docs/superpowers/specs/<date>-lease-events-importer.md`. | Not a Data Feeds row — spec merged; velocity chart ticket opened | [ ] |

Close-out: when every box is checked and Data Feeds reads "0 need attention", set Status to CLOSED with the date and
record it in the project `event_log.md`.

# P4 — Third-Party PM Data Reconciliation / Exception Engine

**Design spec v03** · 2026-08-16
Supersedes v02 (same file, commits `93bfefb` / `03e019e`) and the v01 planning output.
Prerequisite reading: [P4 Capability Audit](./2026-08-16-p4-capability-audit.md) — commissioned by Gabriel after v02 was found to overlap working code.

---

## 1. Purpose

Reconcile PM-supplied data against ORA's lease source of truth and surface **exceptions only**, at a false-positive rate low enough that the report keeps getting read.

Autonomy frame (ratified 2026-08-16): **act on internal** — pulls, reconciliation, internal reporting. **Draft on external** — anything addressed to a tenant or a PM firm.

---

## 2. Why v03 is much smaller than v02

The capability audit found that five of v02's six components already exist and are tested. The ingestion subsystem shipped as PR #230 and was hardened over two adversarial refute rounds on 2026-07-22; all five Phase-1 detectors exist in an 896-line condition engine; the regime registry exists and is populated in the finance warehouse.

**The capability is not missing. It is dark.** `data/ar/` does not exist, `tenantArrears` has 0 entries, and nothing schedules `scripts/ar-import-headless.ts` — which already accepts the exact `.xlsx` format of the eight files sitting in `Business/A.R. Reports/`.

v03 therefore builds only what the audit found genuinely absent (audit §4), and explicitly forbids rebuilding what exists.

### 2.1 Do not rebuild

Implementation must consume, not replace, these:

| Concern | Existing owner |
|---|---|
| AR parsing (Yardi · AppFolio · RentManager) | `server/ar/ar-aging.ts`, `server/ar/rent-manager-delinquency.ts` |
| Tenant→lease matching | `server/ar/match-tenant.ts` |
| Confirmed-mapping persistence | `server/ar/mapping-cache.ts` |
| Auto-write vs review partition | `server/ar/partition-confidence.ts` |
| Multi-unit bucket summation | `server/ar/merge-buckets.ts` |
| Stale/TOCTOU write guards | `server/ar/resolve-latest.ts` |
| `arBalances[]` projection | `server/ar/derive-ar-balances.ts` |
| Detectors (escalation, holdover, renewal, arrears, insurance) | `src/analytics/conditions.ts`, `server/warehouse/insurance-conditions.ts` |
| Exception state | `server/alerts/store.ts`, `src/contracts/alerts.ts` |
| Bulk-change floor | `server/anomaly-floor.ts` — canonical; consolidated 2026-07-26 after two reverts. Do not duplicate. |
| Regime registry | `property_master.property_manager` (`data/warehouse/finance.sqlite`) |

---

## 3. Regime registry — verified state

From `property_master.property_manager`, corroborating Gabriel's 2026-08-16 ruling.

| PM firm | Properties | Platform |
|---|---|---|
| Kohr Royer Griffith | 1100 Rarig · 3034 Westerville · 3540 E 5th · 3875-3883 E Livingston · Sepich Portfolio | AppFolio |
| CRC | 1900 N Broadway · 9050 Red Branch | Yardi |
| SVN | 2203-2207 Northwood | RentManager |
| Thomas Park | 29000 Information Lane | Yardi |
| Peak Real Estate Partners | 9620 E State Route 350 | AppFolio |
| *(self-managed)* | 55 New Plant Ct · 401 Sunburst Hwy · 7658 Fishel Dr N | none |

**Firm and platform are different axes.** The firm is who to email; the platform decides which parser applies. v02 conflated them.

**Known registry defects:** 9510 Persimmon Tree Rd is absent from `property_master` entirely, and `1851-s-club-solar` occupies a row despite being a project, not a property. Both are fixed in Phase 3.

---

## 4. Scope — the eight real gaps

Ordered as built. Numbers match audit §4.

### Phase 0 — Light up the AR feed *(gap 1)*

The highest value per unit of work in the entire project: an existing, tested, adversarially-reviewed pipeline that has never been run.

1. Create the inbox (`data/ar/inbox`, `AR_INBOX`-configurable).
2. Deliver the eight `Business/A.R. Reports/*.xlsx` files (dated 7.15.2026) into it. Copy, never move — the OneDrive business folder is read-only under Invariant 5.
3. **Dry-run first** (ruled 2026-08-16): point `AR_INBOX` and `SNAPSHOT_PATH` at worktree copies. Inspect the review queue and every proposed tenant→lease attribution before any live write. The importer's own docstring warns that `Brain` loads `overlay.json` once at construction and never re-reads it, so a live run while a dev server is up can be silently reverted for that process's whole lifetime.
4. Fix what the first real run breaks. Expected friction: the eight files are per-property xlsx, and format detection was written against Yardi/AppFolio *aging* exports — a delinquency export may parse as recognized-but-unsupported.
5. Verify against the independent `_pipeline` result: **$204,788.48** total, **$172,672.41** active, **31 tenants**, 0 unmapped, from the same eight files on 2026-07-17. Two independent implementations agreeing on the total is the strongest available correctness signal; a divergence is a finding, not a rounding difference.
6. Schedule via supervised `create_scheduled_task` only — never registry JSON splicing.

**Exit:** `tenantArrears` non-empty, `arBalances[]` populated, `arrears-*` and `ar-stale` conditions live, brief Section 4c showing real collections data, and a scheduled task keeping it that way.

**This phase requires no new detectors, no new parsers, and no external dependency.**

### Phase 1 — Make the output trustworthy *(gaps 3, 4, 5)*

- **Convention ledger** (`server/pm/conventions.json`) — definition epochs per derived metric, seeded with the 2026-08-01 vacancy restatement (occupancy 98.6% → 94.9%, definitional) and the three coexisting SF denominators (513,761 / 513,158 / 512,258). Diffs compare within an epoch only; across a boundary the engine reports "series break — definitional" once, with both bases, then goes quiet. `anomaly-floor.ts` would not have caught the 08-01 event — it was a restatement, not a mass removal — so this is a genuinely new layer, not a duplicate.
- **Tripwire thresholds calibrated from data** (ruled 2026-08-16) — replay the snapshot archive with the 08-01 event as the known positive that must trip classification and ordinary weekly runs as the negatives that must not. Thresholds live in `conventions.json` and are re-derivable from the manifest, never inherited as magic numbers.
- **Exception report artifact** — run manifest `{runId, inputs (file + mtime + rowCount), conservationIdentity, sectionsRendered, coverageGaps}`; three-state rendering where every section is exactly one of `CLEAN (checked N)` / `EXCEPTIONS (…)` / `COVERAGE GAP (reason)` with **no code path producing an empty section**; per-property coverage line naming checks run, not applicable, and unverifiable. Output to Notion Ops Hub + `ggoldberg@oxfordra.net` only.
- **Outside-in probe** — a small task on a *different fleet* verifying a dated artifact exists in Notion Ops Hub with a `data_through` watermark inside tolerance. Shares no code, no repo, no failure domain with the engine. The broker OM pipeline was dead for 12 days because its own error channel could not report its own outage; this probes the output, not the logs.
- **Distinct exit codes** — ran-clean / ran-with-exceptions / input-missing-or-stale / internal-error. A generic exit 1 buries the cause.

### Phase 2 — PM rent-roll ingestion *(gap 2)*

The one thing v02 identified correctly. No billed-rent feed exists in either system, so lease-vs-billed leakage has never been checkable — the `escalation-*` condition can only establish that an escalation date passed with rent unchanged in ORA's own records. It finds *tracking* misses, not *billing* misses, and must label itself accordingly until this phase lands.

Requires rent-roll exports from five PM firms. **Drafted for Gabriel to send; never sent by the engine** (Invariant 1). Parsers extend the existing `server/ar/` format-detection pattern — recognized-but-unsupported returns an explicit reason rather than a plausible-but-wrong number.

External dependency on five counterparties. Phases 0, 1, and 3 do not block on it.

### Phase 3 — Self-managed regime and registry repair *(gaps 6, 7)*

- Add 9510 Persimmon Tree Rd to `property_master`; resolve `1851-s-club-solar`'s row.
- Fix the `mapping-cache.ts` collision hazard documented in its own source: `cacheKey()` keeps entity suffixes because `normalizeTokens()` would collapse `Apex LLC` and `Apex Inc`, and a cache hit skips review entirely — silently mis-attributing one tenant's delinquency to another across runs.
- For the three self-managed properties there is no PM feed; counterparty truth becomes payment and compliance evidence: expected rent vs actual receipts, plus an obligation calendar (escalation dates, option/notice windows, COI renewals, tenant-paid taxes/insurance) each carrying a **proof-of-performance** expectation. "Tenant handles it" without evidence reports as UNVERIFIED, never clean.

**Prerequisite (ruled 2026-08-16):** the QuickBooks feed is 2024-annual across 8 of 14 properties with 2 rows unmapped to a `propertyId`. The fix is a refreshed export via the existing SharePoint CSV path — monthly P&L by property for 2025–2026, plus mappings for `1851 S Club — Solar` and `FVC — Fairground Village Center / Sepich Portfolio`. Internal ask, no external dependency.

### Deferred — CAM under-recovery *(gap 8)*

No recovery-type or pro-rata-share fields exist anywhere in the lease schema. Ruled deferred 2026-08-16. Whatever surface reports coverage renders `COVERAGE GAP — no recovery-type or pro-rata-share fields in source` every run so the absence stays visible.

---

## 5. Acceptance gate

Applies at Phase 1 exit. False-positive criteria are **blocking** (ruled 2026-08-16).

Replayed against a fixture corpus built from documented incidents, the engine must:

- **(a)** flag the Suburan name mismatch and its $20,457 balance
- **(b)** flag the 5 wrong `ora-pm` critical-date rows and the omitted CJ's Tint expiry
- **(c)** flag both 2026 holdovers
- **(d)** emit **zero** deterioration alarms on the 2026-08-01 vacancy convention change
- **(e)** emit **zero** "no action taken" claims across the six delinquency tenants

**Failing (d) or (e) fails the phase even if (a)–(c) pass.** A precise engine that cries wolf is worse than no engine.

Phase 0 has its own narrower gate: the `_pipeline` cross-check in §4 Phase 0 step 5.

---

## 6. Suppression rules — encoded non-exceptions

Each carries its citation so a later session cannot re-derive the wrong inference.

- **Static 90+ AR balance ≠ no collection action.** Collection status lives in Outlook threads no export can see. When `Lease Default / Cure Status` is null, report *"collection status not recorded — verify in Outlook"*. Null = unknown, never no-action. (`reference_delinquency_report_collection_status_blindspot.md` — the inferred version was wrong on 4 of 6 tenants.)
- **Negative entity cash balance ≠ distress.** The Cash Data tab covers ORA-held accounts only; negatives are usually property-tax timing covered by PM-held funds. (`reference_cash_data_excludes_pm_held_accounts.md`)
- **Retired-row filtering splits on the `Row Retired` field, never the ⛔ARCHIVED title prefix.** (`reference_tenant_db_completeness_gap.md`)
- **Vacate date ≠ contract expiry.** Both can be correct. Flag the state; do not reconcile the dates to each other. (`tenant_columbus_suburban_default_2026-07-28.md`)
- **A PARKED or ruled state behaving as instructed is never Critical.**
- **Severity is a judgment per instance, never a count.** The report headlines top items with dollars, never `N exceptions found`. (`reference_cc_snapshot_refresh_dq_flag_alert_is_count_not_severity.md`)

---

## 7. Invariants and discipline

- **Workbook is read-only.** Access via `portfolio.json` / snapshot lineage or `read_only=True`. An openpyxl re-save writes absolute comment rel targets that crash every exceljs consumer — both snapshot tasks and the mirror deploy, where it surfaces only as `build:mirror failed (1)` — and strips cached values from ~14,700 formula cells. Never "normalize the rels and carry on." Any future workbook write routes through Excel COM exclusively.
- **`Business/` OneDrive folders are read-only** (Invariant 5). AR files are copied into the inbox, never moved.
- **No external sends.** PM and tenant correspondence is drafted, never sent (Invariant 1).
- **Output routing:** Notion Ops Hub + `ggoldberg@oxfordra.net` only. Send path is Outlook COM (`_shared/send-via-outlook.ps1`).
- **Scheduling** via supervised `create_scheduled_task` only.
- **Single-writer:** all work in `feat/p4-pm-reconciliation`. Re-check `git status` / `git log -1` immediately before any commit, not only at session start.
- **`_pipeline` keeps running untouched** until Phase 0 passes its cross-check, then gets a README pointer to its replacement. No deletions — archive only.
- **`ora-pm` critical-dates feed** is consumed as a reconciled input through Phases 0–3 so its known 5-of-10 error rate surfaces rather than being inherited; it retires only once superseded, following the CC/MCP order (`delete_scheduled_task` first, then archive).

---

## 8. Decision record

Eight decisions ruled by Gabriel 2026-08-16, plus two re-scope rulings the same day. Recorded so implementation does not relitigate them.

| # | Decision | Ruling | Status after audit |
|---|---|---|---|
| 1 | Value estimate | Withdraw pending re-derivation | Stands — see §9 |
| 2 | AR parser language | Port Python → TypeScript | **Moot.** TS parsers already exist; the Python copy is the redundant one |
| 3 | Acceptance gate | False-positive criteria block | Stands — §5 |
| 4 | Tripwire thresholds | Calibrate from snapshot history | Stands — Phase 1 |
| 5 | Alias-ledger authority | R1/R2 autonomous, R3/R4 propose | **Already implemented** in `partition-confidence.ts` |
| 6 | `ora-pm` feed | Reconcile as input, retire at Phase 4 | Stands — §7 |
| 7 | CAM under-recovery | Leave deferred, render COVERAGE GAP | Stands — §4 |
| 8 | QuickBooks blocker | Request monthly 2025–2026 export | Stands — Phase 3 |
| 9 | Re-scope method | Full capability audit before spec v03 | Done — audit committed |
| 10 | First importer run | Dry-run in worktree before live write | Stands — Phase 0 step 3 |

---

## 9. Value

v02's estimate is withdrawn and not replaced. Its largest line was CAM under-recovery, now confirmed unbuildable; its escalation line measured a tracking-miss population, not the billing-miss population the dollar figure implied.

What the audit establishes instead is concrete and does not require an estimate: **$204,788.48 of accounts receivable — $172,672.41 of it active across 31 tenants — is invisible to the Command Center, the daily brief, and every downstream report, because an inbox directory was never created.** Phase 0 makes it visible without building anything new.

The binding constraint Gabriel named is ops/AM bandwidth, not expense reduction. The current substitute for this engine is hand-auditing PM reports after they have already misled someone. That is the cost being removed.

---

## 10. Method note

Three successive discoveries — `_pipeline`, then `server/ar/`, then `conditions.ts` — each invalidated part of an already-approved plan. The failure was writing a spec from a memory-and-doc reading of the system instead of from the system. The standing rule (`feedback_absence_claims_need_verification_before_building.md`) was cited *in* v01 and not applied to v01's own claims.

Any future spec in this repo starts with a capability audit.

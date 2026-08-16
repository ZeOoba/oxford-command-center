# P4 — Third-Party PM Data Reconciliation / Exception Engine

**Design spec v02** · 2026-08-16 · Approved by Gabriel Goldberg 2026-08-16
Supersedes: P4 Implementation Plan v01 (planning session, 2026-08-16 — never committed)

---

## 1. Purpose

Reconcile property-manager-supplied data against ORA's own lease source of truth and surface **exceptions only**, at a false-positive rate low enough that the report keeps getting read.

Autonomy frame (ratified 2026-08-16): **act on internal** — pulls, reconciliation, internal reporting. **Draft on external** — anything addressed to a tenant or a PM firm.

---

## 2. What changed from v01, and why

v01 was written without reading `Business/Master Lease Database/_pipeline/`. That directory contains a working reconciliation pipeline, last built **2026-07-17T19:01:37**, which already solves the component v01 identified as the hard problem.

### 2.1 Verified ground truth

All facts below were read from disk on 2026-08-16. Sources are named so a later session can re-verify rather than re-derive.

**From `_pipeline/output/sync_log.json`:**

| Fact | Value |
|---|---|
| Last build | 2026-07-17T19:01:37 |
| AR total | $204,788.48 |
| AR active / legacy | $172,672.41 / $71,930.20 |
| AR tenants | 31 |
| Unmapped records | 0 |
| Rent-roll parser syncs (`yardi`, `appfolio`, `rentmanager`, `qb`) | **all `null`** |

**From `_pipeline/config/`:** `tenant_aliases.json` holds 6 confirmed tenant aliases — including `"Columbus Suburan Construction" → "Columbus Suburban Construction"`, the exact failure case v01 proposed building a ledger to catch. `property_map.json` holds 36 address aliases plus a property→market map, covering `2207 Nothwood Drive Bldg A`, `29000inf`, `eastgate`, and the Northwood building split.

**From `_pipeline/output/TENANTS.json`:** 145 rows, `src: rentroll_master` on 142 and `manual` on 3 — i.e. April bootstrap data, never refreshed from a PM rent roll.

**From `data/snapshots/portfolio.json`** (`asOf: 2026-08-14`, generated 2026-08-16T18:51):

| Field | State |
|---|---|
| `arBalances` | `[]` — empty |
| `tenantArrears` | `{}` — empty |
| `leases` | 138 rows; `escalationDate` 137/138, `escalationPct` 130/138, `leaseEnd` 137/138 |
| `leases[].status` | 128 Active · 5 Expiring Soon · 4 Expired · 1 Unknown |
| `insurance` | 25 policies across all 14 properties — 11 Current · 5 Renewing Soon · 4 Expired · 4 Renew Now · 1 Cancelled |
| CAM / recovery fields | **absent from the schema entirely** |
| `quickbooks.properties` | 8 of 14 properties; 2 with `propertyId: null`; single `month: "2024"` bucket |

### 2.2 Corrections to v01

1. **`portfolio-anomaly-scout` was misjudged.** v01 cited its "Yardi, AppFolio, Rent Manager" platform list as evidence of generic boilerplate. Those are ORA's three actual platforms, confirmed by `_pipeline/drops/ar_{yardi,appfolio,rentmanager}/` and the parser filenames. Its `~600K SF` figure remains wrong (actual ~513K SF).

2. **The gap is the rent-roll side, not entity resolution.** AR feeds are parsed and matched with zero unmapped records. PM-*billed rent* has never been ingested. Lease-vs-billed leakage detection has never had a left-hand side — which is why nothing caught it.

3. **Two disconnected AR paths.** `_pipeline` computed $204,788.48 of AR on 07-17 and feeds a standalone HTML dashboard. The Command Center's `arBalances`/`tenantArrears` are empty. Neither knows about the other.

4. **The v01 prize estimate must be re-based, not carried forward.** Its largest line was CAM under-recovery ($10K–40K/yr); CAM is confirmed unbuildable for lack of source fields. See §9.

### 2.3 Live defect to fix during the port

`_pipeline/output/TENANTS.json` violates its own documented schema. `_pipeline/README.md` declares `r` = monthly rent and `m` = market (`MD|OH|MO|…`). Actual data: `r` = annual rent per SF, `m` = monthly rent. Verified by `sf × r ÷ 12 == m` in 140/145 rows, and `m` typed float in **145/145** rows — never a market string.

Consequence: any consumer filtering by market silently matches nothing; any consumer reading `r` as monthly rent understates by roughly 833×. Fixed in §4.1 by replacing the one-letter keys with explicit names.

---

## 3. Regime registry

Confirmed by Gabriel 2026-08-16.

**Self-managed single-tenant (4)** — no PM feed exists; reconciliation is redefined per §5.6:

- 55 New Plant Ct, Owings Mills MD
- 401 Sunburst Hwy, Cambridge MD
- 7658 Fishel Dr N, Dublin OH
- 9510 Persimmon Tree Rd, Potomac MD

**Third-party PM (10)** — platform mapping from `_pipeline/drops/` and `sync_log.json` sources:

| Platform | Properties |
|---|---|
| AppFolio | 1100 Rarig · 3034 Westerville · 3540 E 5th · Sepich Portfolio (8 props) · 9620 State Route 350 |
| RentManager | 2203-2207 Northwood |
| Yardi | 29000 Information Lane · 1900 N Broadway + 9050 Red Branch (CRC) |
| Unassigned | 3875-3883 E Livingston Ave — third-party per Gabriel; platform to be identified in Phase 0 |

Note: 9620 State Route 350 appears under `ar_appfolio` sources in `sync_log.json` despite a 2025 Venture Property Management report in its deal folder. Phase 0 confirms the current manager.

Every report carries a per-property coverage line: checks run / not applicable / unverifiable. A property showing no exceptions is never rendered as a bare clean.

---

## 4. Architecture

Home: `oxford-command-center`. Branch `feat/p4-pm-reconciliation`, worktree `.claude/worktrees/p4-pm-reconciliation`.

All new code under `server/pm/`. Six components, each independently testable.

### 4.1 Port layer — `server/pm/ingest/`

Merge `_pipeline/config/tenant_aliases.json` and `property_map.json` into one git-tracked `server/pm/aliases.json` with three namespaces: `tenant`, `property`, `unit`. Confirmed matches persist; the engine never re-fuzzy-matches what a human ratified.

Port the four AR parsers (`ar_appfolio`, `ar_rentmanager`, `ar_yardi`, `qb`) from Python to TypeScript, reusing the repo's existing xlsx path (exceljs, as in `server/workbook/parse.ts`) — one runtime, one test harness, one CI gate.

Output populates the existing-but-empty `arBalances[]` and `tenantArrears{}` in `portfolio.json`.

**Field contract** — replaces the one-letter keys and fixes §2.3:

```
tenantName        string    canonical name after alias resolution
propertyId        string    portfolio.json property id
unit              string    normalized unit label
sf                number    square feet (0 = unknown, never null)
rentPerSfAnnual   number    annual rent per SF
monthlyRent       number    monthly rent, dollars
market            string    MD | OH | MO | IN | KS | WI | TN
leaseStart        string    YYYY-MM-DD
leaseEnd          string    YYYY-MM-DD
arBalance         number?   from PM AR export
arAgeBucket       string?   "0-30" | "31-60" | "61-90" | "90+"
matchRung         string    R1 | R2 | R3 | R4
sourceFile        string    originating export filename
```

`market` is a string by contract and validated as one of the seven values at parse time — the defect in §2.3 must be impossible to reintroduce silently.

### 4.2 Match ladder — `server/pm/resolve.ts`

Per PM record, in order; first hit wins; the rung is recorded on the output row.

1. **R1** — alias ledger hit on (property, unit) or (property, tenant-alias). Deterministic. Pre-seeded from the ported ledger, so Suburan and the 36 property aliases resolve on first run.
2. **R2** — exact normalized (property, unit). Property resolves via the alias table only, never bare-string market guessing (the Northwood Columbus-vs-Salisbury collision). Unit uppercased, punctuation and whitespace stripped, `Suite`/`Ste`/`#`/`Unit` prefixes dropped, compound units (`386+388`, `M & N`) expanded to a set and matched on set overlap.
3. **R3** — (property, fuzzy unit): edit distance ≤ 1 on normalized unit, only when unambiguous within that property.
4. **R4** — (property, fuzzy tenant name) **plus corroboration**: token-set match after stripping legal suffixes, edit distance ≤ 2 per token. A name match alone never suffices — requires SF within 5% or monthly rent within 2%.
5. **UNMATCHED** — §4.3.

Tenant name is never a primary key. When (property, unit) matches but names disagree beyond tolerance, that is its own exception class — possible unrecorded turnover, sublease, or PM typo — not a match failure.

Exceptions built on R4 are presented as weaker evidence than R1/R2, with the rung shown.

### 4.3 Unmatched handling

Silent drops are prohibited by construction.

- **Conservation identity**, asserted every run: `inputRows == matched + unmatched + excluded`, where every excluded row (totals, vacancy blocks) is individually listed. A run that cannot assert this is a **failed run**, not a report with a gap.
- Unmatched PM rows and unmatched ORA-side units each get a mandatory report section, **ranked by dollar value**. A large unmatched balance is itself a 🔴 finding — that is how the Suburan case should have surfaced.
- An unmatched row persisting ≥ 2 runs escalates one severity level.
- Resolution is by human addition to the alias ledger. Additions are internal writes and autonomous-eligible once the workflow is ratified; until then they are proposed in the report.

### 4.4 Detectors — `server/pm/detectors/`

One file per detector, one purpose each.

| Detector | Runnable at Phase 1 | Basis | Default severity |
|---|---|---|---|
| `insurance.ts` | Yes | `portfolio.json.insurance` expiry/status vs today | 🔴 expired with no recorded plan; 🟠 with plan |
| `holdover.ts` | Yes | elapsed-aware: `today > leaseEnd` AND still billing/occupying AND status ≠ Expired | 🔴 |
| `arReconcile.ts` | Yes | parsed AR rows vs lease truth; unmatched ranked by $ | by dollar value; 🔴 above $10K |
| `renewalNotStarted.ts` | Yes | expiry < 9 months, no renewal in workbook + Notion + HubSpot | 🟠; 🔴 inside 90 days |
| `escalation.ts` | **Partial** | ORA-side only until rent rolls land — see below | 🟠; 🔴 ≥$2K/yr or ≥2 cycles |
| `cam.ts` | **No — deferred** | requires recovery-type and pro-rata-share fields that do not exist | n/a |

**`escalation.ts` honesty constraint.** Until PM rent rolls exist, this detector can only establish that an escalation date passed with rent unchanged in ORA's own records. It finds *tracking* misses, not *billing* misses. It must label its own output accordingly and must not imply it checked what the PM billed. When rent-roll ingestion lands (§5.5), it upgrades to a true billed-vs-lease comparison and the label changes.

**`cam.ts` is not silently skipped.** It renders `COVERAGE GAP — no recovery-type or pro-rata-share fields in source` every run, so the absence stays visible.

Severity is a judgment per exception instance — a function of dollar impact, legal/coverage exposure, and match-rung evidence strength. **Never a count.** The report headlines top items with dollars, never `N exceptions found`.

### 4.5 Suppression rules — encoded non-exceptions

Each carries its citation so a later session cannot re-derive the wrong inference.

- **Static 90+ AR balance ≠ no collection action.** Collection status lives in Outlook threads no export can see. When `Lease Default / Cure Status` is null, report *"collection status not recorded — verify in Outlook"*. Null = unknown, never no-action. (`reference_delinquency_report_collection_status_blindspot.md` — the inferred version was wrong on 4 of 6 tenants.)
- **Negative entity cash balance ≠ distress.** The Cash Data tab covers ORA-held accounts only, by design; negatives are usually property-tax timing covered by PM-held funds. (`reference_cash_data_excludes_pm_held_accounts.md`)
- **Retired-row filtering splits on the `Row Retired` field, never the ⛔ARCHIVED title prefix.** (`reference_tenant_db_completeness_gap.md` — the prefix method produced wrong headline numbers in three reports.)
- **Vacate date ≠ contract expiry.** Two different dates can both be correct. Flag the *state*, do not reconcile the dates to each other. (`tenant_columbus_suburban_default_2026-07-28.md`)
- **A PARKED or ruled state behaving as instructed is never Critical.**

### 4.6 False-positive control

The threat model: the 2026-08-01 vacancy-convention change moved reported occupancy 98.6% → 94.9% **by definition, not deterioration**. A naive diff screams; a screaming engine trains its reader to ignore it.

1. **Convention ledger** — `server/pm/conventions.json`, versioned. Per derived metric: definition and effective date. Seeded with the 08-01 vacancy epoch and the three coexisting portfolio-SF denominators (513,761 / 513,158 / 512,258). Diffs compare **within an epoch only**; across a boundary the engine reports "series break — definitional" once, with both bases, then goes quiet.
2. **Change-of-definition tripwire** — a run in which a single field changes on more than 10 lease rows (≈7% of 138), or in which a portfolio aggregate moves more than 2%, triggers classification *before* any alarm: many-small-changes (definitional — one 🟡 "convention change?" asking Gabriel to ratify a new epoch) vs one-big-change (a real event). Both thresholds live in `conventions.json` as `tripwire.rowCount` / `tripwire.aggregatePct` and are tunable without a code change. Generalizes the bulk-field guard that already caught `Months to Expiry` in `tenant_db_snapshot_diff.py`.
3. **Exception state machine** — keyed on business key + class, carrying `NEW | PERSISTING | RESOLVED`. PERSISTING items do not re-headline; they appear in a monthly digest. This is what breaks the cry-wolf cycle.
4. **Time-derived field exclusion** — never diff calendar-recomputed fields (the `Days to Expiration` class: 267-of-298 false diffs). Every detector's test suite includes an advance-the-clock case; a same-day rerun is not a valid test.

### 4.7 Instrumentation — outside-in

Design constraint: the broker OM pipeline was dead in production for 12 days because its own error channel could not report its own outage.

1. **Artifact-existence probe on a different fleet** — a separate small task verifies a dated exception-report artifact exists in Notion Ops Hub and that its `data_through` watermark is within tolerance. Shares no code, no repo, no failure domain with the engine. Probes the *output*, not the engine's logs.
2. **`automation-health-monitor` enrollment** — second line, not first; a task can fail in ways that still look like it ran.
3. **Run manifest** — every run emits `{runId, inputs (file + mtime + rowCount), conservationIdentity, sectionsRendered, coverageGaps}`. A report missing its manifest is malformed by definition and the probe alarms on it.
4. **Three-state rendering, mechanically enforced** — every section renders exactly one of `CLEAN (checked N records)` / `EXCEPTIONS (…)` / `COVERAGE GAP (reason)`. There is no code path producing an empty section. A zero that could mean "couldn't look" is a failure.
5. **Distinct exit codes** — ran-clean / ran-with-exceptions / input-missing-or-stale / internal-error. A generic exit 1 buries the cause.

---

## 5. Phasing

### Phase 0 — Registries and coverage report
Regime registry (§3), feed expectation ledger (which feed, from whom, what cadence), unit registry from the sanctioned read-only workbook path, alias ledger port, convention ledger seed. Identify 3875-3883 E Livingston's platform and confirm 9620's current manager.

Deliverable: a one-page coverage report — per property: regime, expected feeds, last-received date, verified/unverified. Answers "what PM data do we actually have and how stale is it," which no current artifact answers. Verifiable by inspection.

### Phase 1 — Port + ORA-side detectors
Port layer (§4.1), match ladder (§4.2), unmatched handling (§4.3), and the four Phase-1-runnable detectors plus `escalation.ts` in ORA-side-only mode. Read-only throughout.

Exit gate: the acceptance test in §6.

### Phase 2 — Rent-roll ingestion (runs parallel to Phase 1)
Build the four stub rent-roll parsers against a written export spec. **Draft** export-request emails to the three PM firms for Gabriel to send — Invariant 1; the engine never sends to a counterparty.

On arrival, `escalation.ts` upgrades to true billed-vs-lease and its self-label changes.

### Phase 3 — Self-managed regime
For the four self-managed properties there is no PM feed; counterparty truth becomes payment and compliance evidence:

- **Lease-vs-cash** — expected rent from lease terms vs actual receipts. Escalation enforcement is fully checkable here: both the lease and the deposit stream are ORA-visible.
- **Obligation calendar** — escalation effective dates, option/notice windows, COI renewals, and tenant-paid obligations (taxes/insurance where the lease shifts them), each with a **proof-of-performance** expectation. "Tenant handles it" without evidence is an *inferred* zero-exposure and reports as UNVERIFIED, never clean.

**Known blocker:** the QuickBooks feed cannot support this as it stands — 8 of 14 properties, 2 unmapped to a `propertyId`, single `month: "2024"` bucket. Monthly, current-year data is a prerequisite. Phase 3 does not start until that is resolved.

### Phase 4 — Scheduling and absorption
Register via supervised `create_scheduled_task` only — never registry JSON splicing. Natural slot is weekly, after the Monday `ora-master-workbook-ingest` refresh; PM exports are at best biweekly, so daily would mostly re-report.

Rewrite `portfolio-anomaly-scout` to dispatch this engine's report (its description finally becomes true) and correct its ~600K SF figure. Wire the exception report into `ora-am-brief` as a *cited source*, respecting its no-independent-re-derivation doctrine. Point `_pipeline/README.md` at its replacement.

---

## 6. Acceptance gate (Phase 1 exit)

Replayed against a fixture corpus built from documented incidents, the engine must:

- **(a)** flag the Suburan name mismatch and its $20,457 balance
- **(b)** flag the 5 wrong `ora-pm` critical-date rows and the omitted CJ's Tint expiry
- **(c)** flag both 2026 holdovers
- **(d)** emit **zero** deterioration alarms on the 08-01 vacancy convention change
- **(e)** emit **zero** "no action taken" claims across the six delinquency tenants

**Failing (d) or (e) fails the phase even if (a)–(c) pass.** A precise engine that cries wolf is worse than no engine.

---

## 7. Invariants and discipline

- **Workbook is read-only.** Access via `portfolio.json` / snapshot lineage or `read_only=True`. An openpyxl re-save writes absolute comment rel targets that crash every exceljs consumer — both snapshot tasks and the mirror deploy, where it surfaces only as `build:mirror failed (1)` — and separately strips cached values from ~14,700 formula cells. The engine never proposes "normalize the rels and carry on." Any future workbook write routes through Excel COM exclusively.
- Phase 0 health probes include the existing `maintenance/workbook-integrity-probe.py` verdict, so the engine refuses to reconcile against a corrupt source rather than emitting confident garbage.
- **Output routing:** Notion Ops Hub page + email to `ggoldberg@oxfordra.net` only. Send path is Outlook COM (`_shared/send-via-outlook.ps1`).
- **No external sends.** Tenant- or PM-facing follow-up is drafted, never sent (Invariant 1).
- **Single-writer:** all work in the `feat/p4-pm-reconciliation` worktree. Re-check `git status` / `git log -1` immediately before any commit or push, not only at session start.
- **`_pipeline` keeps running untouched** until the port passes §6, then gets a pointer to its replacement. No deletions — archive only.

---

## 8. Explicitly out of scope

- CAM under-recovery detection — deferred until recovery-type and pro-rata-share fields exist (§4.4).
- Any write to the Master Workbook.
- Any write to non-Claude Oxford OneDrive business folders, including `_pipeline`, beyond a README pointer at Phase 4.
- Retiring the `ora-pm` critical-dates feed — that ruling is Gabriel's and still open.

---

## 9. Value estimate — deliberately not carried forward

v01 estimated ~$30K–$100K/yr identified leakage, midpoint ~$55K. That estimate is **withdrawn pending Phase 0**, for two reasons:

1. Its largest single line was CAM under-recovery ($10K–40K/yr), now confirmed unbuildable for lack of source fields.
2. Its escalation line was derived from a *tracking*-miss proxy (18 of 77 Notion expiration dates one cycle behind). Until rent rolls land, the engine measures the same tracking-miss population — not the billing-miss population the dollar figure implied.

Phase 0 re-derives the base from the Master Workbook: portfolio annualized rent, escalation-clause coverage, and recoverable OpEx pool. The estimate is rebuilt from those figures before any spend is justified against it.

**The framing that survives.** Gabriel ranked expense reduction 4th of 4 priorities and named ops/AM bandwidth as the binding constraint. The current substitute for this engine is hand-auditing PM reports *after* they have already misled someone — the 07-24 Outlook audit of six tenants, the 08-04 row-by-row critical-dates cross-check, the Suburan forensics. The recoverable asset is those hours plus the credibility of every downstream report. That likely exceeds the direct NOI recovery, and it is the reason to build.

---

## 10. Open items carried into implementation

| # | Item | Blocks |
|---|---|---|
| 1 | CAM/OpEx source of record per property — PM statements, QB Desktop, or workbook Property NOI tab | `cam.ts` |
| 2 | QuickBooks monthly + current-year export path | Phase 3 |
| 3 | `ora-pm` critical-dates feed: keep as a reconciled input, or retire as superseded | Phase 4 wiring |
| 4 | Whether alias-ledger additions for R1-corroborated exact matches may be committed autonomously | §4.3 automation |
| 5 | 3875-3883 E Livingston platform; 9620 State Route 350 current manager | Phase 0 completion |

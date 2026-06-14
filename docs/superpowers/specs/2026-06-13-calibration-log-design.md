# Score-vs-Outcome Calibration Log — design (the 40-year feedback loop)

**Spec ID:** `docs/superpowers/specs/2026-06-13-calibration-log-design.md`
**Surface:** `C:\Users\Owner\oxford-command-center` (React + Hono + better-sqlite3 warehouse)
**Status:** design — Phase 1 (scaffold) ready to implement
**Author:** Principal Architect, Command Center
**Depends on:** PFI architecture (`2026-06-12-property-financial-intelligence-architecture.md`), `server/warehouse/{scores,anomalies,benchmarks,growth,drivers}.ts`, `src/contracts/warehouse.ts`

---

## 0. Thesis

The warehouse already renders judgments — `scoreProperties()` emits `healthBand`, `attentionBand`, `capitalAction` with `reasons[]`; `detectAnomalies()` emits severity-graded flags. Today those judgments are **ephemeral**: recomputed on every read (`GET /api/warehouse/analytics/scores`), never persisted, never checked against reality. We cannot answer the only question that compounds over 40 years: *was the system right?*

This feature records every verdict at the moment it is made, freezes the exact ledger state that produced it (`inputs_version`), and later records what actually happened. The gap between predicted and realized is the firm's accumulating judgment asset. Over 40 years, as AUM compounds from ~$60M toward $700–800M, the calibration log is what lets the platform's *judgment* compound alongside the *capital* — and it is what keeps weight changes evidence-backed rather than vibes-backed.

**Design invariants (inherited from the warehouse audit philosophy):**
- **Append-only / immutable.** A verdict row, once written, is never UPDATEd or DELETEd. Outcomes attach via a separate resolution row, never by mutating the prediction (mirrors `is_active` supersede + `data_quality_issues.resolved_at`, never hard delete).
- **Deterministic.** Logging is a pure function of `(verdict, inputs_version)`. Re-running the same snapshot writes the identical logical row (dedup key prevents doubles).
- **Fail-open.** Calibration logging NEVER blocks a score read, an import commit, or a snapshot. A logging failure writes a `data_quality_issues` row and proceeds. The feature is observational; it must never become a governor.
- **Weights are proposed, never governors.** `INTEL_CONFIG.healthWeights` are explicitly "PROPOSED — calibrate with Gabriel." This feature produces *evidence* for changing them. It NEVER auto-applies a change. The DSCR 1.25 / LTV 40 governors are out of scope entirely — they are not "scores," and nothing here touches them.

---

## 1. SQLite schema

Added to the `SCHEMA` string in `server/warehouse/db.ts` (same migration mechanism: idempotent `CREATE TABLE IF NOT EXISTS`, runs on every `openWarehouse()`). No existing table is altered.

### 1.1 `inputs_version` — what it is and where it comes from

There is no `inputs_version` concept in the code today; this spec defines it. It is the reproducibility key: given an `inputs_version`, you can deterministically re-derive the exact `PeriodMetrics[]` and config that produced a verdict.

`inputs_version` is a **content hash** (sha256, hex, first 16 chars) over a canonical JSON of:
1. The set of active ledger contributions for the scored subjects — concretely, `MAX(import_batches.id)` among committed/active batches plus `COUNT(active ledger_entries)` and the `MAX(rowid)` of active rows (cheap, monotonic, captures supersede events).
2. The `INTEL_CONFIG` object (weights, bands, thresholds) — so a weight re-ratification changes the version even with identical ledger data.
3. The engine `code_version` (git short SHA at boot, injected from the build; falls back to `'dev'`).

```
calibration_inputs_version (
  inputs_version    TEXT PRIMARY KEY,        -- sha256(...)[:16]
  ledger_fingerprint TEXT NOT NULL,          -- max(import_id)|count|max(rowid) of active rows
  config_hash       TEXT NOT NULL,           -- sha256 of canonical INTEL_CONFIG JSON
  code_version      TEXT NOT NULL,           -- git short sha or 'dev'
  config_json       TEXT NOT NULL,           -- the FULL INTEL_CONFIG snapshot, verbatim
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
)
```

Storing `config_json` verbatim means a calibration analyst in 2046 can read the literal weights that produced a 2026 verdict without archaeology against git history. This is the cheapest possible "reproducible ledger state" — we do not snapshot the whole ledger per verdict (14 properties × decades would still be small, but the fingerprint + supersede log already make ledger state reconstructable, and ledger rows are themselves append-only).

### 1.2 `calibration_log` — the verdict (prediction) row

```
calibration_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,

  -- WHO/WHAT was judged
  subject_kind      TEXT NOT NULL,           -- 'property'|'tenant'|'loan'|'deal'|'portfolio'|'pm'
  subject_id        TEXT NOT NULL,           -- property_master.id, tenant id, loan id, deal id, 'PORTFOLIO', pm name

  -- WHAT KIND of verdict
  verdict_kind      TEXT NOT NULL,           -- see §2.1 enum
  verdict_engine    TEXT NOT NULL,           -- 'scores'|'anomalies'|'benchmarks'|'growth'|'drivers'|'refi'|'acquisition'|'forecast'

  -- THE PREDICTION
  predicted_band    TEXT,                    -- categorical verdict: 'concern'|'red'|'disposition-candidate'|'critical'|... (null if purely numeric)
  predicted_value   REAL,                    -- numeric prediction: health 0..100, refi score, anomaly move %, forecast NOI (null if purely categorical)
  predicted_unit    TEXT,                    -- 'score-0-100'|'pct-change'|'usd'|'usd-per-sf'|'band' — interpretation of predicted_value
  confidence        REAL,                    -- 0..1; deterministic proxy (§2.3); null when engine has none yet
  direction         TEXT,                    -- 'up'|'down'|'flat'|'n/a' — the directional claim being made (for hit-rate on direction)
  reasons_json      TEXT NOT NULL DEFAULT '[]', -- the reasons[] array verbatim (already produced by buildReasons())

  -- WHEN / REPRODUCIBILITY
  as_of_period      TEXT NOT NULL,           -- the metrics period the verdict was computed ON ('YYYY' or 'YYYY-MM')
  horizon_periods   INTEGER,                 -- intended evaluation horizon in periods (e.g. 1 = next full year); null = open-ended
  inputs_version    TEXT NOT NULL REFERENCES calibration_inputs_version(inputs_version),
  emitted_at        TEXT NOT NULL DEFAULT (datetime('now')),
  emitted_by        TEXT NOT NULL,           -- 'commit:<importId>'|'recompute'|'snapshot:<taskId>'|'manual:<user>'

  -- IMMUTABLE DEDUP KEY — one logical verdict per (subject, kind, as_of, inputs_version)
  dedup_key         TEXT NOT NULL UNIQUE
                    -- = subject_kind|subject_id|verdict_kind|as_of_period|inputs_version
)
;
CREATE INDEX IF NOT EXISTS idx_callog_subject ON calibration_log(subject_kind, subject_id, verdict_kind);
CREATE INDEX IF NOT EXISTS idx_callog_asof   ON calibration_log(as_of_period, verdict_kind);
CREATE INDEX IF NOT EXISTS idx_callog_open   ON calibration_log(verdict_kind, as_of_period); -- for "what's unresolved"
```

The `dedup_key UNIQUE` constraint is what makes logging **deterministic and idempotent**: re-running the same snapshot against the same `inputs_version` produces the same key → `INSERT OR IGNORE` is a no-op. A new verdict is logged only when the subject, the verdict kind, the as-of period, OR the inputs_version changes — i.e. genuinely new information or a genuinely new judgment.

### 1.3 `calibration_outcome` — the realized result (back-filled later)

Separate table so the prediction row stays immutable. One verdict may accrue multiple outcome observations over time (e.g. a disposition-candidate scored at +1yr and again at +3yr); the *resolution* is the analyst- or rule-blessed one (`is_resolution = 1`).

```
calibration_outcome (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  calibration_id    INTEGER NOT NULL REFERENCES calibration_log(id),

  -- WHAT ACTUALLY HAPPENED
  realized_band     TEXT,                    -- the realized categorical state, same vocabulary as predicted_band
  realized_value    REAL,                    -- the realized metric (same unit as predicted_unit)
  realized_unit     TEXT,                    -- echoes predicted_unit; explicit for safety
  outcome_period    TEXT NOT NULL,           -- the period the realized metric is measured AT
  horizon_actual    INTEGER,                 -- actual periods elapsed prediction→outcome (may differ from intended)

  -- SCORING THE VERDICT
  hit               INTEGER,                 -- 1 hit / 0 miss / null = not scoreable (categorical match or directional)
  abs_error         REAL,                    -- |realized_value - predicted_value| in predicted_unit (numeric verdicts)
  brier_component   REAL,                    -- (confidence - outcome01)^2 where outcome01∈{0,1} (probabilistic verdicts)

  -- TREATMENT EFFECT — was the firm's hand on the scale? (§5)
  action_taken      TEXT NOT NULL DEFAULT 'unknown', -- 'none'|'acted-aligned'|'acted-counter'|'unknown'
  action_detail     TEXT,                    -- free text / link to the action (capex, refi, disposition, lease push)
  treatment_note    TEXT,                    -- why this outcome is/ isn't a clean test of the verdict

  -- PROVENANCE
  resolved_by       TEXT NOT NULL,           -- 'auto:next-period'|'auto:disposition'|'manual:<user>'
  resolution_basis  TEXT NOT NULL,           -- 'realized-noi-trend'|'actual-disposition'|'refi-closed'|'analyst-judgment'
  is_resolution     INTEGER NOT NULL DEFAULT 0, -- 1 = the blessed scoring observation for this verdict
  resolved_at       TEXT NOT NULL DEFAULT (datetime('now')),
  inputs_version    TEXT REFERENCES calibration_inputs_version(inputs_version) -- the data state that revealed the outcome
)
;
CREATE INDEX IF NOT EXISTS idx_outcome_callog ON calibration_outcome(calibration_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_resolution
  ON calibration_outcome(calibration_id) WHERE is_resolution = 1; -- at most one blessed resolution per verdict
```

Nothing is ever deleted. A superseded resolution flips `is_resolution = 0` and a new row is inserted with `is_resolution = 1` (partial unique index enforces "at most one live resolution," mirroring the supersede pattern in `actions.ts`).

---

## 2. Zod contracts (`src/contracts/warehouse.ts`)

Appended to the existing file, in the established style (`z.enum`, `z.infer`, exported type alongside schema). These are the validation boundary for the `/calibration` routes and the snapshot writer.

```ts
// ── Calibration log (the 40-year feedback loop) ───────────────────────────
export const SubjectKind = z.enum(['property','tenant','loan','deal','portfolio','pm']);
export const VerdictKind = z.enum([
  'health-band','attention','capital-action','anomaly',
  'refi-score','acquisition-score','forecast',
]);
export const VerdictEngine = z.enum([
  'scores','anomalies','benchmarks','growth','drivers','refi','acquisition','forecast',
]);
export const PredictedUnit = z.enum(['score-0-100','pct-change','usd','usd-per-sf','band']);
export const ActionTaken   = z.enum(['none','acted-aligned','acted-counter','unknown']);

export const InputsVersionSchema = z.object({
  inputsVersion: z.string().length(16),
  ledgerFingerprint: z.string().min(1),
  configHash: z.string().min(1),
  codeVersion: z.string().min(1),
  configJson: z.string().min(2),            // serialized INTEL_CONFIG
  createdAt: z.string().optional(),
});
export type InputsVersion = z.infer<typeof InputsVersionSchema>;

export const CalibrationVerdictSchema = z.object({
  subjectKind: SubjectKind,
  subjectId: z.string().min(1),
  verdictKind: VerdictKind,
  verdictEngine: VerdictEngine,
  predictedBand: z.string().nullable(),
  predictedValue: z.number().finite().nullable(),
  predictedUnit: PredictedUnit.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  direction: z.enum(['up','down','flat','n/a']).default('n/a'),
  reasons: z.array(z.string()).default([]),
  asOfPeriod: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/),
  horizonPeriods: z.number().int().positive().nullable(),
  inputsVersion: z.string().length(16),
  emittedBy: z.string().min(1),
}).refine(v => v.predictedBand !== null || v.predictedValue !== null, {
  message: 'a verdict must carry a band, a value, or both',
});
export type CalibrationVerdict = z.infer<typeof CalibrationVerdictSchema>;

export const CalibrationOutcomeSchema = z.object({
  calibrationId: z.number().int().positive(),
  realizedBand: z.string().nullable(),
  realizedValue: z.number().finite().nullable(),
  realizedUnit: PredictedUnit.nullable(),
  outcomePeriod: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/),
  horizonActual: z.number().int().nonnegative().nullable(),
  hit: z.union([z.literal(0), z.literal(1)]).nullable(),
  absError: z.number().nonnegative().nullable(),
  brierComponent: z.number().min(0).max(1).nullable(),
  actionTaken: ActionTaken.default('unknown'),
  actionDetail: z.string().nullable(),
  treatmentNote: z.string().nullable(),
  resolvedBy: z.string().min(1),
  resolutionBasis: z.string().min(1),
  isResolution: z.boolean().default(false),
  inputsVersion: z.string().length(16).nullable(),
});
export type CalibrationOutcome = z.infer<typeof CalibrationOutcomeSchema>;
```

### 2.1 Verdict kind → engine map (what each row means)

| `verdict_kind`     | source engine (`server/warehouse/…`)          | predicted_band                         | predicted_value / unit          | natural horizon |
|--------------------|-----------------------------------------------|----------------------------------------|---------------------------------|-----------------|
| `health-band`      | `scores.ts` → `PropertyScore.healthBand`      | excellent/good/watch/concern           | `health` / score-0-100          | 1 yr            |
| `attention`        | `scores.ts` → `attentionBand`                 | green/yellow/orange/red                 | — / band                        | 1 yr            |
| `capital-action`   | `scores.ts` → `capitalAction`                 | invest/hold/monitor/disposition-cand.  | — / band                        | 1–3 yr          |
| `anomaly`          | `anomalies.ts` → `AnomalyFlag`                | severity (low…critical) + `kind`       | `metricValue` / pct-change      | 1 yr            |
| `refi-score`       | (future debt engine; PFI roadmap)             | refi-now/hold/watch                     | DSCR-headroom or score          | to maturity     |
| `acquisition-score`| acquisition-underwriting scorecard (external) | PURSUE/PASS/WATCH                       | scorecard 0–100                 | 1–5 yr          |
| `forecast`         | `growth.ts` (CAGR/since-acquisition) + future | — / band                                | forecast NOI or NOI/SF / usd…   | 1–N yr          |

Phase 1 logs the three columns the `scores` engine already produces (`health-band`, `attention`, `capital-action`) plus `anomaly`. `refi-score`, `acquisition-score`, and `forecast` are reserved kinds — the schema accepts them now so those engines, when built, write into the same table with zero migration.

### 2.2 What to log, and WHEN (cadence)

Three emission triggers, each tagged in `emitted_by`:

1. **On commit** (`emitted_by = 'commit:<importId>'`).
   In `actions.ts::approveImport()`, *after* the transaction commits, re-score the affected properties and log verdicts. This is the highest-value moment: a new statement just changed the ledger, the `inputs_version` is fresh, and the verdict reflects the newest data. Wrapped in try/catch — a logging failure writes a `data_quality_issues` row (`kind='calibration-emit-failed'`) and the commit still returns `{ok:true}` (fail-open).

2. **On scheduled snapshot** (`emitted_by = 'snapshot:<taskId>'`).
   A new scheduled task `ora-calibration-snapshot` (registered via the supervised `create_scheduled_task` MCP per routing canon — never JSON-splice) runs **quarterly** (and once at fiscal year-end). It calls `scoreProperties()` + `detectAnomalies()` over the full warehouse and logs the current verdict for every subject. This guarantees a regular cadence of dated predictions even in periods with no new imports — essential because outcome scoring needs a steady prediction stream, and a 14-property firm imports irregularly.

3. **On explicit recompute** (`emitted_by = 'recompute'`).
   Optional: a manual "snapshot now" button in the Data Quality view for ad-hoc captures (e.g. right before a weight re-ratification, to freeze the "before" state). Same code path as the snapshot task.

We do **NOT** log on every `GET /analytics/scores` read — that would flood the table with duplicates. The `dedup_key UNIQUE` constraint makes accidental read-time logging harmless, but reads stay pure by policy.

### 2.3 Confidence (deterministic proxy, Phase 1)

No engine emits a probability today. Phase 1 derives a deterministic confidence proxy so Brier scoring has something to bite on later, without inventing model probabilities:

- **Band verdicts:** confidence = normalized distance from the nearest band boundary. A health of 79 (boundary `excellent=80`) is low-confidence; a health of 95 is high-confidence. `confidence = clamp(|health − nearestBoundary| / bandHalfWidth, 0.5, 0.95)`.
- **Anomaly verdicts:** confidence = `severityMultiple` mapped to [0.5, 0.95] (a critical at 4× threshold is high-confidence).
- **Small-cohort penalty:** if the subject's benchmark cohort `n < 3` (the `smallSample`/singleton flag the benchmarks engine already computes), cap confidence at 0.6. This bakes the 14-property small-N reality (§6) directly into the recorded confidence.

This is explicitly a *proxy*, tagged as such. When a real probabilistic engine ships, it overwrites `confidence` for new rows; historical rows keep their proxy and are filtered out of strict Brier reports by `code_version`.

---

## 3. Outcome back-fill

Two mechanisms, both writing `calibration_outcome` rows. Auto-resolution handles the deterministic majority; the manual UI handles judgment calls and treatment-effect annotation.

### 3.1 Automatic resolution (`resolved_by = 'auto:*'`)

A pure resolver function, `resolveDueOutcomes(db)`, run by the same quarterly snapshot task **before** it logs new verdicts. For every `calibration_log` row that (a) has no `is_resolution=1` outcome and (b) whose `as_of_period + horizon_periods` is now covered by committed ledger data:

- **`health-band` / `forecast` (numeric):** pull the realized metric for `outcome_period` from `propertyPeriodMetrics()`. Compute `realized_band` (re-band the realized health) and `abs_error` (predicted vs realized health/NOI). `hit = 1` if realized band == predicted band, else 0.
- **`capital-action` `disposition-candidate`:** auto-score against the **next same-grain full-year NOI trend** (the canonical example). Hit if the realized year-over-year `noiGrowth` for that property is ≤ 0 (the verdict said "this is a drag" and NOI confirmed it declined or stagnated). `realized_value = noiGrowth`, `direction` check folds into `hit`. Conversely, `capital-action = invest` is hit if NOI grew.
- **`attention` `red`/`orange`:** hit if a flagged anomaly or NOI decline actually materialized in the following period.
- **`anomaly`:** these are *concurrent* (they describe a move that already happened), so their "outcome" is a persistence check — did the flagged condition recur or worsen next period (true positive) or revert (likely noise)? `resolution_basis = 'realized-noi-trend'`.

Grain discipline (warehouse §9) is enforced: an outcome is only scored against a **same-grain** future period. A YTD-vs-full-year comparison is never used to resolve a verdict — it would manufacture the spurious ≈−50% decline the growth engine already guards against. Until a same-grain full-year period arrives, the verdict stays unresolved (pending), not wrongly scored.

`action_taken` defaults to `'unknown'` on auto-resolution — the resolver cannot know the firm's intent. That is the manual layer's job.

### 3.2 Manual resolution UI (`resolved_by = 'manual:<user>'`)

In the Data Quality / governance view (§4), an analyst (Gabriel, or whoever runs the quarterly review) sees the queue of **resolvable-but-judgment-required** verdicts and the auto-resolved ones flagged for treatment annotation. They can:
- Bless or override an auto-resolution (`is_resolution` flip — old row preserved).
- Set `action_taken`: did the firm act? `acted-aligned` (followed the verdict — e.g. put capex into an `invest` property), `acted-counter` (did the opposite), `none` (left it alone — the clean natural experiment), `unknown`.
- Record `action_detail` (link to the capex, the refi, the disposition close) and `treatment_note` ("NOI held flat only because we re-leased the anchor — verdict was directionally right but we intervened").

Routes (Hono sub-router, same `withDb` 503-guard pattern as `api.ts`, all bodies Zod-validated):

```
GET  /api/warehouse/calibration/log?subject=&kind=&status=open|resolved
GET  /api/warehouse/calibration/pending          -- verdicts whose horizon is due, unresolved
POST /api/warehouse/calibration/:id/resolve       -- body: CalibrationOutcomeSchema
GET  /api/warehouse/calibration/report?from=&to=&kind=   -- §4 metrics, read-only
```

Writes follow the immutability rule: `/resolve` inserts an outcome row; it never UPDATEs a verdict.

---

## 4. The periodic Calibration Report

Computed by a pure function `calibrationReport(db, {from, to, kind?})` over resolved outcomes. Read-only; never mutates. Surfaces in two places.

### 4.1 Metrics (per `verdict_kind`, and per band within kind)

- **Hit-rate:** `Σ hit / Σ scoreable`. Reported per band (`disposition-candidate` hit-rate vs `invest` hit-rate) because aggregate hit-rate hides which judgments are reliable. Wilson confidence interval reported alongside — at N=14 the point estimate is nearly meaningless without the interval (§6).
- **Brier score:** `mean(brier_component)` over probabilistic verdicts (`(confidence − outcome01)²`, lower is better). Decomposed into reliability + resolution where N permits.
- **Calibration curve:** binned `confidence` vs observed hit-rate (the diagonal = perfectly calibrated). At small N this is a sparse scatter, not a smooth curve — rendered as points with counts, never a fitted line that implies precision we don't have.
- **Directional accuracy:** for verdicts carrying `direction`, fraction where realized direction matched. More robust at small N than band-exact hit-rate.
- **Bias:** mean signed error (`predicted − realized`) per numeric kind — is the engine systematically optimistic or pessimistic?
- **Treatment-adjusted hit-rate:** hit-rate computed **only over `action_taken = 'none'`** rows (the clean natural experiments) reported separately from the all-rows figure. This is the single most important number and the one most prone to misreading (§5).

### 4.2 Where it surfaces

1. **Data Quality / governance view** (React, alongside `data_quality_issues`): a "Calibration" panel — per-kind hit-rate cards with confidence intervals, the pending-resolution queue, and the calibration scatter. This is the operational home; it makes the feedback loop *visible* between formal reviews.
2. **Quarterly / Annual AI briefing:** a "Did the system call it right?" section. Quarterly = the dashboard snapshot. **Annual = the load-bearing artifact** — the year-end review (ties into the `annual-cycle` skill / `ora-year-end-review` task) includes the full per-kind report and any proposed weight changes. This is the institutional ritual that makes 40 years of compounding real: every year, the system is graded, in writing, in front of the principal.

### 4.3 How it DRIVES weight re-ratification (and where it stops)

The report produces a **Proposed Weight Change Memo**, never a config edit. The pipeline:

1. The annual report identifies a sub-score whose verdicts systematically miss — e.g. `benchmarkPosition` (weight 0.10) verdicts have a 40% directional hit-rate while `noiGrowth` (weight 0.22) hits 80%.
2. A deterministic, **offline** re-fit (a script, `scripts/calibration-refit.ts`, run on demand — not in the live path) proposes new `healthWeights` that would have maximized historical hit-rate, **subject to constraints**: weights sum to 1.0, no single weight moves more than ±0.05/year (anti-overfit governor on the *calibration* process itself), and the re-fit is reported with the in-sample/out-of-sample split it was validated on.
3. The memo is presented to Gabriel: current weights, proposed weights, the evidence (which verdicts, what hit-rate delta, the N behind each), and the pre-mortem ("this re-fit is driven by 9 resolved disposition verdicts; 3 were treatment-contaminated").
4. **Gabriel ratifies or rejects.** Only on ratification does `INTEL_CONFIG.healthWeights` change — a normal, reviewed, hook-gated code edit to `intel-config.ts`. That edit changes the `config_hash`, which changes every subsequent `inputs_version`, so the calibration log cleanly partitions "verdicts under weights v1" from "verdicts under weights v2." The system never grades v2 weights against v1 verdicts.

This is the hard line: **the calibration log is advisory. It generates evidence and a proposal. A human ratifies. Nothing in this feature ever writes `intel-config.ts`, and nothing ever touches the DSCR/LTV governors (which are not scores and are out of scope).**

---

## 5. Treatment effect — wrong verdict vs. acted-upon verdict

The deepest correctness trap in the whole feature. A `disposition-candidate` verdict that is followed by *rising* NOI is **not** necessarily a wrong verdict — it may be a *successful intervention* (the firm re-leased the anchor tenant precisely because the system flagged the property). Scoring that as a "miss" would train the system to stop flagging real problems. Conversely, an `invest` verdict followed by flat NOI where the firm did nothing is a clean miss.

Mechanism:
- Every resolution carries `action_taken ∈ {none, acted-aligned, acted-counter, unknown}` and `action_detail`.
- **`action_taken = 'none'` rows are the only clean tests** of the engine's predictive validity → the treatment-adjusted hit-rate (§4.1) is computed over these alone.
- `acted-aligned` rows measure something different and valuable: whether the *firm's response* to a verdict worked — an operational feedback loop, not a model-calibration loop. Reported separately, never mixed into the weight re-fit.
- `acted-counter` / `unknown` rows are excluded from weight re-fitting entirely (logged for completeness, flagged in the memo).

The `treatment_note` free-text field forces the analyst to articulate the causal story at resolution time, when memory is fresh — not reconstruct it years later. Over 40 years this annotation IS the institutional memory of why each call was right or wrong.

---

## 6. Pitfalls (named, with the mitigation in the design)

- **Small-N (14 properties).** Any single-period hit-rate is statistically hollow. Mitigations baked in: (a) Wilson confidence intervals reported with every rate, never a bare point estimate; (b) small-cohort confidence penalty (§2.3) so the system *records its own uncertainty*; (c) the ±0.05/year weight-move cap (§4.3) prevents overfitting to noise; (d) the value compounds over *time* not *cross-section* — 14 properties × 40 years × quarterly verdicts ≈ thousands of dated predictions. The design optimizes for the long series, not the wide panel. **State plainly in every report: the first ~5 years are data-accumulation, not actionable calibration.**

- **Survivorship bias.** A disposed property stops generating ledger data — its verdicts would silently drop out of resolution, biasing the report toward survivors (the very properties the system kept). Mitigation: when `deal-retirement` / disposition fires, the resolver writes a **terminal outcome** (`resolution_basis = 'actual-disposition'`) capturing the disposition as the realized outcome of any open `disposition-candidate`/`monitor` verdict — the sold property's verdict is *resolved*, not dropped. Dispositions are first-class outcomes, not gaps.

- **Lookahead / leakage.** A verdict's `inputs_version` must reflect *only* data available at `emitted_at`. Risk: re-scoring an old period after later data has been committed would let future information leak into a "past" verdict. Mitigation: verdicts are logged at the moment of commit/snapshot against the *then-current* `inputs_version`; the resolver reads outcomes from *strictly later* periods only; and re-scoring history is forbidden — old verdict rows are immutable, so there is no path to retroactively contaminate them.

- **Horizon mismatch.** A `disposition-candidate` plays out over years; an `anomaly` over one period. Scoring both at a fixed horizon is wrong. Mitigation: `horizon_periods` is per-verdict (§2.1 column), the resolver only scores a verdict once its *own* horizon is covered by same-grain data, and `horizon_actual` records the real elapsed gap so reports can stratify by horizon.

- **Grain mismatch.** Same trap as the rest of the warehouse — never resolve a verdict against a cross-grain (YTD-vs-full-year) period. Enforced in the resolver (§3.1), inherited from the `growth.ts`/`anomalies.ts` grain discipline.

- **Wrong vs. acted-upon (treatment).** §5 in full — the single most consequential distinction; mishandling it inverts the training signal.

- **Config drift unversioned.** If weights changed but `inputs_version` didn't capture it, the report would grade new weights against old verdicts. Mitigation: `config_json` + `config_hash` are part of the `inputs_version` hash (§1.1) — a weight change *necessarily* forks the version.

---

## 7. Phase 1 — minimal "start logging now" scaffold

Goal: **begin persisting verdicts with `inputs_version` immediately**, with the smallest, deterministic, tested, fail-open change. Analysis maturity comes later; data accrual must start now, because the report is worthless without a back-history and we cannot manufacture a back-history retroactively (lookahead rule). Every quarter we delay is a quarter of compounding lost.

**Smallest change set:**

1. **`server/warehouse/db.ts`** — append the three tables from §1 to `SCHEMA`. Idempotent; runs on next `openWarehouse()`. Zero migration risk (additive only).

2. **`server/warehouse/calibration.ts`** (new, ~120 lines) — pure module:
   - `computeInputsVersion(db): InputsVersion` — the §1.1 hash; upserts into `calibration_inputs_version` (INSERT OR IGNORE).
   - `logVerdicts(db, verdicts: CalibrationVerdict[]): {written:number; skipped:number}` — Zod-validates, builds `dedup_key`, `INSERT OR IGNORE` in one transaction. Returns counts. Never throws to the caller; on any error returns `{written:0, skipped:0, error}` and writes a `data_quality_issues` row.
   - `verdictsFromScores(scores: PropertyScore[], iv, emittedBy): CalibrationVerdict[]` — maps each `PropertyScore` to three rows (`health-band`, `attention`, `capital-action`) carrying `reasons`, `confidence` proxy, `as_of_period = score.period`.
   - `verdictsFromAnomalies(flags, iv, emittedBy)` — one row per `AnomalyFlag`.

3. **`server/warehouse/actions.ts`** — at the end of `approveImport()`, after the transaction, a fail-open block:
   ```ts
   try {
     const iv = computeInputsVersion(db);
     const metrics = propertyPeriodMetrics(db);
     logVerdicts(db, [
       ...verdictsFromScores(scoreProperties(db, metrics), iv, `commit:${importId}`),
       ...verdictsFromAnomalies(detectAnomalies(metrics), iv, `commit:${importId}`),
     ]);
   } catch (e) { recordQualityIssue(db, 'calibration-emit-failed', String(e)); }
   ```
   The commit's `{ok:true}` is unaffected by any failure here.

4. **`src/contracts/warehouse.ts`** — append the §2 schemas.

5. **Scheduled task** `ora-calibration-snapshot` — quarterly + year-end, calls a new `scripts/calibration-snapshot.ts` that runs the same `logVerdicts` path with `emittedBy='snapshot:<taskId>'`. Registered via supervised `create_scheduled_task` (routing canon: outputs to `ggoldberg@oxfordra.net` only). Deferred to end of Phase 1 — the on-commit hook alone starts the data flow.

**Explicitly NOT in Phase 1:** the resolver, the report function, the React panels, the re-fit script, the manual-resolution routes. Those are Phase 2+ — and they have *no urgency*, because the outcomes they score don't exist yet (we need ≥1 horizon of elapsed time). Phase 1 buys the irreplaceable thing: a dated, reproducible verdict stream starting today.

**Done-definition for Phase 1 (Engineering OS / TDD):**
- Tests written first (`tests/unit/calibration.test.ts`), watched to fail:
  - `computeInputsVersion` is stable across calls on an unchanged db, and **changes** when a ledger row is superseded or `INTEL_CONFIG` changes.
  - `logVerdicts` is idempotent: logging the same verdict set twice writes N then 0 (dedup_key).
  - A forced throw inside `logVerdicts` does NOT propagate to `approveImport`'s return (`{ok:true}` preserved) and DOES write a `data_quality_issues` row (fail-open proof).
  - Zod rejects a verdict with neither band nor value.
  - Determinism: same `(scores, iv)` → byte-identical verdict rows.
- typecheck 0, lint 0, full `vitest` green.
- **Mandatory adversarial review** (this is financial-decision-adjacent code feeding capital-allocation calibration): a reviewer tasked to *break* the inputs_version hash (collision/instability) and the fail-open guarantee, per the Engineering OS financial-code rule.
- Any dev/preview server started for verification is stopped before returning (it holds the warehouse SQLite WAL lock and blocks the next backfill).

---

## 8. Why this is cheap now and priceless later

The Phase 1 change is ~3 files touched + 1 new module + 1 test file, additive-only, fail-open, behind the existing 503 guard — it cannot destabilize the warehouse. It writes a few rows per commit to two tiny tables. The cost is near zero.

What it buys: starting on the commit it ships, every judgment the platform makes is dated, reproducible, and waiting to be graded. In 2027 the first verdicts resolve. By the year-end review of 2028 there is a real, if small-N, calibration report. By 2046 there are tens of thousands of resolved verdicts spanning multiple weight regimes, multiple market cycles, and a real estate portfolio that has compounded 10×. The firm will know — with evidence, not intuition — which of its instruments to trust. That is the 40-year feedback loop, and the only way to have it then is to start the log now.

---

**Files this spec touches (all absolute):**
- `C:\Users\Owner\oxford-command-center\server\warehouse\db.ts` (schema append)
- `C:\Users\Owner\oxford-command-center\server\warehouse\calibration.ts` (new)
- `C:\Users\Owner\oxford-command-center\server\warehouse\actions.ts` (fail-open emit hook in `approveImport`)
- `C:\Users\Owner\oxford-command-center\server\warehouse\api.ts` (Phase 2 `/calibration` routes)
- `C:\Users\Owner\oxford-command-center\server\warehouse\intel-config.ts` (read-only here; edited ONLY on ratified weight change)
- `C:\Users\Owner\oxford-command-center\src\contracts\warehouse.ts` (Zod schemas append)
- `C:\Users\Owner\oxford-command-center\scripts\calibration-snapshot.ts` (new, Phase 1 tail)
- `C:\Users\Owner\oxford-command-center\scripts\calibration-refit.ts` (new, Phase 2+, offline only)
- `C:\Users\Owner\oxford-command-center\tests\unit\calibration.test.ts` (new, TDD-first)
- Spec home: `C:\Users\Owner\oxford-command-center\docs\superpowers\specs\2026-06-13-calibration-log-design.md`

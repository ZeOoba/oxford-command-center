# Acquisition Scorecard Contract — shared ruleset for the underwriting skill AND the platform engine

**Status:** Draft for Gabriel ratification · **Doc version:** 1.0 · **Author:** Principal Architect, ORA Command Center
**Encodes:** `Buy Box & Scorecard v1.0` (calibrated with Gabriel 2026-06-09)
**Scope:** Defines ONE versioned, ratified ruleset that BOTH the Cowork `acquisition-underwriting` skill (v3.0) AND the platform `Acquisition Intelligence Engine` (`server/warehouse/acquisition.ts`, Phase 4) import — so the two surfaces never re-derive scoring logic and never drift.

---

## 0. Sources of record (cited verbatim, path + line)

| Artifact | Path | Lines used |
|---|---|---|
| Ratified ruleset (the skill) | `C:\Users\Owner\OneDrive - Oxford Capital Partners (1)\Claude_Workspace\01_Workspace\.claude\skills\acquisition-underwriting\SKILL.md` | 23–127 |
| Platform config pattern (ratified-vs-proposed) | `C:\Users\Owner\oxford-command-center\server\warehouse\intel-config.ts` | 1–37 |
| Platform deterministic scorer pattern | `C:\Users\Owner\oxford-command-center\server\warehouse\scores.ts` | 1–240 |
| Contract primitives (Confidence/Provenance/DataQualityFlag/SCHEMA_VERSION) | `C:\Users\Owner\oxford-command-center\src\contracts\common.ts` | 9–48 |
| Deal contract (pipeline shape) | `C:\Users\Owner\oxford-command-center\src\contracts\deal.ts` | 20–43 |
| Comp contract (Market sub-score inputs) | `C:\Users\Owner\oxford-command-center\src\contracts\comps.ts` | 36–44 |

The SKILL.md was LOCATED and READ — this extraction is **VERIFIED**, not inferred from description metadata.

---

## 1. Extraction — the ratified ruleset, verbatim

### 1.1 STAGE 0 — GATES (binary; any fail = KILLED, stop scoring) — SKILL.md:23–30

1. **Product** (:25): Class B/C industrial — shallow-bay multi-tenant, flex, office-warehouse, OR functional single-tenant ≤40,000 SF (scored EQUAL to multi-tenant). Quasi-IOS single-tenant <20K SF on land-heavy parcels = explicit target. Office never kills if 1-story / demo-able; ≤30% office ideal.
2. **Size/Price** (:26): **$500K–$10M single asset; ≤$15M multi-building portfolio; <50,000 SF per building.**
3. **Market** (:27): Established clusters (Columbus, Cincinnati, Kansas City, Indianapolis, Maryland/DC, Madison WI) + entry clusters (Grand Rapids, Richmond, Des Moines). Satellite metros eligible ONLY within 30-min drive of an established cluster, **Market points capped at half.** Beyond 30 min = pass.
4. **Physical kills** (:28): multi-story warehouse space; no ground-level access (zero drive-ins AND zero docks); **clear height <12'.**
5. **Flood** (:29): SFHA on the building pad = kill. SFHA on excess land = value land at $0 and proceed.
6. **Other kills** (:30): ground lease <30 yrs remaining; environmental remediation >20% of price; automotive use; child-related use without safety review; retail-only; office-only.

> Note on the global buy-box governors. The firm-wide DSCR ≥ 1.25x / LTV ≤ 40% governors (CLAUDE.md, invariant 4) are **financing-structure governors enforced at underwrite/capital-structure stage**, NOT Stage-0 acquisition gates in SKILL.md. The skill's own capital-structure context (SKILL.md:95, 122) models the all-cash bid + 65% LTV refi. The platform engine must treat DSCR/LTV as **immutable governor constants imported from the financial-constant layer — never re-encoded in the acquisition ruleset JSON** (CLAUDE.md invariant 4; blast-radius file class). See §6 open question Q4.

### 1.2 STAGE 1 — FLOORS (pass/fail after underwriting; NO score overrides a floor) — SKILL.md:32–38

- **Basis floor** (:34): all-in basis at a discount to replacement cost of **≥25% if built ≥2000, ≥30% if built <2000.** Denominator = ORA Canonical Replacement-Cost Table (cite version, e.g. "RCT v01").
- **Yield floor** (:35): stabilized Yield on Cost **>8%** (prefer 10%+).
- **IRR floor** (:36): levered **≥15% (5-yr UW) / ≥12% (10-yr UW)**; interpolate; adjust upward for risk.
- **Portfolios** (:37): EVERY building clears both floors at its allocated price; no averaging. Score the blend.
- **Unpriced / no-NOI** (:38): solve price to the 8% YoC floor (walk-price). Score on that basis; report gap-to-ask.

### 1.3 STAGE 2 — SCORECARD (100 points) — SKILL.md:40–51

| # | Category | Pts | Mechanics (verbatim) |
|---|---|---|---|
| 1 | **Basis** | **25** | Linear: 0 pts at the vintage-adjusted floor → 25 pts at ≥55% discount |
| 2 | **Yield** | **20** | Stabilized YoC spread only: 8.0% = 0 → ≥11.0% = 20, linear (IRR stays a floor) |
| 3 | **Product & Physical** | **20** | Clear/loading adequacy 8 + product fit 5 + construction & condition 4 + site function 3 |
| 4 | **Market & Location** | **12** | Cluster adjacency first: ORA-owned submarket = max → established → entry → 30-min satellite (≤6); submarket fundamentals (vacancy, rent growth, supply) adjust ± |
| 5 | **Seller / Motivation** | **10** | ORA only buys from motivated or inexperienced sellers/brokers — signal list :61–65 |
| 6 | **Tenancy & Lease** | **7** | UPSIDE scoring: deeply below-market in-place rents + short WALT/MTM score HIGH. 100% vacant → these 7 pts reallocate to category 7 |
| 7 | **Value-Add Optionality** | **6 (13 if vacant)** | Vacancy lease-up; usable yard/excess land; subdivision. FAR INFO-ONLY, never a filter |

**Sub-matrices (must be ported verbatim into the ruleset JSON, not re-derived):**
- Clear-height & loading adequacy matrix — SKILL.md:52–57 (size-banded clear minimums; loading ratios; truck-court 100' ideal / <60' ≈0 on site function, does not kill).
- Construction — SKILL.md:59 (block/tilt-up/brick = full; all-metal PEMB ≈ half).
- Seller/Motivation signal list — SKILL.md:61–65 (distress & life events; market evidence; inexperience).
- Environmental — SKILL.md:67 (flag + price; >20% of price = gate kill; NOT scored).

### 1.4 STAGE 2.5 — DD-CRITICAL SCREEN ITEMS — SKILL.md:69–75

Four mandatory items; **any unknown caps the verdict at T2 WATCH:** (1) FEMA flood determination, (2) zoning + permitted-use, (3) roof age/type/remaining life `[est]`, (4) deferred-maintenance CapEx `[est]`.

### 1.5 VERDICT BANDS (SCREEN tier outputs) — SKILL.md:85–87

- **≥75 = T1 PURSUE** · **60–74 = T2 WATCH** · **<60 = PASS** · **Gate/floor failure = KILLED** (display regardless of points) · **Any DD-Critical item unknown = capped at T2.**

---

## 2. Mapping the ruleset to the platform's four sub-scores

The platform produces four sub-scores (Market / Asset / Basis / Risk) and a composite **Oxford Acquisition Score (0–100)**. The seven scorecard categories total exactly 100; the four platform sub-scores are a **lossless re-grouping** of those same 100 points — the composite is the unweighted sum, so the platform composite is **identically the skill's 100-pt total**. This guarantees the two surfaces produce the same number from the same inputs.

| Platform sub-score | Scorecard line items folded in | Raw pts | Skill source |
|---|---|---|---|
| **Basis** | Cat 1 Basis (25) + Cat 2 Yield (20) | **45** | SKILL.md:44–45 |
| **Asset** | Cat 3 Product & Physical (20) + Cat 7 Value-Add Optionality (6/13) | **26 (33 if vacant)** | SKILL.md:46, 50 |
| **Market** | Cat 4 Market & Location (12) | **12** | SKILL.md:47 |
| **Risk** | Cat 5 Seller/Motivation (10) + Cat 6 Tenancy & Lease (7→0 if vacant) | **17 (10 if vacant)** | SKILL.md:48–49 |

**Vacancy reallocation rule (SKILL.md:49–50) preserved:** when 100% vacant, Cat 6's 7 pts move to Cat 7. In platform terms, **7 points migrate from Risk → Asset**; the composite cap stays 100.

**Reporting convention.** The skill's bands operate on the **composite 0–100** (SKILL.md:85–87), not on the four sub-scores. The platform therefore:
1. Computes the four sub-scores on their native point bases (45/26/12/17), each also normalizable to 0–100 for the UI gauge.
2. Sums to the composite (0–100).
3. Applies gates → floors → DD-Critical cap → band, in that precedence order (a KILLED gate or failed floor overrides any composite; an unresolved DD-Critical item caps at T2). This mirrors the skill's STAGE 0 → 1 → 2 → 2.5 → verdict cascade and the platform's existing "no score overrides a floor / gate" logic (SKILL.md:32, 87).

**Determinism boundary (mirrors `scores.ts`:1–6).** Gates, floors, the 100-pt arithmetic, vacancy reallocation, and band assignment are **deterministic compute** — a pure function of `(inputs, ruleset)`. The LLM may only **narrate** reasons and **populate inputs** (e.g. comp research, motivation-signal detection). The engine never lets the model move the number. Financial-decision code path → MANDATORY adversarial review pass before "done" (CLAUDE.md Engineering OS).

---

## 3. Canonical contract — `src/contracts/acquisition.ts` (Zod sketch)

Lives beside the existing domain contracts; imports `Confidence`, `Provenance`, `DataQualityFlag`, `Market`, `SCHEMA_VERSION` from `./common` (common.ts:9–60). Exported via `src/contracts/index.ts`.

```ts
// src/contracts/acquisition.ts
import { z } from 'zod';
import { Confidence, DataQualityFlag, Market } from './common';

/** Ruleset identity — bumped on any calibration change; both surfaces assert against it. */
export const RULESET_VERSION = '1.0.0' as const; // Buy Box & Scorecard v1.0 (Gabriel 2026-06-09)

// ─── Ratification provenance (mirrors intel-config ratified-vs-proposed) ───
export const Ratification = z.enum(['ratified', 'proposed']);

// ─── CONFIG (single source of truth, imported by skill + engine) ───

export const GateId = z.enum([
  'product', 'size-price', 'market', 'physical', 'flood', 'other-use',
]); // SKILL.md:25–30

export const FloorId = z.enum(['basis', 'yield', 'irr']); // SKILL.md:34–36

export const SubScore = z.enum(['market', 'asset', 'basis', 'risk']);
export type SubScore = z.infer<typeof SubScore>;

/** The seven calibrated scorecard categories. Points are RATIFIED — never tuned in code. */
export const ScorecardCategory = z.object({
  id: z.enum([
    'basis', 'yield', 'product-physical', 'market-location',
    'seller-motivation', 'tenancy-lease', 'value-add',
  ]),
  label: z.string(),
  points: z.number().int().positive(),       // base cap (SKILL.md:44–50)
  vacantPoints: z.number().int().positive().nullable(), // value-add 13 if vacant; null = no change
  subScore: SubScore,                          // §2 fold-in target
  reallocatesToWhenVacant: z.enum(['value-add']).nullable(), // tenancy-lease → value-add (:49)
});

export const AcquisitionRuleset = z.object({
  rulesetVersion: z.literal(RULESET_VERSION),
  ratification: Ratification,                  // 'ratified' for v1.0.0
  calibratedWith: z.string(),                  // "Gabriel Goldberg 2026-06-09"
  skillVersion: z.string(),                    // "acquisition-underwriting v3.0"

  // STAGE 0 — gates (SKILL.md:23–30). Bounds, NOT governors.
  gates: z.object({
    sizePrice: z.object({
      singleAssetPriceMin: z.literal(500_000),
      singleAssetPriceMax: z.literal(10_000_000),
      portfolioPriceMax: z.literal(15_000_000),
      maxSfPerBuilding: z.literal(50_000),     // strictly < 50,000
    }),
    physical: z.object({ minClearHeightFt: z.literal(12) }),
    flood: z.object({ sfhaOnPadKills: z.literal(true), sfhaOnLandValuesAtZero: z.literal(true) }),
    other: z.object({
      minGroundLeaseYearsRemaining: z.literal(30),
      maxEnvRemediationPctOfPrice: z.literal(0.20),
    }),
    establishedClusters: z.array(z.string()),  // Columbus, Cincinnati, KC, Indy, MD/DC, Madison
    entryClusters: z.array(z.string()),        // Grand Rapids, Richmond, Des Moines
    satelliteMaxDriveMinutes: z.literal(30),   // Market pts capped at half beyond cluster
  }),

  // STAGE 1 — floors (SKILL.md:32–38). NO score overrides a floor.
  floors: z.object({
    basisDiscountMinPostMillennium: z.literal(0.25), // built ≥2000
    basisDiscountMinPreMillennium: z.literal(0.30),  // built <2000
    basisVintageCutoffYear: z.literal(2000),
    stabilizedYocFloorPct: z.literal(0.08),
    leveredIrrFloor5yr: z.literal(0.15),
    leveredIrrFloor10yr: z.literal(0.12),
  }),

  // STAGE 2 — 100-pt scorecard (SKILL.md:40–50). Weights sum to 100; vacant-adjusted sums to 100.
  scorecard: z.array(ScorecardCategory)
    .refine((cs) => cs.reduce((s, c) => s + c.points, 0) === 100, 'base points must total 100'),

  // Linear-anchor knobs (SKILL.md:44, 45) — calibrated endpoints, ported NOT re-derived.
  scoring: z.object({
    basisFullCreditDiscount: z.literal(0.55),  // 25 pts at ≥55% discount
    yocZeroPct: z.literal(0.08),               // 0 pts at 8.0% YoC
    yocFullPct: z.literal(0.11),               // 20 pts at ≥11.0% YoC
  }),

  // STAGE 2.5 — DD-Critical (SKILL.md:69–75). Any unknown caps verdict at T2.
  ddCritical: z.array(z.enum(['flood', 'zoning', 'roof', 'deferred-maintenance-capex'])),

  // Verdict bands (SKILL.md:85–87).
  bands: z.object({ t1PursueMin: z.literal(75), t2WatchMin: z.literal(60) }),
});
export type AcquisitionRuleset = z.infer<typeof AcquisitionRuleset>;

// ─── SCORED OUTPUT (engine result; UI + skill render from this) ───

export const GateResult = z.object({
  id: GateId, passed: z.boolean(), detail: z.string(),
});
export const FloorResult = z.object({
  id: FloorId, passed: z.boolean(), actual: z.number().nullable(), required: z.number(), detail: z.string(),
});
export const SubScoreResult = z.object({
  id: SubScore,
  points: z.number(),          // achieved, on native base
  maxPoints: z.number(),       // 45/26/12/17 (vacant-shifted)
  normalized: z.number().min(0).max(100), // for the UI gauge
  confidence: Confidence,      // common.ts:12 — Market is the weak link (§5)
});

export const Tier = z.enum(['T1', 'T2', 'PASS', 'KILLED']);
export const Verdict = z.enum(['PURSUE', 'WATCH', 'PASS', 'KILLED']);

export const AcquisitionScore = z.object({
  schemaVersion: z.literal('1.0.0'),
  inputsVersion: z.string(),       // hash/version of the deal-input snapshot scored
  rulesetVersion: z.literal(RULESET_VERSION), // engine asserts === ruleset it loaded
  scoredAt: z.string(),            // ISO

  dealId: z.string(),
  market: Market.nullable(),
  isVacant: z.boolean(),           // drives the 7-pt Risk→Asset reallocation (§2)

  gates: z.array(GateResult),
  gatesPassed: z.boolean(),        // all true
  floors: z.array(FloorResult),
  floorsPassed: z.boolean(),
  ddCriticalUnresolved: z.array(z.string()), // non-empty ⇒ cap at T2

  subScores: z.array(SubScoreResult), // market / asset / basis / risk
  composite: z.number().min(0).max(100), // = Σ scorecard pts = skill 100-pt total

  tier: Tier,
  verdict: Verdict,
  cappedAtT2: z.boolean(),         // true when a DD-Critical item forced the cap
  confidence: Confidence,          // weakest-link of the four sub-score confidences
  reasons: z.array(z.string()),    // deterministic narration (scores.ts:257 pattern)
  dataQuality: z.array(DataQualityFlag), // common.ts:41 — quarantined bad inputs
});
export type AcquisitionScore = z.infer<typeof AcquisitionScore>;
```

---

## 4. Single source of truth, location, and versioning

### 4.1 Where the config lives

The ruleset is committed as a **repo-tracked JSON file**, validated at load against `AcquisitionRuleset`:

```
oxford-command-center/
  config/
    acquisition-ruleset.v1.json     # THE single source of truth (ratified)
  server/warehouse/
    acquisition.ts                  # imports + AcquisitionRuleset.parse() at boot; fail-closed
  src/contracts/
    acquisition.ts                  # the Zod schema above
```

- **Platform engine** (`acquisition.ts`) imports the JSON, parses it through `AcquisitionRuleset`, and asserts `rulesetVersion === RULESET_VERSION` at boot — **fail-closed** (refuse to score on a version mismatch), exactly as the warehouse fails closed on confidential-deal state.
- **Cowork skill** references the SAME JSON as its canonical numeric source. The skill's SKILL.md prose stays human-readable but carries a one-line pointer: *"Numeric ruleset of record: `oxford-command-center/config/acquisition-ruleset.v1.json` (RULESET_VERSION 1.0.0). On any conflict, the JSON governs; prose is explanatory."* The ora-skills repo (`github.com/ZeOoba/ora-skills`) gets the JSON vendored or git-submodule'd so the skill ships with a byte-identical copy; a CI check (or the `doctrine-integrity-probe`) diffs the two and fails on drift.

This is the **one fact, one home** principle from CLAUDE.md applied to scoring: the calibrated numbers live in exactly one file; both surfaces import it; neither re-types it.

### 4.2 Versioning & ratification mechanism (mirrors INTEL_CONFIG)

INTEL_CONFIG (intel-config.ts:3–5, 16–18, 21) tags each constant `ratified` vs `proposed` and keeps weights tunable without touching engine code. The acquisition ruleset adopts the same discipline at file granularity:

- Every constant in `acquisition-ruleset.v1.json` is **`ratified`** (it came from a Gabriel calibration session, 2026-06-09). The `ratification` field on the ruleset object records this; a future tuning candidate ships as a **separate** `acquisition-ruleset.v2-proposed.json` marked `proposed` and is NOT loaded by the production engine until Gabriel ratifies it.
- **Bump rule:** any change to a gate bound, floor, category weight, linear anchor, or band cutoff = a **new RULESET_VERSION** (semver: patch for non-numeric/label fixes, minor for re-weighting within the existing structure, major for adding/removing a category or sub-score). The old file is **moved to `config/archive/`**, never overwritten (CLAUDE.md invariant 6).
- **Ratification gate:** because this file feeds capital-allocation, it is a **blast-radius / financial-decision file** (CLAUDE.md Engineering OS + invariant 4). Changes require: explicit Gabriel sign-off recorded in `memory/event_log.md`, an adversarial reviewer pass (told to refute the recalibration), and the version bump + archive above before "done."
- **Governors stay out.** DSCR 1.25 / LTV 40 are NOT in this JSON. They are imported by the engine from the existing financial-constant layer so a scorecard recalibration can never silently touch a governor.

---

## 5. Market sub-score must be confidence-bounded (no CoStar)

Per the firm's procurement stance (memory: *procurement-stance-deepen-not-migrate.md* — below $150M AUM, no per-seat PropTech/CoStar), the **Market sub-score has no institutional data feed.** Its inputs are public + AI-researched (the `CompSet` shape, comps.ts:36–44: `submarketStats`, `sources`, `sourcedAt`). Therefore:

1. **The Market sub-score (12 pts, Cat 4) carries an explicit `confidence` field** (`confirmed` | `estimated` | `derived`, common.ts:12). Cluster adjacency (ORA-owned/established/entry/satellite) is **deterministic and `confirmed`** — it's a fact about ORA's own footprint and a drive-time calc. The **± fundamentals adjustment** (vacancy, rent growth, supply — SKILL.md:47) rides on AI-researched public data and is at best **`estimated`**.
2. **Confidence floors the composite confidence.** `AcquisitionScore.confidence` = weakest-link of the four sub-scores; a `T1 PURSUE` resting on an `estimated` Market sub-score must surface that in `reasons[]` and the UI gauge (dotted/provenance treatment, per `estimatedFields` in deal.ts:41).
3. **Default-conservative on missing fundamentals.** When public/AI data is absent or stale (`CompSet.sourcedAt` beyond a freshness window), the ± adjustment defaults to **0** (cluster-adjacency base only) rather than guessing upward — the same "null growth → neutral 50" conservatism as `scores.ts`:36.
4. **Market never alone clears T1.** Because Market is the lowest-confidence sub-score AND the smallest (12 pts), the engine should require that a T1 PURSUE be carried by the high-confidence Basis (45) + Asset (26) sub-scores — i.e. Market upside is never the swing vote into PURSUE. (Calibration question Q3.)

---

## 6. Open calibration questions (for Gabriel)

- **Q1 — Sub-matrix granularity.** Cat 3 (20 pts) and Cat 4 (12 pts) have qualitative sub-mechanics (clear-height adequacy, construction credit, cluster tiers, ± fundamentals). The skill states the rubric; the engine needs them as **numeric piecewise functions** to be deterministic. Ratify the exact point breakpoints (e.g. PEMB = exactly 2 of 4 construction pts? satellite cluster = exactly 6 of 12 Market?) so skill and engine agree to the point.
- **Q2 — Cat 6 inverse "upside" scoring (7 pts).** Below-market rent + short WALT scoring HIGH (SKILL.md:49) is the firm's deliberate inversion of institutional convention. Define the **mark-to-market % and WALT thresholds** that map to the 7-pt scale — currently prose only.
- **Q3 — Market-as-swing-vote guard (§5.4).** Confirm the rule that a T1 PURSUE may not be carried by an `estimated` Market sub-score. If accepted it becomes a ratified band-modifier in the ruleset.
- **Q4 — Governor placement.** Confirm DSCR 1.25 / LTV 40 stay in the financial-constant layer (imported, not duplicated in the ruleset JSON) and are applied at the engine's underwrite/capital-structure stage, not as a Stage-0 acquisition gate. (Recommended; preserves invariant 4.)
- **Q5 — Replacement-Cost Table coupling.** The Basis floor + Basis score both divide by the RCT (SKILL.md:34). The engine must pin the **RCT version** in `inputsVersion` so a Basis score is reproducible. Confirm the RCT is itself versioned/ratified the same way (it is a capital-allocation input).
- **Q6 — Freshness window for Market fundamentals.** Define the `CompSet.sourcedAt` staleness threshold beyond which the ± adjustment defaults to 0 (§5.3). Suggest mirroring the 7-day STALE rule from the Master Workbook canon.

---

**Files referenced (absolute):**
- Ruleset of record (skill): `C:\Users\Owner\OneDrive - Oxford Capital Partners (1)\Claude_Workspace\01_Workspace\.claude\skills\acquisition-underwriting\SKILL.md`
- Proposed contract: `C:\Users\Owner\oxford-command-center\src\contracts\acquisition.ts` (to be created)
- Proposed config: `C:\Users\Owner\oxford-command-center\config\acquisition-ruleset.v1.json` (to be created)
- Engine: `C:\Users\Owner\oxford-command-center\server\warehouse\acquisition.ts` (Phase 4, to be built)
- Pattern sources: `C:\Users\Owner\oxford-command-center\server\warehouse\intel-config.ts`, `...\scores.ts`, `C:\Users\Owner\oxford-command-center\src\contracts\common.ts`

# Acquisition Scorecard — Drafted Answers, Failure Analysis & Governance-Correct Build Plan

**Responds to:** §6 *Open calibration questions (for Gabriel)* in `2026-06-13-acquisition-scorecard-contract.md` (Q1–Q6)
**Status:** DRAFT recommendations for Gabriel ratification — *no engine code is written or implied as "done" by this document* (mirrors the `hurdle-rate-governor-proposal` discipline: propose → ratify in-session → then encode)
**Author:** Claude Code (engineering), branch `claude/busy-maxwell-4ilaxd`
**Date:** 2026-06-13
**Verified against (read in full):** `acquisition-scorecard-contract.md`, `intel-config.ts`, `scores.ts`, `src/contracts/{common,deal,comps,index}.ts`, `src/brain/replacement-cost.ts`, `scripts/governance-check.ts`, `agent-assignments.md`, `architecture/ownership.json`, `.claude/workflows/refute-financial-change.js`, sibling specs `hurdle-rate-governor-proposal.md` · `calibration-log-design.md` · `ora-intelligence-platform-master-plan.md`.

---

## 0. The one thing to read first

Q1–Q6 are **firm-strategy decisions**, not engineering choices. Per the repo's own doctrine (`CLAUDE.md` Invariant 4; the `hurdle-rate-governor-proposal` precedent where values stay `PROPOSED` until Gabriel signs *in-session*; the `refute-financial-change` mandatory pass), I can draft, reason about, and pressure-test answers — **but I cannot ratify them, and writing them into a `ratified` config/engine would be a lie in the provenance field and a governance violation.**

So the genuinely *bulletproof* first move is **this document + Gabriel's sign-off on §7**, not engine code. Two independent blockers make "build the engine now" impossible to do without a guaranteed failure:

1. **There is nothing to score.** The `Deal` contract (`src/contracts/deal.ts`) carries `sf / estPrice / capRate / irr / equityMultiple / stage` — and *none* of the scorecard inputs (clear height, loading, construction, office %, vintage, all-in basis, stabilized YoC, levered IRR, WALT, in-place-vs-market rent, SFHA, ground-lease years, seller-motivation signals, drive-time-to-cluster, submarket fundamentals). The master plan confirms it: *"No building-characteristics data model exists"* (P2/P3, 0% built). The engine is inert until a `property_characteristics` / underwriting-input model exists.
2. **The source of record is unreadable here, and the answers aren't fully mine to invent.** The ratified ruleset lives in `SKILL.md` at `C:\Users\Owner\OneDrive…\acquisition-underwriting\SKILL.md` — a path that **does not exist in this execution container**, and `ora-skills` is outside this session's repo scope. The contract's §1 transcription is my *only* view of it; the intra-category point splits Q1 asks about (`SKILL.md:52–57`) were **not** included in that transcription, so I literally cannot read the exact band cutoffs.

**Therefore:** I implemented the only phase that can be flawless today — the decision/ratification artifact (this doc, Phase 0) — and laid out a phased, gated build for everything downstream. The gate is green (deps installed; this is a docs-only change, so `typecheck/lint/test/reconcile/warehouse:verify/governance` are unaffected — confirmed below).

---

## 1. TL;DR — recommendations at a glance

| Q | Topic | Recommendation (one line) | Conf. | Do it… | Hard-blocked by |
|---|---|---|---|---|---|
| **Q1** | Cat 3/4 sub-matrix granularity | Encode each sub-mechanic as explicit piecewise tables; **PEMB = 2/4**, **satellite = 6/12** confirmed; **exact clear-height-by-size-band cutoffs must be transcribed from `SKILL.md:52–57`** (I can't read them) | Med | Partly now; rest needs SKILL.md | `SKILL.md` access |
| **Q2** | Cat 6 inverse upside (7 pts) | Two-part: MtM-gap (0% → 0 pts, ≥30% below mkt → 5 pts, linear) + WALT-capture factor (≤2yr ×1 / 2–4yr ×0.5 / >4yr ×0), **credited only when below market** | Med | Ratify thresholds now; code later | input model (in-place vs market rent) |
| **Q3** | Market-as-swing-vote guard | **RATIFY.** Cap at T2 if the deal only reaches T1 *with* the `estimated` Market ±; cheap, deterministic, doctrine-aligned | High | Now | — |
| **Q4** | Governor placement (DSCR 1.25 / LTV 40) | **CONFIRM.** Keep in the financial-constant/governor layer, imported, applied at underwrite stage — **never** in the ruleset JSON, **never** a Stage-0 gate, **never** hardcoded in `acquisition.ts` | High | Now | (CAPITAL_CONFIG is Phase 5; until then engine marks financing test "pending") |
| **Q5** | Replacement-Cost Table coupling | **Promote RCT to a versioned, ratified `config/replacement-cost.v1.json`**; pin `rctVersion` in `inputsVersion`; current `src/brain/replacement-cost.ts` ($85–120/SF) is a v0 placeholder ("per-market figures pending") | High | Now (design); needs per-class numbers | per-building-class figures from Gabriel |
| **Q6** | Freshness window for Market ± | **Diverge from the 7-day suggestion**: fundamentals move quarterly → use **90 days**, default ± to 0 past it. *Moot in v1* because submarket stats are free-text (see FM-A4), so ± = 0 regardless until structured inputs exist | Med | Defer exact #; safe default now | structured submarket inputs |

**Necessity verdict (the "are these needed at all?" answer):** the Acquisition Engine is firm priority #1 (master-plan F4, top PScore 39.5) so the *contract* is needed — **eventually**. But **none of Q1–Q6 is actionable as code today**: the input model is absent and ratification is pending. Net: **ratify the answers now** (cheap, and it makes the Cowork skill precise immediately), **sequence the engine after the input model + NOI reconciliation gate** (master-plan Revision 1: *no scoring engine ships on un-reconciled NOI*). Q4 and Q5 are pure "confirm/version" decisions you can close today; Q6 is effectively deferrable; Q1 is the one with a true external dependency (`SKILL.md`).

---

## 2. Are these questions needed at all? (necessity triage)

| Q | Needed? | When it actually bites | If you did nothing |
|---|---|---|---|
| Q1 | **Yes — load-bearing** | The moment the engine scores Asset/Market deterministically | Skill & engine silently disagree on Cat 3/4 → two "Oxford Acquisition Scores" that differ → the exact drift the contract exists to prevent |
| Q2 | **Yes** | When in-place-vs-market rent inputs exist | Cat 6 (the firm's *signature* value-add inversion) is prose-only → engine can't reproduce the upside thesis |
| Q3 | **Yes, but cheap** | Rarely binds in v1 (see Q6/FM-A4) | A 3-pt low-confidence ± could manufacture a PURSUE off guessed market data |
| Q4 | **Yes — safety boundary** | Every score, immediately | A scorecard recalibration could silently move a governor; or governors mis-applied as acquisition gates kill all-cash-viable deals |
| Q5 | **Yes — load-bearing** | Every Basis floor + Basis score (45 of 100 pts) | A 2026 Basis score can't be reproduced after the table updates → the #1 floor becomes non-auditable; two RCT copies drift |
| Q6 | **Low — deferrable** | Only once structured submarket inputs exist | ± defaults to 0 anyway in v1; no harm in deferring the exact window |

**Meta-failure if you skip all six and "just build it":** you ship a confident-looking 0–100 score on (a) inputs that don't exist, (b) numbers transcribed from a source nobody can re-verify, (c) governors possibly hardcoded into scoring. That is *false precision feeding capital allocation* — precisely PFR-2 in the master plan's own adversarial review.

---

## 3. Drafted answers & recommendations

For each: **Recommendation · Rationale · Pros · Cons · Failure modes · Confidence · Blocks-on.**

### Q1 — Sub-matrix granularity (Cat 3 = 20 pts, Cat 4 = 12 pts)

**Recommendation.** Encode every qualitative sub-mechanic as an **explicit numeric piecewise function / lookup table** inside the ruleset JSON (never re-derived in code). Concretely for v1:

- **Cat 3 Product & Physical (20)** splits exactly as the contract states: *clear/loading 8 + product fit 5 + construction 4 + site function 3*.
  - **Construction (4):** block / tilt-up / brick = **4**; mixed = **3**; all-metal PEMB = **2** *(confirms the contract's "PEMB = 2 of 4" example).*
  - **Clear/loading (8):** split **clear-height adequacy 5 + loading 3**. Clear-height adequacy is a **size-banded step function**: full 5 at/above the band's ideal clear, 0 at the 12′ kill floor, stepped between. **⚠ The exact size→min-clear cutoffs are in `SKILL.md:52–57`, which was NOT transcribed into the contract and is not readable in this container — these must be ported verbatim by someone with SKILL.md access before this is deterministic.** Loading (3): truck-court ≥100′ ideal = full, <60′ ≈ 0 (does not kill), + dock/drive-in ratio by size.
  - **Product fit (5):** shallow-bay multi-tenant / functional single-tenant ≤40K / quasi-IOS <20K land-heavy all = **5** (skill scores them equal); scales down as office % rises toward the office-only kill.
  - **Site function (3):** truck-court depth + ground-level access + yard/parking.
- **Cat 4 Market & Location (12):** cluster-adjacency tier is the base, fundamentals ± modulates:
  - ORA-owned submarket = **12**, established cluster = **9**, entry cluster = **6**, 30-min satellite = **6** *(confirms "Market points capped at half" and the contract's "satellite = 6 of 12" example).*
  - ± fundamentals adjustment bounded to **±3**, clamped to [0,12], default **0** when stale/absent (Q6 + FM-A4).

**Rationale.** Determinism requires numbers, not prose; the contract's whole premise is skill≡engine agreement "to the point."
**Pros.** Reproducible; auditable; skill and engine provably agree.
**Cons.** The 5/3 split inside the 8, and the ±3 band, are *my* structural proposals — **not visible in the source** — so they need Gabriel's confirmation against the real rubric.
**Failure modes.** (a) If my inferred intra-category splits differ from `SKILL.md`, the two surfaces drift on Cat 3/4 even though the 100-pt totals match — undetectably, because totals reconcile. (b) Porting clear-height bands by guess would bake a wrong physical kill-adjacency in. **Mitigation:** treat all Cat 3/4 sub-points as `NEEDS-SKILL.md-VERBATIM` and refuse to ship them until transcribed; add a contract test asserting Σ sub-points = category cap.
**Confidence.** Medium (structure high; exact cutoffs unknowable here).
**Blocks-on.** `SKILL.md:52–57` access.

### Q2 — Cat 6 inverse "upside" scoring (7 pts)

**Recommendation.** Make Cat 6 a deterministic function of **mark-to-market gap** and **WALT capture timing**, credited **only when in-place rent is below market**:

```
mtmPoints  = clamp( (mtmGapPct / 0.30) * 5, 0, 5 )      // 0% below mkt → 0;  ≥30% below → 5
waltFactor = WALT ≤ 2yr ? 1 : WALT ≤ 4yr ? 0.5 : 0       // shorter WALT captures upside sooner
cat6       = mtmGapPct > 0 ? clamp(mtmPoints + 2*waltFactor, 0, 7) : 0
// 100% vacant → cat6 reallocates to Cat 7 (already specified in the contract)
```

**Rationale.** Encodes the firm's deliberate institutional inversion (below-market + short WALT = *upside*, not risk) as math. Short WALT is rewarded **only** when rents are below market; short WALT on *above-market* rents is rollover risk, not upside, and correctly scores 0 here.
**Pros.** Deterministic; faithful to the doctrine; single clamp.
**Cons.** The 30% MtM anchor and 2yr/4yr WALT bands are proposals needing ratification.
**Failure modes.** Market rent has no institutional feed (no CoStar; §5 / PFR-2), so `mtmGapPct` is itself `estimated` → Cat 6 can over-credit on a soft market-rent guess. **Mitigation:** Cat 6's confidence inherits the comp-data confidence; the Q3 guard prevents an estimated Cat 6 from swinging a deal into PURSUE.
**Confidence.** Medium. **Blocks-on.** input model (in-place rent, market rent, WALT).

### Q3 — Market-as-swing-vote guard

**Recommendation. RATIFY** as a ratified band-modifier. Compute the composite **twice** — once full, once with the Market `estimated` ± forced to 0 (cluster-adjacency `confirmed` floor only). If `full ≥ 75` **but** `confirmedFloor < 75`, **cap at T2 WATCH** and emit a reason: *"PURSUE rests on estimated market upside — capped to WATCH (Basis/Asset do not carry it alone)."*

**Rationale.** Market is both the lowest-confidence (no owned data) and smallest (12 pts) sub-score; the firm's doctrine is that owned-data Basis (45) + Asset (26) carry a buy. This makes "Market upside is never the swing vote" literal.
**Pros.** Cheap (one extra pure pass); deterministic; matches §5.4; fails safe (downgrades, never upgrades).
**Cons.** None material. **Failure modes.** Mis-assigned cluster adjacency (wrong drive-time) corrupts the `confirmed` floor — but that's deterministic/owned data, low risk; add a unit test on the drive-time→tier mapping.
**Confidence.** High. **Blocks-on.** —

### Q4 — Governor placement (DSCR 1.25 / LTV 40)

**Recommendation. CONFIRM, with one engineering nuance.** Governors stay in the financial-constant/governor layer (the `CAPITAL_CONFIG.ratified` slot the `hurdle-rate-governor-proposal` defines), are **imported** by the engine, and are applied at the **underwrite / capital-structure stage** — **never** duplicated into `acquisition-ruleset.json`, **never** a Stage-0 acquisition gate. **Nuance:** because `CAPITAL_CONFIG.ratified` is **Phase 5 and not yet encoded**, the acquisition engine must **not hardcode `1.25`/`0.40`**; until the governor layer exists it should mark the financing test **"pending — governors not yet ratified"** (fail-closed/advisory), exactly as `CAPITAL_CONFIG` refuses to rank on an empty `ratified`.

**Rationale.** A scorecard recalibration must be unable to touch a governor (Invariant 4). The skill itself models an *all-cash bid + 65% refi* (SKILL.md:95,122), so DSCR/LTV are **financing-structure tests**, not acquisition gates — applying them at Stage 0 would wrongly kill all-cash-viable deals.
**Pros.** One source of truth for governors; recalibration safety; consistent with the whole repo.
**Cons.** None. **Failure modes.** If *not* confirmed: (a) duplicated governors silently drift; (b) hardcoded `1.25` in `acquisition.ts` becomes an un-versioned governor outside the ratification gate. **Mitigation:** the nuance above (no hardcode; pending-until-ratified).
**Confidence.** High. **Blocks-on.** — (CAPITAL_CONFIG encoding is Phase 5, non-blocking for the decision).

### Q5 — Replacement-Cost Table coupling

**Finding.** An RCT already exists: `src/brain/replacement-cost.ts` → `REPLACEMENT_COST_PSF = {low:85, mid:102.5, high:120}`, basis *"ORA $85–$120/SF (building-class dependent); per-market validated figures pending."* It is **client-side (UX-owned `src/brain/`), unversioned, unratified, and "unwired"** (master-plan §0.2).

**Recommendation.**
1. **Promote** the RCT to a versioned, ratified artifact: `config/replacement-cost.v1.json` with `RCT_VERSION`, a **building-class × market matrix** (replacing the single firm-wide range), and ratification provenance — *same discipline as the ruleset*.
2. The engine **pins `rctVersion` inside `inputsVersion`** so any Basis score is reproducible years later (ties into the calibration-log `inputs_version` concept).
3. **Confirm** the current $85–120 single range is a **v0 placeholder**; v1 needs the per-class (ideally per-market) figures the file itself says are "pending."

**Rationale.** Basis floor + Basis score both divide by the RCT, and Basis+Yield = 45 of the 100 platform points — it is the single most load-bearing input. A capital-allocation divisor must be versioned/ratified, not a loose client constant.
**Pros.** Reproducibility; governance parity; kills the two-copies-drift risk.
**Cons.** Creates `config/` and eventually migrates a `src/brain/` constant (UX-owned) — needs ownership coordination.
**Failure modes.** Unversioned RCT ⇒ a 2026 Basis score is non-reproducible after any table update ⇒ the #1 floor becomes non-auditable. **Mitigation:** version + archive-on-bump (never overwrite), mirroring the ruleset rule.
**Confidence.** High (design). **Blocks-on.** per-building-class $/SF figures from Gabriel.

### Q6 — Freshness window for Market fundamentals

**Recommendation. Diverge from the suggested 7-day rule for *fundamentals*.** The 7-day STALE rule fits **rates** (which move daily — see the Daily Brief's SOURCE_DEGRADED handling). Submarket **fundamentals** (vacancy, rent growth, supply) move **quarterly**, so a 7-day window would null them out almost always. Use **90 days** for `CompSet.sourcedAt`; past it, the ± adjustment defaults to **0** (cluster-adjacency base only) — conservative, never an upward guess.

**Critical caveat (FM-A4).** In v1 this is **moot**: `SubmarketStat.value` is a **free-form string** (`comps.ts:31`), so vacancy/rent-growth/supply can't be parsed into a deterministic ± at all. Until structured numeric submarket inputs exist, **the ± adjustment is 0 regardless of freshness.** So: adopt 90 days as the *eventual* policy, ship v1 with ± = 0, and revisit the exact window when structured inputs land.

**Pros.** Matches the data's real cadence; conservative; firm-consistent default-to-0.
**Cons.** Diverges from the literal suggestion (justified).
**Failure modes.** Too tight → Market loses its fundamentals signal (acceptable given low confidence + Q3 guard); too loose → stale vacancy inflates a PURSUE (mitigated by Q3 + `estimated` confidence).
**Confidence.** Medium. **Blocks-on.** structured submarket inputs.

---

## 4. Failure-mode register (everything the investigation surfaced)

| ID | Severity | Failure | Mitigation / where handled |
|----|----------|---------|----------------------------|
| **FM-A1** | High | **`SKILL.md` is unreadable in this container** (Windows OneDrive path) and `ora-skills` is out of repo scope → the contract's §1 transcription is the *sole* source and can't be re-verified; Q1 sub-matrix cutoffs are missing entirely | Treat §1 as authoritative-by-citation; tag Cat 3/4 sub-points `NEEDS-SKILL.md-VERBATIM`; add the CI drift-diff (contract §4.1) between the JSON and the skill's copy before trusting parity |
| **FM-A2** | High | **No input model.** `Deal` carries none of the scorecard inputs; `property_characteristics` is planned but 0% built | Engine build is **gated behind** an `AcquisitionInput`/characteristics contract (Plan Phase 2). The engine is inert without it — do not build scorer-before-inputs |
| **FM-A3** | Med | **`Market` enum can't name the clusters.** `common.ts` Market lacks Cincinnati, Madison WI, Grand Rapids, Richmond, Des Moines, MD/DC | Clusters are free-string arrays in the ruleset (already so in the contract sketch); **do not** reuse the `Market` enum for cluster identity in `AcquisitionScore` |
| **FM-A4** | High | **Submarket stats are free-text** (`SubmarketStat.value: string`) → the Market ± fundamentals adjustment is **not computable deterministically** | v1 ± defaults to 0 (Q6); a future structured-submarket contract is its own work item; Market sub-score = cluster-adjacency only until then |
| **FM-A5** | Med | **Ratification home absent.** `config/` and `memory/event_log.md` (the §4.2 sign-off log) **do not exist** | Plan Phase 1 creates `config/`; the human sign-off log location must be decided with Gabriel (create `memory/event_log.md`, or record in the calibration-log SQLite, or in-PR) |
| **FM-A6** | Med | **RCT unversioned + client-side + unwired** | Q5: promote to `config/replacement-cost.v1.json`, version + pin in `inputsVersion` |
| **FM-A7** | Med | **Governors not yet encoded** (`CAPITAL_CONFIG.ratified` is Phase 5) | Q4 nuance: engine imports governors, never hardcodes; financing test = "pending" until the layer exists |
| **FM-A8** | Med | **Architect-owned surface.** `src/contracts/acquisition.ts` + the `src/contracts/index.ts` barrel edit are **Architect-only**; a new engine + `config/` + a new API route + Acquisitions UI cross Analytics/UX ownership and require architect sign-off + `status.json` `review_needed` | Plan stages each behind the claim protocol; this doc touches **only** unowned `docs/` |
| **FM-A9** | High | **Determinism boundary.** The LLM may populate inputs / narrate, but must **never move the number** | Engine is a pure `f(inputs, ruleset)`; LLM output enters only as validated inputs; enforce with a determinism test (same inputs → byte-identical score), mirroring `scores.ts` |
| **FM-A10** | High | **Ratification authority.** These are firm-strategy decisions; self-ratifying them in code violates Invariant 4 + the `refute-financial-change` mandate | This doc proposes; §7 is Gabriel's to sign; the engine PR additionally runs the adversarial refute pass before "done" |
| **FM-A11** | Low | Gate not runnable without deps (`node_modules` was absent) | Resolved: deps installed; docs-only change leaves the gate green (verified §6) |
| **FM-A12** | Med | **NOI-reconciliation precedence.** Master-plan Revision 1: *no scoring engine ships on un-reconciled NOI*; Basis/Yield floors touch NOI-like figures | Acquisition v1 scores the *target's* independently-reconciled broker numbers + comps (Revision 3), not portfolio Spine-A NOI; record the basis explicitly |

---

## 5. Proposed v1 ruleset (concrete — `PROPOSED`, not ratified, not wired)

This is the artifact Gabriel ratifies. It is shown here as a JSON block **only** — it is deliberately **not** written to `config/` and **not** wired to a contract/engine, so nothing un-ratified can be loaded. Fields needing the source or an input model are tagged.

```jsonc
{
  "rulesetVersion": "1.0.0",
  "ratification": "proposed",              // becomes "ratified" only on Gabriel sign-off (§7)
  "calibratedWith": "Gabriel Goldberg 2026-06-09",
  "skillVersion": "acquisition-underwriting v3.0",

  "gates": {                               // STAGE 0 — bounds, NOT governors (Q4)
    "sizePrice": { "singleAssetPriceMin": 500000, "singleAssetPriceMax": 10000000,
                   "portfolioPriceMax": 15000000, "maxSfPerBuilding": 50000 },
    "physical":  { "minClearHeightFt": 12 },
    "flood":     { "sfhaOnPadKills": true, "sfhaOnLandValuesAtZero": true },
    "other":     { "minGroundLeaseYearsRemaining": 30, "maxEnvRemediationPctOfPrice": 0.20 },
    "establishedClusters": ["Columbus OH","Cincinnati OH","Kansas City","Indianapolis IN","Maryland/DC","Madison WI"],
    "entryClusters":       ["Grand Rapids MI","Richmond VA","Des Moines IA"],
    "satelliteMaxDriveMinutes": 30
  },

  "floors": {                              // STAGE 1 — no score overrides a floor
    "basisDiscountMinPostMillennium": 0.25, "basisDiscountMinPreMillennium": 0.30,
    "basisVintageCutoffYear": 2000, "stabilizedYocFloorPct": 0.08,
    "leveredIrrFloor5yr": 0.15, "leveredIrrFloor10yr": 0.12
  },

  "scorecard": [                           // STAGE 2 — must total 100
    { "id": "basis",             "points": 25, "subScore": "basis" },
    { "id": "yield",             "points": 20, "subScore": "basis" },
    { "id": "product-physical",  "points": 20, "subScore": "asset" },
    { "id": "market-location",   "points": 12, "subScore": "market" },
    { "id": "seller-motivation", "points": 10, "subScore": "risk" },
    { "id": "tenancy-lease",     "points": 7,  "subScore": "risk",  "vacantPoints": 0, "reallocatesToWhenVacant": "value-add" },
    { "id": "value-add",         "points": 6,  "subScore": "asset", "vacantPoints": 13 }
  ],

  "scoring": {
    "basisFullCreditDiscount": 0.55,       // 25 pts at ≥55% discount (linear from vintage floor)
    "yocZeroPct": 0.08, "yocFullPct": 0.11,

    // Q1 — Cat 3/4 piecewise (PEMB=2/4 and satellite=6/12 CONFIRMED; clear-height bands NEED SKILL.md)
    "cat3": {
      "clearLoadingSplit": { "clearHeight": 5, "loading": 3 },
      "construction": { "blockTiltBrick": 4, "mixed": 3, "pemb": 2 },
      "clearHeightBands": "NEEDS-SKILL.md:52-57 — size→min-clear cutoffs, transcribe verbatim",
      "truckCourt": { "idealFt": 100, "zeroAtFt": 60, "kills": false }
    },
    "cat4": {
      "tierPoints": { "ownedSubmarket": 12, "established": 9, "entry": 6, "satellite": 6 },
      "fundamentalsAdjustMax": 3, "staleDefault": 0
    },
    // Q2 — Cat 6 inverse upside
    "cat6": { "mtmFullDiscountPct": 0.30, "mtmMaxPoints": 5,
              "waltSweetSpotYr": 2, "waltDecayYr": 4, "waltMaxPoints": 2,
              "creditOnlyWhenBelowMarket": true }
  },

  // Q3 — RATIFY: market-estimated ± may not be the swing vote into T1
  "guards": { "marketEstimatedCannotCarryT1": true },

  // Q6 — fundamentals freshness (90d for quarterly data; v1 ± is 0 until structured inputs exist)
  "freshness": { "marketFundamentalsWindowDays": 90, "staleAction": "zero-adjustment" },

  "ddCritical": ["flood","zoning","roof","deferred-maintenance-capex"],
  "bands": { "t1PursueMin": 75, "t2WatchMin": 60 },

  // Q5 — governors imported, never embedded here; RCT versioned + pinned
  "imports": { "governors": "CAPITAL_CONFIG.ratified (Phase 5; financing test 'pending' until encoded)",
               "replacementCost": "config/replacement-cost.v1.json @ RCT_VERSION" }
}
```

---

## 6. Phased execution plan (governance-correct, gated)

Each phase: deliverable · files · owner · gate · **precondition** · adversarial review. **No phase starts until its precondition is met** — that is what makes the plan bulletproof rather than optimistic.

| Phase | Deliverable | Key files | Owner / sign-off | Precondition | Gate / review |
|------|-------------|-----------|------------------|--------------|---------------|
| **P0 ✅ (this doc)** | Drafted answers, failure register, ratification list | `docs/superpowers/specs/2026-06-13-acquisition-scorecard-answers-and-build-plan.md` | Me (docs unowned) | — | Gate unaffected (docs-only); verified green |
| **P1** | Ratify §7; transcribe `SKILL.md:52–57`; finalize ruleset → `config/acquisition-ruleset.v1.json` (`ratified`) + RCT `config/replacement-cost.v1.json` | `config/*`, `src/contracts/acquisition.ts`, `src/contracts/index.ts` | **Architect (Gabriel)** — `src/contracts/` is Architect-only; post `status.json review_needed` | Gabriel signs §7 **+** SKILL.md cutoffs supplied | typecheck/lint/test + new contract test (Σpoints=100; ratified-vs-proposed) |
| **P2** | `AcquisitionInput` / `property_characteristics` model (the inputs the score needs) | `src/contracts/acquisition.ts`, warehouse characteristics table + migration | Architect + Analytics | P1 ratified; migration approved (Architect-only `migrations/`) | full gate; **NOI-reconciliation precedence (FM-A12)** respected |
| **P3** | Deterministic engine `server/warehouse/acquisition.ts` — pure `f(input, ruleset)`; gates→floors→DD-cap→band; Q3 guard; fail-closed on version mismatch | `server/warehouse/acquisition.ts` (+ tests) | Analytics + Architect | P2 input model exists | full gate + **MANDATORY `refute-financial-change`** (determinism, edge, governor-leak lenses) |
| **P4** | Wire `acquisition-score` into the calibration log (reserved kind already in the schema) | `server/warehouse/calibration.ts`, `actions.ts` | Analytics + Architect | calibration-log Phase 1 shipped | full gate; fail-open logging proof |
| **P5** | API route + Acquisition Workbench UI (score gauge, gates/floors, reasons, confidence) | `server/index.ts` (route mount — Architect), `server/warehouse/api.ts`, `src/modules/acquisitions/*` | Architect + UX | P3 engine green | full gate + confidentiality test (PFR-6: redaction covers acquisition scores) |

**Cross-cutting (every code phase):** explicit-path commits only; `status.json` updated before/after; any dev/preview server stopped before returning (it holds the SQLite WAL lock); `inputsVersion` stamps `rulesetVersion` + `rctVersion` + code SHA.

---

## 7. Gabriel's ratification decision list (sign-off-ready)

Crisp, one decision each (mirrors `hurdle-rate-governor-proposal` §6). Reply with a yes / reprice per line.

1. **D1 — Cat 3/4 structure (Q1):** approve piecewise tables with **PEMB = 2/4** and **satellite = 6/12**? *(And: can you supply `SKILL.md:52–57` clear-height-by-size-band cutoffs + the intra-Cat-3 5/3 split, which I can't read here?)*
2. **D2 — Cat 6 (Q2):** ratify **MtM: 0%→0pts, ≥30%-below→5pts linear**, **WALT factor ≤2yr×1 / 2–4yr×0.5 / >4yr×0**, credited only below market?
3. **D3 — Market swing-vote guard (Q3):** ratify that an `estimated` Market ± **cannot** carry a deal into T1 PURSUE (caps to WATCH)?
4. **D4 — Governor placement (Q4):** confirm DSCR 1.25 / LTV 40 stay in the governor layer, imported, applied at underwrite — **never** in the ruleset, **never** a Stage-0 gate, **never** hardcoded?
5. **D5 — RCT (Q5):** approve promoting the Replacement-Cost Table to a **versioned, ratified `config/` file** with per-building-class figures, pinned in `inputsVersion`? *(And: supply per-class $/SF, or confirm $85–120 mid-102.5 as a v0 placeholder?)*
6. **D6 — Freshness (Q6):** approve **90-day** fundamentals window (vs. 7-day), with ± defaulting to 0 — and accept that v1 ± = 0 until structured submarket inputs exist?
7. **D7 — Sign-off log (FM-A5):** where should ratification provenance live — create `memory/event_log.md`, the calibration-log SQLite, or in-PR record?
8. **D8 — Sequencing & authority:** approve the §6 phasing (input model + NOI-reconciliation gate **before** the engine), and grant architect sign-off to touch `src/contracts/` when P1 begins?

---

## 8. What I deliberately did NOT do, and why

- **No engine, contract, or config code.** Q1–Q6 are unratified firm strategy; encoding them as `ratified` would falsify provenance (Invariant 4) and skip the mandatory adversarial pass. The `hurdle-rate-governor-proposal` set the precedent: *"this section records the decision, not a model edit."*
- **No edits to Architect-owned files** (`src/contracts/`, `server/index.ts`, migrations) — those require `status.json review_needed` + Gabriel's ack first (FM-A8).
- **No fabricated cutoffs.** Where the source (`SKILL.md`) is unreadable, I flagged `NEEDS-SKILL.md-VERBATIM` rather than guess a number into a capital-allocation path.
- **Touched only unowned `docs/`.** This document is the single file added; the gate is unaffected.

**Ready to proceed to P1 the moment §7 is signed and the `SKILL.md` cutoffs are supplied.**

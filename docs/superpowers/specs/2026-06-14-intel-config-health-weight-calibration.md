# INTEL_CONFIG Health-Weight Calibration — Recommendations & Ratification List

**Responds to:** the open item flagged since 2026-06-13 — `INTEL_CONFIG.healthWeights` are **PROPOSED, pending Gabriel's calibration** (`server/warehouse/intel-config.ts:4`, `:21`); the *live* per-property **capital-action verdicts** (invest/hold/monitor/disposition-candidate) run on these unratified weights (master plan Risk #7 / PFR-5).
**Status:** ✅ RATIFIED — Gabriel 2026-06-14 ("All ok" to D1–D5; see §7 + `memory/event_log.md`). The recommended set (Option B + knobs) is now encoded in `intel-config.ts` in this PR; the `refute-financial-change` pass came back clean (no real defect). Same propose→ratify→encode discipline as the acquisition scorecard (#23→#27) and `CAPITAL_CONFIG` (#31).
**Author:** Claude Code · **Date:** 2026-06-14 · **Branch:** `claude/busy-maxwell-4ilaxd`
**Verified against:** `intel-config.ts`, `scores.ts` (how each weight is consumed), `capital-config.ts` (#31 ratify pattern), `2026-06-13-calibration-log-design.md` (#34 — the evidence loop that will refine these).

---

## 0. The one thing to read first

These ten weights are a **prior**, not a fit. The score-vs-outcome calibration log (#34) exists precisely to refine them with evidence — but it has **no resolved outcomes yet** (the design states the first ~5 years are data-accumulation). So the right move today is **not** to "optimize" weights against data we don't have; it is to **ratify a defensible, reasoned starting set** so the live verdicts stop resting on an unratified default, and to let the calibration log discipline them over time (with the design's ±0.05/yr anti-overfit cap). I recommend a modest, principled re-weight; ratifying the current set unchanged is a valid conservative alternative.

I cannot ratify these — they encode firm investment judgment (how much NOI growth matters vs. cost efficiency vs. relative rank). §5 is yours to sign.

---

## 1. Current state — what each weight drives (`scores.ts`)

`health` (0–100) = Σ `healthWeights[k] × subScore[k]`; the band (`excellent≥80 / good≥65 / watch≥50 / concern`) and, with the attention band + NOI/SF quartile, the **capital-action verdict**. Weights sum to 1.0.

| Sub-score | Current | What it measures (scores.ts) |
|---|---|---|
| noiGrowth | 0.18 | YoY NOI growth (same-grain) |
| noiPerSfGrowth | 0.15 | YoY NOI/SF growth |
| revenueGrowth | 0.12 | YoY revenue growth |
| revenuePerSfGrowth | 0.10 | YoY revenue/SF growth |
| expenseEfficiency | 0.10 | opex ratio vs same-basis peer median (lower = better) |
| benchmarkPosition | 0.10 | NOI/SF quartile rank in the portfolio |
| marginStability | 0.07 | inverse of NOI-margin volatility over history |
| taxEfficiency | 0.06 | taxes/SF vs peers |
| insuranceEfficiency | 0.06 | insurance/SF vs peers |
| repairEfficiency | 0.06 | repairs/SF vs peers |

Also PROPOSED (per the file): `anomaly.categorySpikePct = 0.25`, `growthScoreCapPct = 0.20`. Ratified already: the four anomaly decline/growth thresholds. Band cutoffs `80/65/50` are implicit judgment.

---

## 2. Recommended weights (Option B) + rationale

**Thesis:** ORA is a long-horizon buy-and-hold compounding on **NOI**, with a basis-discipline / cost-control overlay. The score should lean harder on NOI(/SF) growth, trim the revenue-side double-count, and slightly de-weight the small-N relative rank.

| Sub-score | Current | **Recommended** | Δ | Why |
|---|---|---|---|---|
| noiGrowth | 0.18 | **0.22** | +0.04 | NOI growth IS the compounding engine for a hold; it should dominate. |
| noiPerSfGrowth | 0.15 | **0.18** | +0.03 | SF-normalized NOI growth = quality of that growth (controls for SF changes). |
| revenueGrowth | 0.12 | **0.10** | −0.02 | Revenue matters but is upstream of NOI; trim to avoid over-rewarding top-line that doesn't reach NOI. |
| revenuePerSfGrowth | 0.10 | **0.08** | −0.02 | Partly redundant with revenueGrowth + noiPerSfGrowth. |
| expenseEfficiency | 0.10 | **0.10** | — | Opex ratio is the core cost-control signal; keep. |
| benchmarkPosition | 0.10 | **0.10** | — | Keep, but see FM-1: small-N (14 props, same-basis cohorts often <5) makes the quartile noisy; the calibration log should be watched to justify this 0.10. |
| marginStability | 0.07 | **0.07** | — | Volatility penalty for a hold; modest is right. |
| taxEfficiency | 0.06 | **0.05** | −0.01 | Cost ratios are secondary to NOI growth; trim the trio. |
| insuranceEfficiency | 0.06 | **0.05** | −0.01 | " |
| repairEfficiency | 0.06 | **0.05** | −0.01 | " |
| **Σ** | **1.00** | **1.00** | | NOI-centric block 0.33→**0.40**; efficiency 0.28→**0.25**; revenue 0.22→**0.18**. |

**Ready-to-encode block (on ratification):**
```ts
healthWeights: {
  noiGrowth: 0.22, noiPerSfGrowth: 0.18,
  revenueGrowth: 0.10, revenuePerSfGrowth: 0.08,
  expenseEfficiency: 0.10, benchmarkPosition: 0.10, marginStability: 0.07,
  taxEfficiency: 0.05, insuranceEfficiency: 0.05, repairEfficiency: 0.05,
}, // RATIFIED — Gabriel 2026-06-14
```

**Option A (conservative):** ratify the *current* set unchanged. It's already reasonable; the only hard requirement is that *some* set is ratified so verdicts aren't running on an explicit "PROPOSED — calibrate" default.

---

## 3. The other PROPOSED knobs

- **`growthScoreCapPct = 0.20`** — maps ±20% YoY growth to the 0–100 sub-score ends. **Recommend ratify 0.20.** For shallow-bay with contractual escalators, ±20% spans normal-to-exceptional; a property at +20% NOI/SF deserves a near-max sub-score. (Lower = saturates too early; higher = compresses real differences.)
- **`anomaly.categorySpikePct = 0.25`** — flags a tax/insurance/repair/utility line jumping ≥25% YoY. **Recommend ratify 0.25**, but note FM-3: it's a flat % with no dollar floor, so a tiny line (e.g. $400→$520) trips it. Consider an absolute-dollar floor in a later pass (out of scope here).
- **Band cutoffs `80/65/50`** — **Recommend confirm as-is.** They're the verdict thresholds; changing them is a separate, higher-stakes lever best left until the calibration log shows the score distribution is mis-banded.

---

## 4. Failure-mode register

| ID | Sev | Issue | Mitigation |
|----|-----|-------|------------|
| **FM-1** | Med | **benchmarkPosition is small-N noisy.** Same-basis cohorts are often <5 (14 props split by cash/accrual/tax); a quartile rank then swings on one peer. `scores.ts` already neutralizes a singleton cohort to 50, but a 3–4 cohort still moves the 0.10 weight on thin evidence. | Keep 0.10 for now; flag it as the #1 weight for the calibration log to validate/cut first. |
| **FM-2** | Med | **These weights gate REAL attention.** `capitalAction` (incl. `disposition-candidate`) is computed from `health` + attention + quartile; a mis-weighted score could mislabel a property. | This is exactly why ratification + the calibration loop matter; the verdict is advisory (recommends, never executes — Invariant 1). |
| **FM-3** | Low | `categorySpikePct` flat % with no $ floor → false spikes on tiny lines. | Note for a later anomaly pass; not ratified-blocking. |
| **FM-4** | Low | **Overfit risk once data arrives.** A future data-fit could chase 14-property noise. | The design's ±0.05/yr move cap + Wilson-interval reporting + treatment-effect adjustment (acted-vs-not) are already specced (#34 §4.3, §5). |
| **FM-5** | Info | Cross-basis: efficiency/benchmark sub-scores already compare within same-basis only (PFI 1a, `scores.ts` G3). No action. |

---

## 5. Ratification decision list (sign-off ready)

1. **D1 — Weight set:** adopt **Option B** (NOI-centric re-weight, §2), or **Option A** (ratify current unchanged)? *(Recommend B.)*
2. **D2 — `growthScoreCapPct`:** ratify **0.20**?
3. **D3 — `categorySpikePct`:** ratify **0.25** (dollar-floor refinement deferred)?
4. **D4 — Band cutoffs:** confirm **80 / 65 / 50** unchanged?
5. **D5 — Refinement governance:** confirm the calibration log (#34) is the *only* path to future weight changes — annual review, evidence-backed, ±0.05/yr cap, your sign-off each time (no silent edits)?

---

## 6. On ratification, I will (mirrors CAPITAL_CONFIG #31)

1. Encode the ratified weights in `intel-config.ts`, flipping the `// PROPOSED — calibrate` comments to `// RATIFIED — Gabriel 2026-06-14` (Analytics-owned; explicit-path commit).
2. Record the sign-off in `memory/event_log.md` and, per the #31/#34 pattern, append a calibration-log/provenance entry so the `config_hash` fork is dated and reproducible.
3. Add a contract/test assertion that `Σ healthWeights === 1.0` (guards a future typo) and a note that any change re-runs the `refute-financial-change` pass (these feed capital-action).
4. **No band/threshold or governor change** rides along — only the ratified weights.

---

## 7. Ratification — signed 2026-06-14 ✅

**Gabriel: "All ok"** → **D1 = Option B** (NOI-centric reweight) · **D2 = 0.20** · **D3 = 0.25** · **D4 = 80 / 65 / 50** · **D5 = calibration-log-only** (annual, evidence-backed, ±0.05/yr, his sign-off each time).

§6 executed in this PR: weights encoded in `server/warehouse/intel-config.ts` (PROPOSED→RATIFIED); sign-off in `memory/event_log.md`; the exact ratified values locked by `tests/unit/intel-config.test.ts`, and `config_json` reproducibility by `tests/unit/calibration.test.ts`. The `refute-financial-change` pass (numerical / capital-action / provenance lenses) returned **no real defect** — and surfaced two doc-drift fixes (a stale `0.18` in the #34 design doc; a misleading `intel-config.ts` header), both applied. No band/threshold or governor change rode along.

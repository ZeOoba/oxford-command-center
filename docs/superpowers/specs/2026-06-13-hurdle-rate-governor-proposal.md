# Hurdle-Rate / Cost-of-Capital Governor — PROPOSAL (pending Gabriel ratification)

**Status:** Payout assumption RATIFIED (Gabriel, 2026-06-13); governor VALUES confirmed under that assumption as the working basis. They become hard governor-class constants when Phase 5 encodes `CAPITAL_CONFIG.ratified` — any change THEN requires explicit in-turn sign-off (Hard Invariant 4).
**Prepared by:** CIO / Head of Acquisitions
**For:** Command Center — Capital Allocation Engine (Phase 5)
**Date:** 2026-06-13

---

## 0. RATIFIED — Gabriel, 2026-06-13

- **Payout ratio = FULL REINVEST (0% distribution).** The single highest-leverage input (§3.39) is settled: no payout grossing-up. The equity base must compound at the **net CAGR floor itself, ~7.48%** (35yr, $60M→$750M midpoint) — the gross asset return requirement does NOT rise above it.
- **Confirmed working governor set** (no upward adjustment needed under full reinvest; the proposed §4 numbers were sized for a 15–25% payout band and are therefore, if anything, conservative here):

  | Governor | Ratified-basis value | Measured on |
  |---|---|---|
  | `HURDLE_UNLEVERED_HOLD` | **7.5%** | forward unlevered yield on current MV |
  | `HURDLE_LEVERED_ACQ_IRR` | **12.0%** | levered equity IRR, full hold |
  | `DISPOSITION_TRIGGER` | **6.5%** (hold − 100 bps) | forward unlevered on current MV |
  | `REFINANCE_TRIGGER` | **+150 bps** IRR accretion | Δ levered equity IRR; DSCR ≥ 1.25 / LTV ≤ 40 hard side-constraints |
  | `HURDLE_CAPEX_IRR` | **15.0%** | incremental unlevered IRR on the capex $ |

  Ordering invariant (load-bearing, survives any future reprice): **DISPOSITION 6.5% < HOLD 7.5% < ACQ-IRR 12% < CAPEX-IRR 15%.**
- **Anchor:** 35-year horizon, $60M→$750M (7.48% floor) — assumed as the canonical anchor unless Gabriel reprices at `CAPITAL_CONFIG` build time.
- **Still pending (non-blocking, finalize at Phase-5 `CAPITAL_CONFIG` encoding):** the [SPECULATIVE] cost-of-debt / cap-rate-environment inputs (§3) refined against the live workbook + rent-comps; and the formal mint into `CAPITAL_CONFIG.ratified` with provenance. Until that code exists, no governor constant has been modified — this section records the decision, not a model edit.

---

## 1. Purpose & the single-axis problem

Phase 5 must rank five mutually-competing actions — **Buy / Hold / Sell / Refinance / Improve** — on **one** risk-adjusted axis so that "buy this asset" and "hold that one" and "deploy capex here" are directly comparable claims on the same scarce dollar. Today each is scored in its own units (going-in cap rate, levered IRR, payback, debt yield). Those are not commensurable. The engine needs a common numéraire: **does this action's forward return clear the firm's marginal cost of capital, and by how much?**

That marginal cost of capital is a **governor-class constant** — same protection class as DSCR ≥ 1.25x and LTV ≤ 40%. It is the one number that, set wrong, silently mis-allocates every dollar the engine touches. Hence: mechanism now, values proposed, ratification gated.

---

## 2. The CAGR floor — what reinvested capital must beat

The AUM goal is not a slogan; it is a binding constraint that sets the **floor** below which an action *destroys* the trajectory. From ~$60M to $700–800M:

| Horizon | → $700M | → $750M (midpoint) | → $800M | Growth multiple |
|---|---|---|---|---|
| **30 yr** | 8.53% | **8.78%** | 9.02% | 11.7–13.3x |
| **35 yr** | 7.27% | **7.48%** | 7.68% | 11.7–13.3x |
| **40 yr** | 6.33% | **6.52%** | 6.69% | 11.7–13.3x |

*Method:* CAGR = (End/Start)^(1/yrs) − 1. The midpoint case (35yr, $60M→$750M) requires **7.48%** compounded, ~3.6 doublings, one doubling every ~9.6 years.

**Critical refinement — this is a NET-OF-DISTRIBUTION floor.** 7.48% is the rate the *equity base must compound at after everything paid out*. A family office that distributes cash cannot reinvest 100% of return. If the firm pays out a portion of total return to the principals, the **gross total return each asset must earn** rises sharply:

| Distribution / payout | Required GROSS total return on capital (35yr → $750M) |
|---|---|
| 0% (full reinvest) | ~7.48% |
| 20% | ~9.35% |
| 30% | ~10.69% |
| 40% | ~12.47% |

**[SPECULATIVE]** ORA's actual payout ratio is not in the source of record and must be supplied by Gabriel. This single input moves the hurdle by 300–500 bps and is the **highest-leverage unknown in this spec.** The proposals below assume a **modest 15–25% payout** band, consistent with a long-horizon family office reinvesting most of its return. If ORA runs hotter on distributions, every hurdle below shifts up.

**The floor, stated plainly:** *Any action whose forward risk-adjusted return is below the CAGR floor is trajectory-dilutive — it is a decision to arrive at less than $750M.* The hurdle rate must therefore sit **at or above** the floor, never below it.

---

## 3. Capital structure — why ORA's hurdle is high, not low

LTV ≤ 40% is the decisive fact. ORA is **equity-heavy by mandate**, so its blended cost of capital is dominated by the cost of *equity*, not the cost of *debt*. Cheap leverage cannot drag the blend down because the firm refuses to use much of it.

A WACC sketch **[SPECULATIVE — illustrative, not ratified]**:
- Cost of equity (required): the CAGR floor grossed for payout → call it **~9–10%** at the asset level.
- Cost of debt (industrial, current environment, 40% LTV, strong DSCR): **[SPECULATIVE] ~6.0–6.75%** all-in, ~4.5–5.0% after the firm's tax posture **[SPECULATIVE — entity tax treatment unverified]**.
- Blend at 40/60 D/E: WACC ≈ 0.40 × 5.0% + 0.60 × 9.5% ≈ **~7.7%**, with most of the weight on equity.

Two structural consequences drive every proposed number:
1. **The unlevered hurdle and the WACC are close together**, because there is so little debt to create a spread. ORA does not get to hide behind cheap leverage.
2. **The levered equity hurdle must clear a meaningful premium over the unlevered hurdle** — the equity is concentrated and illiquid, and at 40% LTV the leverage adds only modest amplification, so the IRR premium for taking concentrated equity risk must be real.

Industrial/flex Class B/C cap-rate environment **[SPECULATIVE — mid-single-digits, ~6.0–7.5% going-in for the sub-$10M shallow-bay box; refine against the live Master Workbook and rent-comp skill]** sits *below* the gross equity hurdle. That is the central tension the governor resolves: **buying at-market cap rates does not, by itself, clear the hurdle** — value-add execution, yield-on-cost expansion, or below-replacement basis must close the gap.

---

## 4. PROPOSED governor constants

All values **PROPOSED**. Each carries logic, not just a number. Ranges are tight on purpose — this is a decision document, not an options menu.

### 4.1 `HURDLE_UNLEVERED_HOLD` — forward unlevered yield to justify *holding*
**PROPOSED: 7.5%** (band 7.25–7.75%)
*Logic:* This is the "hold test." An asset earns the right to stay in the portfolio only if its **forward unlevered return** (forward NOI yield on *current market value* + organic NOI growth, i.e. forward yield-on-current-value) clears the CAGR floor. Anchored to the 35yr midpoint floor (7.48%) rounded to **7.5%**. Below this, the equity trapped in the asset compounds too slowly to reach $750M and should be recycled. Note this is measured on **mark-to-market value, not original basis** — an asset bought at 8% that has compressed to a 5.5% forward yield on today's value is *failing the hold test even though it looks like a winner on cost.* That is the disposition signal Phase 5 is built to surface.

### 4.2 `HURDLE_LEVERED_ACQ_IRR` — levered equity IRR to justify a *new acquisition*
**PROPOSED: 12.0%** (band 11–13%)
*Logic:* New capital must clear a premium over the hold hurdle for three reasons: (a) acquisition friction and J-curve drag, (b) concentrated, illiquid family-office equity demands an illiquidity/concentration premium of ~300–450 bps over the unlevered floor, (c) at 40% LTV the leverage uplift over unlevered is modest, so the *equity* number must do the work. 12% levered IRR over a long hold, on a sub-$10M Class B/C box, is a disciplined bar that screens out at-market deals and forces value-add or below-replacement basis. **Pairs with the existing acquisition-underwriting scorecard** — this is the IRR floor a deal must clear *after* passing the DSCR/LTV gates, not a replacement for them.

### 4.3 `DISPOSITION_TRIGGER` — sell when forward unlevered return drops below hurdle minus a band
**PROPOSED: sell-review trigger at HURDLE_UNLEVERED_HOLD − 100 bps → 6.5%**
*Logic:* A band prevents churn from noise. An asset is flagged **SELL-REVIEW** (not auto-sell — this is a recommendation engine, not an execution path; Invariant 1 stands) when its **forward unlevered return on current market value falls below 6.5%**. Rationale: a 100 bps band below the 7.5% hold hurdle distinguishes "underperforming but recoverable" from "structurally trajectory-dilutive — recycle the equity into a deal that clears 12% levered." The disposition logic must net **frictional cost of sale (~5–7% round-trip [SPECULATIVE]) and the tax drag on recycled capital** against the hold-vs-sell delta before firing. The trigger surfaces candidates; the cost-netted comparison ranks them.

### 4.4 `REFINANCE_TRIGGER` — refinance when it accretes to equity return
**PROPOSED: pursue-refi when refi lifts levered equity IRR by ≥ 150 bps *and* keeps DSCR ≥ 1.25x and LTV ≤ 40% post-refi**
*Logic:* Refinance is not a rate-driven reflex at this firm — at 40% LTV the equity cushion is enormous, so refi is a **capital-efficiency** decision, not a survival one. Fire the trigger when pulling/resetting debt (cash-out to redeploy, or rate improvement) raises the asset's forward levered equity IRR by a material margin **without breaching either standing governor**. The 150 bps accretion bar ensures the transaction cost and reset of the loan clock are earned. **The two existing governors are hard side-constraints here — refi can never be the path that pushes LTV past 40% or DSCR under 1.25x.**

### 4.5 `HURDLE_CAPEX_IRR` — improve/value-add capital must clear the highest bar
**PROPOSED: 15.0%** (band 14–16%)
*Logic:* Incremental capex is the **most discretionary and highest-risk** dollar — execution risk, lease-up risk, cost overrun. It must clear the highest hurdle: **~300 bps over the new-acquisition IRR hurdle.** A roof, a demising wall, a spec suite, or a TI package competes against *buying another building*, and it should only win when its incremental, unlevered, fully-loaded IRR on the marginal dollar clears 15%. This is the bar that stops "improve" from becoming a default sink for capital that would compound faster deployed elsewhere. Measured **incrementally** (return *on the capex*, not the blended asset return after capex).

### 4.6 Summary table (all PROPOSED)

| Governor | PROPOSED | Band | Measured on | Ties to |
|---|---|---|---|---|
| `HURDLE_UNLEVERED_HOLD` | 7.5% | 7.25–7.75% | Fwd unlevered yield on **current MV** | CAGR floor (35yr midpoint) |
| `HURDLE_LEVERED_ACQ_IRR` | 12.0% | 11–13% | Levered equity IRR, full hold | Floor + concentration/illiquidity premium |
| `DISPOSITION_TRIGGER` | 6.5% | hold − 100bps | Fwd unlevered on **current MV** | Hold hurdle − churn band |
| `REFINANCE_TRIGGER` | +150 bps IRR accretion | — | Δ levered equity IRR | Side-constrained by DSCR/LTV |
| `HURDLE_CAPEX_IRR` | 15.0% | 14–16% | Incremental unlevered IRR on capex | Acq hurdle + execution premium |

**Ordering invariant (this is the load-bearing relationship, more than the absolute levels):**
`DISPOSITION (6.5%) < HOLD (7.5%) < ACQ IRR (12%) < CAPEX IRR (15%)`
The *spacing* encodes ORA's risk doctrine: hold a decent asset, demand a premium to buy a new one, demand the most to spend discretionary capex. Even if Gabriel reprices every absolute number, **the monotonic ordering must survive** or the engine's logic inverts.

---

## 5. Config MECHANISM

### 5.1 Where it lives — `CAPITAL_CONFIG`, governor-class
A new governor-class config slot, **structurally separated** into ratified vs. proposed layers, mirroring how `INTEL_CONFIG` separates ratified anomaly thresholds from proposed weights:

```jsonc
// CAPITAL_CONFIG — governor-class. Same protection as DSCR/LTV.
// NOT silently editable. Changes to "ratified" require Invariant-4 sign-off.
{
  "ratified": {
    // EMPTY until Gabriel signs off. The engine MUST refuse to
    // rank on any value not present here. No silent defaults.
  },
  "proposed": {
    "hurdle_unlevered_hold":  { "value": 0.075, "band": [0.0725, 0.0775] },
    "hurdle_levered_acq_irr": { "value": 0.120, "band": [0.11, 0.13] },
    "disposition_trigger":    { "value": 0.065, "rule": "hold_minus_bps", "bps": 100 },
    "refinance_trigger":      { "accretion_bps": 150, "side_constraints": ["dscr>=1.25","ltv<=0.40"] },
    "hurdle_capex_irr":       { "value": 0.150, "band": [0.14, 0.16] }
  },
  "assumptions": {
    "aum_floor_cagr": 0.0748,        // 35yr $60M->$750M midpoint
    "payout_ratio":  null,           // [SPECULATIVE] REQUIRED INPUT — drives gross hurdle
    "horizon_years": 35,
    "aum_target_m":  750
  },
  "provenance": {
    "ratified_by": null, "ratified_date": null,
    "calibration_log_ref": "memory/event_log.md",
    "source_of_record": "ORA Master Workbook (SharePoint)"
  }
}
```

### 5.2 Protection class — not silently editable
- **Same blast-radius treatment as DSCR/LTV / financial-constant files** (per Engineering OS): edits to `CAPITAL_CONFIG.ratified` are disqualified from any fast lane, require read-before-write, and trip the financial-governor protection.
- **Hook-enforced, fail-closed.** The Capital Allocation Engine **must refuse to rank** if `ratified` is empty or if any required key is missing — it may *display* the `proposed` layer flagged "PROPOSED — not ratified, advisory only," but it may not allocate capital on it. No silent fallback to `proposed`; no hardcoded defaults anywhere in the engine.
- **Any change to a ratified value goes through the same gate that mints it** (§7) and appends to the calibration log. Proposed values may be edited freely (they're advisory); the ratified/proposed wall is the safety boundary.

### 5.3 How the engine consumes it — making 5 actions comparable
The governor converts every action into one comparable scalar — **Risk-Adjusted Spread (RAS) = forward return − applicable hurdle** — so all five actions queue on a single axis:

| Action | Forward return computed | Hurdle applied | Comparable output |
|---|---|---|---|
| **Buy** | Levered equity IRR (full hold) | `hurdle_levered_acq_irr` | RAS = IRR − 12% |
| **Hold** | Fwd unlevered yield on current MV | `hurdle_unlevered_hold` | RAS = yield − 7.5% |
| **Sell** | Hold-RAS vs. recycle-RAS, **net of sale friction + tax** | `disposition_trigger` as gate | Δ-RAS of redeployed equity |
| **Refinance** | Δ levered equity IRR from refi | `refinance_trigger` + DSCR/LTV side-constraints | accretion bps vs. 150 |
| **Improve** | Incremental unlevered IRR on capex $ | `hurdle_capex_irr` | RAS = capex IRR − 15% |

Every input on the left already exists in ORA's per-deal reporting stack (**NOI, cap rate, yield-on-cost, levered/unlevered IRR, equity multiple, DSCR**) — the engine adds no new data requirement, only the hurdle subtraction and the cost-netting on disposition. Actions then rank by **RAS, descending**, capital allocated top-down until exhausted. A single firm-wide axis; the governor is the zero-point on that axis.

---

## 6. What Gabriel must ratify — decision list

Crisp, sign-off-ready. Each is a single decision.

1. **Horizon & target anchor** — confirm **35yr / $60M→$750M / 7.48% floor** as the canonical anchor (vs. 30yr-aggressive 8.78% or 40yr-patient 6.52%). *This sets the whole scale.*
2. **Payout ratio** — supply the firm's distribution assumption. **[SPECULATIVE] — required.** Moves every hurdle 300–500 bps; nothing else gets ratified cleanly until this is in.
3. **`HURDLE_UNLEVERED_HOLD`** — ratify **7.5%** or reprice.
4. **`HURDLE_LEVERED_ACQ_IRR`** — ratify **12.0%** or reprice.
5. **`DISPOSITION_TRIGGER` band** — ratify **100 bps below hold (6.5%)** as the sell-review band.
6. **`REFINANCE_TRIGGER`** — ratify **150 bps accretion + DSCR/LTV side-constraints**.
7. **`HURDLE_CAPEX_IRR`** — ratify **15.0%** or reprice.
8. **The ordering invariant** — ratify that `DISPOSITION < HOLD < ACQ_IRR < CAPEX_IRR` must hold under any future reprice (this is the doctrine, independent of levels).
9. **Engine fail-closed behavior** — confirm the engine refuses to allocate on un-ratified values (vs. advisory display only). *Recommended: fail-closed.*

---

## 7. Evidence that refines each number over time (calibration loop)

Each governor is a hypothesis to be disciplined by ORA's own realized data, logged to `memory/event_log.md` (the calibration log). What sharpens each:

| Governor | Refining evidence | Source |
|---|---|---|
| **CAGR floor / payout** | Actual realized AUM CAGR vs. plan; actual distribution ratio | Master Workbook, capital accounts |
| **`HURDLE_UNLEVERED_HOLD`** | Realized forward yields of held assets vs. their disposition counterfactuals | Portfolio NOI history, mark-to-market |
| **`HURDLE_LEVERED_ACQ_IRR`** | Realized vs. underwritten levered IRR on *closed* deals; deal-recon → actual spread | `acquisition-underwriting` outputs, post-mortem |
| **`DISPOSITION_TRIGGER`** | Outcomes of held-past-trigger assets (did the equity have been better recycled?) | Disposition post-mortems |
| **`REFINANCE_TRIGGER`** | Realized accretion on executed refis vs. the 150 bps bar | `debt-management` skill, lender history |
| **`HURDLE_CAPEX_IRR`** | Realized incremental IRR on completed value-add capex vs. underwrite | `maintenance-analytics` / `capex-budgeting`, lease-up actuals |
| **Cost of debt input** | Live term sheets, executed loan all-in rates | `debt-management`, lender package history |
| **Cap-rate environment** | Live going-in caps on screened/closed deals | `rent-comp`, `market-monitor`, Master Workbook |

**Calibration cadence [PROPOSED]:** annual reprice review (ties to the `annual-cycle` skill), with any single ratified value re-openable on demand. Every reprice is a fresh Invariant-4 ratification and a calibration-log entry — the governor is anchored, not frozen.

---

## 8. Bottom line

The mechanism is the deliverable; the numbers are proposals. **Ratify the floor anchor and the payout ratio first** — those two inputs determine everything downstream. The proposed governor set (**7.5% / 12% / 6.5% / +150bps / 15%**) is internally consistent, tied to the CAGR floor and the equity-heavy capital structure, and ordered to encode ORA's risk doctrine. It is built to plug into the existing per-deal reporting stack with no new data requirement. **None of it is live until Gabriel signs the §6 decision list.**

---
*All values PROPOSED — pending Gabriel ratification (Hard Invariant 4). `[SPECULATIVE]` tags mark every inferred input; the payout ratio is the single highest-leverage unknown and must be supplied before clean ratification.*

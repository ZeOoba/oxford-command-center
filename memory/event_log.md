# Event Log — ratifications & financial-constant sign-offs

Append-only record of Invariant-4 sign-offs (governor/financial-decision constants). Each entry: date, who
ratified, what changed, the adversarial-refute reference, and the resulting versioned artifact.

---

## 2026-06-14 — Acquisition Scorecard v1.0 ratified (Gabriel Goldberg)

**Ratified by:** Gabriel Goldberg (principal / Lead Architect), in-session.
**Artifact minted:** `config/acquisition-ruleset.v1.json` (`ratification: "ratified"`, `RULESET_VERSION 1.0.0`).
**Superseded:** `config/acquisition-ruleset.v1.proposed.json` → archived to `config/archive/`.
**Decision list:** §7 of `docs/superpowers/specs/2026-06-13-acquisition-scorecard-answers-and-build-plan.md`.

Ratified answers to the scorecard open questions (Q1–Q6):
- **Q1 (Cat 3/4):** PEMB construction = 2 of 4; satellite cluster = 6 of 12; Cat-3 8 pts split clear **5** / loading **3**.
  - **Clear-height bands (SKILL.md:52–57, supplied by Gabriel):** ≤20,000 SF → full credit at **14′**; >20,000 SF → **16′**; 12′ kill-floor → 0 credit.
  - **Loading door rule (Gabriel):** ideally **1 dock + 1 drive-in per 10,000 SF**.
- **Q2 (Cat 6 inverse upside):** mark-to-market `0%→0 / ≥30%-below→5` linear; WALT factor `≤2yr ×1 / 2–4yr ×0.5 / >4yr ×0`; credited only below market.
- **Q3:** market-estimated ± cannot carry a deal into T1 (caps to WATCH).
- **Q4:** DSCR 1.25 / LTV 40 governors stay in the governor layer — imported, applied at underwrite, never in the ruleset, never hardcoded.
- **Q5:** Replacement-Cost Table promoted to versioned ratified config `config/replacement-cost.v1.json` — **$125–150/SF** (mid $137.50), `rctVersion` pinned in `inputsVersion`. (Overrides the prior $85–120 placeholder.)
- **Q6:** market-fundamentals freshness window = **90 days**; ± defaults to 0 past it (and is 0 in v1 until structured submarket inputs exist).
- **D8:** phasing + architect sign-off for `src/contracts/` approved.

**Adversarial refute (ratification gate):** the recalibration was put through `refute-financial-change`
(hostile reviewers told to break the ratified numbers + the clear-height/loading logic) before this entry
was finalized; findings and resolutions are recorded on the ratification PR.

**Not yet live:** live input population (`property_characteristics`), API route + Acquisition Workbench UI,
and the calibration-log `acquisition-score` hook remain scoped in the merged master plan.

---

## 2026-06-14 — INTEL_CONFIG health weights ratified (Gabriel Goldberg)

**Ratified by:** Gabriel Goldberg (principal / Lead Architect), in-session ("All ok" to D1–D5).
**Artifact:** `server/warehouse/intel-config.ts` — `healthWeights` + the growth/spike knobs flipped PROPOSED → RATIFIED.
**Decision list:** §5 (D1–D5) of `docs/superpowers/specs/2026-06-14-intel-config-health-weight-calibration.md`.

These ten weights drive the per-property health score → health band → **capital-action verdict**
(invest / hold / monitor / disposition-candidate) in `server/warehouse/scores.ts`. They had been a
PROPOSED default since PFI Phase B (#13); the live verdicts were running on an unratified set. This
also resolves the `pfi-phase-b` status-bus blocker ("INTEL_CONFIG weight calibration needed from Gabriel").

Ratified decisions:
- **D1 — Option B (NOI-centric reweight):** noiGrowth 0.18→**0.22**, noiPerSfGrowth 0.15→**0.18**,
  revenueGrowth 0.12→**0.10**, revenuePerSfGrowth 0.10→**0.08**, taxEfficiency / insuranceEfficiency /
  repairEfficiency 0.06→**0.05** each; expenseEfficiency 0.10, marginStability 0.07, benchmarkPosition
  0.10 unchanged. **Σ = 1.00.** (NOI block 0.33→0.40; efficiency 0.28→0.25; revenue 0.22→0.18.)
  Max single-weight move 0.04 — within the D5 ±0.05/yr cap.
- **D2 — growthScoreCapPct = 0.20** ratified (±20% YoY ⇒ 0..100 sub-score).
- **D3 — anomaly.categorySpikePct = 0.25** ratified (absolute-dollar floor deferred to a later pass).
- **D4 — health bands 80 / 65 / 50** confirmed unchanged.
- **D5 — refinement governance:** the calibration log (#34, `score_calibration_*`) is the ONLY path to
  future weight changes — annual, evidence-backed, offline re-fit, ±0.05/yr cap, Gabriel's sign-off each
  time. (The cap is a process governor per the #34 design §4.3, not machine-enforced in the gate.)

**Adversarial refute (ratification gate):** the reweight was put through `refute-financial-change` across
three hostile lenses — numerical/invariant, capital-action coupling/regression, provenance/duplication.
**Final: no real defect (foundRealDefect: false).** Numerical: all 10 weights match code/doc/test, Σ=1.0
(float residual 2e-16, far inside tolerance), every move ≤0.04. Capital-action: `scores.ts` untouched, 44
scores-touching tests green; the band/verdict flips at the margins are bounded to ≤7 health pts and match
the ratified NOI-centric thesis (pre-registered as FM-2, advisory-only — Invariant 1); the disposition path
gets directionally *sharper*, not more dangerous. Provenance: fixed a stale `0.18` cross-reference in the
#34 design doc and a misleading header comment surfaced by the pass.

**Provenance / reproducibility:** dated by this entry + the git commit; the #34 calibration log freezes
`INTEL_CONFIG` verbatim (`config_json`) and forks `config_hash` on the next post-commit verdict emit, so the
config fork is auto-dated and reproducible — now locked by tests (`intel-config.test.ts` pins the exact
ratified values; `calibration.test.ts` asserts `config_json` round-trips to the live weights).

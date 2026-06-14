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

# ORA Command Center â€” Phase-2 Evaluation Scorecard

**Baseline:** `origin/main @ 823574d` Â· worktree `oxford-cc-wt-audit-20260613` Â· branch `feat/cc-audit-hardening-20260613`
**Inputs:** 37-finding audit (7 HIGH / 15 MED / 9 LOW, all `status:confirmed|adjusted`), ratified 2026-06-13 master plan (Phase 0â†’3, F1â€“F13 matrix, PFR-1..7), and the four forward specs (acquisition-scorecard-contract, hurdle-rate-governor, calibration-log, PFI architecture).
**Lens:** Did the SETUP + CODE move ORA toward better acquisition / ops / capital-allocation decisions over a 40-year compounding horizon â€” not code quality for its own sake.

---

## Headline verdict

The hard, unglamorous half is genuinely done and well-built: a 5-layer immutableâ†’ledgerâ†’metricsâ†’intelligence SQLite warehouse, 32 P&L files ingested, deterministic answer-first Intel UX (verdictâ†’whyâ†’do), a Zod-typed boundary the house *knows* how to use (acquisition.ts proves it), a real `gate` (typecheck+lint+test+reconcile+warehouse:verify+governance), and â€” already on baseline â€” F1 NOI Aâ†”B reconcile, `get_macro`, a deterministic acquisition scorecard engine (adversarially hardened: gate/floor-indeterminate symmetry), and parser-version re-ingest. The master plan's executive reframe is correct and validated: this is **not** greenfield; rebuilding to the original brief would destroy capital.

But the audit exposes that the *decision surfaces* the firm's #1 priorities ride on are not yet trustworthy. Three classes of defect dominate, and all three sit directly on capital-allocation paths:

1. **Silent financial mis-computation on served decision surfaces** â€” H2 (`/noi` double-counts on first full-year+YTD coexistence), H3 (approve-path flips a Gas expense to income, mis-signing NOI on human approval), H4 (Downside scenario *raises* portfolio value / *lowers* LTV â€” risk runs backwards), H5 (phantom Portfolio Variance shortfall in the realistic partial-QB state). None throw; each launders a wrong number into a confident headline.
2. **An unenforced read boundary** (H6) â€” the entire warehouseâ†’client analytics path bypasses Zod, with engine types hand-redeclared on the client and shipped as `fetchJson<T>` casts. This is the structural reason the planned engines (F2/F4/F5/F6/F7) cannot cleanly "absorb" onto the warehouse half, and it directly undercuts the master plan's own "contracts are the ONLY typed boundary" invariant.
3. **A confidentiality breach already in git** (H1) â€” an active LOI/PSA deal's full economics + named counsel/consultant are committed verbatim to an off-machine GitHub remote. The `confidential:true` flag only drives runtime bake redaction; it does nothing for source/history. The master plan's pre-mortem (PFR-6) discussed *future* egress and missed the *present* leak.

The platform is at the stage-2 boundary the plan describes (decision support), but the audit shows stage 2 itself is not yet sound enough to build stage 3 (investment intelligence) on. The forward specs (hurdle-rate governor, calibration log, scorecard contract) are unusually high-quality and correctly gated as proposed/fail-closed â€” the design judgment is excellent; the executed analytics layer has correctness holes the plan under-weighted.

---

## Dimension scores (0â€“10)

| Dimension | Score | One-line basis |
|---|---|---|
| Acquisition velocity (firm priority #1) | **5.0** | Scorecard engine + contract + ruleset shipped and hardened, but un-ratified/fail-closed (no live scoring), Notion/HubSpot not wired (seed-as-truth), and the deal surface has no provenance + a cross-section bug (M14). Capability scaffolded, not yet a velocity tool. |
| Ops optimization | **6.0** | Strong ingest/close/reconcile loop and answer-first Intel, but H3/H5 corrupt the close & approve paths, M9/M10 impose a 6Ã— redundant-scan WAL-contention tax, and M13 silently diverges Calendar from Leases. |
| Institutional quality | **5.5** | Excellent quality bar (gate, 483 tests, Zod where used, redaction-on-bake) undercut by H1 (committed confidential terms), H6 (half the boundary unenforced), and the M15/L9 token/theme drift that breaks the parchment theme on prominent surfaces. |
| Analytics digestibility | **7.0** | The verdictâ†’whyâ†’do contract is real and consistently applied on the Intel surface (the system's best feature); but M14/L9 leave Acquisitions/Cash without an answer-first verdict, and H4/H5 mean some headline KPIs are confidently wrong â€” digestible â‰  correct. |
| Learn-from-data | **2.5** | The calibration-log design is first-rate but is design-only; nothing persists verdicts with `inputs_version` on baseline. Scoring weights remain "PROPOSED/uncalibrated," no score-vs-outcome loop exists. The single highest-leverage 40-year feature is the least built. |

**Composite read:** the system reports and supports decisions well *where the numbers are right*, but has not yet earned trust on the surfaces that allocate capital, and has zero of the learning loop that is its stated 40-year edge.

---

## Validation of the master-plan F1â€“F13 matrix

The matrix's *relative* value ranking survives the audit and is largely vindicated â€” the audit independently re-derives PFR-1 (build on the F1 integrity hole = fatal) as live, shipped bugs (H2/H3/H4/H5), confirming the plan was right to promote F1 to a hard Phase-1 exit gate. Two adjustments and one cross-check are required (see matrixAdjustments). Net: **do not re-rank; do widen F1's scope and re-baseline the "Today %" column against `main`.**

---

## The 5â€“8 highest-leverage gaps (cross-checked against ALREADY-DONE; nothing on `origin/main` counted)

See structured `topGaps`. In one line each, by leverage:
1. **H1 committed confidential deal terms** (RED) â€” a present, realized invariant breach; highest institutional-quality leverage, smallest code change.
2. **H6 warehouse read boundary bypasses Zod** (YELLOW) â€” the structural blocker for every planned engine; one-time contract investment with compounding payoff.
3. **H4 scenario value-basis-mix** (YELLOW) â€” the what-if surface understates downside risk on the exact axis capital decisions use.
4. **H2 `/noi` double-count + H3 approve-path sign-flip** (YELLOW) â€” latent/triggerable NOI corruption feeding every downstream score; both fixable inside the existing coherent-batch / section-aware patterns.
5. **Calibration log not started** (GREEN/design-ready) â€” the 40-year learning loop; cheap now, irreplaceable later, lookahead rule means every quarter delayed is lost.
6. **H5 noiVariance phantom shortfall** (YELLOW) â€” corrupts the month-end close headline in the realistic partial-rollout state.
7. **M14 acquisitions has no verdict/provenance + bestCap bug** (GREEN) â€” firm priority #1's own surface is the least answer-first and shows an unprovenanced/dead-deal KPI.
8. **M2/M7 governor-constant annotation + pinning** (RED-adjacent, report-only) â€” no runtime pin on DSCR 1.25 / LTV 0.40; 41â€“65% LTV triggers no signal; ratification-gated, not a unilateral change.

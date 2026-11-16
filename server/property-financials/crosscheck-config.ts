// server/property-financials/crosscheck-config.ts
//
// Thresholds for the three PF cross-checks (tax timing, insurance tracker-vs-ledger, snapshot-vs-PF
// tie-out), as ONE config object so a single edit moves exactly the findings it governs and a test can
// prove it. These are portfolio-spread starting points, NOT governors and NOT scoring inputs: nothing
// here touches DSCR / LTV / hurdle-rate constants (Hard Invariant 4).
//
// The starting points were sized against a review of the per-property PF reports: they catch a missed
// installment or a doubled premium and stay quiet on ordinary cash-basis timing noise.

import { DEFAULT_TOLERANCE } from '../warehouse/reconcile-noi';

export interface CrosscheckThresholds {
  /** YTD tax down by at least this share of the prior YTD (and by at least taxMinUsd) => possible missing installment. */
  readonly taxDropPct: number;
  /** YTD tax up by at least this share (and by at least taxMinUsd) => possible reassessment. */
  readonly taxRisePct: number;
  /** Dollar floor for both tax tests, so a large percent on a tiny base never fires. */
  readonly taxMinUsd: number;
  /** Trailing-12-month ledger insurance at or above this multiple of the tracker's annual premium => possible double payment. */
  readonly insuranceDoublePayRatio: number;
  /** Dollar floor on the excess over the tracker premium for the double-payment test. */
  readonly insuranceMinExcessUsd: number;
  /** A posting after a tracker lapse only counts as a likely renewal at or above this share of the lapsed premium. */
  readonly insuranceRenewalShare: number;
  /** Snapshot-vs-PF tie-out tolerances. The NOI values equal reconcile-noi.ts DEFAULT_TOLERANCE and are applied BY its classifyNoiReconciliation. */
  readonly tieOut: {
    readonly pctBand: number;
    readonly absBandUsd: number;
    readonly largeDriftPct: number;
    /** properties[] LTV vs the loans[] row that collateralizes it: flag a gap above this (absolute, in LTV points). */
    readonly ltvGapPoints: number;
  };
}

export const CROSSCHECK_THRESHOLDS: CrosscheckThresholds = {
  taxDropPct: 0.3,
  taxRisePct: 0.4,
  taxMinUsd: 5_000,
  insuranceDoublePayRatio: 1.5,
  insuranceMinExcessUsd: 2_000,
  insuranceRenewalShare: 0.5,
  // NOI bands ARE reconcile-noi's, imported so the two tie-outs cannot drift apart; only the LTV gap is local.
  tieOut: { ...DEFAULT_TOLERANCE, ltvGapPoints: 0.02 },
};

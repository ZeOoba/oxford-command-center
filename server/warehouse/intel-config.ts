// server/warehouse/intel-config.ts
// SINGLE SOURCE OF TRUTH for warehouse-intel anomaly thresholds, health-score weights, and band
// cutoffs. (Live-snapshot alert thresholds are a SEPARATE set — src/analytics/conditions.ts
// ALERT_THRESHOLDS — with NO shared constant; don't try to "sync" them.) Anomaly thresholds are
// ratified (original PFI spec). Health WEIGHTS, bands, and the growth/spike knobs were RATIFIED by
// Gabriel 2026-06-14 (Option B — NOI-centric; D1–D5 of the calibration doc). Any future
// change is governed: evidence from the calibration log (score_calibration_*), ±0.05/yr cap,
// Gabriel's sign-off, and a refute-financial-change pass — never a silent edit.
// See docs/superpowers/specs/2026-06-14-intel-config-health-weight-calibration.md
//     and memory/event_log.md.
// Engine enums are single-sourced in the contract (H6) so the client and server share one shape;
// re-exported here under their local names so existing engine imports keep working unchanged.
export type { AnomalySeverity, HealthBand, AttentionBand, CapitalAction } from '../../src/contracts/warehouse';

export const INTEL_CONFIG = {
  anomaly: {
    expenseGrowthPct: 0.15,      // ratified
    revenueDeclinePct: 0.05,     // ratified
    noiDeclinePct: 0.05,         // ratified
    noiPerSfDeclinePct: 0.05,    // ratified
    categorySpikePct: 0.25,      // tax/insurance/repair/utility spike (ratified 2026-06-14; $-floor deferred)
    // severity scales by how far PAST the threshold the move is (multiple of threshold):
    severityMultiples: { moderate: 1.5, high: 2.5, critical: 4 } as const,
  },
  // Health sub-scores are each 0..100; weights sum to 1.0. RATIFIED — Gabriel 2026-06-14
  // (Option B, NOI-centric: NOI block 0.40 / revenue 0.18 / efficiency 0.25 / margin 0.07 / rank 0.10).
  healthWeights: {
    revenueGrowth: 0.10,
    revenuePerSfGrowth: 0.08,
    noiGrowth: 0.22,           // NOI growth is the compounding engine for a hold — it dominates
    noiPerSfGrowth: 0.18,      // SF-normalized = quality of that growth
    expenseEfficiency: 0.10,   // vs portfolio median expense ratio
    taxEfficiency: 0.05,
    insuranceEfficiency: 0.05,
    repairEfficiency: 0.05,
    marginStability: 0.07,
    benchmarkPosition: 0.10,   // NOI/SF quartile rank (small-N; first weight the calibration log validates)
  },
  healthBands: { excellent: 80, good: 65, watch: 50 } as const, // <watch ⇒ concern (ratified 2026-06-14)
  // Growth that maps a factor to its 0..100 sub-score: linear clamp on [-cap, +cap].
  growthScoreCapPct: 0.20,    // ±20% growth ⇒ 0..100 (ratified 2026-06-14)
} as const;

export const HURDLE_RATE = {
  proposedPct: 0.08,
  ratification: 'proposed' as const,
  basis: 'unlevered IRR — marginal cost of capital making buy/hold/sell/refi/improve comparable',
} as const;

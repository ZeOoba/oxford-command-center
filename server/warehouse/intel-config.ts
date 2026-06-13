// server/warehouse/intel-config.ts
// SINGLE SOURCE OF TRUTH for analytics thresholds, score weights, and band cutoffs.
// Mirrors src/analytics/conditions.ts ALERT_THRESHOLDS. Anomaly thresholds are ratified
// (original PFI spec). Health/attention WEIGHTS are proposed defaults pending Gabriel's
// calibration — tunable here without touching engine code.
export type AnomalySeverity = 'low' | 'moderate' | 'high' | 'critical';
export type HealthBand = 'excellent' | 'good' | 'watch' | 'concern';
export type AttentionBand = 'green' | 'yellow' | 'orange' | 'red';
export type CapitalAction = 'invest' | 'hold' | 'monitor' | 'disposition-candidate';

export const INTEL_CONFIG = {
  anomaly: {
    expenseGrowthPct: 0.15,      // ratified
    revenueDeclinePct: 0.05,     // ratified
    noiDeclinePct: 0.05,         // ratified
    noiPerSfDeclinePct: 0.05,    // ratified
    categorySpikePct: 0.25,      // tax/insurance/repair/utility spike (proposed)
    // severity scales by how far PAST the threshold the move is (multiple of threshold):
    severityMultiples: { moderate: 1.5, high: 2.5, critical: 4 } as const,
  },
  // Health sub-scores are each 0..100; weights sum to 1.0 (PROPOSED — calibrate with Gabriel).
  healthWeights: {
    revenueGrowth: 0.12,
    revenuePerSfGrowth: 0.10,
    noiGrowth: 0.18,
    noiPerSfGrowth: 0.15,
    expenseEfficiency: 0.10,   // vs portfolio median expense ratio
    taxEfficiency: 0.06,
    insuranceEfficiency: 0.06,
    repairEfficiency: 0.06,
    marginStability: 0.07,
    benchmarkPosition: 0.10,   // NOI/SF quartile rank
  },
  healthBands: { excellent: 80, good: 65, watch: 50 } as const, // <watch ⇒ concern
  // Growth that maps a factor to its 0..100 sub-score: linear clamp on [-cap, +cap].
  growthScoreCapPct: 0.20,    // ±20% growth ⇒ 0..100
} as const;

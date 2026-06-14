import { INTEL_CONFIG, type AnomalySeverity } from '../../server/warehouse/intel-config';
import { describe, expect, it } from 'vitest';
describe('intel-config', () => {
  it('exposes ratified anomaly thresholds', () => {
    expect(INTEL_CONFIG.anomaly.expenseGrowthPct).toBe(0.15);
    expect(INTEL_CONFIG.anomaly.revenueDeclinePct).toBe(0.05);
    expect(INTEL_CONFIG.anomaly.noiDeclinePct).toBe(0.05);
    expect(INTEL_CONFIG.anomaly.noiPerSfDeclinePct).toBe(0.05);
  });
  it('health weights sum to 1.0', () => {
    const sum = Object.values(INTEL_CONFIG.healthWeights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });
  it('encodes the RATIFIED health weights (Gabriel 2026-06-14, Option B — NOI-centric)', () => {
    // Locks the ratified set so no future edit can SILENTLY move a capital-allocation weight
    // (these feed scores.ts health → capital-action). Any change must be re-ratified (calibration
    // doc D1) — and must update this oracle deliberately. See memory/event_log.md.
    expect(INTEL_CONFIG.healthWeights).toEqual({
      revenueGrowth: 0.10,
      revenuePerSfGrowth: 0.08,
      noiGrowth: 0.22,
      noiPerSfGrowth: 0.18,
      expenseEfficiency: 0.10,
      taxEfficiency: 0.05,
      insuranceEfficiency: 0.05,
      repairEfficiency: 0.05,
      marginStability: 0.07,
      benchmarkPosition: 0.10,
    });
    const w = INTEL_CONFIG.healthWeights;
    expect(w.noiGrowth + w.noiPerSfGrowth).toBeCloseTo(0.40, 6); // NOI block dominates
    expect(w.noiGrowth).toBeGreaterThan(w.revenueGrowth);        // NOI leads revenue (hold thesis)
  });
  it('encodes the RATIFIED knobs (growth cap, category spike, bands)', () => {
    expect(INTEL_CONFIG.growthScoreCapPct).toBe(0.20);
    expect(INTEL_CONFIG.anomaly.categorySpikePct).toBe(0.25);
    expect(INTEL_CONFIG.healthBands).toEqual({ excellent: 80, good: 65, watch: 50 });
  });
  it('health bands are ordered', () => {
    const b = INTEL_CONFIG.healthBands;
    expect(b.excellent).toBeGreaterThan(b.good);
    expect(b.good).toBeGreaterThan(b.watch);
  });
  it('exports the AnomalySeverity union', () => {
    const sev: AnomalySeverity = 'critical';
    expect(sev).toBe('critical');
  });
});

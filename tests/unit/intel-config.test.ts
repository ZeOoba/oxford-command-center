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

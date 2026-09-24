import { describe, expect, it } from 'vitest';
import { rolloverChartData } from '../../src/modules/leasing/rollover-chart-data';

describe('rolloverChartData', () => {
  it('maps buckets to period/expiring-rent bars, dropping empty periods', () => {
    expect(rolloverChartData([
      { period: '2026 H2', count: 18, expiringSf: 45130, expiringRent: 482000 },
      { period: '2027', count: 0, expiringSf: 0, expiringRent: 0 },
      { period: '2028', count: 43, expiringSf: 148206, expiringRent: 1760000 },
    ])).toEqual([{ label: '2026 H2', value: 482000 }, { label: '2028', value: 1760000 }]);
  });
});

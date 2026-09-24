import type { BarDatum } from '@/charts/BarChart';
import type { RolloverBucket } from '@/analytics/types';

/** Maps rollover buckets to bar-chart data, dropping periods with no expiring rent. */
export function rolloverChartData(buckets: RolloverBucket[]): BarDatum[] {
  return buckets.filter((b) => b.expiringRent > 0).map((b) => ({ label: b.period, value: b.expiringRent }));
}

// Portfolio Trends Wave 2 — merge recorded month snapshots over the Wave 1 reconstruction.
// Pure functions + one thin query hook. MonthPoint (Wave 1) is untouched; the source tag lives here.
import { useQuery } from '@tanstack/react-query';
import { addMonths, type MonthKey, type MonthPoint } from '../../analytics/portfolio-trends';
import { TrendsHistoryResponseSchema, type TrendsHistoryPoint, type TrendsHistoryResponse } from '@contracts/trends';
import { QUERY_OPTS, fetchParsedOrMirror } from '../intel/hooks';

export type MonthSource = 'recorded' | 'reconstructed';

export interface SourcedMonthPoint extends MonthPoint {
  source: MonthSource;
}

export interface MergeScope {
  propertyIds: readonly string[];
  /** When set, the single-property view: use that property's recorded row. */
  propertyId?: string;
}

function toPoint(
  month: MonthKey,
  totalSf: number,
  leasedSf: number,
  inPlaceRent: number,
  leaseCount: number,
): MonthPoint {
  const vacantSf = Math.max(0, totalSf - leasedSf);
  return {
    month,
    isForecast: false,
    inPlaceRent,
    leasedSf,
    totalSf,
    vacantSf,
    vacancyPct: totalSf > 0 ? vacantSf / totalSf : 0,
    leaseCount,
  };
}

export function recordedToMonthPoint(r: TrendsHistoryPoint): MonthPoint {
  return toPoint(r.month, r.totalSf, r.leasedSf, r.inPlaceRent, r.leaseCount);
}

/**
 * Overlay recorded snapshots on the reconstructed series. Portfolio scope sums only when EVERY
 * in-scope property has a recorded row for the month (a partial sum would silently understate).
 * Forecast months are never replaced.
 */
export function mergeRecorded(
  reconstructed: MonthPoint[],
  recorded: TrendsHistoryPoint[],
  scope: MergeScope,
): SourcedMonthPoint[] {
  const ids = scope.propertyId != null ? [scope.propertyId] : [...new Set(scope.propertyIds)];
  const byMonth = new Map<MonthKey, Map<string, TrendsHistoryPoint>>();
  for (const r of recorded) {
    let m = byMonth.get(r.month);
    if (!m) byMonth.set(r.month, (m = new Map()));
    m.set(r.propertyId, r);
  }

  return reconstructed.map((p): SourcedMonthPoint => {
    const rows = byMonth.get(p.month);
    if (p.isForecast || !rows || ids.length === 0) return { ...p, source: 'reconstructed' };
    const picked: TrendsHistoryPoint[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (!row) return { ...p, source: 'reconstructed' };
      picked.push(row);
    }
    let totalSf = 0, leasedSf = 0, inPlaceRent = 0, leaseCount = 0;
    for (const r of picked) {
      totalSf += r.totalSf;
      leasedSf += r.leasedSf;
      inPlaceRent += r.inPlaceRent;
      leaseCount += r.leaseCount;
    }
    return { ...toPoint(p.month, totalSf, leasedSf, inPlaceRent, leaseCount), source: 'recorded' };
  });
}

/** Fraction YoY in-place-rent change; non-null only when both ends are recorded and prior rent > 0. */
export function recordedYoY(points: SourcedMonthPoint[], asOfMonth: MonthKey): number | null {
  const cur = points.find((p) => p.month === asOfMonth);
  const prev = points.find((p) => p.month === addMonths(asOfMonth, -12));
  if (!cur || !prev || cur.source !== 'recorded' || prev.source !== 'recorded') return null;
  if (!(prev.inPlaceRent > 0)) return null;
  return cur.inPlaceRent / prev.inPlaceRent - 1;
}

export const TRENDS_HISTORY_KEY = ['warehouse', 'analytics', 'trends', 'history'] as const;

/** Errors propagate; the consumer treats isWarehouseUnavailable as "no recorded history". */
export function useTrendsHistory() {
  return useQuery({
    queryKey: TRENDS_HISTORY_KEY,
    queryFn: (): Promise<TrendsHistoryResponse> =>
      fetchParsedOrMirror('/api/warehouse/analytics/trends/history', TrendsHistoryResponseSchema),
    ...QUERY_OPTS,
  });
}

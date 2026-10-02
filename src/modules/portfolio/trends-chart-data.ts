import type { TimePoint } from '@/charts/AreaChart';
import type { BarDatum } from '@/charts/BarChart';
import { addMonths, type MonthKey, type MonthPoint, type RentBridgeStep } from '@analytics/portfolio-trends';

export const rentSeries = (pts: MonthPoint[]): TimePoint[] => pts.map((p) => ({ date: `${p.month}-01`, value: p.inPlaceRent }));
export const vacancySeries = (pts: MonthPoint[]): TimePoint[] => pts.map((p) => ({ date: `${p.month}-01`, value: p.vacancyPct * 100 }));
export const rentChangeBars = (steps: RentBridgeStep[]): BarDatum[] => steps.map((s) => ({ label: s.month, value: s.closing - s.opening }));

export function kpiAt(pts: MonthPoint[], asOfMonth: MonthKey) {
  const find = (m: MonthKey) => pts.find((p) => p.month === m);
  const cur = find(asOfMonth);
  const prev = find(addMonths(asOfMonth, -1));
  const yoy = find(addMonths(asOfMonth, -12));
  const ratio = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined || b === 0 ? null : a / b - 1);
  return {
    rent: cur?.inPlaceRent ?? 0,
    vacancyPct: cur?.vacancyPct ?? 0,
    vacantSf: cur?.vacantSf ?? 0,
    rentMoM: ratio(cur?.inPlaceRent, prev?.inPlaceRent),
    rentYoY: ratio(cur?.inPlaceRent, yoy?.inPlaceRent),
    vacancyMoMPts: cur && prev ? (cur.vacancyPct - prev.vacancyPct) * 100 : null,
  };
}

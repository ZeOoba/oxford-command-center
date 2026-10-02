// src/analytics/portfolio-trends.ts — monthly rent / vacancy reconstruction. Pure functions over
// PortfolioSnapshot rows (Spine A). No DB, no I/O, no Date.now (asOf is always passed in).
import type { Lease, Property } from '@contracts/index';
import { isInvestmentProperty } from './property-basis';

/** 'YYYY-MM' — lexicographic order == chronological order. */
export type MonthKey = string;

export const monthOf = (iso: string): MonthKey => iso.slice(0, 7);

const monthIndex = (m: MonthKey): number => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return y * 12 + (mo - 1);
};

export function addMonths(m: MonthKey, n: number): MonthKey {
  const idx = monthIndex(m) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** Month-granular: counts a month if the lease is in effect on any day of it. */
export function leaseActive(l: Lease, m: MonthKey): boolean {
  if (!l.leaseStart) return false;
  if (monthOf(l.leaseStart) > m) return false;
  return l.leaseEnd == null || monthOf(l.leaseEnd) >= m;
}

/**
 * Monthly rent of one lease in month `m`. Months <= asOf use the current monthlyRent flat (history
 * is NOT back-cast — past escalations are unknown). Future months apply the next escalation and
 * compound it every 12 months. escalationDate is the NEXT escalation; stale dates roll forward.
 */
export function leaseRent(l: Lease, m: MonthKey, asOfMonth: MonthKey): number {
  const pct = l.escalationPct;
  if (m <= asOfMonth || !l.escalationDate || !pct) return l.monthlyRent;
  let next = monthOf(l.escalationDate);
  while (next <= asOfMonth) next = addMonths(next, 12);
  if (m < next) return l.monthlyRent;
  const steps = 1 + Math.floor((monthIndex(m) - monthIndex(next)) / 12);
  return l.monthlyRent * Math.pow(1 + pct, steps);
}

export interface MonthPoint {
  month: MonthKey;
  isForecast: boolean;
  inPlaceRent: number;
  leasedSf: number;
  totalSf: number;
  vacantSf: number;
  /** 0..1 fraction. */
  vacancyPct: number;
  leaseCount: number;
}

export interface RentBridgeStep {
  month: MonthKey;
  isForecast: boolean;
  opening: number;
  escalations: number;
  newLeases: number;
  /** Negative or zero. */
  expirations: number;
  closing: number;
}

export interface TrendOptions {
  asOf: string;
  monthsBack?: number;
  monthsForward?: number;
}

export interface TrendResult {
  asOfMonth: MonthKey;
  months: MonthKey[];
  portfolio: MonthPoint[];
  byProperty: Record<string, MonthPoint[]>;
  bridge: RentBridgeStep[];
}

function pointsFor(leases: Lease[], totalSf: number, months: MonthKey[], asOfMonth: MonthKey): MonthPoint[] {
  return months.map((month) => {
    const active = leases.filter((l) => leaseActive(l, month));
    const leasedSf = active.reduce((s, l) => s + l.sf, 0);
    const vacantSf = Math.max(0, totalSf - leasedSf);
    return {
      month,
      isForecast: month > asOfMonth,
      inPlaceRent: active.reduce((s, l) => s + leaseRent(l, month, asOfMonth), 0),
      leasedSf,
      totalSf,
      vacantSf,
      vacancyPct: totalSf > 0 ? vacantSf / totalSf : 0,
      leaseCount: active.length,
    };
  });
}

export function rentBridge(leases: Lease[], months: MonthKey[], asOfMonth: MonthKey): RentBridgeStep[] {
  const steps: RentBridgeStep[] = [];
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1]!;
    const cur = months[i]!;
    let opening = 0, escalations = 0, newLeases = 0, expirations = 0, closing = 0;
    for (const l of leases) {
      const wasActive = leaseActive(l, prev);
      const isActive = leaseActive(l, cur);
      const before = wasActive ? leaseRent(l, prev, asOfMonth) : 0;
      const after = isActive ? leaseRent(l, cur, asOfMonth) : 0;
      opening += before;
      closing += after;
      if (wasActive && isActive) escalations += after - before;
      else if (isActive) newLeases += after;
      else if (wasActive) expirations -= before;
    }
    steps.push({ month: cur, isForecast: cur > asOfMonth, opening, escalations, newLeases, expirations, closing });
  }
  return steps;
}

export function buildPortfolioTrend(leases: Lease[], properties: Property[], opts: TrendOptions): TrendResult {
  const asOfMonth = monthOf(opts.asOf);
  const months = monthRange(addMonths(asOfMonth, -(opts.monthsBack ?? 12)), addMonths(asOfMonth, opts.monthsForward ?? 18));
  const props = properties.filter(isInvestmentProperty);
  const ids = new Set(props.map((p) => p.id));
  const inScope = leases.filter((l) => l.propertyId !== null && ids.has(l.propertyId) && l.status !== 'Vacant');

  const byProperty: Record<string, MonthPoint[]> = {};
  for (const p of props) {
    byProperty[p.id] = pointsFor(inScope.filter((l) => l.propertyId === p.id), p.sf, months, asOfMonth);
  }
  const totalSf = props.reduce((s, p) => s + p.sf, 0);
  return {
    asOfMonth,
    months,
    portfolio: pointsFor(inScope, totalSf, months, asOfMonth),
    byProperty,
    bridge: rentBridge(inScope, months, asOfMonth),
  };
}

// src/modules/portfolio/table-trends.ts
//
// Per-row trend cells for the Portfolio property table (roadmap 2.4). Two series, two bases, never
// mixed with the table's workbook columns:
//  - NOI 12m: the last 12 consecutive P&L-ledger months (entity 100%, Spine B), as a sparkline whose
//    sort value is their sum. No spark when the ledger's latest 12 months are not all present.
//  - Occupancy change: recorded month snapshots only (lease-SF basis). The reconstruction is never
//    used here — it rebuilds the past from today's leases and omits departed tenants, so a Δ off it
//    would be invented. Null unless two recorded months exist for the property.
import { addMonths, type MonthKey } from '@analytics/portfolio-trends';
import type { TrendsHistoryPoint } from '@contracts/trends';
import { ledgerMonths, pfEntityFor } from '../property/property-page-model';

type Cube = Parameters<typeof ledgerMonths>[0];

export interface LedgerSpark {
  entity: string;
  /** Exactly 12 consecutive months, oldest first. */
  months: { month: MonthKey; noi: number }[];
  t12: number;
  through: MonthKey;
}

/** The ledger NOI spark for a property, or null when no entity maps to it or the latest 12 months
 *  are incomplete (a gap is never bridged — same rule as rollingT12). */
export function ledgerSparkFor(
  monthly: Readonly<Partial<Record<string, Cube>>> | undefined,
  entries: Readonly<Record<string, { readonly canonicalId: string | null }>> | undefined,
  propertyId: string,
): LedgerSpark | null {
  const entity = pfEntityFor(entries, propertyId);
  if (!entity || !monthly) return null;
  const all = ledgerMonths(monthly[entity]);
  if (all.length < 12) return null;
  const last12 = all.slice(-12);
  const consecutive = last12.every((m, j) => j === 0 || m.month === addMonths(last12[j - 1]!.month, 1));
  if (!consecutive) return null;
  return {
    entity,
    months: last12.map((m) => ({ month: m.month, noi: m.noi })),
    t12: last12.reduce((s, m) => s + m.noi, 0),
    through: last12[11]!.month,
  };
}

export interface RecordedOccDelta {
  /** Percentage points, (to − from) × 100. */
  deltaPp: number;
  from: MonthKey;
  to: MonthKey;
  spanMonths: number;
}

const occ = (r: TrendsHistoryPoint): number | null => (r.totalSf > 0 ? r.leasedSf / r.totalSf : null);

/**
 * Occupancy change between two recorded snapshots of one property: the latest recorded month
 * against the same month a year earlier when recorded, else the earliest recorded month inside that
 * 12-month window. The span is returned so the cell can state it — a 3-month Δ is not a YoY.
 */
export function recordedOccDelta(recorded: readonly TrendsHistoryPoint[], propertyId: string): RecordedOccDelta | null {
  const rows = recorded.filter((r) => r.propertyId === propertyId && occ(r) !== null).sort((a, b) => a.month.localeCompare(b.month));
  const latest = rows[rows.length - 1];
  if (!latest) return null;
  const floor = addMonths(latest.month, -12);
  const prior = rows.find((r) => r.month >= floor && r.month < latest.month);
  if (!prior) return null;
  return {
    deltaPp: (occ(latest)! - occ(prior)!) * 100,
    from: prior.month,
    to: latest.month,
    spanMonths: monthsBetween(prior.month, latest.month),
  };
}

function monthsBetween(a: MonthKey, b: MonthKey): number {
  const [ay, am] = a.split('-').map(Number) as [number, number];
  const [by, bm] = b.split('-').map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
}

/** "+2.1 pp" / "−0.4 pp" / "0.0 pp". */
export function fmtPp(pp: number): string {
  const r = Math.round(pp * 10) / 10;
  if (r === 0) return '0.0 pp';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(1)} pp`;
}

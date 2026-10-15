// src/modules/property-condition/clock.ts
//
// Merges the register's install / warranty facts with the overlay's extra asset facts and attaches the
// runtime warranty / useful-life clock. Years remaining are recomputed from `asOf` on every render — no
// "years left" value is stored anywhere.
import { warrantyClock } from '@/analytics/pca-intelligence';
import type { PcaWarrantyStatus, PcaScheduleRow } from '@contracts/property-condition';
import type { ExtraAssetFact } from './pca-overlay';

export type ClockScheduleRow = PcaScheduleRow & {
  eul: number | null;
  rul: number | null;
  rulAsOfYear: number | null;
  warrantyYearsRemaining: number | null;
  lifeYearsRemaining: number | null;
  /** Where the row came from — the register, or a curated overlay fact with its own provenance. */
  origin: 'register' | 'overlay';
};

function statusFor(endYear: number | null, asOfYear: number): PcaWarrantyStatus {
  if (endYear === null) return 'unknown';
  if (endYear < asOfYear) return 'expired';
  if (endYear === asOfYear) return 'ends-this-year';
  return endYear - asOfYear <= 2 ? 'expiring' : 'active';
}

/** Sort key for "Years left": the soonest-to-expire of warranty and life; one missing side never stands in for the other. */
export function yearsLeftSortKey(r: Pick<ClockScheduleRow, 'warrantyYearsRemaining' | 'lifeYearsRemaining'>): number | null {
  const vals = [r.warrantyYearsRemaining, r.lifeYearsRemaining].filter((v): v is number => v !== null);
  return vals.length === 0 ? null : Math.min(...vals);
}

export function buildClockRows(schedule: PcaScheduleRow[], extras: ExtraAssetFact[], asOf: string): ClockScheduleRow[] {
  const asOfYear = Number(asOf.slice(0, 4));
  const superseded = (r: PcaScheduleRow) =>
    extras.some((x) => x.supersedes !== null && (x.supersedesPropertyKey ?? x.propertyKey) === r.propertyKey && r.component.startsWith(x.supersedes));

  const base: Array<PcaScheduleRow & { eul: number | null; rul: number | null; rulAsOfYear: number | null; origin: 'register' | 'overlay' }> = [
    ...schedule
      .filter((r) => !superseded(r))
      .map((r) => ({ ...r, eul: null, rul: null, rulAsOfYear: null, origin: 'register' as const })),
    ...extras.map((x) => ({
      propertyKey: x.propertyKey,
      propertyLabel: x.propertyLabel,
      component: x.component,
      installFact: x.note,
      installYear: x.installYear,
      ageYears: x.installYear === null ? null : Math.max(0, asOfYear - x.installYear),
      warranty: x.warrantyEndYear === null ? 'None stated' : (x.note ?? `Ends ${x.warrantyEndYear}`),
      warrantyEndYear: x.warrantyEndYear,
      warrantyStatus: statusFor(x.warrantyEndYear, asOfYear),
      flag: null,
      eul: x.eul,
      rul: x.rul,
      rulAsOfYear: x.rulAsOfYear,
      origin: 'overlay' as const,
    })),
  ];
  return warrantyClock(base, asOf);
}

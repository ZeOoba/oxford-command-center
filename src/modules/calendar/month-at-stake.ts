import type { BarDatum } from '@/charts/BarChart';
import type { DatedEvent } from '@/brain/critical-dates';

/**
 * Sums upcoming (daysToDate >= 0) ANNUAL RENT at stake per month, LEASE events only
 * (entityType 'lease' — lease-expiry + escalation). Loan maturities carry the loan balance (a
 * stock) and insurance renewals carry the premium (a different flow than rent); mixing either
 * into this total would sum incompatible bases, so this chart is rent-only — loan/insurance
 * dates stay visible in the Critical Dates list below, just not in this sum. Overdue/holdover
 * dates are excluded — this chart mirrors the Critical Dates list's future-facing framing, not
 * the separate Overdue/Holdover KPI.
 *
 * One lease can carry two DatedEvents in the same month (e.g. an escalation notice and the
 * lease expiry both landing in the same monthKey), and both carry the lease's annualRent as
 * `amount`. Summing every event verbatim would double-count that lease's rent for the month, so
 * within a given month each entity (`entityType:entityId`) contributes its amount at most once.
 */
export function monthlyAtStake(events: DatedEvent[]): BarDatum[] {
  const byMonth = new Map<string, Map<string, number>>();
  for (const e of events) {
    if (e.entityType !== 'lease') continue;
    if (e.daysToDate < 0) continue;
    const seen = byMonth.get(e.monthKey) ?? new Map<string, number>();
    byMonth.set(e.monthKey, seen);
    const entityKey = `${e.entityType}:${e.entityId}`;
    if (seen.has(entityKey)) continue;
    seen.set(entityKey, e.amount ?? 0);
  }
  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthKey, seen]) => ({
      label: new Date(`${monthKey}-01T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'short',
        year: '2-digit',
        timeZone: 'UTC',
      }),
      value: [...seen.values()].reduce((sum, v) => sum + v, 0),
    }));
}

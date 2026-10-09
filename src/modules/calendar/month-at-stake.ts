import type { BarDatum } from '@/charts/BarChart';
import type { DatedEvent } from '@/brain/critical-dates';

/**
 * Sums upcoming (daysToDate >= 0) ANNUAL RENT actually expiring per month — lease-expiry events
 * only (entityType 'lease' AND type 'lease-expiry'). Escalation events are lease events too, but
 * an escalation carries the SAME full annualRent as its lease's own expiry (see
 * src/brain/critical-dates.ts, both push `amount: contractAnnualRent(l)`) — it is a notice date, not rent
 * leaving or landing that month, so counting it would double-book or inflate the total depending
 * on whether it lands in the same month as the expiry. No other lease event type in
 * CalendarEventType carries a comparable rent-at-risk amount (loan-maturity carries the loan
 * balance — a stock — and insurance-renewal carries the premium — a different flow than rent;
 * mixing either in would sum incompatible bases), so this chart stays lease-expiry-only —
 * loan/insurance/escalation dates stay visible in the Critical Dates list below, just not in
 * this sum. Overdue/holdover dates are excluded — this chart mirrors the Critical Dates list's
 * future-facing framing, not the separate Overdue/Holdover KPI.
 *
 * Even restricted to lease-expiry, defensive per-entity dedup stays: within a given month each
 * entity (`entityType:entityId`) contributes its amount at most once, in case a future event
 * source ever emits more than one lease-expiry DatedEvent for the same lease in the same month.
 */
export function monthlyAtStake(events: DatedEvent[]): BarDatum[] {
  const byMonth = new Map<string, Map<string, number>>();
  for (const e of events) {
    if (e.entityType !== 'lease') continue;
    if (e.type !== 'lease-expiry') continue;
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

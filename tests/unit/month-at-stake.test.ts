import { describe, expect, it } from 'vitest';
import { monthlyAtStake } from '../../src/modules/calendar/month-at-stake';

const e = (
  monthKey: string,
  amount: number | null,
  daysToDate: number,
  entityId = 'x',
  entityType: 'lease' | 'loan' | 'insurance' = 'lease',
) => ({ monthKey, amount, daysToDate, entityId, entityType }) as never;

describe('monthlyAtStake', () => {
  it('sums upcoming $ by month, excludes overdue, ascending', () => {
    expect(monthlyAtStake([e('2026-11', 12000, 38), e('2026-10', 38000, 8), e('2026-11', null, 40), e('2024-09', 10000, -752)]))
      .toEqual([{ label: 'Oct 26', value: 38000 }, { label: 'Nov 26', value: 12000 }]);
  });

  it('does not double-count the same lease within a month (notice + expiry both landing there)', () => {
    // Same lease (entityType+entityId) with two dated events in the same month — e.g. an
    // escalation notice and the lease expiry both carrying the lease's annualRent. Only the
    // lease's amount should be counted once for that month, not summed per-event.
    const events = [
      e('2026-11', 50000, 10, 'L-1', 'lease'), // escalation
      e('2026-11', 50000, 45, 'L-1', 'lease'), // expiry — same lease, same month
      e('2026-11', 20000, 20, 'L-2', 'lease'), // different lease, same month
    ];
    expect(monthlyAtStake(events)).toEqual([{ label: 'Nov 26', value: 70000 }]);
  });

  it('excludes loan-maturity (entityType loan) and insurance-renewal (entityType insurance) events — only lease rent counts', () => {
    // A loan balance is a stock and an insurance premium is a flow of a different kind than
    // annual rent; mixing them into "$ at stake" sums incompatible bases. Only lease events
    // (entityType 'lease') contribute — loans/insurance stay in the Critical Dates list below.
    const events = [
      e('2026-11', 50000, 10, 'L-1', 'lease'),
      e('2026-11', 900000, 15, 'LN-1', 'loan'), // loan-maturity balance — excluded
      e('2026-11', 12000, 20, 'INS-1', 'insurance'), // insurance-renewal premium — excluded
    ];
    expect(monthlyAtStake(events)).toEqual([{ label: 'Nov 26', value: 50000 }]);
  });
});

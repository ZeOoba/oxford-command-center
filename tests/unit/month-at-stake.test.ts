import { describe, expect, it } from 'vitest';
import { monthlyAtStake } from '../../src/modules/calendar/month-at-stake';

const e = (
  monthKey: string,
  amount: number | null,
  daysToDate: number,
  entityId = 'x',
  entityType: 'lease' | 'loan' | 'insurance' = 'loan',
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

  it('does not dedupe across different entity types that happen to share an id', () => {
    const events = [
      e('2026-11', 50000, 10, 'SAME-ID', 'lease'),
      e('2026-11', 30000, 20, 'SAME-ID', 'loan'),
    ];
    expect(monthlyAtStake(events)).toEqual([{ label: 'Nov 26', value: 80000 }]);
  });
});

import { describe, expect, it } from 'vitest';
import { monthlyAtStake } from '../../src/modules/calendar/month-at-stake';

const e = (
  monthKey: string,
  amount: number | null,
  daysToDate: number,
  entityId = 'x',
  entityType: 'lease' | 'loan' | 'insurance' = 'lease',
  type: string = 'lease-expiry',
) => ({ monthKey, amount, daysToDate, entityId, entityType, type }) as never;

describe('monthlyAtStake', () => {
  it('sums upcoming $ by month, excludes overdue, ascending', () => {
    expect(monthlyAtStake([e('2026-11', 12000, 38), e('2026-10', 38000, 8), e('2026-11', null, 40), e('2024-09', 10000, -752)]))
      .toEqual([{ label: 'Oct 26', value: 38000 }, { label: 'Nov 26', value: 12000 }]);
  });

  it('does not double-count the same lease within a month (two lease-expiry events landing there)', () => {
    // Same lease (entityType+entityId) with two dated events in the same month. Only the
    // lease's amount should be counted once for that month, not summed per-event.
    const events = [
      e('2026-11', 50000, 10, 'L-1', 'lease'),
      e('2026-11', 50000, 45, 'L-1', 'lease'), // same lease, same month
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

  // I-2: an escalation event carries the lease's FULL annualRent as its amount (same as the
  // lease's own expiry event) — it is a notice date, not rent actually leaving or landing that
  // month. Counting it as "annual rent at stake" double-books that lease's rent whenever the
  // escalation and expiry land in different months, and inflates the total even when they don't.
  // Only lease-expiry events put rent genuinely at stake.
  it('excludes escalation events — only lease-expiry counts as rent at stake', () => {
    const events = [
      e('2026-11', 50000, 10, 'L-1', 'lease', 'lease-expiry'),
      e('2026-11', 50000, 20, 'L-1', 'lease', 'escalation'), // same lease, already counted via its expiry
      e('2026-11', 20000, 5, 'L-2', 'lease', 'escalation'), // escalation-only lease — must not appear at all
    ];
    expect(monthlyAtStake(events)).toEqual([{ label: 'Nov 26', value: 50000 }]);
  });

  it('excludes an escalation entirely when its lease has no corresponding lease-expiry event in the window', () => {
    const events = [e('2026-11', 20000, 5, 'L-2', 'lease', 'escalation')];
    expect(monthlyAtStake(events)).toEqual([]);
  });
});

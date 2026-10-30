import { describe, it, expect } from 'vitest';
import { buildPriorityActionsTier } from '../../src/modules/overview/widgets';
import type { MergedInsight } from '../../src/modules/insights/insights.logic';

function m(over: Partial<MergedInsight> & Pick<MergedInsight, 'id'>): MergedInsight {
  return {
    spine: 'A',
    propertyId: null,
    title: over.id,
    detail: '',
    impactUsd: null,
    severity: 'critical',
    category: 'lease',
    advisoryOnly: true,
    ...over,
  };
}

const lapsed = (n: number) =>
  m({ id: `ins-lapsed-P${n}`, category: 'insurance', spine: 'B', title: `Policy expired — Prop ${n}` });
const lease = (n: number, usd: number) => m({ id: `lease-expiry-L${n}`, impactUsd: usd });

describe('buildPriorityActionsTier', () => {
  it('rolls same-cause alerts into one row before cutting to the limit', () => {
    const merged = [
      ...[1, 2, 3, 4, 5, 6].map((n) => lapsed(n)),
      m({ id: 'debt-note-1', category: 'debt', spine: 'B', impactUsd: 328_000 }),
      lease(1, 58_000),
      lease(2, 48_000),
    ];
    const tier = buildPriorityActionsTier(merged, 5);
    // 6 lapsed policies = ONE row, not six of the five slots.
    expect(tier.items.map((i) => i.title)).toEqual([
      '6 insurance policies expired or cancelled',
      'debt-note-1',
      'lease-expiry-L1',
      'lease-expiry-L2',
    ]);
  });

  it('puts lapsed coverage first even though its dollars are unquantified', () => {
    const tier = buildPriorityActionsTier([lease(1, 900_000), lapsed(1)], 5);
    expect(tier.items[0]!.id).toBe('ins-lapsed-P1');
    expect(tier.items[0]!.impactUsd).toBeNull();
  });

  it('never lets dollar rows crowd out an unquantified breach (DSCR floor, reconcile failure)', () => {
    const merged = [
      // Ids with no cause, so each is its own row and competes for a slot.
      ...[1, 2, 3, 4, 5, 6].map((n) => m({ id: `debt-note-${n}`, category: 'debt', spine: 'B', impactUsd: 100_000 - n })),
      m({ id: 'dscr-floor-P9', category: 'debt', spine: 'B', title: 'DSCR below floor — P9' }),
      m({ id: 'reconcile-fail', category: 'data', spine: 'B', title: 'Reconciliation failure' }),
    ];
    const ids = buildPriorityActionsTier(merged, 3).items.map((i) => i.id);
    expect(ids).toContain('dscr-floor-P9');
    expect(ids).toContain('reconcile-fail');
    expect(ids).toHaveLength(3);
  });

  // wf_42182077-678: `expiring-*` ids are critical (<60d) OR warning (60-180d) under ONE cause. Grouping
  // across severities folded a critical lease into a warning roll-up and hid it from the top 5.
  it('groups within each severity, so a critical lease never folds into a warning roll-up', () => {
    const exp = (id: string, severity: 'critical' | 'warning', usd: number) =>
      m({ id: `expiring-${id}`, severity, impactUsd: usd, title: `Expiring ${id}` });
    const merged = [
      exp('L4', 'critical', 100_000),
      exp('L5', 'warning', 10),
      exp('L6', 'warning', 10),
      exp('L7', 'warning', 10),
    ];
    const tier = buildPriorityActionsTier(merged, 5);
    expect(tier.items.map((i) => i.id)).toEqual(['expiring-L4', 'group:warning:lease-expiring-soon']);
    expect(tier.items[1]!.members).toHaveLength(3);
    expect(new Set(tier.items.map((i) => i.id)).size).toBe(tier.items.length);
  });

  // A warning roll-up sums its members' dollars, so it can out-total a single critical row. Severity
  // is the primary key: every critical row precedes every warning row regardless of dollars.
  it('ranks every critical row ahead of warning rows, even a warning roll-up with larger dollars', () => {
    const warn = (n: number) => m({ id: `escalation-W${n}`, severity: 'warning', impactUsd: 40_000 });
    const merged = [warn(1), warn(2), warn(3), m({ id: 'debt-note-1', category: 'debt', spine: 'B', impactUsd: 30_000 })];
    const tier = buildPriorityActionsTier(merged, 5);
    expect(tier.items.map((i) => i.id)).toEqual(['debt-note-1', 'group:warning:escalation-passed']);
    expect(tier.items.map((i) => i.rank)).toEqual([1, 2]);
  });

  it('keeps one group row per severity when a cause spans both (unique ids)', () => {
    const exp = (id: string, severity: 'critical' | 'warning') => m({ id: `expiring-${id}`, severity, impactUsd: 5 });
    const tier = buildPriorityActionsTier(
      [exp('a', 'critical'), exp('b', 'critical'), exp('c', 'critical'), exp('d', 'warning'), exp('e', 'warning'), exp('f', 'warning')],
      5,
    );
    expect(tier.items.map((i) => i.id).sort()).toEqual(['group:critical:lease-expiring-soon', 'group:warning:lease-expiring-soon']);
  });

  it('a duplicate id cannot inflate the subtotal or appear twice', () => {
    const tier = buildPriorityActionsTier([lease(1, 100), lease(1, 100), lease(2, 50)], 5);
    expect(tier.items.map((i) => i.id)).toEqual(['lease-expiry-L1', 'lease-expiry-L2']);
    expect(tier.totalsBySpine?.find((t) => t.label === 'Workbook basis')?.totalUsd).toBe(150);
  });

  it('subtotals only the signals actually shown, per basis', () => {
    const merged = [lapsed(1), lease(1, 100), lease(2, 50), m({ id: 'x-1', impactUsd: 7 }), m({ id: 'x-2', impactUsd: 6 })];
    const tier = buildPriorityActionsTier(merged, 2); // lapsed + the $100 lease only
    const byLabel = Object.fromEntries((tier.totalsBySpine ?? []).map((t) => [t.label, t.totalUsd]));
    expect(byLabel['Workbook basis']).toBe(100);
    expect(byLabel['Ledger & combined basis']).toBe(0);
  });
});

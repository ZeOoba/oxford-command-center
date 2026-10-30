import { describe, it, expect } from 'vitest';
import { buildPriorityActionsTier } from '../../src/modules/overview/widgets';
import { OVERVIEW_MAX_ITEMS } from '../../src/lib/ranked-cap';
import { MIN_GROUP_SIZE } from '../../src/lib/tier-group';
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
  // Adversarial review 2026-10-30: the cap sliced the ranked rows, so once pinned rows outnumbered
  // the limit the overflow pinned rows (a DSCR breach, a lapsed policy) were silently cut. A cause
  // only collapses at MIN_GROUP_SIZE, so two-member pinned causes stay as separate rows.
  describe('pinned rows are never cut by the surface cap', () => {
    // Two members per cause (below MIN_GROUP_SIZE, so each stays its own row) plus one singleton.
    // Severities are the generator's real ones (src/analytics/conditions.ts): dscr-floor-,
    // ins-lapsed- and reconcile-fail are critical; dscr- (covenant watch) and ltv- are WARNING. The
    // m() default of 'critical' hid that pinned warnings could crowd critical rows off the surface.
    const pinnedMerged = () => [
      m({ id: 'dscr-floor-P1', category: 'debt', spine: 'B', severity: 'critical' }),
      m({ id: 'dscr-floor-P2', category: 'debt', spine: 'B', severity: 'critical' }),
      m({ id: 'dscr-P3', category: 'debt', spine: 'B', severity: 'warning' }),
      m({ id: 'dscr-P4', category: 'debt', spine: 'B', severity: 'warning' }),
      m({ id: 'ltv-P5', category: 'debt', spine: 'B', severity: 'warning' }),
      m({ id: 'ltv-P6', category: 'debt', spine: 'B', severity: 'warning' }),
      lapsed(7),
      lapsed(8),
      m({ id: 'reconcile-fail', category: 'data', spine: 'B', severity: 'critical' }),
    ];
    // Warning-tier dollar rows: they share a tier with the pinned warnings, so the cap (not the
    // severity rule) decides whether they show.
    const dollarRows = (n: number, severity: 'critical' | 'warning' = 'warning') =>
      Array.from({ length: n }, (_, i) =>
        m({ id: `debt-note-${i + 1}`, category: 'debt', spine: 'B', impactUsd: 500_000 - i, severity }),
      );

    it('shows every pinned row when they outnumber OVERVIEW_MAX_ITEMS, and holds back only unpinned rows', () => {
      expect(MIN_GROUP_SIZE).toBe(3); // the fixture relies on 2-member causes staying separate rows
      const pinned = pinnedMerged();
      expect(pinned.length).toBeGreaterThanOrEqual(8);
      expect(pinned.length).toBeGreaterThan(OVERVIEW_MAX_ITEMS);
      const tier = buildPriorityActionsTier([...dollarRows(3), ...pinned], OVERVIEW_MAX_ITEMS);
      const ids = tier.items.map((i) => i.id);
      for (const p of pinned) expect(ids).toContain(p.id);
      expect(tier.items).toHaveLength(pinned.length);
      expect(tier.items.every((i) => i.pinned)).toBe(true);
      expect(tier.heldBack).toEqual({ rows: 3, signals: 3 });
    });

    it('fills the remaining slots with the top unpinned rows when pinned rows fit under the cap', () => {
      const pinned = pinnedMerged().slice(0, 5);
      const tier = buildPriorityActionsTier([...dollarRows(6), ...pinned], OVERVIEW_MAX_ITEMS);
      expect(tier.items).toHaveLength(OVERVIEW_MAX_ITEMS);
      expect(tier.items.slice(0, 5).every((i) => i.pinned)).toBe(true);
      expect(tier.items.slice(5).map((i) => i.id)).toEqual(['debt-note-1', 'debt-note-2']);
      expect(tier.heldBack).toEqual({ rows: 4, signals: 4 });
    });

    it('counts held-back signals inside a held-back group row, and reports zero when nothing is cut', () => {
      const lease3 = [1, 2, 3].map((n) => lease(n, 10)); // one group row of 3 signals, lowest dollars
      const tier = buildPriorityActionsTier([...dollarRows(2, 'critical'), ...lease3], 2);
      expect(tier.items.map((i) => i.id)).toEqual(['debt-note-1', 'debt-note-2']);
      expect(tier.heldBack).toEqual({ rows: 1, signals: 3 });
      expect(buildPriorityActionsTier(dollarRows(2), 7).heldBack).toEqual({ rows: 0, signals: 0 });
    });

    it('subtotals the overflow pinned rows it shows (shown ids drive the subtotal)', () => {
      const pinned = pinnedMerged().map((p, i) => ({ ...p, impactUsd: i === 8 ? 1_000 : null }));
      const tier = buildPriorityActionsTier([...dollarRows(3), ...pinned], OVERVIEW_MAX_ITEMS);
      expect(tier.items.map((i) => i.id)).toContain('reconcile-fail');
      const byLabel = Object.fromEntries((tier.totalsBySpine ?? []).map((t) => [t.label, t.totalUsd]));
      expect(byLabel['Ledger & combined basis']).toBe(1_000);
    });

    // Adversarial review 2026-10-30 (C4): pinned rows ranked first ACROSS severities, so seven pinned
    // rows (four of them warning-level covenant / LTV watches) filled the 7-row Overview and a
    // critical $2M balloon and critical $250K arrears were held back behind them.
    it('never holds back a critical row while a pinned warning row shows', () => {
      const merged = [
        m({ id: 'dscr-floor-P1', category: 'debt', spine: 'B', severity: 'critical' }),
        m({ id: 'dscr-floor-P2', category: 'debt', spine: 'B', severity: 'critical' }),
        m({ id: 'dscr-P3', category: 'debt', spine: 'B', severity: 'warning' }),
        m({ id: 'dscr-P4', category: 'debt', spine: 'B', severity: 'warning' }),
        m({ id: 'ltv-P5', category: 'debt', spine: 'B', severity: 'warning' }),
        m({ id: 'ltv-P6', category: 'debt', spine: 'B', severity: 'warning' }),
        m({ id: 'reconcile-fail', category: 'data', spine: 'B', severity: 'critical' }),
        m({ id: 'balloon-L1', category: 'debt', spine: 'B', severity: 'critical', impactUsd: 2_000_000 }),
        m({ id: 'arrears-T1', category: 'collections', spine: 'B', severity: 'critical', impactUsd: 250_000 }),
      ];
      const tier = buildPriorityActionsTier(merged, OVERVIEW_MAX_ITEMS);
      const ids = tier.items.map((i) => i.id);
      expect(ids).toContain('balloon-L1');
      expect(ids).toContain('arrears-T1');
      for (const p of merged.filter((x) => x.id.startsWith('dscr') || x.id.startsWith('ltv') || x.id === 'reconcile-fail')) {
        expect(ids).toContain(p.id); // pinned rows still never cut (may exceed the cap)
      }
      expect(tier.heldBack).toEqual({ rows: 0, signals: 0 });
      // Display: critical tier (pinned first, then dollars), then warning tier.
      expect(ids).toEqual([
        'dscr-floor-P1',
        'dscr-floor-P2',
        'reconcile-fail',
        'balloon-L1',
        'arrears-T1',
        'dscr-P3',
        'dscr-P4',
        'ltv-P5',
        'ltv-P6',
      ]);
      expect(tier.items.map((i) => i.rank)).toEqual(ids.map((_, i) => i + 1));
    });

    it('every shown critical row precedes every shown warning row, and no critical is held back while a warning shows (#505)', () => {
      const sevOf = new Map<string, string>();
      const corpus: MergedInsight[][] = [];
      for (let k = 0; k <= 9; k++) {
        const merged = [
          ...pinnedMerged().slice(0, k),
          ...dollarRows(4, 'critical').map((x) => ({ ...x, id: `${x.id}-c` })),
          ...dollarRows(4, 'warning').map((x) => ({ ...x, id: `${x.id}-w`, impactUsd: 9_000_000 })),
          m({ id: 'info-1', severity: 'info', impactUsd: 50_000_000 }),
        ];
        corpus.push(merged);
      }
      for (const merged of corpus) {
        for (const x of merged) sevOf.set(x.id, x.severity);
        const tier = buildPriorityActionsTier(merged, OVERVIEW_MAX_ITEMS);
        const order = { critical: 0, warning: 1, info: 2 } as const;
        const rowSev = (row: (typeof tier.items)[number]) =>
          order[sevOf.get((row.members ?? [row])[0]!.id) as keyof typeof order];
        const sevs = tier.items.map(rowSev);
        expect([...sevs].sort((a, b) => a - b)).toEqual(sevs);
        const shownIds = new Set(tier.items.flatMap((r) => (r.members ?? [r]).map((x) => x.id)));
        const worstShown = Math.max(...sevs);
        for (const x of merged) {
          if (order[x.severity as keyof typeof order] < worstShown) expect(shownIds.has(x.id)).toBe(true);
        }
      }
    });
  });
});

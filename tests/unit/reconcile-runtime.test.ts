import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot, Lease } from '../../src/contracts/index';
import { evaluateConditions } from '../../src/analytics/conditions';
import { checkSnapshot, checkStaleLeaseRows, checkDebtBasis } from '../../server/reconcile-runtime';

const base = (over: Partial<Record<string, unknown>> = {}): PortfolioSnapshot =>
  ({
    properties: [{ id: 'p1' }],
    leases: [{ id: 'l1', annualRent: 1200, monthlyRent: 100 }],
    loans: [],
    deals: [],
    insurance: [],
    cash: { totalCash: 500, entities: [{ id: 'e1', currentBalance: 500 }] },
    counterparties: [],
    dataQuality: [],
    ...over,
  }) as unknown as PortfolioSnapshot;

describe('checkSnapshot — runtime reconciliation', () => {
  it('returns no flags for a consistent snapshot', () => {
    expect(checkSnapshot(base())).toEqual([]);
  });

  it('flags a cash total that does not equal Σ entities (error)', () => {
    const flags = checkSnapshot(base({ cash: { totalCash: 999, entities: [{ id: 'e1', currentBalance: 500 }] } }));
    expect(flags.some((f) => f.field === 'cash.totalCash' && f.severity === 'error')).toBe(true);
  });

  it('flags annual rent ≠ Σ(monthly×12) (warn)', () => {
    const flags = checkSnapshot(base({ leases: [{ id: 'l1', annualRent: 1000, monthlyRent: 100 }] }));
    expect(flags.some((f) => f.field === 'leases.annualRent' && f.severity === 'warn')).toBe(true);
  });

  it('flags dangling relationship edges (warn)', () => {
    const flags = checkSnapshot(base({ counterparties: [{ links: { properties: ['nope'], loans: [], deals: [], insurance: [] } }] }));
    expect(flags.some((f) => f.field === 'counterparties.links')).toBe(true);
  });

  it('flags empty core entity sets (error)', () => {
    const flags = checkSnapshot(base({ properties: [] }));
    expect(flags.some((f) => f.field === 'properties' && f.severity === 'error')).toBe(true);
  });

  // The three near-duplicate deal-name cases that stood here were RETIRED 2026-08-12 with the check
  // they covered. checkSnapshot ran findNearDuplicateNames over the MERGED deal set, which was the
  // wrong layer: a wrong merge leaves exactly ONE row, so the failure the check most needed to
  // catch was structurally invisible to it, and the duplicates it did catch were reported without
  // the fact that explains them — which rows failed to join. mergeDeals now raises that itself
  // (its migration tripwire), and deals join on an opaque Deal ID, so a naming variance can no
  // longer produce two rows for one deal at all. Coverage lives in
  // tests/unit/deal-id-join.test.ts and tests/unit/deal-id-join-invariants.test.ts.
  //
  // The property-id collision backstop below is UNRELATED and stays: property ids are a different
  // join key with a different producer (parse.ts), and nothing about the deal join touches it.

  it('flags duplicate property ids (error) — the join-key collision backstop', () => {
    const flags = checkSnapshot(base({ properties: [{ id: 'dup' }, { id: 'dup' }, { id: 'ok' }] }));
    expect(flags.some((f) => f.field === 'properties.id' && f.severity === 'error' && /dup/.test(f.issue))).toBe(true);
  });

  it('passes when all property ids are distinct', () => {
    const flags = checkSnapshot(base({ properties: [{ id: 'a' }, { id: 'b' }] }));
    expect(flags.some((f) => f.field === 'properties.id')).toBe(false);
  });

  // Restored 2026-08-13 (code review): this check stood here as findNearDuplicateNames until
  // 2026-08-12, when it was retired on the argument that mergeDeals' migration tripwire replaced
  // it. That missed that checkSnapshot is ALSO invoked by scripts/reconcile-snapshot.ts's
  // `npm run gate:ci` — zero Notion I/O, zero call into mergeDeals — which exists precisely to
  // catch corruption in the COMMITTED snapshot independent of how it was generated.
  describe('deal duplicate/collision backstop — reachable independent of a live Notion fetch', () => {
    it('flags duplicate deal Deal IDs (error) — same shape as properties.id', () => {
      const flags = checkSnapshot(base({
        deals: [
          { id: 'a', name: 'Alpha', notionDealId: 'DEAL-1' },
          { id: 'b', name: 'Beta', notionDealId: 'DEAL-1' },
        ],
      }));
      expect(flags.some((f) => f.field === 'deals.notionDealId' && f.severity === 'error' && /DEAL-1/.test(f.issue))).toBe(true);
    });

    it('flags two rows sharing a normalized name and DIFFERENT Deal IDs, naming both ids', () => {
      const flags = checkSnapshot(base({
        deals: [
          { id: 'a', name: 'Quorravale Depot', notionDealId: 'DEAL-1' },
          { id: 'b', name: 'Quorravale Depot', notionDealId: 'DEAL-2' },
        ],
      }));
      const f = flags.find((x) => x.field === 'deals.name')!;
      expect(f.severity).toBe('error');
      expect(f.issue).toContain('different Deal IDs');
      expect(f.issue).toContain('DEAL-1');
      expect(f.issue).toContain('DEAL-2');
    });

    it('says "SAME Deal ID" — not "different" — for a verbatim-duplicated row (the CI path’s primary target)', () => {
      // The exact scenario reconcile-snapshot.ts's gate:ci call exists to catch: a merge conflict
      // or hand-edit duplicating one row. Asserting "different Deal IDs" here would be false and
      // would misdirect the operator toward Notion for a defect that lives in the committed file.
      const flags = checkSnapshot(base({
        deals: [
          { id: 'a', name: 'Quorravale Depot', notionDealId: 'DEAL-1' },
          { id: 'a', name: 'Quorravale Depot', notionDealId: 'DEAL-1' },
        ],
      }));
      const f = flags.find((x) => x.field === 'deals.name')!;
      expect(f.issue).toContain('SAME Deal ID');
      expect(f.issue).not.toContain('different Deal IDs');
      expect(f.issue.toLowerCase()).toContain('merge conflict');
    });

    it('names no deal in either the notionDealId or the name duplicate flag — both reach the public mirror', () => {
      const flags = checkSnapshot(base({
        deals: [
          { id: 'a', name: 'Zephyrine Yard', notionDealId: 'DEAL-9' },
          { id: 'b', name: 'Zephyrine Yard', notionDealId: 'DEAL-9' },
        ],
      }));
      const published = JSON.stringify(flags);
      expect(published).not.toContain('Zephyrine');
    });

    it('suppresses a genuine cross-metro namesake, but only when the states actually differ', () => {
      const suppressed = checkSnapshot(base({
        deals: [
          { id: 'a', name: '470 McCormick Blvd — Columbus, OH', notionDealId: 'DEAL-1' },
          { id: 'b', name: '470 McCormick Blvd — Louisville, KY', notionDealId: 'DEAL-2' },
        ],
      }));
      expect(suppressed.some((f) => f.field === 'deals.name')).toBe(false);

      // Same-STATE namesakes are realistic for ORA's own Columbus/Cincinnati OH cluster and must
      // NOT be waved through by a bare locality tail — the remedy text says so explicitly.
      const notSuppressed = checkSnapshot(base({
        deals: [
          { id: 'a', name: '1200 Main St — Columbus, OH', notionDealId: 'DEAL-1' },
          { id: 'b', name: '1200 Main St — Cincinnati, OH', notionDealId: 'DEAL-2' },
        ],
      }));
      const f = notSuppressed.find((x) => x.field === 'deals.name')!;
      expect(f).toBeDefined();
      expect(f.issue).toContain('DIFFERENT STATE');
    });
  });

  it('flags a cash-history latest point that disagrees with the current total (error)', () => {
    const flags = checkSnapshot(
      base({ cash: { totalCash: 500, entities: [{ id: 'e1', currentBalance: 500 }], history: [{ total: 100 }] } }),
    );
    expect(flags.some((f) => f.field === 'cash.history' && f.severity === 'error')).toBe(true);
  });

  it('does not flag cash history when there is none (no history array supplied)', () => {
    const flags = checkSnapshot(base());
    expect(flags.some((f) => f.field === 'cash.history')).toBe(false);
  });

  it('flags a property NOI sum that disagrees with the workbook\'s own Portfolio Total', () => {
    const flags = checkSnapshot(
      base({ properties: [{ id: 'p1', noi: 100 }], workbookTotals: { noi: 999, value: null, rent: null } }),
    );
    expect(flags.some((f) => f.field === 'properties.noi' && f.severity === 'error')).toBe(true);
  });

  it('flags an Oxford value sum that disagrees with the workbook\'s own Portfolio Total', () => {
    const flags = checkSnapshot(
      base({ properties: [{ id: 'p1', oxfordValue: 100 }], workbookTotals: { noi: null, value: 999, rent: null } }),
    );
    expect(flags.some((f) => f.field === 'properties.oxfordValue' && f.severity === 'error')).toBe(true);
  });

  it('flags an annual rent sum that disagrees with the workbook\'s own Portfolio Total', () => {
    const flags = checkSnapshot(
      base({ leases: [{ id: 'l1', annualRent: 1200, monthlyRent: 100 }], workbookTotals: { noi: null, value: null, rent: 5000 } }),
    );
    expect(flags.some((f) => f.field === 'leases.annualRent' && f.severity === 'error')).toBe(true);
  });

  it('does not cross-check against the workbook Portfolio Total when workbookTotals is absent (legacy payload)', () => {
    const flags = checkSnapshot(base({ properties: [{ id: 'p1', noi: 100 }] }));
    expect(flags.some((f) => f.field === 'properties.noi')).toBe(false);
  });

  // cc-audit-army finding unresolved-lease-propertyid-silent: a lease that never resolved to a
  // property (parse.ts's rowFlags handles the per-row 'warn') must ALSO fail the snapshot at the
  // aggregate level once the unresolved share is material — mirrors the reproduced incident (41 of
  // 138 leases, $1.14M, ~30% of rent, on the largest-NOI property).
  describe('unresolved lease propertyId — aggregate backstop', () => {
    it('flags when unresolved-propertyId rent exceeds 1% of the workbook total (error)', () => {
      const flags = checkSnapshot(
        base({
          leases: [
            { id: 'l1', propertyId: 'p1', annualRent: 9_700, monthlyRent: 9_700 / 12 },
            { id: 'l2', propertyId: null, annualRent: 300, monthlyRent: 25 },
          ],
          workbookTotals: { noi: null, value: null, rent: 10_000 },
        }),
      );
      const f = flags.find((x) => x.field === 'leases.propertyId');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('error');
      expect(f!.issue).toContain('3.0%');
      expect(f!.issue).toContain('300');
    });

    it('does not flag a negligible unresolved share (below 1%)', () => {
      const flags = checkSnapshot(
        base({
          leases: [
            { id: 'l1', propertyId: 'p1', annualRent: 9_950, monthlyRent: 9_950 / 12 },
            { id: 'l2', propertyId: null, annualRent: 50, monthlyRent: 50 / 12 },
          ],
          workbookTotals: { noi: null, value: null, rent: 10_000 },
        }),
      );
      expect(flags.some((f) => f.field === 'leases.propertyId')).toBe(false);
    });

    it('does not flag when workbookTotals is absent (nothing to compare against)', () => {
      const flags = checkSnapshot(
        base({ leases: [{ id: 'l1', propertyId: null, annualRent: 1_000_000, monthlyRent: 1_000_000 / 12 }] }),
      );
      expect(flags.some((f) => f.field === 'leases.propertyId')).toBe(false);
    });

    it('reproduces the incident shape: the largest-NOI property resolving zero leases fails the snapshot', () => {
      const leases = [
        // 41 leases, $1.14M/yr, all unresolved — matches the reproduced incident.
        ...Array.from({ length: 41 }, (_, i) => ({
          id: `unresolved-${i}`,
          propertyId: null,
          annualRent: 1_140_000 / 41,
          monthlyRent: 1_140_000 / 41 / 12,
        })),
        // 97 resolved leases making up the rest of a $5M portfolio.
        { id: 'resolved-1', propertyId: 'p1', annualRent: 5_000_000 - 1_140_000, monthlyRent: (5_000_000 - 1_140_000) / 12 },
      ];
      const flags = checkSnapshot(
        base({ leases, workbookTotals: { noi: null, value: null, rent: 5_000_000 } }),
      );
      const f = flags.find((x) => x.field === 'leases.propertyId');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('error');
    });
  });

  // 2026-09-14 financial-code sweep: the committed snapshot carried cash.asOf = 2026-09-10 over a
  // history array whose last row was 2026-07-10, with the July slot's total bit-identical to the
  // September headline -- a clobbered slot, and the ONLY cash-history check here ("latest point =
  // current total") read that as a pass. Date-aware invariants close it. Detection only: the missing
  // 08-10 / 09-10 rows are a workbook problem for a human, never backfilled here.
  describe('cash — date-aware history invariants', () => {
    const cashWith = (over: Record<string, unknown>) => ({
      asOf: '2026-07-10',
      totalCash: 500,
      entities: [{ id: 'e1', currentBalance: 500 }],
      history: [
        { date: '2026-06-10', total: 400 },
        { date: '2026-07-10', total: 500 },
      ],
      ...over,
    });

    it('is silent for a history that ends on cash.asOf with distinct consecutive totals', () => {
      const flags = checkSnapshot(base({ meta: { generatedAt: '2026-07-14T14:23:48.819Z' }, cash: cashWith({}) }));
      expect(flags.filter((f) => f.field.startsWith('cash.'))).toEqual([]);
    });

    it('flags cash.asOf later than meta.generatedAt (error) — a structural impossibility, not a business event', () => {
      const flags = checkSnapshot(base({ meta: { generatedAt: '2026-09-14T14:23:48.819Z' }, cash: cashWith({ asOf: '2026-09-15', history: [{ date: '2026-09-15', total: 500 }] }) }));
      const f = flags.find((x) => x.field === 'cash.asOf');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('error');
      expect(f!.issue).toContain('2026-09-15');
      expect(f!.issue).toContain('2026-09-14');
    });

    it('compares asOf to generatedAt on the DATE portion — a bare date on the same day as a later-in-the-day timestamp is fine', () => {
      const flags = checkSnapshot(base({ meta: { generatedAt: '2026-09-14T00:00:01.000Z' }, cash: cashWith({ asOf: '2026-09-14', history: [{ date: '2026-09-14', total: 500 }] }) }));
      expect(flags.some((f) => f.field === 'cash.asOf')).toBe(false);
    });

    it('flags (warn) a history whose latest date is not cash.asOf — the September asOf over a July-ending history', () => {
      const flags = checkSnapshot(base({ meta: { generatedAt: '2026-09-14T14:23:48.819Z' }, cash: cashWith({ asOf: '2026-09-10' }) }));
      const f = flags.find((x) => x.field === 'cash.history.date');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('warn');
      expect(f!.issue).toContain('2026-07-10');
      expect(f!.issue).toContain('2026-09-10');
    });

    it('flags (warn) two consecutive history entries with identical totals — the clobbered-slot signature', () => {
      const flags = checkSnapshot(base({
        meta: { generatedAt: '2026-07-14T14:23:48.819Z' },
        cash: cashWith({ history: [{ date: '2026-05-10', total: 300 }, { date: '2026-06-10', total: 500 }, { date: '2026-07-10', total: 500 }] }),
      }));
      const f = flags.find((x) => x.field === 'cash.history.total');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('warn');
      expect(f!.issue).toContain('2026-06-10');
      expect(f!.issue).toContain('2026-07-10');
    });

    // 2026-09-25: a 2026-07-10 row was keyed from estimates. The value-only gate check caught it only
    // because the current balances were not rolled forward; had they been, it would have passed.
    describe('estimated-row signature (round-number balances)', () => {
      const june = { A: 181752.34, B: 4479008, C: 39262.31, D: 1592701.78, E: 211498.933, F: 17479.8 };
      const row = (date: string, balances: Record<string, number>) => ({
        date,
        total: Object.values(balances).reduce((a, b) => a + b, 0),
        balances,
      });
      const flagsFor = (latest: Record<string, number>) =>
        checkSnapshot(base({ cash: cashWith({ history: [row('2026-06-10', june), row('2026-07-10', latest)] }) }))
          .filter((f) => f.field === 'cash.history.estimated');

      it('flags (warn) the live 2026-07-10 shape: most changed balances are whole multiples of $500', () => {
        const f = flagsFor({ ...june, A: 220000, B: 4500000, C: 55000, D: 1500000, E: 212000 });
        expect(f).toHaveLength(1);
        expect(f[0]!.severity).toBe('warn');
        expect(f[0]!.issue).toContain('2026-07-10');
        expect(f[0]!.issue).toContain('5 of 5');
      });

      it('is silent for statement-style balances (cents, odd dollars), even when some entities are unchanged', () => {
        expect(flagsFor({ ...june, A: 190313.07, B: 4481220, D: 1601877.12, E: 212004.5 })).toEqual([]);
      });

      it('is silent when only one or two changed balances happen to be round', () => {
        expect(flagsFor({ ...june, A: 190000, B: 4481220.5, C: 40000, D: 1601877.12 })).toEqual([]);
      });

      it('is silent for history rows that carry no per-entity balances', () => {
        expect(checkSnapshot(base({ cash: cashWith({}) })).some((f) => f.field === 'cash.history.estimated')).toBe(false);
      });
    });

    it('does not run the date checks when the snapshot carries no history / asOf / meta (legacy fixture)', () => {
      expect(checkSnapshot(base()).filter((f) => f.field.startsWith('cash.'))).toEqual([]);
    });
  });

  // 2026-09-14 sweep: two live entities carried a percent whose sign contradicted its own dollar
  // figure (deltaDollar -1,698 with deltaPct +4.1%; growth12Dollar +2,064 with growth12Pct -1186%)
  // because the workbook's own percent cell divides by a NEGATIVE prior balance. parse.ts now
  // recomputes both and emits null over a wrong-signed number; this is the self-consistency
  // backstop over whatever is actually on the snapshot (committed file, legacy bake, hand-edit).
  describe('cash — entity self-consistency (dollar vs percent sign, all-time min/max vs current)', () => {
    const entity = (over: Record<string, unknown>) => ({
      id: 'e1', currentBalance: 500, priorBalance: null, deltaDollar: null, deltaPct: null,
      minAllTime: null, maxAllTime: null, bal12moAgo: null, growth12Dollar: null, growth12Pct: null,
      ...over,
    });
    const snapWith = (e: Record<string, unknown>) => base({ cash: { totalCash: 500, entities: [entity(e)] } });

    it('flags (warn) an entity whose deltaDollar and deltaPct disagree in sign', () => {
      const flags = checkSnapshot(snapWith({ deltaDollar: -1698.4, deltaPct: 0.0413 }));
      const f = flags.find((x) => x.field === 'cash.entities.deltaPct');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('warn');
      expect(f!.issue).toContain('e1');
    });

    it('flags (warn) an entity whose growth12Dollar and growth12Pct disagree in sign', () => {
      const flags = checkSnapshot(snapWith({ growth12Dollar: 2064.165, growth12Pct: -11.863 }));
      const f = flags.find((x) => x.field === 'cash.entities.growth12Pct');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('warn');
    });

    it('is silent when the signs agree, when either side is null, or when the dollar move is exactly zero', () => {
      expect(checkSnapshot(snapWith({ deltaDollar: 416.9, deltaPct: 0.0503 })).filter((f) => f.field.startsWith('cash.entities'))).toEqual([]);
      expect(checkSnapshot(snapWith({ deltaDollar: -416.9, deltaPct: null })).filter((f) => f.field.startsWith('cash.entities'))).toEqual([]);
      expect(checkSnapshot(snapWith({ deltaDollar: 0, deltaPct: 0 })).filter((f) => f.field.startsWith('cash.entities'))).toEqual([]);
    });

    it('flags (warn) maxAllTime below the current balance — a stale workbook cell, found live', () => {
      const flags = checkSnapshot(snapWith({ currentBalance: 500, maxAllTime: 450 }));
      const f = flags.find((x) => x.field === 'cash.entities.maxAllTime');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('warn');
      expect(f!.issue).toContain('450');
      expect(f!.issue).toContain('500');
    });

    it('flags (warn) minAllTime above the current balance', () => {
      const flags = checkSnapshot(snapWith({ currentBalance: 500, minAllTime: 600 }));
      expect(flags.some((f) => f.field === 'cash.entities.minAllTime' && f.severity === 'warn')).toBe(true);
    });

    it('is silent when min ≤ current ≤ max, and within the $2 rounding tolerance the other cash checks use', () => {
      expect(checkSnapshot(snapWith({ currentBalance: 500, minAllTime: 100, maxAllTime: 500 })).filter((f) => f.field.startsWith('cash.entities'))).toEqual([]);
      expect(checkSnapshot(snapWith({ currentBalance: 500.9, minAllTime: 100, maxAllTime: 500 })).filter((f) => f.field.startsWith('cash.entities'))).toEqual([]);
    });
  });

  it('passes when property NOI/value and annual rent all agree with the workbook Portfolio Total', () => {
    const flags = checkSnapshot(
      base({
        properties: [{ id: 'p1', noi: 400, oxfordValue: 5000000 }],
        leases: [{ id: 'l1', annualRent: 1200, monthlyRent: 100 }],
        workbookTotals: { noi: 400, value: 5000000, rent: 1200 },
      }),
    );
    expect(flags).toEqual([]);
  });
});

describe('checkStaleLeaseRows', () => {
  const meta = { asOf: '2026-09-23' } as PortfolioSnapshot['meta'];
  const l = (o: Partial<Lease>) => ({ id: 'x', tenantName: 'T', status: 'Active', leaseEnd: null, ...o }) as Lease;
  it('flags a non-Expired row whose leaseEnd passed > 365d ago (workbook row whose status was never updated)', () => {
    const flags = checkStaleLeaseRows({ meta, leases: [l({ id: 'st1', tenantName: 'Stale Co', leaseEnd: '2024-09-01' })] });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ entity: 'lease', field: 'lease.st1.leaseEnd', severity: 'warn' });
    expect(flags[0]!.issue).toContain('Stale Co');
  });
  it('is NOT a reconciliation-entity flag (would otherwise fire the CRITICAL "Reconciliation failure" insight)', () => {
    const flags = checkStaleLeaseRows({ meta, leases: [l({ leaseEnd: '2024-09-01' })] });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.entity).not.toBe('reconciliation');
  });
  it('ignores recent holdovers and rows already marked Expired', () => {
    expect(checkStaleLeaseRows({ meta, leases: [
      l({ leaseEnd: '2026-06-30' }),
      l({ status: 'Expired', leaseEnd: '2023-01-01' }),
    ] })).toEqual([]);
  });
  it('ignores rows with no leaseEnd', () => {
    expect(checkStaleLeaseRows({ meta, leases: [l({ leaseEnd: null })] })).toEqual([]);
  });
  it('threshold is strictly > 365 days: exactly 365 → no flag, 366 → flag', () => {
    expect(checkStaleLeaseRows({ meta, leases: [l({ leaseEnd: '2025-09-23' })] })).toEqual([]);
    expect(checkStaleLeaseRows({ meta, leases: [l({ leaseEnd: '2025-09-22' })] })).toHaveLength(1);
  });
  it('normalizes a leaseEnd carrying a time component to its date before comparing (matches asOf)', () => {
    // 366 calendar days before asOf. Without the slice(0, 10) a local-time-of-day component shifts
    // the parsed instant by up to a day relative to the date-only (UTC) asOf and can round to 365.
    expect(checkStaleLeaseRows({ meta, leases: [l({ leaseEnd: '2025-09-22T12:00:00' })] })).toHaveLength(1);
  });
  it('returns [] when meta.asOf is missing (no reference date to measure from)', () => {
    expect(checkStaleLeaseRows({ meta: {} as PortfolioSnapshot['meta'], leases: [l({ leaseEnd: '2020-01-01' })] })).toEqual([]);
    expect(checkStaleLeaseRows({ meta: undefined as unknown as PortfolioSnapshot['meta'], leases: [l({ leaseEnd: '2020-01-01' })] })).toEqual([]);
  });
});

// 2026-09-23 review: Overview "Total Debt" (Σ investment-property loanBalance, Property NOI sheet)
// and Capital › Debt "External Debt" (Σ borrower-loan absBalance, loan schedule) disagreed by
// ~$0.7M with nothing on screen saying so. Warn-only: surfaces the gap, never picks a winner or
// alters either total.
describe('checkDebtBasis', () => {
  it('flags when Overview total debt (Σ property loan balances) ≠ Capital external debt (Σ borrower loans)', () => {
    const flags = checkDebtBasis({
      properties: [{ loanBalance: 11_300_000 }] as never,
      loans: [{ direction: 'borrower', absBalance: 10_600_000 }, { direction: 'internal', absBalance: 2_610_000 }] as never,
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ field: 'debt.basis', severity: 'warn' });
    expect(flags[0]!.issue).toContain('700');
  });
  it('names both figures being compared, so the reader knows which two surfaces disagree', () => {
    const flags = checkDebtBasis({
      properties: [{ loanBalance: 11_300_000 }] as never,
      loans: [{ direction: 'borrower', absBalance: 10_600_000 }] as never,
    });
    expect(flags[0]!.issue).toContain('11,300,000');
    expect(flags[0]!.issue).toContain('10,600,000');
    expect(flags[0]!.issue).toMatch(/Overview/);
    expect(flags[0]!.issue).toMatch(/External Debt/);
  });
  it('silent within $1,000', () => {
    expect(checkDebtBasis({ properties: [{ loanBalance: 100_500 }] as never, loans: [{ direction: 'borrower', absBalance: 100_000 }] as never })).toEqual([]);
  });
  it('threshold is strictly > $1,000: exactly 1,000 → silent, 1,001 → flag (either sign)', () => {
    expect(checkDebtBasis({ properties: [{ loanBalance: 101_000 }] as never, loans: [{ direction: 'borrower', absBalance: 100_000 }] as never })).toEqual([]);
    expect(checkDebtBasis({ properties: [{ loanBalance: 101_001 }] as never, loans: [{ direction: 'borrower', absBalance: 100_000 }] as never })).toHaveLength(1);
    expect(checkDebtBasis({ properties: [{ loanBalance: 100_000 }] as never, loans: [{ direction: 'borrower', absBalance: 101_001 }] as never })).toHaveLength(1);
  });
  it('compares like with like: the residence is outside Overview Total Debt, so its loanBalance is outside this check too', () => {
    // Overview's totalDebt sums loanBalance over isInvestmentProperty rows only (engine.ts
    // portfolioKpis). A residence mortgage must not be read as an "unexplained" gap against the
    // borrower-loan schedule.
    expect(checkDebtBasis({
      properties: [{ type: 'Flex', loanBalance: 500_000 }, { type: 'Residence', loanBalance: 900_000 }] as never,
      loans: [{ direction: 'borrower', absBalance: 500_000 }] as never,
    })).toEqual([]);
  });
  it('only borrower loans count on the loan-schedule side (lender / internal directions are not External Debt)', () => {
    expect(checkDebtBasis({
      properties: [{ loanBalance: 500_000 }] as never,
      loans: [
        { direction: 'borrower', absBalance: 500_000 },
        { direction: 'lender', absBalance: 1_700_000 },
        { direction: 'internal', absBalance: 2_900_000 },
      ] as never,
    })).toEqual([]);
  });
  it('tolerates missing arrays (legacy fixture)', () => {
    expect(checkDebtBasis({ properties: undefined, loans: undefined } as never)).toEqual([]);
  });
  it('is NOT a reconciliation-entity flag and does NOT fire the CRITICAL "reconcile-fail" insight (PR-1 lesson)', () => {
    const flags = checkDebtBasis({
      properties: [{ loanBalance: 11_300_000 }] as never,
      loans: [{ direction: 'borrower', absBalance: 10_600_000 }] as never,
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.entity).not.toBe('reconciliation');
    // Prove it end-to-end through the insights engine, which treats ANY entity==='reconciliation'
    // flag (whatever its severity) as a critical reconciliation failure.
    const asOf = '2026-09-23';
    const snap = {
      meta: { schemaVersion: '1.0.0', asOf, generatedAt: '2026-09-23T00:00:00.000Z', source: 't', scenario: 'Base' },
      assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf },
      properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [],
      renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null,
      cash: { asOf, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
      dataQuality: flags,
    } as unknown as PortfolioSnapshot;
    const insights = evaluateConditions(snap, { now: Date.parse('2026-09-23T12:00:00.000Z') });
    expect(insights.some((i) => i.id === 'reconcile-fail')).toBe(false);
    expect(insights.some((i) => i.severity === 'critical')).toBe(false);
  });
  it('is wired into checkSnapshot (fires on the full snapshot path) and stays warn there too', () => {
    const flags = checkSnapshot(base({
      properties: [{ id: 'p1', loanBalance: 11_300_000 }],
      loans: [{ id: 'n1', direction: 'borrower', absBalance: 10_600_000 }],
    }));
    const f = flags.find((x) => x.field === 'debt.basis');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warn');
    expect(f!.entity).not.toBe('reconciliation');
    expect(flags.some((x) => x.severity === 'error')).toBe(false);
  });
});

describe('checkDebtBasis — order-independent at the $1,000 boundary (refute wf_fb49dbb9-c91)', () => {
  const loans = [{ direction: 'borrower', absBalance: 0.3 }, { direction: 'borrower', absBalance: 0.6 }];
  const prop = (loanBalance: number) => ({ type: 'Flex', loanBalance });
  it('gives the same answer for every row order when the gap is exactly $1,000.00', () => {
    const a = checkDebtBasis({ properties: [prop(1000.6), prop(0.1), prop(0.2)], loans } as never);
    const b = checkDebtBasis({ properties: [prop(0.1), prop(0.2), prop(1000.6)], loans } as never);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });
  it('prints en-US grouped figures regardless of the host locale', () => {
    const [f] = checkDebtBasis({ properties: [prop(11_300_000)], loans: [{ direction: 'borrower', absBalance: 10_600_000 }] } as never);
    expect(f!.issue).toContain('11,300,000');
    expect(f!.issue).toContain('gap $700,000');
  });
});
